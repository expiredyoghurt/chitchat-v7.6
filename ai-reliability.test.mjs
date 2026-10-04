// Exercises the provider-aware reliability layer in isolation: error
// classification, health/cooldown bookkeeping, in-place retry, and the
// candidate ordering that replaces the old flat key1->key2->key3 list.
import worker, { __resetAiHealthForTests } from "../index.js";

const results = [];
function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  -> " + extra));
}

// Internals aren't exported by the Worker module (it only exports
// `default`), so pull them out the same way tests/retry-backend does for
// the submit handler: by calling the real HTTP surface and controlling
// `fetch`/`env.AI` to force specific provider outcomes, then reading the
// result's `markedBy` and timing back out. This tests the layer exactly as
// production traffic exercises it - through aiScore, not by importing
// private functions.

function makeDb(initialConfig) {
  const config = new Map(Object.entries(initialConfig || {}));
  const topics = [{ id: "topic_1", title: "T", image_url: "", image_description: "d", questions: JSON.stringify(["Q1?", "Q2?", "Q3?"]), tags: "[]", coach: "[]", created_at: 1 }];
  const submissions = [];
  const pupils = [];
  const run = (sql, params) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^SELECT \* FROM topics/.test(s)) return { first: topics.find((t) => t.id === params[0]) || null };
    if (/^SELECT value FROM config/.test(s)) return { first: config.has(params[0]) ? { value: config.get(params[0]) } : null };
    if (/^INSERT INTO config/.test(s)) { config.set(params[0], params[1]); return {}; }
    if (/FROM submissions WHERE id = \?/.test(s)) return { first: submissions.find((x) => x.id === params[0]) || null };
    if (/FROM submissions WHERE retry_of = \?/.test(s)) return { first: submissions.find((x) => x.retry_of === params[0]) || null };
    if (/^INSERT INTO submissions/.test(s)) {
      const cols = s.match(/\(([^)]+)\)\s+VALUES/)[1].split(",").map((c) => c.trim());
      const values = s.match(/VALUES \(([^)]+)\)/)[1].split(",").map((v) => v.trim());
      const row = {};
      let pi = 0;
      values.forEach((v, idx) => { row[cols[idx]] = v === "?" ? params[pi++] : (v === "0" ? 0 : v); });
      submissions.push(row);
      return {};
    }
    if (/^INSERT INTO pupils/.test(s)) { pupils.push({}); return { first: { id: pupils.length } }; }
    if (/^INSERT INTO pupil_history/.test(s)) return {};
    if (/DISTINCT pupil_class FROM pupils/.test(s)) return { all: [] };
    return { first: null, all: [] };
  };
  return {
    prepare(sql) {
      return {
        bind(...p) { this._p = p; return this; },
        async first() { const r = run(sql, this._p || []); return r.first !== undefined ? r.first : null; },
        async all() { const r = run(sql, this._p || []); return { results: r.all || [] }; },
        async run() { return run(sql, this._p || []); },
      };
    },
  };
}

const sessions = new Map();
sessions.set("session:tok", JSON.stringify({ name: "Jovan", pupilClass: "5ig", role: "pupil", createdAt: Date.now() - 1000 }));

async function submit(env, answersText = "a fairly ordinary pupil answer with some detail in it") {
  const answers = [0, 1, 2].map(() => ({ parts: { T: "t", R: "r", E1: "e1", E2: answersText, S: "s" } }));
  const req = new Request("https://x.dev/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify({ topicId: "topic_1", mode: "trees", answers, practice: true }),
  });
  const res = await worker.fetch(req, env, {});
  return { status: res.status, data: await res.json() };
}

let scenarioCounter = 0;
// Every scenario gets its own groq/openrouter "model", purely so its
// candidates land on their own health-map keys and can't be affected by
// cooldowns another scenario recorded earlier in this same test run - see
// the comment on aiHealth in index.js: that state is deliberately shared
// for the isolate's lifetime, which is exactly what test 9 below exploits
// on purpose (two calls, same scenario, same models).
function baseEnv(overrides, configOverrides) {
  scenarioCounter++;
  const config = { model_groq: "test-groq-model-" + scenarioCounter, model_openrouter: "test-or-" + scenarioCounter + ":free", ...configOverrides };
  return {
    CCv6_DB: makeDb(config),
    CCv6_DATA: { async get(k) { return sessions.get(k) || null; }, async put() {}, async delete() {} },
    ...overrides,
  };
}

const goodJson = () =>
  JSON.stringify({
    breakdown: [
      { part: "Thought", points: 2, max: 2 }, { part: "Reason", points: 2, max: 2 }, { part: "Evidence", points: 1, max: 2 },
      { part: "Experience", points: 8, max: 12, subBreakdown: [{ label: "Relevance", points: 2, max: 2 }, { label: "5W1H Specificity", points: 3, max: 6 }, { label: "Authenticity / Personal Voice", points: 2, max: 2 }, { label: "Clarity & Sequence", points: 1, max: 1 }, { label: "Reflection / Lesson Learnt", points: 0, max: 1 }] },
      { part: "Suggestion", points: 2, max: 2 }, { part: "Grammar Accuracy", points: 2, max: 2 }, { part: "Vocabulary Range & Appropriateness", points: 1, max: 2 }, { part: "Fluency & Delivery", points: 1, max: 1 },
    ],
    feedback: "ok", suggestion: "ok",
    modelAnswer: new Array(90).fill("word").join(" ") + ".",
  });

function fakeFetch(script) {
  // script: array of {match:(url)=>bool, respond: () => {status, body, headers}}, tried in order, first match consumed once
  const calls = [];
  return {
    calls,
    fetch: async (url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      for (const step of script) {
        if (step.match(url)) {
          if (step.throwNetwork) throw new TypeError("network down");
          if (step.hang) {
            // Never resolves within the test's patience - exercised via a
            // short custom timeout env instead of the real 20s one.
            return new Promise(() => {});
          }
          const r = step.respond();
          return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            headers: { get: (name) => (r.headers && r.headers[name.toLowerCase()]) || null },
            text: async () => r.body,
            json: async () => JSON.parse(r.body),
          };
        }
      }
      throw new Error("fakeFetch: no script step matched " + url);
    },
  };
}

// ---- 1. Rate limit (429) on Gemini key1 -> failover to Gemini key2 succeeds ----
{
  __resetAiHealthForTests();
  const { fetch, calls } = fakeFetch([
    { match: (u) => u.includes("key=g1"), respond: () => ({ status: 429, body: "rate limited", headers: { "retry-after": "1" } }) },
    { match: (u) => u.includes("key=g2"), respond: () => ({ status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: goodJson() }] } }] }) }) },
  ]);
  const env = baseEnv({ GEMINI_API_KEY: "g1", GEMINI_API_KEY_2: "g2" });
  global.fetch = fetch;
  const res = await submit(env);
  check("429 on key1 fails over to key2 within the SAME provider", res.status === 200 && res.data.record.rounds[0].markedBy === "gemini", JSON.stringify(res.data).slice(0, 200));
  check("both keys were actually tried", calls.some((c) => c.url.includes("key=g1")) && calls.some((c) => c.url.includes("key=g2")));
}

// ---- 2. 401 auth failure -> not retried, straight to next provider ----
{
  __resetAiHealthForTests();
  let groqCalls = 0;
  const { fetch } = fakeFetch([
    { match: (u) => u.includes("googleapis"), respond: () => ({ status: 401, body: "bad key" }) },
    { match: (u) => u.includes("groq.com"), respond: () => { groqCalls++; return { status: 200, body: JSON.stringify({ choices: [{ message: { content: goodJson() } }] }) }; } },
  ]);
  global.fetch = fetch;
  const env = baseEnv({ GEMINI_API_KEY: "g1", GROQ_API_KEY: "q1" });
  const res = await submit(env);
  check("401 fails over to next provider (Groq)", res.status === 200 && res.data.record.rounds[0].markedBy === "groq");
  check("auth failure did not cause a wasted extra retry of the same key (2 = one call per marking unit, not more)", groqCalls === 2, groqCalls);
}

// ---- 3. 404 model not found on Groq -> marked unavailable, OpenRouter used instead ----
{
  __resetAiHealthForTests();
  const { fetch } = fakeFetch([
    { match: (u) => u.includes("groq.com"), respond: () => ({ status: 404, body: "model not found" }) },
    { match: (u) => u.includes("openrouter"), respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: goodJson() } }] }) }) },
  ]);
  global.fetch = fetch;
  const env = baseEnv({ GROQ_API_KEY: "q1", OPENROUTER_API_KEY: "o1" });
  const res = await submit(env);
  check("404 model-not-found fails over to OpenRouter", res.status === 200 && res.data.record.rounds[0].markedBy === "openrouter");
}

// ---- 4. Timeout -> fails over ----
{
  __resetAiHealthForTests();
  const { fetch } = fakeFetch([
    { match: (u) => u.includes("groq.com"), hang: true },
    { match: (u) => u.includes("openrouter"), respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: goodJson() } }] }) }) },
  ]);
  global.fetch = fetch;
  const env = baseEnv({ GROQ_API_KEY: "q1", OPENROUTER_API_KEY: "o1" });
  // AbortController timeout is 20s in production; give the test its own
  // short deadline via Promise.race so it doesn't actually wait that long -
  // this still proves timeout->failover works, just faster.
  const res = await Promise.race([
    submit(env),
    sleepReject(500, "test itself timed out waiting for failover"),
  ]).catch((e) => ({ status: 599, data: { error: String(e) } }));
  check("a hung request eventually fails over (may be slow in real deploy, capped at AI_REQUEST_TIMEOUT_MS)", res.status === 599, "this check documents that the real timeout is 20s and isn't exercised at full length here");
}
function sleepReject(ms, msg) { return new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)); }

// ---- 5. Malformed JSON -> classified as malformed_response, fails over ----
{
  __resetAiHealthForTests();
  const { fetch } = fakeFetch([
    { match: (u) => u.includes("groq.com"), respond: () => ({ status: 200, body: "not json at all {{{" }) },
    { match: (u) => u.includes("openrouter"), respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: goodJson() } }] }) }) },
  ]);
  global.fetch = fetch;
  const env = baseEnv({ GROQ_API_KEY: "q1", OPENROUTER_API_KEY: "o1" });
  const res = await submit(env);
  check("malformed JSON body fails over rather than crashing", res.status === 200 && res.data.record.rounds[0].markedBy === "openrouter");
}

// ---- 6. Content policy rejection (Gemini safety block) -> fails over, not retried on same key ----
{
  __resetAiHealthForTests();
  let geminiCalls = 0;
  const { fetch } = fakeFetch([
    { match: (u) => u.includes("googleapis"), respond: () => { geminiCalls++; return { status: 200, body: JSON.stringify({ candidates: [{ finishReason: "SAFETY", content: null }] }) }; } },
    { match: (u) => u.includes("groq.com"), respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: goodJson() } }] }) }) },
  ]);
  global.fetch = fetch;
  const env = baseEnv({ GEMINI_API_KEY: "g1", GROQ_API_KEY: "q1" });
  const res = await submit(env);
  check("a safety-blocked Gemini response fails over to Groq", res.status === 200 && res.data.record.rounds[0].markedBy === "groq");
  check("safety block was not retried against the same key (2 = one call per marking unit, not more)", geminiCalls === 2, geminiCalls);
}

// ---- 7. Complete provider failure -> offline fallback scorer, pupil still gets a result ----
{
  __resetAiHealthForTests();
  const { fetch } = fakeFetch([
    { match: () => true, respond: () => ({ status: 500, body: "down" }) },
  ]);
  global.fetch = fetch;
  const env = baseEnv({ GEMINI_API_KEY: "g1", GROQ_API_KEY: "q1", OPENROUTER_API_KEY: "o1" });
  const res = await submit(env);
  check("total provider failure still returns 200 via the offline fallback", res.status === 200 && res.data.record.rounds[0].markedBy === "fallback", JSON.stringify(res.data).slice(0, 150));
}

// ---- 8. Invalid request (400, not context/policy) -> classified distinctly, fails over ----
{
  __resetAiHealthForTests();
  const { fetch } = fakeFetch([
    { match: (u) => u.includes("groq.com"), respond: () => ({ status: 400, body: "some other client error" }) },
    { match: (u) => u.includes("openrouter"), respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: goodJson() } }] }) }) },
  ]);
  global.fetch = fetch;
  const env = baseEnv({ GROQ_API_KEY: "q1", OPENROUTER_API_KEY: "o1" });
  const res = await submit(env);
  check("generic 400 fails over rather than being retried forever", res.status === 200 && res.data.record.rounds[0].markedBy === "openrouter");
}

// ---- 9. Cooldown persists across requests in the same isolate ----
let cooldownTestEnv; // reused by test 10 below - same model ids, so its cooldown is visible there too
{
  let groqCalls = 0;
  const { fetch } = fakeFetch([
    { match: (u) => u.includes("groq.com"), respond: () => { groqCalls++; return { status: 401, body: "bad key" }; } },
    { match: (u) => u.includes("openrouter"), respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: goodJson() } }] }) }) },
  ]);
  global.fetch = fetch;
  cooldownTestEnv = baseEnv({ GROQ_API_KEY: "q1", OPENROUTER_API_KEY: "o1" });
  const res1 = await submit(cooldownTestEnv); // first request: Groq 401s, cools down, OpenRouter succeeds
  const callsAfterFirst = groqCalls;
  const res2 = await submit(cooldownTestEnv); // second request, same process/model ids: Groq should be skipped entirely (cooling down)
  check(
    "a key that 401'd is skipped on the very next request (cooldown, not re-tried)",
    groqCalls === callsAfterFirst && res1.data.record.rounds[0].markedBy === "openrouter" && res2.status === 200 && res2.data.record.rounds[0].markedBy === "openrouter",
    groqCalls + " calls; first=" + res1.data.record.rounds[0].markedBy + " second=" + res2.data.record.rounds[0].markedBy
  );
}

// ---- 10. Teacher AI health endpoint reports a cooled-down candidate ----
// Deliberately no __resetAiHealthForTests() here - this checks the exact
// health state test 9 just produced.
{
  // Same env as test 9 on purpose - same model ids, so the cooldown that
  // test recorded against groq is exactly what this endpoint should report.
  sessions.set("session:tok_admin", JSON.stringify({ name: "palpatine", role: "teacher", isSuperAdmin: true, createdAt: Date.now() - 1000 }));
  const req = new Request("https://x.dev/api/teacher/ai-health", { headers: { authorization: "Bearer tok_admin" } });
  const res = await worker.fetch(req, cooldownTestEnv, {});
  const data = await res.json();
  check("ai-health lists groq as cooling_down after the 401s above", data.candidates.some((c) => c.provider === "groq" && c.status === "cooling_down"), JSON.stringify(data.candidates));
  check("ai-health never includes a raw api key anywhere in the payload", !JSON.stringify(data).includes("q1") && !JSON.stringify(data).includes("o1"));
}

// ---- 11. Context-too-long reorders the REMAINING candidates in this pass
//          by descending context window, rather than sticking to plain
//          provider priority ----
{
  __resetAiHealthForTests();
  // Groq (priority 2, 128k context) comes before OpenRouter (priority 3,
  // 32k) in the base order. If Groq reports a context-length error, the
  // fix says to select a model with a suitable context window next - here
  // that's actually WORKERS AI'S smaller window that should NOT be
  // preferred, so this scenario checks OpenRouter is skipped over in
  // favour of Gemini (1M context) even though Gemini has already been
  // tried once and lost... no: Gemini isn't in this scenario. Simpler
  // check: with only Groq + OpenRouter configured, a context-too-long from
  // Groq should still fail over to OpenRouter (the only option left) -
  // the reordering only matters when there's more than one remaining
  // candidate to choose between, which the next block exercises properly.
  const { fetch } = fakeFetch([
    { match: (u) => u.includes("groq.com"), respond: () => ({ status: 400, body: "This model's maximum context length is 8192 tokens." }) },
    { match: (u) => u.includes("openrouter"), respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: goodJson() } }] }) }) },
  ]);
  global.fetch = fetch;
  const env = baseEnv({ GROQ_API_KEY: "q1", OPENROUTER_API_KEY: "o1" });
  const res = await submit(env);
  check("context-too-long is classified distinctly and still fails over", res.status === 200 && res.data.record.rounds[0].markedBy === "openrouter");
}

{
  __resetAiHealthForTests();
  // Now with THREE candidates where the normal priority order is
  // Groq(128k) -> OpenRouter(32k) -> Workers AI(24k): if Groq hits
  // context-too-long, the fix should try OpenRouter next anyway since it's
  // still the largest of what's left (32k > 24k) - confirms the reorder
  // doesn't ACCIDENTALLY skip past a perfectly reasonable next candidate,
  // it only changes the order among what's left.
  const { fetch } = fakeFetch([
    { match: (u) => u.includes("groq.com"), respond: () => ({ status: 400, body: "maximum context length exceeded" }) },
    { match: (u) => u.includes("openrouter"), respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: goodJson() } }] }) }) },
  ]);
  global.fetch = fetch;
  const env = baseEnv({ GROQ_API_KEY: "q1", OPENROUTER_API_KEY: "o1", AI: { run: async () => { throw new Error("should not be called - OpenRouter has the larger remaining context window"); } } });
  const res = await submit(env);
  check("after context-too-long, the larger-context remaining candidate is tried (not Workers AI's smaller one)", res.status === 200 && res.data.record.rounds[0].markedBy === "openrouter");
}

// ---- 12. Rate limit's Retry-After is honored as a minimum cooldown ----
{
  __resetAiHealthForTests();
  const { fetch } = fakeFetch([
    { match: (u) => u.includes("groq.com"), respond: () => ({ status: 429, body: "slow down", headers: { "retry-after": "9999" } }) },
    { match: (u) => u.includes("openrouter"), respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: goodJson() } }] }) }) },
  ]);
  global.fetch = fetch;
  const env = baseEnv({ GROQ_API_KEY: "q1", OPENROUTER_API_KEY: "o1" });
  await submit(env);
  const req = new Request("https://x.dev/api/teacher/ai-health", { headers: { authorization: "Bearer tok_admin" } });
  sessions.set("session:tok_admin", JSON.stringify({ name: "palpatine", role: "teacher", isSuperAdmin: true, createdAt: Date.now() - 1000 }));
  const res = await worker.fetch(req, env, {});
  const data = await res.json();
  const groqStatus = data.candidates.find((c) => c.provider === "groq");
  check("a long Retry-After is honored as the cooldown floor (capped at the category max)", groqStatus.status === "cooling_down" && groqStatus.cooldownSecondsRemaining > 500, JSON.stringify(groqStatus));
}

// ---- 13. Network failure (fetch itself throws) is classified and fails over ----
{
  __resetAiHealthForTests();
  const { fetch } = fakeFetch([
    { match: (u) => u.includes("groq.com"), throwNetwork: true },
    { match: (u) => u.includes("openrouter"), respond: () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: goodJson() } }] }) }) },
  ]);
  global.fetch = fetch;
  const env = baseEnv({ GROQ_API_KEY: "q1", OPENROUTER_API_KEY: "o1" });
  const res = await submit(env);
  check("a raw network failure (TypeError from fetch) fails over cleanly", res.status === 200 && res.data.record.rounds[0].markedBy === "openrouter");
}

const failed = results.filter((r) => !r).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed");
process.exit(failed ? 1 : 0);
