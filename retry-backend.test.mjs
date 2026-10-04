// Exercises the real /api/submit handler and retry-policy endpoints against
// an in-memory stand-in for D1 + KV, so the retry rules (one per attempt,
// same session, own attempt, same topic, class toggle) are tested as the
// Worker actually runs them.
import worker from "../index.js";

const results = [];
function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  -> " + extra));
}

// ---- tiny D1 stand-in: enough SQL for the paths the submit handler takes ----
function makeDb() {
  const submissions = [];
  const pupils = [];
  const history = [];
  const config = new Map();
  const topics = [{ id: "topic_1", title: "Helping Others", image_url: "", image_description: "", questions: JSON.stringify(["Q1?", "Q2?", "Q3?"]), tags: "[]", coach: "[]", created_at: 1 }];

  const run = (sql, params) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^SELECT \* FROM topics/.test(s)) return { first: topics.find((t) => t.id === params[0]) || null };
    if (/^SELECT value FROM config/.test(s)) return { first: config.has(params[0]) ? { value: config.get(params[0]) } : null };
    if (/^INSERT INTO config/.test(s)) { config.set(params[0], params[1]); return { ok: true }; }
    if (/FROM submissions WHERE id = \?/.test(s)) return { first: submissions.find((x) => x.id === params[0]) || null };
    if (/FROM submissions WHERE retry_of = \?/.test(s)) return { first: submissions.find((x) => x.retry_of === params[0]) || null };
    if (/^INSERT INTO submissions/.test(s)) {
      const cols = s.match(/\(([^)]+)\)\s+VALUES/)[1].split(",").map((c) => c.trim());
      const row = {};
      let pi = 0;
      const values = s.match(/VALUES \(([^)]+)\)/)[1].split(",").map((v) => v.trim());
      values.forEach((v, idx) => { row[cols[idx]] = v === "?" ? params[pi++] : (v === "0" ? 0 : v); });
      if (row.retry_of && submissions.some((x) => x.retry_of === row.retry_of)) throw new Error("UNIQUE constraint failed: submissions.retry_of");
      submissions.push(row);
      return { ok: true };
    }
    if (/^INSERT INTO pupils/.test(s)) {
      const [name, pupilClass, , , score] = params;
      let p = pupils.find((x) => x.name === name && x.pupil_class === pupilClass);
      if (!p) { p = { id: pupils.length + 1, name, pupil_class: pupilClass, best_score: params[2], total_score: params[3], attempts: 1 }; pupils.push(p); }
      else { p.attempts += 1; p.total_score += params[4]; p.best_score = Math.max(p.best_score, params[5]); }
      return { first: { id: p.id } };
    }
    if (/^INSERT INTO pupil_history/.test(s)) { history.push(params); return { ok: true }; }
    if (/DISTINCT pupil_class FROM pupils/.test(s)) return { all: [...new Set(pupils.map((p) => p.pupil_class))].map((c) => ({ pupil_class: c })) };
    if (/^SELECT COUNT/.test(s)) return { first: { c: 0 } };
    return { first: null, all: [] };
  };

  return {
    _state: { submissions, pupils, config },
    prepare(sql) {
      const stmt = {
        bind(...params) { this._p = params; return this; },
        async first() { const r = run(sql, this._p || []); return r.first !== undefined ? r.first : null; },
        async all() { const r = run(sql, this._p || []); return { results: r.all || [] }; },
        async run() { return run(sql, this._p || []); },
      };
      return stmt;
    },
  };
}

const sessions = new Map();
function makeEnv(db) {
  return {
    CCv6_DB: db,
    CCv6_DATA: {
      async get(k) { return sessions.get(k) || null; },
      async put(k, v) { sessions.set(k, v); },
      async delete(k) { sessions.delete(k); },
    },
    // A fake Workers AI binding stands in for the whole provider chain, so
    // marking "succeeds" and attempts count on the leaderboard the way they
    // would in production. The rewrite it returns is deliberately long enough
    // to pass the model-answer length check, so no regenerate call fires.
    AI: {
      async run() {
        return {
          response: JSON.stringify({
            breakdown: [
              { part: "Thought", points: 2, max: 2, note: "ok" },
              { part: "Reason", points: 2, max: 2, note: "ok" },
              { part: "Evidence", points: 1, max: 2, note: "ok" },
              { part: "Experience", points: 8, max: 12, note: "ok", subBreakdown: [
                { label: "Relevance", points: 2, max: 2 },
                { label: "5W1H Specificity", points: 3, max: 6 },
                { label: "Authenticity / Personal Voice", points: 2, max: 2 },
                { label: "Clarity & Sequence", points: 1, max: 1 },
                { label: "Reflection / Lesson Learnt", points: 0, max: 1 },
              ] },
              { part: "Suggestion", points: 2, max: 2, note: "ok" },
              { part: "Grammar Accuracy", points: 2, max: 2, note: "ok" },
              { part: "Vocabulary Range & Appropriateness", points: 1, max: 2, note: "ok" },
              { part: "Fluency & Delivery", points: 1, max: 1, note: "ok" },
            ],
            feedback: "Good effort.",
            suggestion: "Add more detail.",
            modelAnswer: new Array(90).fill("word").join(" ") + ".",
          }),
        };
      },
    },
  };
}

const db = makeDb();
const env = makeEnv(db);

const PUPIL_SESSION_START = Date.now() - 60000;
sessions.set("session:tok_jovan", JSON.stringify({ name: "Jovan", pupilClass: "5ig", role: "pupil", createdAt: PUPIL_SESSION_START }));
sessions.set("session:tok_mei", JSON.stringify({ name: "Mei", pupilClass: "5ig", role: "pupil", createdAt: PUPIL_SESSION_START }));
sessions.set("session:tok_admin", JSON.stringify({ name: "palpatine", role: "teacher", isSuperAdmin: true, createdAt: PUPIL_SESSION_START }));
sessions.set("session:tok_scoped", JSON.stringify({ name: "mrslim", role: "teacher", isSuperAdmin: false, assignedClasses: ["5ig"], createdAt: PUPIL_SESSION_START }));

const answers = () => [0, 1, 2].map((i) => ({ parts: { T: "I think x" + i, R: "because y", E1: "in the picture", E2: "Last year at school my friend and I helped a boy who fell down near the canteen and we told our teacher", S: "I suggest we help" } }));

async function call(path, method, body, token) {
  const req = new Request("https://x.dev" + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });
  const res = await worker.fetch(req, env, {});
  return { status: res.status, data: await res.json() };
}

const submit = (body, token = "tok_jovan") => call("/api/submit", "POST", { topicId: "topic_1", mode: "trees", answers: answers(), ...body }, token);

// ---- 1. first attempt ----
const first = await submit({});
check("first attempt accepted", first.status === 200, JSON.stringify(first.data).slice(0, 120));
check("retryEnabled defaults to on", first.data.retryEnabled === true);
check("canRetry true on a first attempt", first.data.canRetry === true);
check("retryOf null on a first attempt", first.data.record.retryOf === null);
const firstId = first.data.record.id;

// ---- 2. the retry itself ----
const retry = await submit({ retryOf: firstId });
check("retry accepted", retry.status === 200, JSON.stringify(retry.data).slice(0, 120));
check("retry linked to the original", retry.data.record.retryOf === firstId);
check("canRetry false on a retry (no third try)", retry.data.canRetry === false);
check("retry stored as its own row", db._state.submissions.length === 2);
check("retry counted as a fresh leaderboard attempt", db._state.pupils[0].attempts === 2, JSON.stringify(db._state.pupils[0]));

// ---- 3. one retry per attempt ----
const third = await submit({ retryOf: firstId });
check("second retry of the same attempt rejected", third.status === 400 && /already had your second try/.test(third.data.error), JSON.stringify(third.data));
const retryOfRetry = await submit({ retryOf: retry.data.record.id });
check("retry of a retry rejected", retryOfRetry.status === 400 && /already had your second try/.test(retryOfRetry.data.error), JSON.stringify(retryOfRetry.data));

// ---- 4. ownership + topic + session ----
const notMine = await submit({ retryOf: firstId }, "tok_mei");
check("cannot retry someone else's attempt", notMine.status === 403, JSON.stringify(notMine.data));
const missing = await submit({ retryOf: "nope" });
check("unknown original rejected", missing.status === 400 && /could not be found/.test(missing.data.error));

const second = await submit({});
const secondId = second.data.record.id;
const wrongTopic = await call("/api/submit", "POST", { topicId: "topic_1", mode: "trees", answers: answers(), retryOf: secondId }, "tok_jovan");
check("same-topic retry still fine", wrongTopic.status === 200);

// simulate a NEW session: the original now predates the session start
const older = await submit({});
const olderId = older.data.record.id;
db._state.submissions.find((s) => s.id === olderId).created_at = PUPIL_SESSION_START - 1000;
const staleSession = await submit({ retryOf: olderId });
check("retry from a later session rejected", staleSession.status === 400 && /same session/.test(staleSession.data.error), JSON.stringify(staleSession.data));

// ---- 5. teacher toggle ----
let policy = await call("/api/teacher/retry-policy", "GET", null, "tok_admin");
check("policy readable by super admin", policy.status === 200 && policy.data.global === true && policy.data.canEditGlobal === true);
check("policy lists the class that has pupils", policy.data.classes.some((c) => c.pupilClass === "5ig"));

await call("/api/teacher/retry-policy", "POST", { global: false }, "tok_admin");
const a4 = await submit({});
check("Try Again hidden once switched off globally", a4.data.retryEnabled === false && a4.data.canRetry === false);
const blocked = await submit({ retryOf: a4.data.record.id });
check("retry rejected server-side when switched off", blocked.status === 400 && /isn't switched on/.test(blocked.data.error), JSON.stringify(blocked.data));

// per-class override turns it back on for 5ig only
await call("/api/teacher/retry-policy", "POST", { pupilClass: "5ig", override: true }, "tok_scoped");
const a5 = await submit({});
check("class override beats a global off", a5.data.retryEnabled === true && a5.data.canRetry === true);
const okAgain = await submit({ retryOf: a5.data.record.id });
check("retry accepted again under the class override", okAgain.status === 200);

// clearing the override drops back to the global default
await call("/api/teacher/retry-policy", "POST", { pupilClass: "5ig", override: null }, "tok_admin");
const a6 = await submit({});
check("cleared override follows the global default again", a6.data.retryEnabled === false);

// ---- 6. permissions ----
const scopedGlobal = await call("/api/teacher/retry-policy", "POST", { global: true }, "tok_scoped");
check("scoped admin cannot change the global default", scopedGlobal.status === 403, JSON.stringify(scopedGlobal.data));
const scopedOther = await call("/api/teacher/retry-policy", "POST", { pupilClass: "5ha", override: true }, "tok_scoped");
check("scoped admin cannot override a class that isn't theirs", scopedOther.status === 403, JSON.stringify(scopedOther.data));
const pupilPolicy = await call("/api/teacher/retry-policy", "GET", null, "tok_jovan");
check("pupils cannot read the policy", pupilPolicy.status === 403);
const scopedRead = await call("/api/teacher/retry-policy", "GET", null, "tok_scoped");
check("scoped admin sees global read-only", scopedRead.status === 200 && scopedRead.data.canEditGlobal === false);

// ---- 7. practice inheritance ----
await call("/api/teacher/retry-policy", "POST", { global: true }, "tok_admin");
const prac = await submit({ practice: true });
check("practice attempt still offers a retry", prac.data.canRetry === true);
const attemptsBefore = db._state.pupils[0].attempts;
const pracRetry = await submit({ retryOf: prac.data.record.id, practice: true });
check("practice retry accepted", pracRetry.status === 200);
check("practice retry stays off the leaderboard", db._state.pupils[0].attempts === attemptsBefore, String(db._state.pupils[0].attempts));

// ---- 8. the UNIQUE-index race (two resubmits at once) ----
// Force the pre-check to miss so the insert is the thing that catches it,
// which is exactly what happens when two requests interleave.
const realPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  if (/FROM submissions WHERE retry_of = \?/.test(sql.replace(/\s+/g, " "))) {
    return { bind() { return this; }, async first() { return null; }, async all() { return { results: [] }; }, async run() { return {}; } };
  }
  return realPrepare(sql);
};
const raceBase = await submit({});
await submit({ retryOf: raceBase.data.record.id });
const raced = await submit({ retryOf: raceBase.data.record.id });
check("UNIQUE race reported as a clean 400, not a 500", raced.status === 400 && /already had your second try/.test(raced.data.error), raced.status + " " + JSON.stringify(raced.data));
db.prepare = realPrepare;

const failed = results.filter((r) => !r).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed");
process.exit(failed ? 1 : 0);
