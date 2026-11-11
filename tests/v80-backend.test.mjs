// v8.0 backend: small skill shapes per pupil for the teacher's Pupils list.
import { check, summary, baseEnv, loginAll, get, post, subRow, crit } from "./_fake.mjs";
import { computePupilSkillMinis, skillsOfRounds } from "../src/index.js";

loginAll();
const DAY = 86400000, T0 = Date.now() - 60 * DAY;
const r1 = (pts, extra) => ({ unit: "q1", question: "Q1?", mode: "trees", answer: { parts: {} }, score: 12, max: 25,
  breakdown: [crit("Thought", pts, 2), crit("Reason", pts, 2), crit("Evidence", pts, 2), crit("Experience", pts * 4, 12), crit("Suggestion", pts, 2), crit("Grammar Accuracy", pts, 2), crit("Vocabulary Range & Appropriateness", pts, 2), crit("Fluency & Delivery", Math.min(pts, 1), 1)],
  feedback: "f", modelAnswer: "m", markedBy: "groq", ...(extra || {}) });
const off = (r) => ({ ...r, markedBy: "fallback" });
const row = (o) => subRow({ rounds: o.rounds, ...o });
const mk = (name, cls, at, rounds, practice) => ({ pupil_name: name, pupil_class: cls, created_at: at, rounds: JSON.stringify(rounds), practice: practice ? 1 : 0 });

// ---- pure function ----
{
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(mk("Jovan", "5ig", T0 + i * DAY, [r1(0)]));            // 6 weak
  for (let i = 0; i < 5; i++) rows.push(mk("jovan", "5IG", T0 + (10 + i) * DAY, [r1(2)]));       // 5 strong, same pupil spelled differently
  rows.push(mk("Mei", "5ig", T0, [off(r1(2))]));                                                     // offline only
  rows.push(mk("Ravi", "6ha", T0, [off(r1(2, { score: 25, overridden: true }))]));                 // teacher-marked offline
  const out = computePupilSkillMinis(rows);
  const jo = out.find((x) => x.name === "Jovan");
  check("minis: one entry per pupil, names / classes matched without regard to case", out.filter((x) => x.name.toLowerCase() === "jovan").length === 1 && out.length === 3, out.map((x) => x.name + x.pupilClass));
  check("minis: only the last 5 usable attempts count (the strong ones), 8 percentages in skill order", jo.n === 5 && jo.pcts.length === 8 && jo.pcts[0] === 100 && jo.pcts[3] === 67, jo);
  check("minis: a pupil with only offline-estimated marks has no shape yet (n 0, all null)", out.find((x) => x.name === "Mei").n === 0 && out.find((x) => x.name === "Mei").pcts.every((v) => v === null));
  check("minis: a teacher-marked offline attempt counts", out.find((x) => x.name === "Ravi").n === 1 && out.find((x) => x.name === "Ravi").pcts[0] !== null);
  check("minis: junk rounds never throw", computePupilSkillMinis([{ pupil_name: "x", pupil_class: "c", created_at: 1, rounds: "{not json" }, { pupil_name: "y", rounds: "[]", created_at: 2 }]).length === 1);
}

// ---- endpoint ----
{
  const env = baseEnv();
  const subs = env.CCv6_DB._state.submissions;
  subs.push(row({ id: "a", name: "Jovan", cls: "5ig", at: T0, rounds: [r1(2)] }));
  subs.push(row({ id: "b", name: "Mei", cls: "5ig", at: T0, rounds: [off(r1(2))], degraded: true }));
  subs.push(row({ id: "c", name: "Ravi", cls: "6ha", at: T0, rounds: [r1(1)] }));
  subs.push(row({ id: "d", name: "Jovan", cls: "5ig", at: T0 + DAY, rounds: [r1(0)], practice: true }));
  subs.push(row({ id: "e", name: "Old", cls: "5ig", at: T0, rounds: [r1(2)], archived: true }));
  let r = await get(env, "/api/teacher/pupil-skills", "admin");
  check("endpoint: admin gets one shape per pupil (non-practice, not archived)", r.status === 200 && r.data.pupils.length === 3 && !r.data.pupils.some((p) => p.name === "Old") && r.data.capped === false, r.data.pupils && r.data.pupils.map((p) => p.name));
  check("endpoint: the practice attempt did not change Jovan's shape (Thought stays 100%)", r.data.pupils.find((p) => p.name === "Jovan").pcts[0] === 100);
  check("endpoint: the offline-only pupil is listed with n 0", r.data.pupils.find((p) => p.name === "Mei").n === 0);
  check("endpoint: nothing beyond name, class, count and 8 percentages is sent", Object.keys(r.data.pupils[0]).sort().join() === "n,name,pcts,pupilClass");
  r = await get(env, "/api/teacher/pupil-skills?class=6ha", "admin");
  check("endpoint: the class filter applies", r.data.pupils.length === 1 && r.data.pupils[0].name === "Ravi");
  r = await get(env, "/api/teacher/pupil-skills", "scoped-in");
  check("endpoint: a class-scoped teacher only sees their own classes", r.status === 200 && r.data.pupils.length === 2 && r.data.pupils.every((p) => p.pupilClass === "5ig"), r.data.pupils);
  r = await get(env, "/api/teacher/pupil-skills?class=6ha", "scoped-in");
  check("endpoint: asking for a class outside their scope returns nothing", r.status === 200 && r.data.pupils.length === 0);
  r = await get(env, "/api/teacher/pupil-skills", "scoped-out");
  check("endpoint: a teacher with no overlapping class sees none of these pupils", r.status === 200 && r.data.pupils.every((p) => p.pupilClass !== "5ig"), r.data.pupils);
  r = await get(env, "/api/teacher/pupil-skills", "pup1");
  check("endpoint: pupils cannot call it", r.status === 403);
  r = await get(env, "/api/teacher/pupil-skills");
  check("endpoint: no login, no data", r.status === 401 || r.status === 403, r.status);

  // updates after an override (rebuilt on every request)
  r = await post(env, "/api/teacher/submissions/b/override-score", "admin", { roundIndex: 0, score: 20, feedback: "marked" });
  r = await get(env, "/api/teacher/pupil-skills", "admin");
  check("endpoint: after a teacher marks Mei's offline part her shape appears straight away", r.data.pupils.find((p) => p.name === "Mei").n === 1 && r.data.pupils.find((p) => p.name === "Mei").pcts[0] !== null, r.data.pupils.find((p) => p.name === "Mei"));
  r = await post(env, "/api/teacher/submissions/a/override-score", "admin", { roundIndex: 0, score: 3, feedback: "lower" });
  r = await get(env, "/api/teacher/pupil-skills", "admin");
  check("endpoint: after an override that lowers a score the pupil's shape shrinks", r.data.pupils.find((p) => p.name === "Jovan").pcts[0] < 100, r.data.pupils.find((p) => p.name === "Jovan").pcts);
}
summary("v8.0 backend");
