// v7.10 backend: the skill web. Built from stored marks on every read, so a teacher override or an AI re-mark
// shows up straight away; offline-estimated parts stay out until a teacher marks or an AI re-marks them.
import { check, summary, baseEnv, loginAll, get, post, subRow, crit } from "./_fake.mjs";
import { skillsOfRounds, buildSkillWeb, computeProgressSeries, redactForPupil, scaleBreakdownToScore, __resetAiHealthForTests } from "../src/index.js";

loginAll();
const DAY = 86400000, NOW = Date.now(), T0 = NOW - 60 * DAY;

// ---- full-breakdown rounds (all 8 assessed parts) ----
const sub6 = [["Relevance", 2, 2], ["5W1H Specificity", 4, 6], ["Authenticity / Personal Voice", 2, 2], ["Clarity & Sequence", 2, 2], ["Reflection / Lesson Learnt", 1, 2], ["Depth & Development Across Both Answers", 2, 2]].map(([label, points, max]) => ({ label, points, max }));
const sub5 = [["Relevance", 2, 2], ["5W1H Specificity", 3, 6], ["Authenticity / Personal Voice", 2, 2], ["Clarity & Sequence", 1, 1], ["Reflection / Lesson Learnt", 0, 1]].map(([label, points, max]) => ({ label, points, max }));
const r1 = (extra) => ({ unit: "q1", question: "Q1?", mode: "trees", answer: { parts: { T: "t", R: "r", E1: "e", E2: "story", S: "s" } }, score: 18, max: 25,
  breakdown: [crit("Thought", 2, 2), crit("Reason", 1, 2), crit("Evidence", 2, 2), { ...crit("Experience", 8, 12), subBreakdown: sub5 }, crit("Suggestion", 1, 2), crit("Grammar Accuracy", 2, 2), crit("Vocabulary Range & Appropriateness", 1, 2), crit("Fluency & Delivery", 1, 1)],
  feedback: "f", modelAnswer: "m", markedBy: "groq", coachUsed: true, ...(extra || {}) });
const r23 = (extra) => ({ unit: "q2q3", questions: ["Q2?", "Q3?"], question: "q", mode: "trees", answers: [{ parts: { E2: "a" } }, { parts: { E2: "b" } }], score: 18, max: 25,
  breakdown: [{ ...crit("Experience", 10, 16), subBreakdown: sub6 }, crit("Suggestion", 2, 2), crit("Grammar Accuracy", 3, 3), crit("Vocabulary Range & Appropriateness", 2, 3), crit("Fluency & Delivery", 1, 1)],
  feedback: "f2", modelAnswers: ["x", "y"], observed: [{ part: "Thought", status: "Present" }], markedBy: "groq", coachUsed: false, ...(extra || {}) });
const off = (r) => ({ ...r, markedBy: "fallback" });
const pctOf = (sk, key) => { const a = sk.axes[key]; return a && a.max > 0 ? Math.round((a.points / a.max) * 100) : null; };
const axis = (web, key) => web.axes.find((a) => a.key === key);

// ======================== 1. skillsOfRounds ========================
{
  const sk = skillsOfRounds([r1(), r23()]);
  check("skills: all 8 assessed skills are present for a full attempt", ["Thought", "Reason", "Evidence", "Experience", "Suggestion", "Grammar", "Vocabulary", "Fluency"].every((k) => sk.axes[k]), Object.keys(sk.axes));
  check("skills: Thought / Reason / Evidence come from Question 1 only (Unit 2 has no marks for them)", sk.axes.Thought.max === 2 && sk.axes.Reason.max === 2 && sk.axes.Evidence.max === 2);
  check("skills: Experience pools both units as points / max (8+10 of 12+16 = 64%)", sk.axes.Experience.points === 18 && sk.axes.Experience.max === 28 && pctOf(sk, "Experience") === 64, sk.axes.Experience);
  check("skills: Suggestion and the three language parts pool across units (maxima 2+2, 2+3, 2+3, 1+1)", sk.axes.Suggestion.max === 4 && sk.axes.Grammar.max === 5 && sk.axes.Vocabulary.max === 5 && sk.axes.Fluency.max === 2);
  check("skills: Experience sub-skills are pooled by label (Relevance 4/4 incl. Depth only from Unit 2)", sk.sub["Relevance"].points === 4 && sk.sub["Relevance"].max === 4 && sk.sub["Depth & Development Across Both Answers"].max === 2 && Object.keys(sk.sub).length === 6, sk.sub);
  check("skills: used 2, nothing excluded, nothing adjusted", sk.used === 2 && sk.excluded === 0 && !sk.adjusted && sk.staffMarked === 0);

  const q1Off = skillsOfRounds([off(r1()), r23()]);
  check("offline: a part marked only by the offline estimate is left out of the web", q1Off.used === 1 && q1Off.excluded === 1 && !q1Off.axes.Thought && !q1Off.axes.Reason && q1Off.axes.Experience.max === 16, q1Off);
  const allOff = skillsOfRounds([off(r1()), off(r23())]);
  check("offline: a fully offline attempt contributes nothing, and says how many parts it left out", allOff.used === 0 && allOff.excluded === 2 && Object.keys(allOff.axes).length === 0);

  // teacher override of an offline round -> counts, spread over the criteria
  const ov = skillsOfRounds([off(r1({ score: 10, overridden: true, originalScore: 18 })), r23()]);
  check("override: a teacher-marked offline round counts toward the web (and is reported as such)", ov.used === 2 && ov.excluded === 0 && ov.staffMarked === 1 && ov.adjusted === true);
  const q1Only = skillsOfRounds([off(r1({ score: 10, overridden: true, originalScore: 18 }))]);
  const sum = Object.values(q1Only.axes).reduce((s, a) => s + a.points, 0);
  check("override: spread keeps the sum of all criteria equal to the override score (10 of 25)", Math.abs(sum - 10) < 0.06, sum);
  check("override: no criterion goes above its maximum", ["Thought", "Reason", "Evidence", "Experience", "Suggestion", "Grammar", "Vocabulary", "Fluency"].every((k) => q1Only.axes[k].points <= q1Only.axes[k].max + 1e-9));
  const up = skillsOfRounds([r1({ score: 25, overridden: true, originalScore: 18 })]);
  check("override: raising an AI-marked round to full marks lifts every skill to 100%", Object.keys(up.axes).every((k) => pctOf(up, k) === 100), Object.keys(up.axes).map((k) => k + pctOf(up, k)));
  const down = skillsOfRounds([r1({ score: 9, overridden: true, originalScore: 18 })]);
  check("override: lowering an AI-marked round lowers the skills in proportion (Thought 100% -> 50%)", pctOf(down, "Thought") === 50 && pctOf(down, "Experience") === 33, [pctOf(down, "Thought"), pctOf(down, "Experience")]);
  check("override: Experience sub-skills follow the same scaling", down.sub["Relevance"].points === 1 && down.sub["Relevance"].max === 2, down.sub);
  const zeros = skillsOfRounds([off(r1({ score: 5, overridden: true, breakdown: r1().breakdown.map((b) => ({ ...b, points: 0 })) }))]);
  check("override: an all-zero estimate is shared out by each criterion's maximum, never NaN", Object.values(zeros.axes).every((a) => Number.isFinite(a.points)) && Math.abs(Object.values(zeros.axes).reduce((s, a) => s + a.points, 0) - 5) < 0.06);
  const same = skillsOfRounds([r1({ score: 18, overridden: true, originalScore: 18 })]);
  check("override: an override that equals the AI's own score changes nothing (not flagged adjusted)", same.adjusted === false && pctOf(same, "Experience") === 67);
  // a re-mark after an override keeps the old flags on the round but the AI's own score: no more scaling
  const afterRemark = skillsOfRounds([r1({ score: 18, overridden: true, originalScore: 5, markedBy: "groq" })]);
  check("re-mark: once the AI has re-marked an overridden round the AI's own breakdown is used again", afterRemark.adjusted === false && pctOf(afterRemark, "Thought") === 100);

  const legacy = skillsOfRounds([0, 1, 2].map(() => ({ question: "Q", mode: "trees", score: 15, max: 25, breakdown: [crit("Thought", 1, 2), crit("Experience", 6, 12)], feedback: "f" })));
  check("legacy: older untagged 3-round attempts (no markedBy) count as marked, all three rounds", legacy.used === 3 && legacy.axes.Thought.max === 6 && legacy.axes.Experience.points === 18);
  check("robust: junk input never throws", skillsOfRounds(null).used === 0 && skillsOfRounds([null, {}, { breakdown: "x" }, { breakdown: [null, { part: 5 }, { part: "Mystery", points: 1, max: 1 }, crit("Thought", 1, 0)] }]).used === 0);

  const scaled = scaleBreakdownToScore([crit("Thought", 2, 2), crit("Reason", 0, 2)], 3);
  check("scale: overflow is handed to the criteria with room (2/2 + 0/2 scaled to 3 -> 2 + 1)", scaled.length === 2 && scaled[0].points === 2 && Math.abs(scaled[1].points - 1) < 0.01, scaled.map((x) => x.points));
  check("scale: a target above the total maximum is clamped", scaleBreakdownToScore([crit("Thought", 1, 2)], 99)[0].points === 2);
}

// ======================== 2. buildSkillWeb (window, practice, deltas) ========================
{
  const mk = (id, at, rounds, practice) => ({ id, createdAt: at, practice: !!practice, skills: skillsOfRounds(rounds) });
  const goodHi = () => [r1({ breakdown: r1().breakdown.map((b) => ({ ...b, points: b.max })) }), r23()];
  const goodLo = () => [r1({ breakdown: r1().breakdown.map((b) => ({ ...b, points: 0 })) }), r23()];
  const entries = [];
  for (let i = 0; i < 5; i++) entries.push(mk("old" + i, T0 + i * DAY, goodLo()));
  for (let i = 0; i < 5; i++) entries.push(mk("new" + i, T0 + (10 + i) * DAY, goodHi()));
  const web = buildSkillWeb(entries, false);
  check("web: the last 5 usable attempts are 'now' and the 5 before are 'earlier'", web.n === 5 && web.nPrev === 5 && web.window === 5);
  check("web: Thought went from 0% to 100% (delta +100)", axis(web, "Thought").pct === 100 && axis(web, "Thought").prevPct === 0 && axis(web, "Thought").delta === 100, axis(web, "Thought"));
  check("web: the eight axes are always listed in the same order, even with no data", web.axes.map((a) => a.key).join() === "Thought,Reason,Evidence,Experience,Suggestion,Grammar,Vocabulary,Fluency");
  check("web: Experience sub-skills are listed with their own percentages", web.sub.length === 6 && web.sub[0].label === "Relevance");
  const one = buildSkillWeb(entries.slice(0, 3), false);
  check("web: with 3 attempts there is a 'now' and no 'earlier' outline, deltas are null", one.n === 3 && one.nPrev === 0 && one.axes.every((a) => a.prevPct === null && a.delta === null));
  const none = buildSkillWeb([], false);
  check("web: no attempts -> n 0, every skill null, nothing thrown", none.n === 0 && none.axes.length === 8 && none.axes.every((a) => a.pct === null) && none.sub.length === 0);

  const withPractice = [...entries.slice(0, 2), mk("pr", T0 + 40 * DAY, goodHi(), true)];
  check("practice: left out by default (counted attempts only)", buildSkillWeb(withPractice, false).n === 2 && buildSkillWeb(withPractice, false).practiceOnly === false);
  check("practice: included when asked", buildSkillWeb(withPractice, true).n === 3);
  const onlyPractice = [mk("p1", T0, goodHi(), true)];
  const po = buildSkillWeb(onlyPractice, false);
  check("practice: if practice is all there is, the web uses it and says so", po.n === 1 && po.practiceOnly === true);

  const mixed = [mk("a", T0, goodHi()), mk("b", T0 + DAY, [off(r1()), off(r23())]), mk("c", T0 + 2 * DAY, [off(r1()), r23()])];
  const mw = buildSkillWeb(mixed, false);
  check("offline: an all-offline attempt is not in the web; the number of parts left out is reported", mw.n === 2 && mw.excludedRounds === 3, [mw.n, mw.excludedRounds]);
  check("offline: the half-offline attempt still contributes its AI-marked unit only (no Thought from it)", axis(mw, "Thought").pct === 100 && axis(mw, "Experience").pct !== null);
}

// ======================== 3. series + API ========================
const mkRow = (o) => subRow({ rounds: o.rounds, ...o });
{
  const rows = [
    mkRow({ id: "s1", at: T0, rounds: [r1(), r23()] }),
    mkRow({ id: "s2", at: T0 + DAY, rounds: [off(r1()), r23()], degraded: true }),
  ];
  const out = computeProgressSeries(rows);
  check("series: every entry carries its skills", out.entries.every((e) => e.skills && typeof e.skills.used === "number"));
  check("series: summary has the web with and without practice", out.summary.skillWeb && out.summary.skillWebAll && out.summary.skillWeb.axes.length === 8);
  check("series: strongest / weakest ignore the offline-estimated part (Thought has only the AI-marked 2/2, not the estimate)", out.summary.criteria.find((c) => c.part === "Thought").n === 1);
  const withOv = computeProgressSeries([rows[0], mkRow({ id: "s2", at: T0 + DAY, rounds: [off(r1({ score: 6, overridden: true, originalScore: 18 })), r23()], degraded: true })]);
  check("series: after a teacher override the parts count in strongest / weakest too", withOv.summary.criteria.find((c) => c.part === "Thought").n === 2);
}

{
  const env = baseEnv();
  const subs = env.CCv6_DB._state.submissions;
  subs.push(mkRow({ id: "j1", name: "Jovan", cls: "5ig", at: T0, rounds: [r1(), r23()] }));
  subs.push(mkRow({ id: "j2", name: "Jovan", cls: "5ig", at: T0 + DAY, rounds: [off(r1({ markedBy: "fallback" })), off(r23())], degraded: true }));
  subs.push(mkRow({ id: "m1", name: "Mei", cls: "5ig", at: T0, rounds: [r1(), r23()] }));

  let r = await get(env, "/api/pupil/progress", "pup1");
  const web = r.data.summary.skillWeb;
  check("API: My Progress carries the skill web; the all-offline attempt is not in it and is counted as left out", r.status === 200 && web.n === 1 && web.excludedRounds === 2, web);
  check("API: per-attempt skills are there for the result screen", r.data.entries.every((e) => e.skills && e.skills.axes));
  check("API: still no teacher-only words in the pupil's progress (coach use, override details, notes)", !/coachUsed|overriddenBy|originalScore|overriddenAt|teacher|comment/i.test(JSON.stringify(r.data)));

  // --- teacher override updates the web ---
  r = await post(env, "/api/teacher/submissions/j2/override-score", "admin", { roundIndex: 0, score: 20, feedback: "ok" });
  check("override: the teacher override request succeeds", r.status === 200, r.data);
  check("override: the response's submission already carries the new skills", r.data.submission.skills.used === 1 && r.data.submission.skills.staffMarked === 1 && r.data.submission.skills.excluded === 1, r.data.submission.skills);
  r = await get(env, "/api/pupil/progress", "pup1");
  const afterOv = r.data.summary.skillWeb;
  check("override: the pupil's web now includes the teacher-marked part (2 attempts) and left-out parts drop to 1", afterOv.n === 2 && afterOv.excludedRounds === 1 && afterOv.staffMarked === 1, afterOv);
  const thoughtA = axis(afterOv, "Thought").pct;
  r = await post(env, "/api/teacher/submissions/j2/override-score", "admin", { roundIndex: 0, score: 5, feedback: "lower" });
  r = await get(env, "/api/pupil/progress", "pup1");
  const afterOv2 = r.data.summary.skillWeb;
  check("override: changing the override again moves the web (Thought falls)", axis(afterOv2, "Thought").pct < thoughtA, [thoughtA, axis(afterOv2, "Thought").pct]);
  // an override on an AI-marked unit also moves it
  r = await post(env, "/api/teacher/submissions/j1/override-score", "admin", { roundIndex: 0, score: 25, feedback: "great" });
  r = await get(env, "/api/pupil/progress", "pup1");
  check("override: overriding an AI-marked unit upward lifts that skill too", axis(r.data.summary.skillWeb, "Reason").pct > axis(afterOv2, "Reason").pct, [axis(afterOv2, "Reason").pct, axis(r.data.summary.skillWeb, "Reason").pct]);

  // --- who sees skills ---
  r = await get(env, "/api/submissions/j1", "pup1");
  check("own result: the pupil's own submission carries skills", r.status === 200 && r.data.submission.skills && r.data.submission.skills.axes.Thought);
  r = await get(env, "/api/teacher/submissions/j1", "admin");
  check("teacher detail: the submission carries skills too", r.status === 200 && r.data.submission.skills && r.data.submission.skills.used === 2, r.data);
  const sample = { id: "x", rounds: [r1(), r23()], skills: { fake: true } };
  const peer = redactForPupil(sample, false), mine = redactForPupil(sample, true);
  check("redact: peer copy has no skills; owner copy is recomputed from the rounds, not trusted", !("skills" in peer) && mine.skills.axes.Thought && !mine.skills.fake);
}

// ======================== 4. AI re-mark updates the web (real re-mark path) ========================
{
  __resetAiHealthForTests();
  const goodU1 = () => ({ breakdown: [
    { part: "Thought", points: 2, max: 2 }, { part: "Reason", points: 2, max: 2 }, { part: "Evidence", points: 1, max: 2 },
    { part: "Experience", points: 8, max: 12, subBreakdown: [{ label: "Relevance", points: 2, max: 2 }, { label: "5W1H Specificity", points: 3, max: 6 }, { label: "Authenticity / Personal Voice", points: 2, max: 2 }, { label: "Clarity & Sequence", points: 1, max: 1 }, { label: "Reflection / Lesson Learnt", points: 0, max: 1 }] },
    { part: "Suggestion", points: 2, max: 2 }, { part: "Grammar Accuracy", points: 2, max: 2 }, { part: "Vocabulary Range & Appropriateness", points: 1, max: 2 }, { part: "Fluency & Delivery", points: 1, max: 1 }],
    feedback: "Nicely done.", suggestion: "Add more detail.", modelAnswer: new Array(90).fill("word").join(" ") + "." });
  global.fetch = async (url) => (String(url).includes("groq.com")
    ? { ok: true, status: 200, headers: { get: () => null }, text: async () => "", json: async () => ({ choices: [{ message: { content: JSON.stringify(goodU1()) } }] }) }
    : { ok: false, status: 500, headers: { get: () => null }, text: async () => "down", json: async () => ({}) });
  const env = baseEnv({ GROQ_API_KEY: "k" });
  env.CCv6_DB._state.topics.push({ id: "topic_1", title: "Helping Others", image_url: "", image_description: "d", questions: JSON.stringify(["Q1?", "Q2?", "Q3?"]), tags: "[]", coach: "[]", created_at: 1, sort_order: null });
  const subs = env.CCv6_DB._state.submissions;
  subs.push(mkRow({ id: "rm1", name: "Jovan", cls: "5ig", at: T0, rounds: [off(r1({ breakdown: r1().breakdown.map((b) => ({ ...b, points: 0 })) })), r23()], degraded: true }));
  let r = await get(env, "/api/pupil/progress", "pup1");
  check("re-mark: before, the offline Question 1 part is not in the web (no Thought data)", axis(r.data.summary.skillWeb, "Thought").pct === null && r.data.summary.skillWeb.excludedRounds === 1);
  r = await post(env, "/api/submissions/rm1/remark", "pup1", { roundIndex: 0 });
  check("re-mark: the AI re-mark succeeds", r.status === 200 && r.data.success === true, r.data);
  check("re-mark: the response already carries the new skills (Thought 100%, nothing left out)", r.data.submission.skills.excluded === 0 && pctOf(r.data.submission.skills, "Thought") === 100, r.data.submission && r.data.submission.skills);
  r = await get(env, "/api/pupil/progress", "pup1");
  const w2 = r.data.summary.skillWeb;
  check("re-mark: the progress web now has the AI-marked Question 1 skills and no 'left out' note", axis(w2, "Thought").pct === 100 && axis(w2, "Reason").pct === 100 && axis(w2, "Evidence").pct === 50 && w2.excludedRounds === 0, w2.axes.map((a) => a.key + ":" + a.pct));
  global.fetch = undefined;
}

// ======================== 5. teacher pupil report ========================
{
  const env = baseEnv();
  const subs = env.CCv6_DB._state.submissions;
  const hi = () => [r1({ breakdown: r1().breakdown.map((b) => ({ ...b, points: b.max })) }), r23()];
  const lo = () => [r1({ breakdown: r1().breakdown.map((b) => ({ ...b, points: 0 })) }), r23()];
  for (let i = 0; i < 6; i++) subs.push(mkRow({ id: "lo" + i, name: "Jovan", cls: "5ig", at: T0 + i * DAY, rounds: lo() }));
  for (let i = 0; i < 6; i++) subs.push(mkRow({ id: "hi" + i, name: "Jovan", cls: "5ig", at: T0 + (20 + i) * DAY, rounds: hi() }));
  subs.push(mkRow({ id: "mei1", name: "Mei", cls: "5ig", at: T0 + 30 * DAY, rounds: hi() }));
  subs.push(mkRow({ id: "meiP", name: "Mei", cls: "5ig", at: T0 + 31 * DAY, rounds: lo(), practice: true }));
  subs.push(mkRow({ id: "ravi", name: "Ravi", cls: "6ha", at: T0 + 30 * DAY, rounds: lo() }));
  subs.push(mkRow({ id: "meiOff", name: "Mei", cls: "5ig", at: T0 + 32 * DAY, rounds: [off(r1()), off(r23())], degraded: true }));
  subs.push(mkRow({ id: "meiOv", name: "Mei", cls: "5ig", at: T0 + 33 * DAY, rounds: [off(r1({ score: 25, overridden: true, originalScore: 3 })), off(r23({ score: 25, overridden: true, originalScore: 3 }))], degraded: true }));

  let r = await get(env, "/api/teacher/pupil-progress?name=Jovan&class=5ig", "admin");
  const sw = r.data.skillWeb;
  check("report: has the latest window (5 attempts), the first window and a class average", r.status === 200 && sw.latest.n === 5 && sw.first && sw.first.n === 5 && sw.classAvg, sw);
  check("report: first window is the early weak attempts and latest the later strong ones (Thought 0% vs 100%)", sw.first.axes.find((a) => a.key === "Thought").pct === 0 && sw.latest.axes.find((a) => a.key === "Thought").pct === 100);
  check("report: class average pools the class's counted attempts (practice and other classes left out; offline-only left out; teacher-marked in)", sw.classAvg.n === 6 + 6 + 1 + 1, sw.classAvg.n);
  r = await get(env, "/api/teacher/pupil-progress?name=Ravi&class=6ha", "admin");
  check("report: another class's average is its own (one attempt)", r.data.skillWeb.classAvg.n === 1 && r.data.skillWeb.first === null);
  r = await get(env, "/api/teacher/pupil-progress?name=Jovan&class=5ig", "scoped-out");
  check("report: a teacher outside the class is still refused", r.status === 403);
  r = await get(env, "/api/teacher/pupil-progress?name=Jovan&class=5ig", "pup1");
  check("report: pupils cannot open it", r.status === 403);
}

// ======================== 6. class Insights ========================
{
  const env = baseEnv();
  const subs = env.CCv6_DB._state.submissions;
  subs.push(mkRow({ id: "a1", name: "Jovan", cls: "5ig", topic: "Helping Others", at: NOW - 3 * DAY, rounds: [r1(), r23()] }));
  subs.push(mkRow({ id: "a2", name: "Mei", cls: "5ig", topic: "My Hobby", at: NOW - 2 * DAY, rounds: [r1(), r23()] }));
  subs.push(mkRow({ id: "b1", name: "Ravi", cls: "6ha", topic: "Helping Others", at: NOW - 2 * DAY, rounds: [r1({ breakdown: r1().breakdown.map((b) => ({ ...b, points: 0 })) }), r23()] }));
  subs.push(mkRow({ id: "pp", name: "Mei", cls: "5ig", at: NOW - DAY, rounds: [r1(), r23()], practice: true }));
  subs.push(mkRow({ id: "offo", name: "Mei", cls: "5ig", at: NOW - DAY, rounds: [off(r1()), off(r23())], degraded: true }));
  subs.push(mkRow({ id: "tm", name: "Mei", cls: "5ig", topic: "Helping Others", at: NOW - DAY, rounds: [off(r1({ score: 25, overridden: true, originalScore: 4 })), r23()], degraded: true }));

  let r = await get(env, "/api/teacher/analytics", "admin");
  const w = r.data.skillWeb;
  check("insights: the skill web is there alongside the existing numbers", r.status === 200 && w && w.overall.length === 8 && typeof r.data.submissions === "number", Object.keys(r.data));
  check("insights: the existing figures still only use fully AI-marked, non-practice submissions (3)", r.data.submissions === 3, r.data.submissions);
  check("insights: the web also uses the teacher-marked part of a still-degraded submission (4 attempts), not practice, not all-offline", w.n === 4 && w.excludedRounds === 2, [w.n, w.excludedRounds]);
  check("insights: per class and per topic breakdowns with their own counts", w.byClass.find((c) => c.pupilClass === "5ig").n === 3 && w.byClass.find((c) => c.pupilClass === "6ha").n === 1 && w.byTopic.find((t) => t.topic === "Helping Others").n === 3, [w.byClass, w.byTopic.map((t) => t.topic + t.n)]);
  check("insights: 6ha's Thought is 0% and 5ig's is 100% (the web separates the classes)", w.byClass.find((c) => c.pupilClass === "6ha").axes.find((a) => a.key === "Thought").pct === 0 && w.byClass.find((c) => c.pupilClass === "5ig").axes.find((a) => a.key === "Thought").pct === 100);
  r = await get(env, "/api/teacher/analytics?class=5ig", "admin");
  check("insights: the class filter applies to the web", r.data.skillWeb.byClass.length === 1 && r.data.skillWeb.n === 3, r.data.skillWeb.byClass);
  r = await get(env, "/api/teacher/analytics", "scoped-in");
  check("insights: a class-scoped teacher only gets their own class in the web", r.data.skillWeb.byClass.every((c) => c.pupilClass === "5ig") && r.data.skillWeb.n === 3);
  r = await get(env, "/api/teacher/analytics?from=" + new Date(NOW - DAY).toISOString().slice(0, 10), "admin");
  check("insights: the date range applies to the web (only the teacher-marked attempt from the last day)", r.data.skillWeb.n === 1, r.data.skillWeb.n);
  r = await get(env, "/api/teacher/analytics", "pup1");
  check("insights: pupils cannot read it", r.status === 403);
}

summary("v7.10 backend");
