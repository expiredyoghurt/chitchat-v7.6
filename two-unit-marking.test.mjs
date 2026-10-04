// v7.5 - Question 1 is marked alone (full TREES vs the picture); Questions 2+3
// are marked TOGETHER in ONE AI call on a modified rubric (Experience 16 /
// Suggestion 2 / Language 7). finalScore = average of the 2 unit scores.
// Pupils only ever see the overall average; teachers see the breakdown.
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
// Provider fakes that look at WHICH unit is being asked for (the Unit 2
// system prompt names "QUESTIONS 2 AND 3 TOGETHER" / the Unit 1 one does not)
// ---------------------------------------------------------------------
const unit1Json = () => goodJson();
const unit2Json = (over) =>
  JSON.stringify({
    breakdown: [
      { part: "Experience", points: 99, max: 16, note: "n", subBreakdown: [
        { label: "Relevance", points: 2, max: 2 }, { label: "5W1H Specificity", points: 4, max: 6 }, { label: "Authenticity / Personal Voice", points: 2, max: 2 },
        { label: "Clarity & Sequence", points: 2, max: 2 }, { label: "Reflection / Lesson Learnt", points: 1, max: 2 }, { label: "Depth & Development Across Both Answers", points: 2, max: 2 },
      ] },
      { part: "Suggestion", points: 2, max: 2 },
      { part: "Grammar Accuracy", points: 3, max: 3 }, { part: "Vocabulary Range & Appropriateness", points: 2, max: 3 }, { part: "Fluency & Delivery", points: 1, max: 1 },
    ],
    feedback: "Lovely connected story.", suggestion: "Add where it happened.",
    modelAnswer: new Array(150).fill("story").join(" ") + ".",
    ...(over || {}),
  });
// Expected Unit 2 total from the JSON above: Experience subs 2+4+2+2+1+2 = 13, + Suggestion 2 + 3 + 2 + 1 = 21
const UNIT2_EXPECTED = 21;
// Unit 1 total from goodJson (see teacher-override fixture): read from DB rather than hard-coding.

function recordingFetch(calls) {
  return async (url, init) => {
    if (!String(url).includes("groq.com")) return { ok: false, status: 500, headers: { get: () => null }, text: async () => "down", json: async () => ({}) };
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    const isUnit2 = /QUESTIONS 2 AND 3 TOGETHER|TWO linked spoken questions/.test(system);
    calls.push({ isUnit2, system, user });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => ({ choices: [{ message: { content: isUnit2 ? unit2Json() : unit1Json() } }] }) };
  };
}

async function submitDistinct(env, token, opts) {
  opts = opts || {};
  const mk = (tag) => ({ parts: { T: "thought " + tag, R: "reason " + tag, E1: "evidence " + tag, E2: "experience " + tag + " at the void deck with my friend", S: "suggestion " + tag } });
  const answers = [mk("ONE"), mk("TWO"), mk("THREE")];
  const req = new Request("https://x.dev/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ topicId: "topic_1", mode: "trees", answers, practice: !!opts.practice, coachUsed: opts.coachUsed || [false, false, false] }),
  });
  const res = await worker.fetch(req, env, {});
  return { status: res.status, data: await res.json() };
}
const storedRounds = (env, id) => JSON.parse(env.CCv6_DB._state.submissions.find((x) => x.id === id).rounds);

// ============================================================
// 1. Two independent AI calls; Unit 2's call sees BOTH questions + answers
// ============================================================
let env1, id1;
{
  __resetAiHealthForTests();
  const calls = [];
  global.fetch = recordingFetch(calls);
  env1 = baseEnv({ GROQ_API_KEY: "k" });
  const res = await submitDistinct(env1, "pup1", { coachUsed: [true, false, true] });
  id1 = res.data.record.id;
  check("submit succeeds", res.status === 200, JSON.stringify(res.data).slice(0, 150));
  check("exactly 2 AI calls per submission (one per unit), not 3", calls.length === 2, calls.length);
  check("call 1 is Unit 1 (full TREES prompt), call 2 is Unit 2", calls[0] && !calls[0].isUnit2 && calls[1] && calls[1].isUnit2);
  check("Unit 1 call contains Q1's text only", /experience ONE/.test(calls[0].user) && !/experience TWO/.test(calls[0].user) && !/experience THREE/.test(calls[0].user));
  check("Unit 2 call contains BOTH Q2 and Q3 answers together", /experience TWO/.test(calls[1].user) && /experience THREE/.test(calls[1].user));
  check("Unit 2 call does NOT contain Q1's answer", !/experience ONE/.test(calls[1].user));
  check("Unit 2 call contains both questions", /Q2\?/.test(calls[1].user) && /Q3\?/.test(calls[1].user) && !/Q1\?/.test(calls[1].user));
  check("Unit 2 prompt reads the answers as one story", /ONE extended personal-narrative|one story/i.test(calls[1].system));
  check("Unit 2 prompt states Experience 16 / Suggestion 2 / Language 7", /Experience 16/.test(calls[1].system) && /Suggestion 2/.test(calls[1].system) && /Language Use 7/.test(calls[1].system));
  check("Unit 2 prompt does not ask the model to return Thought/Reason/Evidence", !/"part": "Thought"|"part": "Reason"|"part": "Evidence"/.test(calls[1].system));
  check("Unit 2 prompt says Suggestion may appear in either answer", /EITHER answer/.test(calls[1].system));
  check("Unit 1 prompt is the unchanged TREES prompt (asks for Thought/Reason/Evidence)", /"part": "Thought"/.test(calls[0].system) && /"part": "Evidence"/.test(calls[0].system));
  check("Unit 1 prompt carries the Unit 1 rubric (Experience 12), not the Unit 2 one", /Experience: 0-12 marks/.test(calls[0].system) && !/QUESTIONS 2 AND 3 TOGETHER/.test(calls[0].system));
  check("Unit 2 prompt carries the Unit 2 rubric", /Depth and development across both answers/.test(calls[1].system));
}

// ============================================================
// 2. Stored shape + scoring maths
// ============================================================
{
  const r = storedRounds(env1, id1);
  check("2 rounds stored (rounds[0] = Q1, rounds[1] = Q2+Q3)", r.length === 2);
  check("rounds[0] tagged unit q1 with its own question + answer", r[0].unit === "q1" && r[0].question === "Q1?" && /experience ONE/.test(r[0].answer.parts.E2));
  check("rounds[1] tagged unit q2q3 with questions[] and answers[]", r[1].unit === "q2q3" && r[1].questions.length === 2 && r[1].questions[0] === "Q2?" && r[1].questions[1] === "Q3?" && r[1].answers.length === 2);
  check("Unit 1 breakdown still has T/R/E1/E2/S + Language (8 rows, 25 max)", r[0].breakdown.map((b) => b.part).join(",") === "Thought,Reason,Evidence,Experience,Suggestion,Grammar Accuracy,Vocabulary Range & Appropriateness,Fluency & Delivery" && r[0].max === 25);
  check("Unit 1 Experience is still out of 12", r[0].breakdown.find((b) => b.part === "Experience").max === 12);
  check("Unit 2 breakdown has exactly Experience/Suggestion/Grammar/Vocabulary/Fluency", r[1].breakdown.map((b) => b.part).join(",") === "Experience,Suggestion,Grammar Accuracy,Vocabulary Range & Appropriateness,Fluency & Delivery");
  check("Unit 2 maxes are 16 / 2 / 3 / 3 / 1 (sum 25)", r[1].breakdown.map((b) => b.max).join(",") === "16,2,3,3,1" && r[1].max === 25);
  check("Unit 2 Experience total is re-derived from sub-criteria (13), ignoring the model's bogus 99", r[1].breakdown[0].points === 13 && r[1].breakdown[0].subBreakdown.length === 6);
  check("Unit 2 score total = 21", r[1].score === UNIT2_EXPECTED, r[1].score);
  const row = env1.CCv6_DB._state.submissions.find((x) => x.id === id1);
  const expectedRaw = Math.round(((r[0].score + r[1].score) / 2) * 10) / 10;
  const expected = row.repeated_ideas_penalty ? Math.max(0, Math.round((expectedRaw - 5) * 10) / 10) : expectedRaw;
  check("finalScore = average of the TWO unit scores", row.final_score === expected, JSON.stringify({ final: row.final_score, expected, u1: r[0].score, u2: r[1].score }));
  check("maxScore is still 25", row.max_score === 25);
  check("modelAnswer for Unit 2 may exceed Unit 1's 1500-char cap (own, larger cap)", r[1].modelAnswer.length > 600);
  check("teacher-only coachUsed kept on both units, Q2/Q3 split recorded", r[0].coachUsed === true && r[1].coachUsed === true && r[1].coachUsedQuestions[0] === false && r[1].coachUsedQuestions[1] === true);
}

// ============================================================
// 3. Pupils see ONLY the overall average (server-side)
// ============================================================
{
  const sub = await submitDistinct(env1, "pup1");
  const rec = sub.data.record;
  check("submit response keeps finalScore + maxScore", typeof rec.finalScore === "number" && rec.maxScore === 25);
  check("submit response has no per-unit score/max/breakdown", rec.rounds.every((r) => !("score" in r) && !("max" in r) && !("breakdown" in r)));
  check("submit response still has written feedback, suggestion and stronger version for each unit", rec.rounds.every((r) => r.feedback && r.suggestion !== undefined && "modelAnswer" in r));
  check("submit response has no coachUsed", rec.rounds.every((r) => !("coachUsed" in r) && !("coachUsedQuestions" in r)));
  check("pupil record keeps the question/answers so the result screen can show them", rec.rounds[1].questions.length === 2 && rec.rounds[1].answers.length === 2);

  const mine = await get(env1, "/api/submissions/mine", "pup1");
  check("/mine: no per-unit scores or breakdown for the owner either", mine.data.submissions.length >= 1 && mine.data.submissions.every((s) => s.rounds.every((r) => !("score" in r) && !("breakdown" in r) && !("max" in r))));
  check("/mine still exposes the overall finalScore", mine.data.submissions.every((s) => typeof s.finalScore === "number"));

  const lb = await get(env1, "/api/submissions/leaderboard", "pup2");
  check("leaderboard-submissions (another pupil's view): overall score only, no per-unit scores/breakdown", lb.data.submissions.length >= 1 && lb.data.submissions.every((s) => typeof s.finalScore === "number" && s.rounds.every((r) => !("score" in r) && !("breakdown" in r) && !("coachUsed" in r))));

  const stored = storedRounds(env1, rec.id);
  check("the stored record (teacher truth) still has the full breakdown", stored.every((r) => Array.isArray(r.breakdown) && typeof r.score === "number"));
}

// ============================================================
// 4. Teacher override: per-unit, divides by 2, redacted for pupil
// ============================================================
{
  const before = storedRounds(env1, id1);
  const ov = await override(env1, id1, 1, 10, "Teacher says: lovely story.", "admin");
  check("teacher can override Unit 2 (rounds[1])", ov.status === 200 && ov.data.ok === true, JSON.stringify(ov.data).slice(0, 150));
  check("teacher response still carries the full breakdown + score", ov.data.submission.rounds[1].score === 10 && Array.isArray(ov.data.submission.rounds[1].breakdown));
  check("originalScore preserved", ov.data.submission.rounds[1].originalScore === before[1].score);
  check("Unit 1 untouched by overriding Unit 2", ov.data.submission.rounds[0].score === before[0].score && !ov.data.submission.rounds[0].overridden);
  const rawAvg = Math.round(((before[0].score + 10) / 2) * 10) / 10;
  const exp = ov.data.submission.repeatedIdeasPenalty ? Math.max(0, Math.round((rawAvg - 5) * 10) / 10) : rawAvg;
  check("finalScore recomputed as the average of the 2 units", ov.data.submission.finalScore === exp, JSON.stringify({ got: ov.data.submission.finalScore, exp }));
  const tooHigh = await override(env1, id1, 1, 26, "", "admin");
  check("score above 25 rejected on Unit 2", tooHigh.status === 400);
  const noRound2 = await override(env1, id1, 2, 5, "", "admin");
  check("there is no third round on a v7.5 submission", noRound2.status === 400);
  const mine = await get(env1, "/api/submissions/mine", "pup1");
  const mineSub = mine.data.submissions.find((s) => s.id === id1);
  check("pupil sees only a bare 'Score adjusted' flag, not who/when/original score", mineSub.rounds[1].overridden === true && !("overriddenBy" in mineSub.rounds[1]) && !("originalScore" in mineSub.rounds[1]) && !("overriddenAt" in mineSub.rounds[1]));
}

// ============================================================
// 5. Re-mark: Unit 2 re-marks as ONE combined call; Unit 1 alone as before
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "down", json: async () => ({}) });
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const res = await submitDistinct(env, "pup1");
  const id = res.data.record.id;
  check("AI down: both units fall back, exactly 2 rounds", res.data.record.rounds.length === 2 && res.data.record.rounds.every((r) => r.markedBy === "fallback") && res.data.record.gradingDegraded === true);
  check("fallback Unit 2 round is still tagged q2q3 and totals 25 max", storedRounds(env, id)[1].unit === "q2q3" && storedRounds(env, id)[1].max === 25);
  const fb = storedRounds(env, id);
  check("offline Unit 1 and Unit 2 scores are within 0..25", fb.every((r) => r.score >= 0 && r.score <= 25));
  check("offline Unit 2 breakdown has the Unit 2 shape (16/2/3/3/1)", fb[1].breakdown.map((b) => b.max).join(",") === "16,2,3,3,1", fb[1].breakdown.map((b) => b.max).join(","));
  check("offline Unit 2 Experience sub-criteria sum matches Experience points", fb[1].breakdown[0].subBreakdown.reduce((a, b) => a + b.points, 0) === fb[1].breakdown[0].points && fb[1].breakdown[0].subBreakdown.length === 6);

  const calls = [];
  global.fetch = recordingFetch(calls);
  const remark = async (round) => {
    const req = new Request("https://x.dev/api/submissions/" + id + "/remark", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer pup1" }, body: JSON.stringify({ roundIndex: round }) });
    const r = await worker.fetch(req, env, {});
    return { status: r.status, data: await r.json() };
  };
  const r1 = await remark(1);
  check("re-marking Unit 2 makes exactly ONE call, and it is the combined Unit 2 call with both answers", calls.length === 1 && calls[0].isUnit2 && /experience TWO/.test(calls[0].user) && /experience THREE/.test(calls[0].user), JSON.stringify(calls.map((c) => c.isUnit2)));
  check("Unit 2 re-mark succeeded and Unit 1 is still fallback (independent re-mark button)", r1.data.success === true && r1.data.submission.rounds[1].markedBy === "groq" && r1.data.submission.rounds[0].markedBy === "fallback");
  check("not on the leaderboard until Unit 1 is also fixed", r1.data.addedToLeaderboard === false && r1.data.submission.gradingDegraded === true);
  const r0 = await remark(0);
  check("re-marking Unit 1 is a Q1-only call (no Q2/Q3 text) and finishes the job", calls.length === 2 && !calls[1].isUnit2 && !/experience TWO/.test(calls[1].user) && r0.data.addedToLeaderboard === true);
  check("re-mark responses to the pupil carry no per-unit scores", r0.data.submission.rounds.every((r) => !("score" in r) && !("breakdown" in r)));
  const hist = env.CCv6_DB._state.history;
  const breakdown = JSON.parse(hist[hist.length - 1][6]);
  const by = Object.fromEntries(breakdown.map((b) => [b.part, b]));
  check("pupil_history Experience max is the average of the two units (12 and 16 -> 14)", by["Experience"] && by["Experience"].max === 14, JSON.stringify(by["Experience"]));
  check("pupil_history keeps Thought only from Unit 1 (max 2, not halved)", by["Thought"] && by["Thought"].max === 2, JSON.stringify(by["Thought"]));
  check("pupil_history Grammar max is the average of 2 and 3 (2.5)", by["Grammar Accuracy"] && by["Grammar Accuracy"].max === 2.5, JSON.stringify(by["Grammar Accuracy"]));
}

// ============================================================
// 6. Legacy 3-round submissions keep working (no unit tag, divide by 3)
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = recordingFetch([]);
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const legacyRounds = [0, 1, 2].map((i) => ({ question: "Q" + (i + 1) + "?", mode: "trees", answer: { parts: { T: "t", R: "r", E1: "e", E2: "experience legacy " + i, S: "s" } }, score: 12, max: 25, breakdown: [{ part: "Thought", points: 2, max: 2 }], feedback: "old", suggestion: "", modelAnswer: "", flagged: false, markedBy: "groq", coachUsed: false }));
  env.CCv6_DB._state.submissions.push({ id: "legacy1", pupil_name: "Jovan", pupil_class: "5ig", topic_id: "topic_1", topic_title: "Helping Others", mode: "trees", rounds: JSON.stringify(legacyRounds), final_score: 12, max_score: 25, practice: 0, grading_degraded: 0, repeated_ideas_penalty: 0, archived: 0, flagged: 0, created_at: Date.now() - 5000, retry_of: null, leaderboard_counted: 1 });
  const ov = await override(env, "legacy1", 2, 24, "", "admin");
  check("legacy override on round index 2 still works", ov.status === 200 && ov.data.ok === true, JSON.stringify(ov.data).slice(0, 150));
  check("legacy finalScore still divides by 3: (12+12+24)/3 = 16", ov.data.submission.finalScore === 16, ov.data.submission.finalScore);
  const mine = await get(env, "/api/submissions/mine", "pup1");
  const s = mine.data.submissions.find((x) => x.id === "legacy1");
  check("legacy submission is redacted for pupils the same way", s && s.rounds.length === 3 && s.rounds.every((r) => !("score" in r) && !("breakdown" in r)) && s.finalScore === 16);
}

// ============================================================
// 7. Single-response mode also goes through the 2-unit path
// ============================================================
{
  __resetAiHealthForTests();
  const calls = [];
  global.fetch = recordingFetch(calls);
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const req = new Request("https://x.dev/api/submit", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer pup1" }, body: JSON.stringify({ topicId: "topic_1", mode: "single", answers: [{ text: "answer ALPHA about the picture" }, { text: "answer BETA my story" }, { text: "answer GAMMA how it ended" }] }) });
  const res = await worker.fetch(req, env, {});
  const data = await res.json();
  check("single mode: 2 AI calls", res.status === 200 && calls.length === 2, calls.length);
  check("single mode: Unit 2 call sees both Q2 and Q3 text, not Q1", /BETA/.test(calls[1].user) && /GAMMA/.test(calls[1].user) && !/ALPHA/.test(calls[1].user));
  check("single mode: stored as unit q1 + q2q3 with text answers", storedRounds(env, data.record.id)[1].answers[0].text.includes("BETA"));
}

// ============================================================
// 8. Rubric config: separate key for Q2+Q3, super-admin only
// ============================================================
{
  __resetAiHealthForTests();
  const calls = [];
  global.fetch = recordingFetch(calls);
  const env = baseEnv({ GROQ_API_KEY: "k" });
  const getRub = (token) => get(env, "/api/teacher/rubric-q2q3", token);
  const g = await getRub("admin");
  check("GET rubric-q2q3 returns the built-in default for the super admin", g.status === 200 && g.data.isDefault === true && /QUESTIONS 2 AND 3 TOGETHER/.test(g.data.rubric));
  check("scoped teacher-admins cannot read/set the Q2+Q3 rubric", (await getRub("scoped-in")).status === 403 && (await getRub("pup1")).status === 403);
  const post = await worker.fetch(new Request("https://x.dev/api/teacher/rubric-q2q3", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer admin" }, body: JSON.stringify({ rubric: "CUSTOM Q2Q3 RUBRIC TEXT" }) }), env, {});
  check("POST saves a custom Q2+Q3 rubric", post.status === 200 && (await post.json()).isDefault === false);
  await submitDistinct(env, "pup1");
  check("the custom rubric is used for Unit 2 only", calls[1].isUnit2 && /CUSTOM Q2Q3 RUBRIC TEXT/.test(calls[1].system) && !/CUSTOM Q2Q3 RUBRIC TEXT/.test(calls[0].system));
  check("saving the Q2+Q3 rubric never touches Question 1's rubric key", !env.CCv6_DB._state.config.has("rubric"));
  const reset = await worker.fetch(new Request("https://x.dev/api/teacher/rubric-q2q3", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer admin" }, body: JSON.stringify({ rubric: "" }) }), env, {});
  check("blank POST resets to default", (await reset.json()).isDefault === true && !env.CCv6_DB._state.config.has("rubric_q2q3"));
}

// ============================================================
// 9. CSV export for a two-unit submission
// ============================================================
{
  __resetAiHealthForTests();
  global.fetch = recordingFetch([]);
  const env = baseEnv({ GROQ_API_KEY: "k" });
  await submitDistinct(env, "pup1");
  const res = await worker.fetch(new Request("https://x.dev/api/teacher/submissions/export", { headers: { authorization: "Bearer admin" } }), env, {});
  const csv = await res.text();
  const [head, row] = csv.split("\r\n");
  check("CSV has the new unit columns", /markingScheme/.test(head) && /unit1_score/.test(head) && /unit2_score/.test(head) && /unit2_breakdown/.test(head));
  check("CSV row for a v7.5 submission names the scheme and carries both unit scores", /v7\.5 two-unit/.test(row) && new RegExp(",21,").test(row));
  check("CSV still has 3 question columns, with Q2/Q3 answers split out", /Q2\?/.test(row) && /Q3\?/.test(row) && /experience TWO/.test(row) && /experience THREE/.test(row));
}

const passed = results.filter(Boolean).length;
console.log("\n" + passed + "/" + results.length + " checks passed");
process.exit(passed === results.length ? 0 : 1);
