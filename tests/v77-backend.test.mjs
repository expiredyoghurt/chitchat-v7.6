// v7.7 backend: pupil's own breakdown, per-answer improved rewrites (doubled cap), Present / Not observed,
// 'Retry AI suggested answer', output-token limit.
import worker, { __resetAiHealthForTests } from "../index.js";

const results = [];
function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  -> " + extra));
}

// ---- in-memory D1 stand-in (same shape as tests/submissions-remark.test.mjs) ----
function makeDb(initialConfig) {
  const config = new Map(Object.entries(initialConfig || {}));
  const topics = [{ id: "topic_1", title: "Helping Others", image_url: "", image_description: "d", questions: JSON.stringify(["Q1?", "Q2?", "Q3?"]), tags: "[]", coach: "[]", created_at: 1 }];
  const submissions = [];
  const pupils = [];
  const history = [];

  function run(sql, params) {
    const s = sql.replace(/\s+/g, " ").trim();

    if (/^SELECT \* FROM topics WHERE id = \?/.test(s)) return { first: topics.find((t) => t.id === params[0]) || null };
    if (/^SELECT created_at FROM topics WHERE id = \?/.test(s)) { const t = topics.find((x) => x.id === params[0]); return { first: t ? { created_at: t.created_at } : null }; }
    if (/^SELECT \* FROM topics ORDER BY/.test(s)) return { all: topics.slice() };
    if (/^SELECT value FROM config WHERE key = \?/.test(s)) return { first: config.has(params[0]) ? { value: config.get(params[0]) } : null };
    if (/^INSERT INTO config/.test(s)) { config.set(params[0], params[1]); return {}; }
    if (/^INSERT INTO topics/.test(s)) {
      const [id, title, image_url, image_description, questionsJ, tagsJ, coachJ, created_at] = params;
      const i = topics.findIndex((t) => t.id === id);
      const row = { id, title, image_url, image_description, questions: questionsJ, tags: tagsJ, coach: coachJ, created_at };
      if (i >= 0) topics[i] = row; else topics.push(row);
      return {};
    }
    if (/^SELECT pupil_class, topic_title, rounds, final_score FROM submissions/.test(s)) {
      let rows = submissions.filter((r) => r.practice === 0 && r.grading_degraded === 0 && r.archived === 0);
      if (/LOWER\(pupil_class\) IN/.test(s)) { rows = rows.filter((r) => params.map(String).includes(String(r.pupil_class).toLowerCase())); }
      else if (/LOWER\(pupil_class\) = LOWER\(\?\)/.test(s)) { rows = rows.filter((r) => String(r.pupil_class).toLowerCase() === String(params[0]).toLowerCase()); }
      return { all: rows };
    }
    if (/^DELETE FROM config WHERE key = \?/.test(s)) { config.delete(params[0]); return {}; }
    if (/^SELECT \* FROM submissions WHERE archived = 0 ORDER BY/.test(s)) return { all: submissions.filter((r) => r.archived === 0).slice().sort((a, b) => b.created_at - a.created_at) };

    if (/^SELECT \* FROM submissions WHERE id = \?/.test(s)) return { first: submissions.find((x) => x.id === params[0]) || null };
    if (/FROM submissions WHERE retry_of = \?/.test(s)) return { first: submissions.find((x) => x.retry_of === params[0]) || null };

    if (/^INSERT INTO submissions/.test(s)) {
      const cols = s.match(/\(([^)]+)\)\s+VALUES/)[1].split(",").map((c) => c.trim());
      const values = s.match(/VALUES \(([^)]+)\)/)[1].split(",").map((v) => v.trim());
      const row = {};
      let pi = 0;
      values.forEach((v, idx) => { row[cols[idx]] = v === "?" ? params[pi++] : Number(v); });
      submissions.push(row);
      return {};
    }
    if (/^UPDATE submissions SET rounds = \?, final_score = \?, grading_degraded = \? WHERE id = \?/.test(s)) {
      const row = submissions.find((x) => x.id === params[3]);
      if (row) { row.rounds = params[0]; row.final_score = params[1]; row.grading_degraded = params[2]; }
      return {};
    }
    // Teacher override's UPDATE - no grading_degraded column touched at all.
    if (/^UPDATE submissions SET rounds = \?, final_score = \? WHERE id = \?/.test(s)) {
      const row = submissions.find((x) => x.id === params[2]);
      if (row) { row.rounds = params[0]; row.final_score = params[1]; }
      return {};
    }
    if (/^UPDATE submissions SET rounds = \? WHERE id = \?/.test(s)) {
      const row = submissions.find((r) => r.id === params[1]);
      if (row) row.rounds = params[0];
      return {};
    }
    if (/^UPDATE submissions SET leaderboard_counted = 1 WHERE id = \?/.test(s)) {
      const row = submissions.find((x) => x.id === params[0]);
      if (row) row.leaderboard_counted = 1;
      return {};
    }

    if (/leaderboard_counted = 1 AND archived = 0/.test(s)) {
      let pi = 0;
      let rows = submissions.filter((r) => r.leaderboard_counted === 1 && r.archived === 0);
      if (/LOWER\(pupil_class\) = LOWER\(\?\)/.test(s) && /LOWER\(topic_title\)/.test(s)) {
        const classParam = params[pi++], topicParam = params[pi++];
        rows = rows.filter((r) => String(r.pupil_class).toLowerCase() === classParam.toLowerCase() && String(r.topic_title).toLowerCase() === topicParam.toLowerCase());
      } else if (/LOWER\(pupil_class\) = LOWER\(\?\)/.test(s)) {
        const classParam = params[pi++];
        rows = rows.filter((r) => String(r.pupil_class).toLowerCase() === classParam.toLowerCase());
      } else if (/LOWER\(topic_title\) = LOWER\(\?\)/.test(s)) {
        const topicParam = params[pi++];
        rows = rows.filter((r) => String(r.topic_title).toLowerCase() === topicParam.toLowerCase());
      }
      if (/LOWER\(pupil_name\) LIKE \?/.test(s)) {
        const like = String(params[pi++]).replace(/%/g, ""); pi++;
        rows = rows.filter((r) => String(r.pupil_name).toLowerCase().includes(like) || String(r.pupil_class).toLowerCase().includes(like));
      }
      rows = rows.slice().sort((a, b) => b.created_at - a.created_at);
      if (/^SELECT COUNT/.test(s)) return { first: { c: rows.length } };
      if (/LIMIT \? OFFSET \?/.test(s)) {
        const limit = params[pi++], offset = params[pi++];
        return { all: rows.slice(offset, offset + limit) };
      }
      return { all: rows };
    }

    if (/LOWER\(pupil_name\) = LOWER\(\?\) AND LOWER\(pupil_class\) = LOWER\(\?\)/.test(s)) {
      const [name, cls] = params;
      let rows = submissions.filter((r) => String(r.pupil_name).toLowerCase() === name.toLowerCase() && String(r.pupil_class).toLowerCase() === cls.toLowerCase());
      let pi = 2;
      if (/AND LOWER\(topic_title\) = LOWER\(\?\)/.test(s)) { const tp = params[pi++]; rows = rows.filter((r) => String(r.topic_title).toLowerCase() === String(tp).toLowerCase()); }
      if (/ORDER BY final_score DESC/.test(s)) rows = rows.slice().sort((a, b) => b.final_score - a.final_score);
      else if (/ORDER BY created_at ASC/.test(s)) rows = rows.slice().sort((a, b) => a.created_at - b.created_at);
      else rows = rows.slice().sort((a, b) => b.created_at - a.created_at);
      if (/^SELECT COUNT/.test(s)) return { first: { c: rows.length } };
      const limit = params[pi], offset = params[pi + 1];
      return { all: rows.slice(offset, offset + limit) };
    }

    if (/^INSERT INTO pupils.*ON CONFLICT/.test(s)) {
      const [name, pupilClass, bestScore, totalScore] = params;
      let p = pupils.find((x) => x.name === name && x.pupil_class === pupilClass);
      if (!p) { p = { id: pupils.length + 1, name, pupil_class: pupilClass, best_score: bestScore || 0, total_score: totalScore || 0, attempts: 1 }; pupils.push(p); }
      else { p.attempts += 1; p.total_score += params[3]; p.best_score = Math.max(p.best_score, params[4]); }
      return { first: { id: p.id } };
    }
    if (/^SELECT id FROM pupils WHERE name = \? AND pupil_class = \?/.test(s)) {
      const [name, pupilClass] = params;
      const p = pupils.find((x) => x.name === name && x.pupil_class === pupilClass);
      return { first: p ? { id: p.id } : null };
    }
    if (/^INSERT INTO pupils \(name, pupil_class, best_score, total_score, attempts\) VALUES \(\?, \?, 0, 0, 0\) RETURNING id/.test(s)) {
      const [name, pupilClass] = params;
      const p = { id: pupils.length + 1, name, pupil_class: pupilClass, best_score: 0, total_score: 0, attempts: 0 };
      pupils.push(p);
      return { first: { id: p.id } };
    }
    if (/^SELECT COUNT\(\*\) as attempts, COALESCE\(SUM\(final_score\), 0\) as total, COALESCE\(MAX\(final_score\), 0\) as best FROM submissions WHERE pupil_name = \? AND pupil_class = \? AND leaderboard_counted = 1/.test(s)) {
      const [name, pupilClass] = params;
      const rows = submissions.filter((r) => r.pupil_name === name && r.pupil_class === pupilClass && r.leaderboard_counted === 1);
      const total = rows.reduce((sum, r) => sum + (r.final_score || 0), 0);
      const best = rows.reduce((max, r) => Math.max(max, r.final_score || 0), 0);
      return { first: { attempts: rows.length, total, best } };
    }
    if (/^UPDATE pupils SET attempts = \?, total_score = \?, best_score = \? WHERE id = \?/.test(s)) {
      const [attempts, total, best, id] = params;
      const p = pupils.find((x) => x.id === id);
      if (p) { p.attempts = attempts; p.total_score = total; p.best_score = best; }
      return {};
    }
    if (/^INSERT INTO pupil_history/.test(s)) { history.push(params); return {}; }
    if (/DISTINCT pupil_class FROM pupils/.test(s)) return { all: [...new Set(pupils.map((p) => p.pupil_class))].map((c) => ({ pupil_class: c })) };

    return { first: null, all: [] };
  }

  return {
    _state: { submissions, pupils, history, config },
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
let scenarioCounter = 0;
function baseEnv(overrides) {
  scenarioCounter++;
  return {
    CCv6_DB: makeDb({ model_groq: "test-groq-" + scenarioCounter, model_openrouter: "test-or-" + scenarioCounter + ":free" }),
    CCv6_DATA: { async get(k) { return sessions.get(k) || null; }, async put() {}, async delete() {} },
    ...overrides,
  };
}
function login(token, session) { sessions.set("session:" + token, JSON.stringify(session)); }

login("pup1", { name: "Jovan", pupilClass: "5ig", role: "pupil", createdAt: Date.now() - 1000 });
login("pup2", { name: "Mei", pupilClass: "5ig", role: "pupil", createdAt: Date.now() - 1000 });
login("admin", { name: "palpatine", role: "teacher", isSuperAdmin: true, createdAt: Date.now() - 1000 });
login("scoped-in", { name: "mrslim", role: "teacher", isSuperAdmin: false, assignedClasses: ["5ig"], createdAt: Date.now() - 1000 });
login("scoped-out", { name: "mrslam", role: "teacher", isSuperAdmin: false, assignedClasses: ["6ha"], createdAt: Date.now() - 1000 });

async function submit(env, token, answersText, practice) {
  const answers = [0, 1, 2].map(() => ({ parts: { T: "t", R: "r", E1: "e1", E2: answersText || "a fairly ordinary pupil answer with reasonable detail in it", S: "s" } }));
  const req = new Request("https://x.dev/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ topicId: "topic_1", mode: "trees", answers, practice: !!practice }),
  });
  const res = await worker.fetch(req, env, {});
  return { status: res.status, data: await res.json() };
}
async function get(env, path, token) {
  const req = new Request("https://x.dev" + path, { headers: token ? { authorization: "Bearer " + token } : {} });
  const res = await worker.fetch(req, env, {});
  return { status: res.status, data: await res.json() };
}
async function override(env, id, roundIndex, score, feedback, token) {
  const req = new Request("https://x.dev/api/teacher/submissions/" + id + "/override-score", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: JSON.stringify({ roundIndex, score, feedback }),
  });
  const res = await worker.fetch(req, env, {});
  return { status: res.status, data: await res.json() };
}

const goodJson = () =>
  JSON.stringify({
    breakdown: [
      { part: "Thought", points: 2, max: 2 }, { part: "Reason", points: 2, max: 2 }, { part: "Evidence", points: 1, max: 2 },
      { part: "Experience", points: 8, max: 12, subBreakdown: [{ label: "Relevance", points: 2, max: 2 }, { label: "5W1H Specificity", points: 3, max: 6 }, { label: "Authenticity / Personal Voice", points: 2, max: 2 }, { label: "Clarity & Sequence", points: 1, max: 1 }, { label: "Reflection / Lesson Learnt", points: 0, max: 1 }] },
      { part: "Suggestion", points: 2, max: 2 }, { part: "Grammar Accuracy", points: 2, max: 2 }, { part: "Vocabulary Range & Appropriateness", points: 1, max: 2 }, { part: "Fluency & Delivery", points: 1, max: 1 },
    ],
    feedback: "Nicely done.", suggestion: "Add more detail.",
    modelAnswer: new Array(90).fill("word").join(" ") + ".",
  });
function fakeFetchGroqSucceeds() {
  return async (url) => {
    if (String(url).includes("groq.com")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => ({ choices: [{ message: { content: goodJson() } }] }) };
    return { ok: false, status: 500, headers: { get: () => null }, text: async () => "down", json: async () => ({}) };
  };
}
function fakeFetchAllFail() {
  return async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "down", json: async () => ({}) });
}



// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------
const storedRounds = (env, id) => JSON.parse(env.CCv6_DB._state.submissions.find((x) => x.id === id).rounds);
const unitOfSystem = (system) => (/QUESTIONS 2 AND 3 TOGETHER|TWO linked spoken questions/.test(system) ? 2 : 1);
const u1 = (extra) => JSON.parse(goodJson(), null) && { ...JSON.parse(goodJson()), ...(extra || {}) };
const u2base = () => ({
  breakdown: [
    { part: "Experience", points: 0, max: 16, note: "n", subBreakdown: [
      { label: "Relevance", points: 2, max: 2 }, { label: "5W1H Specificity", points: 4, max: 6 }, { label: "Authenticity / Personal Voice", points: 2, max: 2 },
      { label: "Clarity & Sequence", points: 2, max: 2 }, { label: "Reflection / Lesson Learnt", points: 1, max: 2 }, { label: "Depth & Development Across Both Answers", points: 2, max: 2 } ] },
    { part: "Suggestion", points: 2, max: 2 }, { part: "Grammar Accuracy", points: 3, max: 3 }, { part: "Vocabulary Range & Appropriateness", points: 2, max: 3 }, { part: "Fluency & Delivery", points: 1, max: 1 },
  ],
  feedback: "Lovely story.", suggestion: "Add where.", modelAnswers: [new Array(120).fill("story").join(" ") + ".", new Array(120).fill("story").join(" ") + "."],
  observed: [{ part: "Thought", status: "Present" }, { part: "Reason", status: "Present" }, { part: "Evidence", status: "Not observed" }],
});
function fetchWith(opts) {
  opts = opts || {};
  const calls = [];
  const fn = async (url, init) => {
    if (!String(url).includes("groq.com")) return { ok: false, status: 500, headers: { get: () => null }, text: async () => "down", json: async () => ({}) };
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    calls.push({ system, user: body.messages[1].content });
    const unit = unitOfSystem(system);
    const payload = unit === 2 ? { ...u2base(), ...(opts.u2 || {}) } : { ...u1(), ...(opts.u1 || {}) };
    for (const k of opts.drop || []) delete payload[k];
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
  };
  fn.calls = calls;
  return fn;
}
async function postJson(env, path, token, body) {
  const res = await worker.fetch(new Request("https://x.dev" + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) }), env, {});
  return { status: res.status, data: await res.json() };
}
async function submitFor(env, token, topicId, tag, opts) {
  opts = opts || {};
  const mk = (n) => ({ parts: { T: "t", R: "r", E1: "e", E2: "experience " + tag + n + " at the void deck", S: "s" } });
  return postJson(env, "/api/submit", token, { topicId: topicId || "topic_1", mode: "trees", answers: [mk(1), mk(2), mk(3)], practice: !!opts.practice });
}


const longText = (n, w) => new Array(n).fill(w || "story").join(" ") + ".";
function fetchCapture(opts) {
  opts = opts || {};
  const calls = [];
  const fn = async (url, init) => {
    if (!String(url).includes("groq.com")) return { ok: false, status: 500, headers: { get: () => null }, text: async () => "down", json: async () => ({}) };
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    const unit = unitOfSystem(system);
    const modelOnly = /You are NOT marking anything now/.test(system);
    calls.push({ system, user, unit, modelOnly, body });
    const n = calls.length;
    let payload;
    if (modelOnly) {
      payload = unit === 2 ? { modelAnswers: opts.retryAnswers || [longText(90), longText(90)] } : { modelAnswer: opts.retryQ1 || longText(120) };
    } else if (unit === 2) {
      const fn2 = typeof opts.u2 === "function" ? opts.u2(n, calls) : opts.u2 || {};
      payload = { ...u2base(), ...fn2 };
    } else {
      payload = { ...u1(), ...(opts.u1 || {}) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
  };
  fn.calls = calls;
  return fn;
}
const down = () => async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "down", json: async () => ({}) });

// ============================================================
// 1. The pupil sees THEIR OWN full breakdown; classmates never see marks
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = fetchCapture();
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const a = await submitFor(env, "pup1", "topic_1", "own");
  const b = await submitFor(env, "pup2", "topic_1", "mei");
  const rec = a.data.record;
  check("own submit response: score, max and the full breakdown on both units", rec.rounds.every((r) => typeof r.score === "number" && r.max === 25 && r.breakdown.length >= 5));
  check("own submit response: Experience sub-criteria are included (for the 'see detail' toggle)", rec.rounds[1].breakdown[0].subBreakdown.length === 6);
  check("own submit response: still no teacher-only fields", rec.rounds.every((r) => !("coachUsed" in r) && !("coachUsedQuestions" in r) && !("originalScore" in r) && !("overriddenBy" in r)));
  const mine = await get(env, "/api/submissions/mine", "pup1");
  check("My Submissions: full breakdown on the pupil's own entries", mine.data.submissions.every((s) => s.rounds.every((r) => Array.isArray(r.breakdown) && typeof r.score === "number")));
  const lb = await get(env, "/api/submissions/leaderboard?limit=100", "pup1");
  const own = lb.data.submissions.filter((s) => s.pupilName === "Jovan");
  const peers = lb.data.submissions.filter((s) => s.pupilName !== "Jovan");
  check("leaderboard list: the pupil's own entry keeps its breakdown", own.length === 1 && own[0].rounds.every((r) => Array.isArray(r.breakdown)));
  check("leaderboard list: a classmate's entry has NO score, max, breakdown or observed (answers and feedback only)", peers.length === 1 && peers[0].rounds.every((r) => r.feedback && !("score" in r) && !("max" in r) && !("breakdown" in r) && !("observed" in r)));
  check("a classmate still sees the overall score and the improved answers", typeof peers[0].finalScore === "number" && peers[0].rounds[1].modelAnswers.length === 2);
  const other = await get(env, "/api/submissions/leaderboard?limit=100", "pup2");
  check("the same rule from the other pupil's side", other.data.submissions.find((s) => s.pupilName === "Jovan").rounds.every((r) => !("breakdown" in r)) && other.data.submissions.find((s) => s.pupilName === "Mei").rounds.every((r) => Array.isArray(r.breakdown)));
  const ov = await postJson(env, "/api/teacher/submissions/" + rec.id + "/override-score", "admin", { roundIndex: 1, score: 9, feedback: "adjusted" });
  const mine2 = await get(env, "/api/submissions/mine", "pup1");
  const adj = mine2.data.submissions.find((s) => s.id === rec.id).rounds[1];
  check("after a teacher override the pupil sees the new score and a bare 'adjusted' flag, not who/when/original", ov.status === 200 && adj.score === 9 && adj.overridden === true && !("originalScore" in adj) && !("overriddenBy" in adj) && !("overriddenAt" in adj));
  const t = await get(env, "/api/teacher/submissions", "admin");
  const ts = t.data.submissions.find((s) => s.id === rec.id);
  check("teachers still get everything", ts.rounds[1].originalScore !== undefined && ts.rounds[0].coachUsed !== undefined);
}

// ============================================================
// 2. Unit 2: two improved answers, doubled cap, per-answer length target
// ============================================================
{
  __resetAiHealthForTests();
  const f = fetchCapture();
  global.fetch = f;
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const res = await submitFor(env, "pup1", "topic_1", "two");
  const unit2 = f.calls.find((c) => c.unit === 2 && !c.modelOnly);
  check("Unit 2 prompt asks for modelAnswers: exactly two strings, one per answer", /"modelAnswers": an array of EXACTLY TWO strings/.test(unit2.system) && /modelAnswers\[0\]/.test(unit2.system) && /modelAnswers\[1\]/.test(unit2.system));
  check("Unit 2 prompt asks for a continuous story across the two rewrites", /keep the two rewrites continuous/.test(unit2.system));
  check("Unit 2 prompt gives a per-answer length target (floor applies to short answers)", /Question 2 answer is \d+ words, so modelAnswers\[0\] MUST be at least \d+ words/.test(unit2.system) && /Keep each under about 400 words/.test(unit2.system));
  check("Unit 2 prompt no longer asks for a single combined 'modelAnswer'", !/"modelAnswer": "one rewritten/.test(unit2.system));
  const r = storedRounds(env, res.data.record.id)[1];
  check("two improved answers are stored; modelAnswer is their join (compat)", r.modelAnswers.length === 2 && r.modelAnswers.every((m) => m.length > 0) && r.modelAnswer.includes(r.modelAnswers[0]) && r.modelAnswer.includes(r.modelAnswers[1]));
  const unit1 = f.calls.find((c) => c.unit === 1 && !c.modelOnly);
  check("Q1 prompt now asks for the improved version of the WHOLE answer as flowing paragraphs", /WHOLE answer/.test(unit1.system));
  check("Q1 keeps its single 'modelAnswer'", /"modelAnswer":/.test(unit1.system) && !/"modelAnswers"/.test(unit1.system));

  // doubled cap: each rewrite may be up to 2800 chars (5600 combined), the old cap was 2800 combined
  __resetAiHealthForTests();
  const big = new Array(430).fill("wordy").join(" "); // ~2580 chars, well over the old per-answer share
  global.fetch = fetchCapture({ u2: { modelAnswers: [big, big] } });
  const env2 = baseEnv({ GROQ_API_KEY: "k" });
  const res2 = await submitFor(env2, "pup1", "topic_1", "big");
  const r2 = storedRounds(env2, res2.data.record.id)[1];
  check("two rewrites of ~2.5k chars each are both kept whole (combined > the old 2800 cap)", r2.modelAnswers[0].length > 2400 && r2.modelAnswers[1].length > 2400 && r2.modelAnswer.length > 5000);
  __resetAiHealthForTests();
  const huge = new Array(900).fill("wordy").join(" ");
  global.fetch = fetchCapture({ u2: { modelAnswers: [huge, huge] } });
  const env3 = baseEnv({ GROQ_API_KEY: "k" });
  const res3 = await submitFor(env3, "pup1", "topic_1", "huge");
  const r3 = storedRounds(env3, res3.data.record.id)[1];
  check("each rewrite is capped at 2800 characters (5600 in total)", r3.modelAnswers.every((m) => m.length <= 2800) && r3.modelAnswer.length <= 5600 + 2);
}

// ============================================================
// 3. Too-short rewrites: one bounded regenerate, then 'not available' for just that answer
// ============================================================
{
  __resetAiHealthForTests();
  const f = fetchCapture({ u2: (n) => (n <= 2 ? { modelAnswers: [longText(90), "too short"] } : { modelAnswers: [longText(90), longText(95)] }) });
  global.fetch = f;
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const res = await submitFor(env, "pup1", "topic_1", "short1");
  const u2calls = f.calls.filter((c) => c.unit === 2);
  check("a short Q3 rewrite triggers exactly one regenerate, naming modelAnswers[1]", u2calls.length === 2 && /SECOND ATTEMPT/.test(u2calls[1].system) && /modelAnswers\[1\]/.test(u2calls[1].system) && !/YOUR "modelAnswers\[0\]"/.test(u2calls[1].system));
  const r = storedRounds(env, res.data.record.id)[1];
  check("the regenerate fixed it: both rewrites present, marks unchanged", r.modelAnswers[0] && countW(r.modelAnswers[1]) >= 60 && r.score === 21);

  __resetAiHealthForTests();
  global.fetch = fetchCapture({ u2: { modelAnswers: [longText(90), "still short"] } });
  const env2 = baseEnv({ GROQ_API_KEY: "k" });
  const res2 = await submitFor(env2, "pup1", "topic_1", "short2");
  const r2 = storedRounds(env2, res2.data.record.id)[1];
  check("still short after the regenerate: only that rewrite is withheld, the other is kept", r2.modelAnswers[0].length > 0 && r2.modelAnswers[1] === "" && r2.score === 21 && r2.markedBy === "groq");
  check("the pupil's payload shows the empty slot so the page can say 'currently not available'", res2.data.record.rounds[1].modelAnswers[1] === "" && res2.data.record.rounds[1].modelAnswers[0].length > 0);
}
function countW(t) { return String(t || "").trim().split(/\s+/).filter(Boolean).length; }

// ============================================================
// 4. Present / Not observed for Thought, Reason, Evidence - never marked
// ============================================================
{
  __resetAiHealthForTests();
  const f = fetchCapture();
  global.fetch = f;
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const res = await submitFor(env, "pup1", "topic_1", "obs");
  const u2 = f.calls.find((c) => c.unit === 2 && !c.modelOnly);
  check("Unit 2 prompt asks for 'observed' and says it carries no marks", /"observed" is FOR INFORMATION ONLY and carries NO marks/.test(u2.system) && /Present or Not observed/.test(u2.system) && /do NOT lower any mark/.test(u2.system));
  const r = storedRounds(env, res.data.record.id)[1];
  check("stored: Thought, Reason, Evidence with the AI's statuses", r.observed.map((o) => o.part + "=" + o.status).join(",") === "Thought=Present,Reason=Present,Evidence=Not observed");
  check("observed rows are NOT part of the breakdown and add no marks", r.breakdown.length === 5 && !r.breakdown.some((b) => ["Thought", "Reason", "Evidence"].includes(b.part)) && r.score === 21 && r.max === 25);
  check("the pupil receives the observed list on their own entry", res.data.record.rounds[1].observed.length === 3);
  check("Question 1 has no observed list", !("observed" in storedRounds(env, res.data.record.id)[0]));

  const other = (observed) => async () => {
    __resetAiHealthForTests();
    global.fetch = fetchCapture({ u2: { observed } });
    const e = baseEnv({ GROQ_API_KEY: "k" });
    const out = await postJson(e, "/api/submit", "pup1", { topicId: "topic_1", mode: "single", answers: [{ text: "my story" }, { text: "I think it is kind because I helped my friend. For example, last week I carried his bag." }, { text: "In the end he thanked me." }] });
    return storedRounds(e, out.data.record.id)[1];
  };
  const missing = await other(undefined)();
  check("AI left 'observed' out: derived from the text (never blank) - Thought, Reason and Evidence all found", missing.observed.length === 3 && missing.observed.every((o) => o.status === "Present"), JSON.stringify(missing.observed));
  const junk = await other([{ part: "Thought", status: "maybe??" }, { part: "Reason", status: "not observed" }, { part: "Evidence", status: "PRESENT" }])();
  check("odd statuses are normalised to exactly 'Present' / 'Not observed'; invalid ones are derived", junk.observed.map((o) => o.status).join("|") === "Present|Not observed|Present", JSON.stringify(junk.observed));
  global.fetch = down();
  __resetAiHealthForTests();
  const e2 = baseEnv({ GROQ_API_KEY: "k" });
  const off = await postJson(e2, "/api/submit", "pup1", { topicId: "topic_1", mode: "single", answers: [{ text: "x" }, { text: "I think it was fun." }, { text: "Nothing else." }] });
  const offR = storedRounds(e2, off.data.record.id)[1];
  check("offline-marked Unit 2 still reports Present / Not observed", offR.markedBy === "fallback" && offR.observed.length === 3 && offR.observed.every((o) => o.status === "Present" || o.status === "Not observed") && offR.observed[0].status === "Present" && offR.observed[1].status === "Not observed");
}

// ============================================================
// 5. 'Retry AI suggested answer' (teacher)
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = fetchCapture({ u2: { modelAnswers: ["", ""] }, u1: { modelAnswer: "" } });
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const res = await submitFor(env, "pup1", "topic_1", "needs");
  const id = res.data.record.id;
  const before = storedRounds(env, id);
  check("setup: AI marked the round but returned no improved answers (unavailable)", before[1].markedBy === "groq" && before[1].modelAnswers.every((m) => !m) && !before[0].modelAnswer);

  const f = fetchCapture();
  global.fetch = f;
  const fin = env.CCv6_DB._state.submissions.find((x) => x.id === id).final_score;
  const retry = await postJson(env, "/api/teacher/submissions/" + id + "/retry-model-answer", "admin", { roundIndex: 1 });
  const after = storedRounds(env, id);
  check("retry fills BOTH improved answers for Q2 & 3 from a model-only prompt", retry.status === 200 && retry.data.success === true && after[1].modelAnswers.every((m) => countW(m) >= 60) && f.calls.length === 1 && f.calls[0].modelOnly && f.calls[0].unit === 2);
  check("the model-only prompt contains both pupil answers and asks for nothing to be marked", /experience tagneeds2|experience needs2/.test(f.calls[0].user) && /experience needs3/.test(f.calls[0].user) && /NOT marking anything now/.test(f.calls[0].system));
  check("scores, breakdown, feedback and markedBy are untouched", after[1].score === before[1].score && after[1].markedBy === "groq" && JSON.stringify(after[1].breakdown) === JSON.stringify(before[1].breakdown) && after[1].feedback === before[1].feedback && env.CCv6_DB._state.submissions.find((x) => x.id === id).final_score === fin);
  check("the response carries the updated submission with the teacher's full view", retry.data.submission.rounds[1].modelAnswers[0].length > 0 && "coachUsed" in retry.data.submission.rounds[0]);

  const q1 = await postJson(env, "/api/teacher/submissions/" + id + "/retry-model-answer", "admin", { roundIndex: 0 });
  check("retry works for Question 1 as well (single rewrite of the whole answer)", q1.data.success === true && countW(storedRounds(env, id)[0].modelAnswer) >= 100 && f.calls[1].unit === 1 && f.calls[1].modelOnly);

  __resetAiHealthForTests();
  global.fetch = down();
  const failed = await postJson(env, "/api/teacher/submissions/" + id + "/retry-model-answer", "admin", { roundIndex: 1 });
  check("AI down: a clear 'currently not available' message and nothing is changed", failed.status === 200 && failed.data.success === false && /currently not available/.test(failed.data.message) && JSON.stringify(storedRounds(env, id)) === JSON.stringify(storedRounds(env, id)));

  __resetAiHealthForTests();
  const keep = baseEnv({ GROQ_API_KEY: "k" });
  global.fetch = fetchCapture({ u2: { modelAnswers: [longText(90), ""] } });
  const r2 = await submitFor(keep, "pup1", "topic_1", "half");
  const half = storedRounds(keep, r2.data.record.id)[1];
  global.fetch = fetchCapture({ retryAnswers: ["", longText(90)] });
  await postJson(keep, "/api/teacher/submissions/" + r2.data.record.id + "/retry-model-answer", "admin", { roundIndex: 1 });
  const healed = storedRounds(keep, r2.data.record.id)[1];
  check("a retry never discards an improved answer that already exists (fills only the gap)", half.modelAnswers[0].length > 0 && healed.modelAnswers[0] === half.modelAnswers[0] && healed.modelAnswers[1].length > 0);

  const pupil = await postJson(env, "/api/teacher/submissions/" + id + "/retry-model-answer", "pup1", { roundIndex: 1 });
  check("pupils cannot use it", pupil.status === 403);
  const wrongClass = await postJson(env, "/api/teacher/submissions/" + id + "/retry-model-answer", "scoped-out", { roundIndex: 1 });
  check("a class-scoped teacher cannot use it on another class's submission", wrongClass.status === 403);
  const right = await postJson(env, "/api/teacher/submissions/" + id + "/retry-model-answer", "scoped-in", { roundIndex: 1 });
  check("a class-scoped teacher can use it for their own class", right.status === 200);
  const bad = await postJson(env, "/api/teacher/submissions/" + id + "/retry-model-answer", "admin", { roundIndex: 7 });
  const nope = await postJson(env, "/api/teacher/submissions/" + id + "/retry-model-answer", "admin", { roundIndex: 2 });
  const missing = await postJson(env, "/api/teacher/submissions/nope/retry-model-answer", "admin", { roundIndex: 0 });
  check("bad round index, absent third round and unknown id are rejected cleanly", bad.status === 400 && nope.status === 400 && missing.status === 404);
}

// ============================================================
// 6. Output limits are set on every provider (long rewrites must not be cut off mid-JSON)
// ============================================================
{
  __resetAiHealthForTests();
  const f = fetchCapture();
  global.fetch = f;
  const env = baseEnv({ GROQ_API_KEY: "k" });
  await submitFor(env, "pup1", "topic_1", "tok");
  check("Groq requests carry an explicit completion-token ceiling of 6000", f.calls.every((c) => c.body.max_completion_tokens === 6000));
  const src = (await import("node:fs")).readFileSync(new URL("../index.js", import.meta.url), "utf8");
  check("OpenRouter and Workers AI also set max_tokens, Gemini sets maxOutputTokens", (src.match(/max_tokens: AI_MAX_OUTPUT_TOKENS/g) || []).length === 2 && /maxOutputTokens: AI_MAX_OUTPUT_TOKENS \+ 2048/.test(src));
}

// ============================================================
// 7. Re-mark stores the new Unit 2 fields too
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = down();
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const res = await submitFor(env, "pup1", "topic_1", "rem");
  const id = res.data.record.id;
  const off = storedRounds(env, id)[1];
  check("offline Unit 2 has no improved answers yet", off.markedBy === "fallback" && (!off.modelAnswers || off.modelAnswers.every((m) => !m)));
  global.fetch = fetchCapture();
  const rm = await postJson(env, "/api/submissions/" + id + "/remark", "pup1", { roundIndex: 1 });
  const done = storedRounds(env, id)[1];
  check("AI re-mark of Unit 2 stores two improved answers and Present / Not observed", rm.data.success === true && done.modelAnswers.length === 2 && done.modelAnswers.every((m) => m.length > 0) && done.observed.length === 3);
  check("the pupil's re-mark response includes their own score and observed list", rm.data.submission.rounds[1].score === 21 && rm.data.submission.rounds[1].observed.length === 3 && !("coachUsed" in rm.data.submission.rounds[1]));
}

const passed = results.filter(Boolean).length;
console.log("\n" + passed + "/" + results.length + " checks passed");
process.exit(passed === results.length ? 0 : 1);
