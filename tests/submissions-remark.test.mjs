// Exercises the two newest features end to end through the real Worker
// handlers: GET /api/submissions/leaderboard, GET /api/submissions/mine,
// and POST /api/submissions/:id/remark - including the "only join the
// leaderboard once every question is AI-marked" transition.
import worker, { __resetAiHealthForTests } from "../index.js";

const results = [];
function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  -> " + extra));
}

// ---- in-memory D1 stand-in ----
// Not a real SQL engine - recognizes the small, fixed set of query shapes
// index.js actually issues (grepped directly from the source) and applies
// the equivalent filter/sort/paginate in JS. Good enough to exercise the
// real route handlers end to end without a real database.
function makeDb(initialConfig) {
  const config = new Map(Object.entries(initialConfig || {}));
  const topics = [{ id: "topic_1", title: "Helping Others", image_url: "", image_description: "d", questions: JSON.stringify(["Q1?", "Q2?", "Q3?"]), tags: "[]", coach: "[]", created_at: 1 }];
  const submissions = [];
  const pupils = [];
  const history = [];

  function matchesPublicLeaderboardFilter(row, params) {
    if (row.leaderboard_counted !== 1 || row.archived === 1) return false;
    let pi = 0;
    if (params.classParam) return String(row.pupil_class).toLowerCase() === String(params.classParam).toLowerCase();
    return true;
  }

  function run(sql, params) {
    const s = sql.replace(/\s+/g, " ").trim();

    if (/^SELECT \* FROM topics WHERE id = \?/.test(s)) return { first: topics.find((t) => t.id === params[0]) || null };
    if (/^SELECT value FROM config WHERE key = \?/.test(s)) return { first: config.has(params[0]) ? { value: config.get(params[0]) } : null };
    if (/^INSERT INTO config/.test(s)) { config.set(params[0], params[1]); return {}; }

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
    if (/^UPDATE submissions SET leaderboard_counted = 1 WHERE id = \?/.test(s)) {
      const row = submissions.find((x) => x.id === params[0]);
      if (row) row.leaderboard_counted = 1;
      return {};
    }

    // GET /api/submissions/leaderboard - COUNT and SELECT variants share the
    // same WHERE clause text (leaderboard_counted = 1 AND archived = 0
    // [+ optional class/topic]).
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
      rows = rows.slice().sort((a, b) => b.created_at - a.created_at); // default newest
      if (/^SELECT COUNT/.test(s)) return { first: { c: rows.length } };
      if (/LIMIT \? OFFSET \?/.test(s)) {
        const limit = params[pi++], offset = params[pi++];
        return { all: rows.slice(offset, offset + limit) };
      }
      return { all: rows };
    }

    // GET /api/submissions/mine
    if (/LOWER\(pupil_name\) = LOWER\(\?\) AND LOWER\(pupil_class\) = LOWER\(\?\)/.test(s)) {
      const [name, cls] = params;
      let rows = submissions.filter((r) => String(r.pupil_name).toLowerCase() === name.toLowerCase() && String(r.pupil_class).toLowerCase() === cls.toLowerCase());
      rows = rows.slice().sort((a, b) => b.created_at - a.created_at);
      if (/^SELECT COUNT/.test(s)) return { first: { c: rows.length } };
      const limit = params[2], offset = params[3];
      return { all: rows.slice(offset, offset + limit) };
    }

    // The original /api/submit path's increment-style upsert (always has
    // ON CONFLICT) - distinct from getOrCreatePupilId's plain INSERT below,
    // which has no ON CONFLICT clause at all (it only runs after a SELECT
    // already found nothing).
    if (/^INSERT INTO pupils.*ON CONFLICT/.test(s)) {
      const [name, pupilClass, bestScore, totalScore] = params;
      let p = pupils.find((x) => x.name === name && x.pupil_class === pupilClass);
      if (!p) { p = { id: pupils.length + 1, name, pupil_class: pupilClass, best_score: bestScore || 0, total_score: totalScore || 0, attempts: 1 }; pupils.push(p); }
      else { p.attempts += 1; p.total_score += params[3]; p.best_score = Math.max(p.best_score, params[4]); }
      return { first: { id: p.id } };
    }
    // getOrCreatePupilId's own two-query shape (SELECT id, then a plain
    // INSERT with no ON CONFLICT if nothing was found).
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
    // recomputePupilAggregate: derive attempts/total/best straight from the
    // submissions table, then write them onto the pupils row.
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
    _state: { submissions, pupils, history },
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

function login(token, session) {
  sessions.set("session:" + token, JSON.stringify(session));
}

async function call(path, method, body, token) {
  const req = new Request("https://x.dev" + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });
  return { req };
}

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

async function remark(env, id, roundIndex, token) {
  const req = new Request("https://x.dev/api/submissions/" + id + "/remark", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ roundIndex }),
  });
  const res = await worker.fetch(req, env, {});
  return { status: res.status, data: await res.json() };
}

function fakeFetchAllFail() {
  return async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "down", json: async () => ({}) });
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

login("pup1", { name: "Jovan", pupilClass: "5ig", role: "pupil", createdAt: Date.now() - 1000 });
login("pup2", { name: "Mei", pupilClass: "5ig", role: "pupil", createdAt: Date.now() - 1000 });
login("admin", { name: "palpatine", role: "teacher", isSuperAdmin: true, createdAt: Date.now() - 1000 });
login("scoped-in", { name: "mrslim", role: "teacher", isSuperAdmin: false, assignedClasses: ["5ig"], createdAt: Date.now() - 1000 });
login("scoped-out", { name: "mrslam", role: "teacher", isSuperAdmin: false, assignedClasses: ["6ha"], createdAt: Date.now() - 1000 });

// ============================================================
// Feature 2: AI re-mark
// ============================================================
let sharedEnv, subId;
{
  __resetAiHealthForTests();
  global.fetch = fakeFetchAllFail(); // every provider down -> both marking units fall back
  sharedEnv = baseEnv({ GROQ_API_KEY: "q1" });
  const res = await submit(sharedEnv, "pup1");
  check("submission with AI fully down is still created (offline fallback)", res.status === 200, JSON.stringify(res.data).slice(0, 150));
  check("it's marked grading-degraded", res.data.record.gradingDegraded === true);
  check("it's NOT yet on the leaderboard", res.data.record.leaderboardCounted === false);
  check("every round is markedBy fallback", res.data.record.rounds.every((r) => r.markedBy === "fallback"));
  subId = res.data.record.id;

  const lb1 = await get(sharedEnv, "/api/submissions/leaderboard", "pup1");
  check("a fully-degraded submission does not appear on the public leaderboard-submissions list", !lb1.data.submissions.some((s) => s.id === subId));

  const mine1 = await get(sharedEnv, "/api/submissions/mine", "pup1");
  check("but it DOES appear in the pupil's own submissions list", mine1.data.submissions.some((s) => s.id === subId));
  check("coachUsed is stripped from the pupil's own view", mine1.data.submissions.every((s) => s.rounds.every((r) => !("coachUsed" in r))));
}

{
  // Now AI is back (Groq succeeds) - remark round 0 only.
  global.fetch = fakeFetchGroqSucceeds();
  const r0 = await remark(sharedEnv, subId, 0, "pup1");
  check("remarking round 0 succeeds", r0.status === 200 && r0.data.success === true, JSON.stringify(r0.data).slice(0, 200));
  check("round 0 is no longer markedBy fallback", r0.data.submission.rounds[0].markedBy !== "fallback");
  check("still gradingDegraded (unit 2 is still fallback)", r0.data.submission.gradingDegraded === true);
  check("NOT added to leaderboard yet - only one of two units fixed", r0.data.addedToLeaderboard === false);

  check("v7.5: a submission has exactly 2 marking units", r0.data.submission.rounds.length === 2);
  check("v7.5: pupil never receives per-unit scores from the re-mark response", r0.data.submission.rounds.every((x) => !("score" in x) && !("breakdown" in x) && !("max" in x)));

  const r2 = await remark(sharedEnv, subId, 1, "pup1");
  check("remarking the LAST fallback unit (Q2+Q3) succeeds", r2.data.success === true);
  check("Q2+Q3 unit is no longer fallback", r2.data.submission.rounds[1].markedBy !== "fallback");
  check("gradingDegraded finally clears once both units are AI-marked", r2.data.submission.gradingDegraded === false);
  check("THIS is the moment it joins the leaderboard", r2.data.addedToLeaderboard === true);
  check("finalScore was recomputed from the new unit scores", typeof r2.data.submission.finalScore === "number" && r2.data.submission.finalScore > 0);

  check("pupils table now has exactly one entry with 1 attempt", sharedEnv.CCv6_DB._state.pupils.length === 1 && sharedEnv.CCv6_DB._state.pupils[0].attempts === 1, JSON.stringify(sharedEnv.CCv6_DB._state.pupils));

  const lb2 = await get(sharedEnv, "/api/submissions/leaderboard", "pup1");
  check("the submission now appears on the public leaderboard-submissions list", lb2.data.submissions.some((s) => s.id === subId));
}

{
  // Re-marking an already-AI-marked round is a safe no-op, not another AI call.
  let groqCallsBefore = 0;
  global.fetch = async (url) => { if (String(url).includes("groq.com")) groqCallsBefore++; return { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => ({ choices: [{ message: { content: goodJson() } }] }) }; };
  const again = await remark(sharedEnv, subId, 0, "pup1");
  check("remarking an already AI-marked round is a no-op", again.status === 200 && again.data.alreadyMarked === true);
  check("no wasted AI call for an already-marked round", groqCallsBefore === 0, groqCallsBefore);
}

// ---- Authorization ----
{
  __resetAiHealthForTests();
  global.fetch = fakeFetchAllFail();
  const env2 = baseEnv({ GROQ_API_KEY: "q1" });
  const res = await submit(env2, "pup1");
  const id2 = res.data.record.id;

  const byOther = await remark(env2, id2, 0, "pup2");
  check("a different pupil cannot remark someone else's submission", byOther.status === 403);

  const byScopedOut = await remark(env2, id2, 0, "scoped-out");
  check("a teacher-admin outside the pupil's class cannot remark it", byScopedOut.status === 403);

  global.fetch = fakeFetchGroqSucceeds();
  const byScopedIn = await remark(env2, id2, 0, "scoped-in");
  check("a teacher-admin scoped to the pupil's class CAN remark it", byScopedIn.status === 200 && byScopedIn.data.success === true, JSON.stringify(byScopedIn.data).slice(0, 150));

  const byAdmin = await remark(env2, id2, 1, "admin");
  check("the super admin can remark any submission", byAdmin.status === 200 && byAdmin.data.success === true);

  const notLoggedIn = await remark(env2, id2, 1, undefined);
  check("an unauthenticated request is rejected", notLoggedIn.status === 401);
}

// ---- Practice submissions never join the leaderboard, even fully re-marked ----
{
  __resetAiHealthForTests();
  global.fetch = fakeFetchAllFail();
  const env3 = baseEnv({ GROQ_API_KEY: "q1" });
  const res = await submit(env3, "pup1", undefined, true);
  const id3 = res.data.record.id;
  check("a practice attempt with AI down is still degraded", res.data.record.gradingDegraded === true);

  global.fetch = fakeFetchGroqSucceeds();
  await remark(env3, id3, 0, "pup1");
  const last = await remark(env3, id3, 1, "pup1");
  check("once fully AI-marked, a practice submission is NOT added to the leaderboard", last.data.addedToLeaderboard === false);
  check("and pupils table stays empty for this class", env3.CCv6_DB._state.pupils.length === 0);
}

// ---- Still down: a remark attempt that also falls back changes nothing ----
{
  __resetAiHealthForTests();
  global.fetch = fakeFetchAllFail();
  const env4 = baseEnv({ GROQ_API_KEY: "q1" });
  const res = await submit(env4, "pup1");
  const id4 = res.data.record.id;

  global.fetch = fakeFetchAllFail(); // still down at remark time too
  const r = await remark(env4, id4, 0, "pup1");
  check("a remark that also falls back reports success:false", r.status === 200 && r.data.success === false, JSON.stringify(r.data));
  check("a friendly message is included", typeof r.data.message === "string" && r.data.message.length > 0);
  check("the round is untouched (still fallback, same as before)", r.data.submission.rounds[0].markedBy === "fallback");
  check("not added to the leaderboard", r.data.addedToLeaderboard === false);
}

// ---- Input validation ----
{
  __resetAiHealthForTests();
  global.fetch = fakeFetchAllFail();
  const env5 = baseEnv({ GROQ_API_KEY: "q1" });
  const res = await submit(env5, "pup1");
  const id5 = res.data.record.id;
  const badRound = await remark(env5, id5, 7, "pup1");
  check("an out-of-range roundIndex is rejected with 400", badRound.status === 400);
  const missingSub = await remark(env5, "does-not-exist", 0, "pup1");
  check("remarking a nonexistent submission id returns 404", missingSub.status === 404);
}

// ============================================================
// Feature 1: pupil-facing submission lists (filters, pagination, scoping)
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = fakeFetchGroqSucceeds(); // real AI marking this time - lands on the leaderboard immediately
  const env6 = baseEnv({ GROQ_API_KEY: "q1" });
  await submit(env6, "pup1", "answer one with plenty of specific detail in it for good measure");
  await submit(env6, "pup2", "answer two with plenty of specific detail in it for good measure");

  const mine = await get(env6, "/api/submissions/mine", "pup1");
  check("mine only ever shows the calling pupil's own submissions", mine.data.submissions.length === 1 && mine.data.submissions[0].pupilName === "Jovan", JSON.stringify(mine.data.submissions.map((s) => s.pupilName)));

  const lb = await get(env6, "/api/submissions/leaderboard", "pup1");
  check("leaderboard-submissions shows BOTH pupils' AI-marked attempts", lb.data.submissions.length === 2);
  check("a pupil can see a classmate's full round detail (feedback/model answer), not just a score", lb.data.submissions.every((s) => s.rounds[0].feedback && s.rounds[0].modelAnswer));
  check("coachUsed is stripped even from a classmate's submission", lb.data.submissions.every((s) => s.rounds.every((r) => !("coachUsed" in r))));

  const lbFiltered = await get(env6, "/api/submissions/leaderboard?class=5ig", "pup2");
  check("the class filter on leaderboard-submissions works", lbFiltered.data.submissions.length === 2 && lbFiltered.data.submissions.every((s) => s.pupilClass === "5ig"));

  const lbOtherClass = await get(env6, "/api/submissions/leaderboard?class=6ha", "pup2");
  check("filtering to a class with no submissions returns an empty list, not an error", lbOtherClass.status === 200 && lbOtherClass.data.submissions.length === 0);

  const unauth = await get(env6, "/api/submissions/leaderboard", undefined);
  check("leaderboard-submissions requires login", unauth.status === 401);
  const unauthMine = await get(env6, "/api/submissions/mine", undefined);
  check("mine requires login", unauthMine.status === 401);
}

const failed = results.filter((r) => !r).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed");
process.exit(failed ? 1 : 0);
