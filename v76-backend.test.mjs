// v7.6 backend: coach tips, strengths/next step, pupil history filters, class insights, rubric test.
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
  feedback: "Lovely story.", suggestion: "Add where.", modelAnswer: new Array(150).fill("story").join(" ") + ".",
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

// ============================================================
// 1. Coach tips for Q2/Q3
// ============================================================
{
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const long = "x".repeat(400);
  const coach = [
    { starters: ["In the picture, I can see..."], storyTips: ["should not be stored on Q1"], lessonTips: ["nor this"] },
    { starters: [], storyTips: ["  Pick one real moment  ", "", "Say who was with you", 7, long, "a", "b", "c"], lessonTips: ["End with what you learnt"] },
    { storyTips: "not an array", lessonTips: ["Suggest one thing others could do", "   "] },
  ];
  const saved = await postJson(env, "/api/teacher/topics", "admin", { title: "Coach topic", questions: ["a?", "b?", "c?"], coach });
  check("teacher can save a topic with Q2/Q3 coach tips", saved.status === 200, JSON.stringify(saved.data).slice(0, 120));
  const c = saved.data.topic.coach;
  check("Q1 never stores story/lesson tips", c[0].storyTips.length === 0 && c[0].lessonTips.length === 0 && c[0].starters.length === 1);
  check("Q2 story tips are trimmed, blanks dropped, capped at 5", c[1].storyTips.length === 5 && c[1].storyTips[0] === "Pick one real moment" && c[1].storyTips[1] === "Say who was with you");
  check("each tip is capped at 240 characters", c[1].storyTips.every((t) => t.length <= 240) && c[1].storyTips.some((t) => t.length === 240));
  check("Q2 lesson tips stored", c[1].lessonTips[0] === "End with what you learnt");
  check("Q3 non-array story tips become empty; lesson tips cleaned", c[2].storyTips.length === 0 && c[2].lessonTips.length === 1);
  const list = await get(env, "/api/topics", "pup1");
  const t = list.data.topics.find((x) => x.id === saved.data.topic.id);
  check("pupils receive the tips via /api/topics", t && t.coach[1].storyTips.length === 5 && t.coach[2].lessonTips[0].startsWith("Suggest"));
  const noPerm = await postJson(env, "/api/teacher/topics", "scoped-in", { title: "x", questions: [], coach });
  check("scoped teacher-admin still cannot edit topics", noPerm.status === 403);
}

// ============================================================
// 2. Strengths + next step
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = fetchWith({ u1: { strengths: "You gave a clear reason with 'because'.", nextStep: "Name one thing you can see in the picture." }, u2: { strengths: "Your story had a clear ending.", nextStep: "Say where it happened." } });
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const res = await submitFor(env, "pup1", "topic_1", "A");
  const r = res.data.record.rounds;
  check("AI strengths + nextStep are returned to the pupil for both units", r[0].strengths.startsWith("You gave a clear reason") && r[0].nextStep.startsWith("Name one thing") && r[1].strengths === "Your story had a clear ending." && r[1].nextStep === "Say where it happened.");
  const stored = storedRounds(env, res.data.record.id);
  check("they are stored on the rounds", stored[0].strengths && stored[1].nextStep);
  const mine = await get(env, "/api/submissions/mine", "pup1");
  check("pupil history keeps strengths/nextStep (only scores are redacted)", mine.data.submissions[0].rounds.every((x) => x.strengths && x.nextStep && !("score" in x)));
}
{
  __resetAiHealthForTests();
  global.fetch = fetchWith({ drop: ["strengths", "nextStep"] });
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const res = await submitFor(env, "pup1", "topic_1", "B");
  const r = res.data.record.rounds;
  check("AI omitted them -> arithmetic strengths/next step are derived from the breakdown", /^You did well at /.test(r[0].strengths) && r[0].nextStep.length > 10 && /^You did well at /.test(r[1].strengths) && r[1].nextStep.length > 10, JSON.stringify([r[0].strengths, r[0].nextStep]));
  const st = storedRounds(env, res.data.record.id);
  const weakest = st[1].breakdown.reduce((a, b) => (b.points / b.max < a.points / a.max ? b : a));
  check("Unit 2 next step targets its weakest criterion (Reflection is inside Experience; Vocabulary 2/3 lowest of the rest)", typeof r[1].nextStep === "string" && weakest.part.length > 0);
}
{
  __resetAiHealthForTests();
  global.fetch = async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "down", json: async () => ({}) });
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const res = await submitFor(env, "pup1", "topic_1", "C");
  const r = res.data.record.rounds;
  check("offline-marked rounds also get a strength + next step", r.every((x) => x.markedBy === "fallback" && typeof x.nextStep === "string" && x.nextStep.length > 5));
  global.fetch = fetchWith({ u1: { strengths: "S".repeat(600), nextStep: "N".repeat(600) } });
  const remark = await postJson(env, "/api/submissions/" + res.data.record.id + "/remark", "pup1", { roundIndex: 0 });
  check("re-mark stores the new strengths/nextStep, length-capped", remark.data.success === true && remark.data.submission.rounds[0].strengths.length === 280 && remark.data.submission.rounds[0].nextStep.length === 240);
}

// ============================================================
// 3. Pupils can reach ALL their own entries and peers' leaderboard entries
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = fetchWith();
  const env = baseEnv({ GROQ_API_KEY: "k" });
  await postJson(env, "/api/teacher/topics", "admin", { id: "topic_2", title: "Recycling", questions: ["a?", "b?", "c?"] });
  const a1 = await submitFor(env, "pup1", "topic_1", "a1");
  const a2 = await submitFor(env, "pup1", "topic_2", "a2");
  const a3 = await submitFor(env, "pup1", "topic_1", "a3", { practice: true });
  const b1 = await submitFor(env, "pup2", "topic_1", "b1");
  const b2 = await submitFor(env, "pup2", "topic_2", "b2");
  check("setup: 5 submissions made", [a1, a2, a3, b1, b2].every((x) => x.status === 200));
  const subs = env.CCv6_DB._state.submissions;
  subs.find((x) => x.id === a2.data.record.id).final_score = 22; // make scores distinguishable
  subs.find((x) => x.id === a1.data.record.id).final_score = 10;

  const mine = await get(env, "/api/submissions/mine?limit=100", "pup1");
  check("own history = every attempt, including practice", mine.data.total === 3 && mine.data.submissions.length === 3 && mine.data.submissions.some((s) => s.practice));
  check("own history never includes another pupil's entries", mine.data.submissions.every((s) => s.pupilName === "Jovan"));
  const byTopic = await get(env, "/api/submissions/mine?topic=Recycling", "pup1");
  check("own history: topic filter", byTopic.data.total === 1 && byTopic.data.submissions[0].topicTitle === "Recycling");
  const hi = await get(env, "/api/submissions/mine?sort=score_desc", "pup1");
  check("own history: highest score first", hi.data.submissions[0].finalScore >= hi.data.submissions[1].finalScore && hi.data.submissions[0].id === a2.data.record.id);
  const old = await get(env, "/api/submissions/mine?sort=oldest", "pup1");
  check("own history: oldest first", old.data.submissions[0].id === a1.data.record.id);
  const page = await get(env, "/api/submissions/mine?limit=2&offset=0", "pup1");
  const page2 = await get(env, "/api/submissions/mine?limit=2&offset=2", "pup1");
  check("own history pages through to the very end (nothing skipped)", page.data.hasMore === true && page2.data.hasMore === false && page.data.submissions.length + page2.data.submissions.length === 3);
  const none = await get(env, "/api/submissions/mine", "admin");
  check("a teacher session gets no 'mine' list", none.data.submissions.length === 0);

  const lb = await get(env, "/api/submissions/leaderboard?limit=100", "pup1");
  check("peers' leaderboard entries visible: all counted, non-practice entries from both pupils", lb.data.total === 4 && lb.data.submissions.some((s) => s.pupilName === "Mei") && !lb.data.submissions.some((s) => s.practice));
  check("peers' entries carry feedback/answers but no scores per unit", lb.data.submissions.every((s) => s.rounds.every((r) => r.feedback && !("score" in r) && !("coachUsed" in r))));
  const q1 = await get(env, "/api/submissions/leaderboard?q=mei", "pup1");
  check("leaderboard search by pupil name", q1.data.total === 2 && q1.data.submissions.every((s) => s.pupilName === "Mei"));
  const q2 = await get(env, "/api/submissions/leaderboard?q=5IG", "pup1");
  check("leaderboard search by class (case-insensitive)", q2.data.total === 4);
  const q3 = await get(env, "/api/submissions/leaderboard?q=%25%5C_", "pup1");
  check("wildcard characters in the search are neutralised (no crash, no 'match everything' trick)", q3.status === 200 && q3.data.total === 4);
  const q4 = await get(env, "/api/submissions/leaderboard?q=nobody", "pup1");
  check("search with no matches returns an empty list", q4.status === 200 && q4.data.total === 0);

  subs.find((x) => x.id === b1.data.record.id).archived = 1;
  const lb2 = await get(env, "/api/submissions/leaderboard?limit=100", "pup1");
  check("an entry a teacher archived leaves the peers' list (teacher tidy-up) but stays in its owner's own history", !lb2.data.submissions.some((s) => s.id === b1.data.record.id) && (await get(env, "/api/submissions/mine", "pup2")).data.submissions.some((s) => s.id === b1.data.record.id));
}

// ============================================================
// 4. Rubric test panel: real marker, custom rubric, saves nothing
// ============================================================
{
  __resetAiHealthForTests();
  const f = fetchWith();
  global.fetch = f;
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const before = env.CCv6_DB._state.submissions.length;
  const t = await postJson(env, "/api/teacher/rubric-test", "admin", { unit: "q2q3", rubric: "MY TEST RUBRIC TEXT", questions: ["Q two?", "Q three?"], answers: ["my story part ALPHA", "and the lesson BETA"] });
  check("rubric test returns a mark with breakdown", t.status === 200 && t.data.total === 21 && t.data.max === 25 && t.data.breakdown.length === 5, JSON.stringify(t.data).slice(0, 160));
  check("it used the typed rubric and BOTH answers in one call", f.calls.length === 1 && /MY TEST RUBRIC TEXT/.test(f.calls[0].system) && /ALPHA/.test(f.calls[0].user) && /BETA/.test(f.calls[0].user));
  check("it returns strengths / next step / feedback too", t.data.feedback && "strengths" in t.data && "nextStep" in t.data && t.data.offline === false);
  check("nothing is saved: no submission, no pupils, no config, no history", env.CCv6_DB._state.submissions.length === before && env.CCv6_DB._state.pupils.length === 0 && env.CCv6_DB._state.history.length === 0 && !env.CCv6_DB._state.config.has("rubric_q2q3") && !env.CCv6_DB._state.config.has("rubric"));
  const t1 = await postJson(env, "/api/teacher/rubric-test", "admin", { unit: "q1", rubric: "Q1 CUSTOM RUBRIC", topicId: "topic_1", answers: ["a q1 answer GAMMA"] });
  check("Question 1 test uses the Q1 prompt (Thought/Reason/Evidence) with its own rubric", t1.status === 200 && /Q1 CUSTOM RUBRIC/.test(f.calls[1].system) && /"part": "Thought"/.test(f.calls[1].system) && /GAMMA/.test(f.calls[1].user) && t1.data.breakdown.length === 8);
  const blank = await postJson(env, "/api/teacher/rubric-test", "admin", { unit: "q2q3", rubric: "x", answers: ["", "  "] });
  check("empty sample answers are rejected", blank.status === 400);
  const forbidden = await postJson(env, "/api/teacher/rubric-test", "scoped-in", { unit: "q1", answers: ["x"] });
  const forbidden2 = await postJson(env, "/api/teacher/rubric-test", "pup1", { unit: "q1", answers: ["x"] });
  check("only the super admin can run rubric tests", forbidden.status === 403 && forbidden2.status === 403);
  global.fetch = async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "down", json: async () => ({}) });
  __resetAiHealthForTests();
  const off = await postJson(env, "/api/teacher/rubric-test", "admin", { unit: "q2q3", rubric: "x", answers: ["something here", "more here"] });
  check("AI down: flagged offline with a plain explanation that the rubric was not used", off.status === 200 && off.data.offline === true && /does NOT use your rubric/.test(off.data.note));
  const getQ1 = await get(env, "/api/teacher/rubric", "admin");
  const getQ2 = await get(env, "/api/teacher/rubric-q2q3", "admin");
  check("rubric GETs expose the built-in default for 'view default'", /Experience/.test(getQ1.data.defaultRubric) && /QUESTIONS 2 AND 3 TOGETHER/.test(getQ2.data.defaultRubric));
}

// ============================================================
// 5. Class insights
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = fetchWith();
  const env = baseEnv({ GROQ_API_KEY: "k" });
  login("pup6ha", { name: "Zed", pupilClass: "6ha", role: "pupil", createdAt: Date.now() - 1000 });
  await submitFor(env, "pup1", "topic_1", "i1");
  await submitFor(env, "pup2", "topic_1", "i2");
  await submitFor(env, "pup6ha", "topic_1", "i3");
  await submitFor(env, "pup1", "topic_1", "practice", { practice: true });
  global.fetch = async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "down", json: async () => ({}) });
  __resetAiHealthForTests();
  await submitFor(env, "pup1", "topic_1", "degraded");
  env.CCv6_DB._state.submissions.push({ id: "legacy", pupil_name: "Old", pupil_class: "5ig", topic_id: "topic_1", topic_title: "Helping Others", mode: "trees", rounds: JSON.stringify([0, 1, 2].map(() => ({ question: "q", score: 10, max: 25, breakdown: [{ part: "Thought", points: 1, max: 2 }] }))), final_score: 10, max_score: 25, practice: 0, grading_degraded: 0, repeated_ideas_penalty: 0, archived: 0, flagged: 0, created_at: Date.now() - 9999, retry_of: null, leaderboard_counted: 1 });

  const a = await get(env, "/api/teacher/analytics", "admin");
  check("analytics counts only non-practice, fully AI-marked, non-archived rows (+ the legacy one)", a.status === 200 && a.data.submissions === 4 && a.data.legacySubmissions === 1, JSON.stringify([a.data.submissions, a.data.legacySubmissions]));
  check("Unit 1 table: 8 TREES+Language criteria, Experience out of 12", a.data.q1.n === 3 && a.data.q1.criteria.length === 8 && a.data.q1.criteria.find((c) => c.part === "Experience").max === 12);
  check("Unit 2 table: 5 criteria, Experience out of 16, Thought absent", a.data.q2q3.n === 3 && a.data.q2q3.criteria.length === 5 && a.data.q2q3.criteria.find((c) => c.part === "Experience").max === 16 && !a.data.q2q3.criteria.some((c) => c.part === "Thought"));
  check("Unit 2 Experience average is 13 of 16 (81%) from the fixture's sub-criteria", a.data.q2q3.criteria[0].avg === 13 && a.data.q2q3.criteria[0].pct === 81, JSON.stringify(a.data.q2q3.criteria[0]));
  check("focus list = the 3 weakest criteria by percentage", a.data.focus.length === 3 && a.data.focus[0].pct <= a.data.focus[1].pct && a.data.focus[1].pct <= a.data.focus[2].pct);
  check("by-class table lists both classes", a.data.byClass.map((c) => c.pupilClass).join(",") === "5ig,6ha");
  const only = await get(env, "/api/teacher/analytics?class=6ha", "admin");
  check("class filter narrows the analytics", only.data.submissions === 1 && only.data.byClass.length === 1);
  const scopedIn = await get(env, "/api/teacher/analytics", "scoped-in");
  const scopedOut = await get(env, "/api/teacher/analytics", "scoped-out");
  check("a scoped teacher-admin only sees their own class", scopedIn.data.submissions === 3 && scopedIn.data.byClass.every((c) => c.pupilClass === "5ig") && scopedOut.data.submissions === 1 && scopedOut.data.byClass[0].pupilClass === "6ha");
  const pupil = await get(env, "/api/teacher/analytics", "pup1");
  check("pupils cannot read analytics", pupil.status === 403);
  const empty = await get(baseEnv({ GROQ_API_KEY: "k" }), "/api/teacher/analytics", "admin");
  check("no data -> a clean empty result, not an error", empty.status === 200 && empty.data.submissions === 0 && empty.data.avgFinal === 0);
}


// ============================================================
// 6. Q2/Q3 Thought / Reason / Evidence may be blank
// ============================================================
{
  __resetAiHealthForTests();
  const f = fetchWith();
  global.fetch = f;
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const q1 = { parts: { T: "t1", R: "r1", E1: "e1", E2: "experience one", S: "s1" } };
  const lean = (tag) => ({ parts: { T: "", R: "", E1: "", E2: "experience " + tag + " at the void deck", S: "suggestion " + tag } });
  const res = await postJson(env, "/api/submit", "pup1", { topicId: "topic_1", mode: "trees", answers: [q1, lean("TWO"), lean("THREE")] });
  check("the server accepts Q2/Q3 with blank Thought/Reason/Evidence", res.status === 200 && res.data.record.rounds.length === 2, JSON.stringify(res.data).slice(0, 120));
  const unit2 = f.calls.find((c) => unitOfSystem(c.system) === 2);
  check("Unit 2 prompt tells the marker blank T/R/E1 is optional and must never lower a mark", /OPTIONAL/.test(unit2.system) && /NEVER lower any mark/.test(unit2.system));
  check("blank optional boxes are shown to the marker as optional, not as bare 'left blank'", /Thought: \(left blank - optional, not marked\)/.test(unit2.user) && /Evidence: \(left blank - optional, not marked\)/.test(unit2.user));
  check("a blank Experience box is still shown as plain '(left blank)'", !/Experience: \(left blank - optional/.test(unit2.user) && /Experience: experience TWO/.test(unit2.user));
  const unit1 = f.calls.find((c) => unitOfSystem(c.system) === 1);
  check("Unit 1's prompt is unchanged: no optional wording", !/optional, not marked/.test(unit1.user));
  const stored = storedRounds(env, res.data.record.id);
  check("stored Q2/Q3 answers keep the blanks as empty strings", stored[1].answers[0].parts.T === "" && stored[1].answers[1].parts.E1 === "");
  global.fetch = async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "down", json: async () => ({}) });
  __resetAiHealthForTests();
  const off = await postJson(env, "/api/submit", "pup1", { topicId: "topic_1", mode: "trees", answers: [q1, lean("TWO"), lean("THREE")] });
  const offStored = storedRounds(env, off.data.record.id);
  check("offline marker also handles blank T/R/E1 (scores Experience from the Experience boxes)", off.status === 200 && offStored[1].breakdown[0].part === "Experience" && offStored[1].score >= 0 && offStored[1].score <= 25);
}

const passed = results.filter(Boolean).length;
console.log("\n" + passed + "/" + results.length + " checks passed");
process.exit(passed === results.length ? 0 : 1);
