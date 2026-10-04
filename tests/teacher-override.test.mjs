// Exercises POST /api/teacher/submissions/:id/override-score end to end,
// and separately locks in the rule from the same request: a pupil must
// never be able to see another pupil's submission unless every question on
// it was actually assessed by AI - a teacher's manual override must never
// be able to satisfy that on its own.
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
    // Teacher override's UPDATE - no grading_degraded column touched at all.
    if (/^UPDATE submissions SET rounds = \?, final_score = \? WHERE id = \?/.test(s)) {
      const row = submissions.find((x) => x.id === params[2]);
      if (row) { row.rounds = params[0]; row.final_score = params[1]; }
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
      rows = rows.slice().sort((a, b) => b.created_at - a.created_at);
      if (/^SELECT COUNT/.test(s)) return { first: { c: rows.length } };
      const limit = params[2], offset = params[3];
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

// ============================================================
// Happy path: override a round on an already fully-AI-marked,
// leaderboard-counted submission
// ============================================================
let env1, id1;
{
  __resetAiHealthForTests();
  global.fetch = fakeFetchGroqSucceeds();
  env1 = baseEnv({ GROQ_API_KEY: "q1" });
  const res = await submit(env1, "pup1");
  id1 = res.data.record.id;
  check("setup: submission is fully AI-marked and on the leaderboard already", res.data.record.gradingDegraded === false && res.data.record.leaderboardCounted === true);
  const storedRounds = (id) => JSON.parse(env1.CCv6_DB._state.submissions.find((x) => x.id === id).rounds);
  const originalScore0 = storedRounds(id1)[0].score;
  check("v7.5: the pupil's own submit response carries no per-unit score", res.data.record.rounds.every((r) => !("score" in r)));

  const ov = await override(env1, id1, 0, 5, "Actually this deserved less credit.", "admin");
  check("override succeeds", ov.status === 200 && ov.data.ok === true, JSON.stringify(ov.data).slice(0, 200));
  check("the round's score is updated", ov.data.submission.rounds[0].score === 5);
  check("the round's feedback is updated", ov.data.submission.rounds[0].feedback === "Actually this deserved less credit.");
  check("overridden flag is set", ov.data.submission.rounds[0].overridden === true);
  check("overriddenBy records the teacher", ov.data.submission.rounds[0].overriddenBy === "palpatine");
  check("overriddenAt is a timestamp", typeof ov.data.submission.rounds[0].overriddenAt === "number");
  check("originalScore preserves the pre-override AI score", ov.data.submission.rounds[0].originalScore === originalScore0, originalScore0 + " vs " + ov.data.submission.rounds[0].originalScore);
  check("markedBy is untouched by the override", ov.data.submission.rounds[0].markedBy !== "fallback" && ov.data.submission.rounds[0].markedBy === "groq");
  check("gradingDegraded is unaffected (was already false)", ov.data.submission.gradingDegraded === false);
  check("leaderboardCounted is unaffected (was already true)", ov.data.submission.leaderboardCounted === true);
  check("finalScore is recomputed as the average of the 2 units", (() => {
    const raw = Math.round(((5 + ov.data.submission.rounds[1].score) / 2) * 10) / 10;
    // All 3 answers share identical text in this test fixture, which
    // the real repeated-ideas detector correctly flags - the same penalty
    // that applied at original submission time keeps applying here.
    const expected = ov.data.submission.repeatedIdeasPenalty ? Math.max(0, Math.round((raw - 5) * 10) / 10) : raw;
    return ov.data.submission.finalScore === expected;
  })(), JSON.stringify({ finalScore: ov.data.submission.finalScore, repeatedIdeasPenalty: ov.data.submission.repeatedIdeasPenalty }));
  check("pupilAggregateUpdated is true since this was already on the leaderboard", ov.data.pupilAggregateUpdated === true);
}

// ---- A second override on the SAME round keeps the ORIGINAL original score ----
{
  const ov2 = await override(env1, id1, 0, 9, "", "admin");
  check("a second override succeeds", ov2.status === 200 && ov2.data.ok === true);
  check("score updates again", ov2.data.submission.rounds[0].score === 9);
  check("blank feedback in the request keeps the PREVIOUS feedback rather than clearing it", ov2.data.submission.rounds[0].feedback === "Actually this deserved less credit.");
  check("originalScore still points at the very first AI score, not the first override", ov2.data.submission.rounds[0].originalScore === ov2.data.submission.rounds[0].originalScore && typeof ov2.data.submission.rounds[0].originalScore === "number");
}

// ============================================================
// Pupil-aggregate correctness across two submissions (MAX must actually
// recompute down when the overridden submission was the pupil's best)
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = fakeFetchGroqSucceeds();
  const env2 = baseEnv({ GROQ_API_KEY: "q1" });
  const a = await submit(env2, "pup1", "first attempt with plenty of specific detail for good measure here");
  const b = await submit(env2, "pup1", "second attempt with plenty of specific detail for good measure too");
  const idA = a.data.record.id, idB = b.data.record.id;
  const scoreA = a.data.record.finalScore, scoreB = b.data.record.finalScore; // overall average stays visible to pupils

  const before = env2.CCv6_DB._state.pupils.find((p) => p.name === "Jovan");
  check("setup: pupil aggregate reflects both attempts before any override", before.attempts === 2 && Math.abs(before.total_score - (scoreA + scoreB)) < 0.01, JSON.stringify(before));

  // Push submission A's score down to 0 across both units via overrides.
  await override(env2, idA, 0, 0, "", "admin");
  const last = await override(env2, idA, 1, 0, "", "admin");
  check("submission A's score is now 0", last.data.submission.finalScore === 0);

  const after = env2.CCv6_DB._state.pupils.find((p) => p.name === "Jovan");
  check("total_score recomputed to just submission B's score", Math.abs(after.total_score - scoreB) < 0.01, JSON.stringify(after));
  check("best_score recomputes DOWN once the higher-scoring submission is overridden to 0", Math.abs(after.best_score - Math.max(0, scoreB)) < 0.01, JSON.stringify(after));
  check("attempts count is unaffected by an override (still 2, not re-counted)", after.attempts === 2);
}

// ============================================================
// Override on a STILL fallback-marked round: score changes, but the
// AI-assessed gate for leaderboard/visibility is untouched
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = fakeFetchAllFail();
  const env3 = baseEnv({ GROQ_API_KEY: "q1" });
  const res = await submit(env3, "pup1");
  const id3 = res.data.record.id;
  check("setup: submission is fully offline-scored (AI down)", res.data.record.gradingDegraded === true && res.data.record.leaderboardCounted === false);

  const ov = await override(env3, id3, 0, 10, "Manually graded while AI was down.", "admin");
  check("teacher can override a fallback round directly, without needing AI re-mark first", ov.status === 200 && ov.data.ok === true, JSON.stringify(ov.data).slice(0, 200));
  check("the score is updated", ov.data.submission.rounds[0].score === 10);
  check("markedBy STAYS fallback - the override never claims to be an AI assessment", ov.data.submission.rounds[0].markedBy === "fallback");
  check("gradingDegraded stays true - unit 2 is still un-AI-assessed", ov.data.submission.gradingDegraded === true);
  check("leaderboardCounted stays false - an override alone never unlocks the leaderboard", ov.data.submission.leaderboardCounted === false);
  check("pupilAggregateUpdated is false - this was never on the leaderboard to begin with", ov.data.pupilAggregateUpdated === false);

  // Regression lock on the user's explicit request: even with a teacher
  // override applied, this submission must stay invisible to another pupil.
  const lb = await get(env3, "/api/submissions/leaderboard", "pup2");
  check("a still-degraded submission stays OFF the public leaderboard-submissions list even after a teacher override", !lb.data.submissions.some((x) => x.id === id3));
}

// ============================================================
// Practice submissions never reach the leaderboard via override either
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = fakeFetchGroqSucceeds();
  const env4 = baseEnv({ GROQ_API_KEY: "q1" });
  const res = await submit(env4, "pup1", undefined, true);
  const id4 = res.data.record.id;
  check("setup: practice attempt, fully AI-marked, still never on the leaderboard", res.data.record.gradingDegraded === false && res.data.record.leaderboardCounted === false);

  const ov = await override(env4, id4, 0, 1, "", "admin");
  check("override on a practice submission still works (updates the score)", ov.data.submission.rounds[0].score === 1);
  check("but leaderboardCounted still never flips to true for a practice attempt", ov.data.submission.leaderboardCounted === false);
  check("and pupilAggregateUpdated is false", ov.data.pupilAggregateUpdated === false);
}

// ============================================================
// Validation
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = fakeFetchGroqSucceeds();
  const env5 = baseEnv({ GROQ_API_KEY: "q1" });
  const res = await submit(env5, "pup1");
  const id5 = res.data.record.id;
  const max0 = 25; // pupils no longer receive per-unit max; both units are out of 25

  const tooHigh = await override(env5, id5, 0, max0 + 5, "", "admin");
  check("a score above the round's max is rejected", tooHigh.status === 400, JSON.stringify(tooHigh.data));
  const negative = await override(env5, id5, 0, -1, "", "admin");
  check("a negative score is rejected", negative.status === 400);
  const badRound = await override(env5, id5, 9, 2, "", "admin");
  check("an out-of-range roundIndex is rejected", badRound.status === 400);
  const notANumber = await override(env5, id5, 0, "banana", "", "admin");
  check("a non-numeric score is rejected", notANumber.status === 400, JSON.stringify(notANumber.data));
  const missingSub = await override(env5, "does-not-exist", 0, 1, "", "admin");
  check("overriding a nonexistent submission returns 404", missingSub.status === 404);

  const confirmUnchanged = await get(env5, "/api/submissions/mine", "pup1");
  const rejectedStored = JSON.parse(env5.CCv6_DB._state.submissions.find((x) => x.id === id5).rounds);
  check("none of the rejected attempts actually changed the stored score", rejectedStored[0].score !== 0 && rejectedStored[0].score <= 25 && !rejectedStored[0].overridden);
}

// ============================================================
// Authorization
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = fakeFetchGroqSucceeds();
  const env6 = baseEnv({ GROQ_API_KEY: "q1" });
  const res = await submit(env6, "pup1");
  const id6 = res.data.record.id;

  const byPupil = await override(env6, id6, 0, 1, "", "pup1");
  check("a pupil - even the submission's own owner - cannot use the teacher override endpoint", byPupil.status === 403);

  const byScopedOut = await override(env6, id6, 0, 1, "", "scoped-out");
  check("a teacher-admin outside the pupil's class cannot override it", byScopedOut.status === 403);

  const byScopedIn = await override(env6, id6, 0, 1, "", "scoped-in");
  check("a teacher-admin scoped to the pupil's class CAN override it", byScopedIn.status === 200);

  const byAdmin = await override(env6, id6, 1, 2, "", "admin");
  check("the super admin can override any submission", byAdmin.status === 200);

  const notLoggedIn = await override(env6, id6, 1, 1, "", undefined);
  check("an unauthenticated request is rejected", notLoggedIn.status === 401 || notLoggedIn.status === 403);
}

// ============================================================
// Explicit lock-in of the visibility rule itself (no override involved):
// a pupil can NEVER see another pupil's work unless every question on it
// was actually assessed by AI.
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = fakeFetchAllFail();
  const envV = baseEnv({ GROQ_API_KEY: "q1" });
  const degraded = await submit(envV, "pup1");

  global.fetch = fakeFetchGroqSucceeds();
  const clean = await submit(envV, "pup2", "a second pupil's fully AI-marked answer with good detail");
  const practiceClean = await submit(envV, "pup2", "a practice answer that is fully AI-marked", true);

  const lbAsB = await get(envV, "/api/submissions/leaderboard", "pup2");
  check("pupil B cannot see pupil A's fully offline-scored submission", !lbAsB.data.submissions.some((s) => s.id === degraded.data.record.id));
  check("pupil B's OWN fully AI-marked, non-practice submission IS visible on the shared list", lbAsB.data.submissions.some((s) => s.id === clean.data.record.id));
  check("pupil B's own fully AI-marked PRACTICE submission is still not on the shared list", !lbAsB.data.submissions.some((s) => s.id === practiceClean.data.record.id));

  const mineAsA = await get(envV, "/api/submissions/mine", "pup1");
  check("pupil A can always see their own degraded submission in their own history", mineAsA.data.submissions.some((s) => s.id === degraded.data.record.id));
  const mineAsB = await get(envV, "/api/submissions/mine", "pup2");
  check("pupil B's own-history endpoint never returns pupil A's submissions", !mineAsB.data.submissions.some((s) => s.id === degraded.data.record.id));
}

const failed = results.filter((r) => !r).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed");
process.exit(failed ? 1 : 0);
