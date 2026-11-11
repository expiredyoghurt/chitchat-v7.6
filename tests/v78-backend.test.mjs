// v7.8 backend: computeProgressSeries, GET /api/pupil/progress (owner only), GET /api/submissions/:id (owner only).
import { check, summary, baseEnv, loginAll, get, post, subRow, q1Round, q23Round, crit } from "./_fake.mjs";
import { computeProgressSeries } from "../src/index.js";

loginAll();
const DAY = 86400000, T0 = Date.UTC(2026, 8, 1);

// ---- 1. computeProgressSeries ----
{
  const rows = [
    subRow({ id: "c", topic: "Helping Others", topicId: "t1", final: 20, at: T0 + 3 * DAY, q1: 21, q23: 19, retryOf: "a" }),
    subRow({ id: "a", topic: "Helping Others", topicId: "t1", final: 14, at: T0 + 1 * DAY, q1: 15, q23: 13 }),
    subRow({ id: "b", topic: "My Hobby", topicId: "t2", final: 18, at: T0 + 2 * DAY, practice: true }),
  ];
  const out = computeProgressSeries(rows);
  check("series: entries come back oldest first regardless of input order", out.entries.map((e) => e.id).join() === "a,b,c", out.entries.map((e) => e.id));
  check("series: each entry has per-unit scores and criteria", out.entries[0].units.length === 2 && out.entries[0].units[0].score === 15 && out.entries[0].criteria.length === 6);
  check("series: practice flag and retryOf carried", out.entries[1].practice === true && out.entries[2].retryOf === "a");
  check("series: personal best ignores practice when counted attempts exist", out.summary.best.id === "c" && out.summary.best.finalScore === 20, out.summary.best);
  check("series: most improved = largest gain on the SAME topic (14 -> 20, +6)", out.summary.mostImproved && out.summary.mostImproved.topicTitle === "Helping Others" && out.summary.mostImproved.gain === 6 && out.summary.mostImproved.from === 14 && out.summary.mostImproved.to === 20, out.summary.mostImproved);
  check("series: strongest and weakest criterion are different parts with percentages", out.summary.strongest && out.summary.weakest && out.summary.strongest.part !== out.summary.weakest.part && out.summary.strongest.pct >= out.summary.weakest.pct, [out.summary.strongest, out.summary.weakest]);
  check("series: attempts counts every row (practice included)", out.summary.attempts === 3);
}
{
  const empty = computeProgressSeries([]);
  check("series: no rows -> empty, no best, no crash", empty.entries.length === 0 && empty.summary.best === null && empty.summary.mostImproved === null && empty.summary.strongest === null && empty.summary.weakest === null);
  const legacyRounds = [0, 1, 2].map((i) => ({ question: "Q" + i, mode: "trees", answer: { parts: {} }, score: 15, max: 25, breakdown: [crit("Thought", 1, 2), crit("Experience", 6, 12)], feedback: "f" }));
  const mixed = computeProgressSeries([
    subRow({ id: "old", rounds: legacyRounds, final: 15, at: T0 }),
    subRow({ id: "bad", at: T0 + 10, extra: { rounds: "{not json" } }),
    subRow({ id: "new", final: 19, at: T0 + DAY }),
  ]);
  check("series: older untagged 3-round rows work; malformed rounds are skipped, not fatal", mixed.entries.map((e) => e.id).join() === "old,new" && mixed.entries[0].units.length === 3, mixed.entries.map((e) => e.id));
  check("series: aggregate uses percentages so old and v7.5+ attempts mix (Experience counted in all 3 old rounds + both new units)", mixed.summary.criteria.find((c) => c.part === "Experience").n === 5);
  const onlyPractice = computeProgressSeries([subRow({ id: "p1", practice: true, final: 12 })]);
  check("series: only practice attempts -> best falls back to practice, flagged as practice", onlyPractice.summary.best && onlyPractice.summary.best.practice === true);
  const flat = computeProgressSeries([subRow({ id: "x1", final: 10, at: T0 }), subRow({ id: "x2", final: 10, at: T0 + 1 })]);
  check("series: no gain -> no 'most improved'", flat.summary.mostImproved === null);
  const noMax = computeProgressSeries([subRow({ id: "z", final: 0, at: T0, rounds: [q1Round(0, { max: 0, breakdown: [crit("Thought", 0, 0)] })] })]);
  check("series: zero maxima never divide by zero", noMax.entries.length === 1 && noMax.summary.criteria.length === 0);
}

// ---- 2. GET /api/pupil/progress ----
{
  const env = baseEnv();
  const subs = env.CCv6_DB._state.submissions;
  subs.push(subRow({ id: "j1", name: "Jovan", cls: "5ig", at: T0, final: 12 }));
  subs.push(subRow({ id: "j2", name: "Jovan", cls: "5ig", at: T0 + DAY, final: 18, retryOf: "j1" }));
  subs.push(subRow({ id: "m1", name: "Mei", cls: "5ig", at: T0, final: 22 }));
  subs.push(subRow({ id: "j6", name: "Jovan", cls: "6ha", at: T0, final: 9 }));
  subs.push(subRow({ id: "j-arch", name: "Jovan", cls: "5ig", at: T0 + 2 * DAY, final: 16, archived: true }));

  let r = await get(env, "/api/pupil/progress");
  check("progress: not logged in -> 401", r.status === 401);
  r = await get(env, "/api/pupil/progress", "admin");
  check("progress: a teacher is refused (pupil page only) -> 403", r.status === 403);
  r = await get(env, "/api/pupil/progress", "pup1");
  check("progress: a pupil gets their own entries only (name + class), oldest first, archived ones included", r.status === 200 && r.data.entries.map((e) => e.id).join() === "j1,j2,j-arch", r.data.entries && r.data.entries.map((e) => e.id));
  check("progress: never includes a classmate or same-name pupil in another class", !JSON.stringify(r.data).includes("m1") && !JSON.stringify(r.data).includes("j6"));
  const blob = JSON.stringify(r.data);
  check("progress: no teacher-only data leaks (coach use, override details, comments, notes)", !/coachUsed|overriddenBy|originalScore|overriddenAt|teacher|comment/i.test(blob), blob.slice(0, 200));
  check("progress: carries what the tab needs (unit scores, criteria, retryOf, summary)", r.data.entries[1].units.length === 2 && r.data.entries[1].retryOf === "j1" && r.data.summary.mostImproved && r.data.summary.mostImproved.gain === 6);
  r = await get(env, "/api/pupil/progress?name=Mei&class=5ig", "pup1");
  check("progress: query-string tricks cannot show another pupil's data", r.status === 200 && r.data.entries.every((e) => e.id.startsWith("j")));
  r = await get(env, "/api/pupil/progress", "pup2");
  check("progress: another pupil sees only their own", r.data.entries.map((e) => e.id).join() === "m1");
  const empty = baseEnv();
  r = await get(empty, "/api/pupil/progress", "pup1");
  check("progress: a pupil with no history gets an empty, friendly payload (200)", r.status === 200 && r.data.entries.length === 0 && r.data.summary.attempts === 0);
  // newest-100 cap
  const big = baseEnv();
  for (let i = 0; i < 130; i++) big.CCv6_DB._state.submissions.push(subRow({ id: "b" + i, at: T0 + i * 1000, final: 10 }));
  r = await get(big, "/api/pupil/progress", "pup1");
  check("progress: capped to the latest 100, still oldest-first", r.data.entries.length === 100 && r.data.entries[0].id === "b30" && r.data.entries[99].id === "b129", [r.data.entries.length, r.data.entries[0] && r.data.entries[0].id]);
}

// ---- 3. GET /api/submissions/:id ----
{
  const env = baseEnv();
  const subs = env.CCv6_DB._state.submissions;
  subs.push(subRow({ id: "own1", name: "Jovan", cls: "5ig" }));
  subs.push(subRow({ id: "peer1", name: "Mei", cls: "5ig" }));
  subs.push(subRow({ id: "samename", name: "Jovan", cls: "6ha" }));
  let r = await get(env, "/api/submissions/own1");
  check("by-id: not logged in -> 401", r.status === 401);
  r = await get(env, "/api/submissions/own1", "admin");
  check("by-id: teachers use their own endpoints -> 403 here", r.status === 403);
  r = await get(env, "/api/submissions/own1", "pup1");
  check("by-id: owner gets it, with their marks (v7.7) but no coach / override data", r.status === 200 && r.data.submission.id === "own1" && r.data.submission.rounds[0].score === 15 && !/coachUsed|overriddenBy|originalScore|overriddenAt/.test(JSON.stringify(r.data)), JSON.stringify(r.data).slice(0, 160));
  r = await get(env, "/api/submissions/peer1", "pup1");
  check("by-id: a classmate's id answers 404 (same as 'does not exist'), no data", r.status === 404 && !JSON.stringify(r.data).includes("Mei"));
  r = await get(env, "/api/submissions/samename", "pup1");
  check("by-id: same name in ANOTHER class is not 'mine' -> 404", r.status === 404);
  r = await get(env, "/api/submissions/nope", "pup1");
  check("by-id: unknown id -> 404", r.status === 404);
  r = await get(env, "/api/submissions/mine", "pup1");
  check("by-id: /api/submissions/mine is not shadowed by the :id route", r.status === 200 && Array.isArray(r.data.submissions));
  r = await get(env, "/api/submissions/leaderboard", "pup1");
  check("by-id: /api/submissions/leaderboard is not shadowed either", r.status === 200 && Array.isArray(r.data.submissions));
}
summary("v7.8 backend");
