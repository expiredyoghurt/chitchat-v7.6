// v7.9 backend: migration detection, teacher notes, reviewed ticks, Needs-attention + bulk actions, linked retries,
// pupil report, analytics range/heatmap/weekly, dashboard alerts, alert settings, topic duplicate/reorder, coach templates, CSV.
import { check, summary, baseEnv, loginAll, get, post, call, subRow, q1Round, q23Round, crit } from "./_fake.mjs";
import { redactForPupil, attentionReasons, computeAnalyticsExtras } from "../src/index.js";

loginAll();
const DAY = 86400000, NOW = Date.now();
const topicRow = (id, title, extra) => ({ id, title, image_url: "", image_description: "", questions: JSON.stringify(["a", "b", "c"]), tags: "[]", coach: "[]", created_at: NOW - 100000, sort_order: null, ...(extra || {}) });
const noImproved = () => [q1Round(15, { modelAnswer: "" }), q23Round(15)];
const offline = () => [q1Round(15, { markedBy: "fallback", modelAnswer: "" }), q23Round(15)];
const coachy = () => [q1Round(15, { coachUsed: true }), q23Round(15, { coachUsed: true })];

// ================= teacher note + reviewed tick =================
{
  const env = baseEnv();
  const subs = env.CCv6_DB._state.submissions;
  subs.push(subRow({ id: "n1", name: "Jovan", cls: "5ig", at: NOW - 1000 }));
  subs.push(subRow({ id: "n2", name: "Mei", cls: "5ig", at: NOW - 2000 }));
  subs.push(subRow({ id: "other", name: "Ravi", cls: "6ha", at: NOW - 3000 }));

  let r = await post(env, "/api/teacher/submissions/n1/comment", null, { comment: "hi" });
  check("note: not logged in -> 403", r.status === 403);
  r = await post(env, "/api/teacher/submissions/n1/comment", "pup1", { comment: "hi" });
  check("note: a pupil cannot write notes -> 403", r.status === 403);
  r = await post(env, "/api/teacher/submissions/n1/comment", "scoped-out", { comment: "hi" });
  check("note: a teacher outside the pupil's class -> 403 and nothing stored", r.status === 403 && !subs[0].teacher_comment);
  r = await post(env, "/api/teacher/submissions/nope/comment", "admin", { comment: "hi" });
  check("note: unknown submission -> 404", r.status === 404);
  r = await post(env, "/api/teacher/submissions/n1/comment", "admin", { comment: "x".repeat(601) });
  check("note: over 600 characters -> 400, nothing stored", r.status === 400 && !subs[0].teacher_comment);
  r = await post(env, "/api/teacher/submissions/n1/comment", "scoped-in", { comment: "  Lovely detail about the canteen - now add how it ended.  " });
  check("note: a class teacher saves a (trimmed) note; who and when are recorded", r.status === 200 && subs[0].teacher_comment === "Lovely detail about the canteen - now add how it ended." && subs[0].comment_by === "mrslim" && subs[0].comment_at > 0, r.data);
  r = await get(env, "/api/submissions/n1", "pup1");
  check("note: the owning pupil sees the note text and date on their own result", r.status === 200 && r.data.submission.teacherComment && r.data.submission.teacherComment.text.startsWith("Lovely detail") && r.data.submission.teacherComment.at > 0, r.data.submission && r.data.submission.teacherComment);
  check("note: ...but not who wrote it, and never the review tick", !("by" in r.data.submission.teacherComment) && !("reviewedAt" in r.data.submission) && !("reviewedBy" in r.data.submission));
  r = await get(env, "/api/submissions/n1", "pup2");
  check("note: another pupil cannot read it (404)", r.status === 404 && !JSON.stringify(r.data).includes("Lovely"));
  const sample = { id: "x", rounds: [], teacherComment: { text: "secret", by: "t", at: 1 }, reviewedAt: 5, reviewedBy: "t" };
  const peer = redactForPupil(sample, false), own = redactForPupil(sample, true);
  check("note: a classmate's copy of a submission never carries the note or the tick (leaderboard view)", !("teacherComment" in peer) && !("reviewedAt" in peer) && own.teacherComment.text === "secret" && !("reviewedBy" in own), [peer, own]);
  r = await post(env, "/api/teacher/submissions/n1/comment", "admin", { comment: "   " });
  check("note: empty text removes the note", r.status === 200 && r.data.teacherComment === null && subs[0].teacher_comment === null);

  r = await post(env, "/api/teacher/submissions/n2/reviewed", "scoped-out", { reviewed: true });
  check("reviewed: out-of-class teacher -> 403", r.status === 403 && !subs[1].reviewed_at);
  r = await post(env, "/api/teacher/submissions/n2/reviewed", "scoped-in", { reviewed: true });
  check("reviewed: tick stores when and by whom", r.status === 200 && subs[1].reviewed_at > 0 && subs[1].reviewed_by === "mrslim");
  r = await post(env, "/api/teacher/submissions/n2/reviewed", "scoped-in", { reviewed: false });
  check("reviewed: untick clears it", r.status === 200 && subs[1].reviewed_at === null && subs[1].reviewed_by === null);
  r = await post(env, "/api/teacher/submissions/n2/reviewed", "pup2", { reviewed: true });
  check("reviewed: a pupil cannot tick -> 403", r.status === 403);
}

// ================= migration not yet run =================
{
  const env = baseEnv({}, { v79: false });
  const subs = env.CCv6_DB._state.submissions, topics = env.CCv6_DB._state.topics;
  subs.push(subRow({ id: "m1", name: "Jovan", cls: "5ig", rounds: offline() }));
  topics.push(topicRow("ta", "Topic A"), topicRow("tb", "Topic B"));
  let r = await post(env, "/api/teacher/submissions/m1/comment", "admin", { comment: "hello" });
  check("no migration: writing a note answers 409 with plain instructions (not a crash)", r.status === 409 && r.data.needsMigration === true && /v7_9\.sql/.test(r.data.error), r);
  r = await post(env, "/api/teacher/submissions/m1/reviewed", "admin", { reviewed: true });
  check("no migration: the reviewed tick answers 409 with the same instructions", r.status === 409 && r.data.needsMigration === true);
  r = await post(env, "/api/teacher/topics/reorder", "admin", { ids: ["tb", "ta"] });
  check("no migration: reordering topics answers 409", r.status === 409 && r.data.needsMigration === true);
  r = await get(env, "/api/topics", "pup1");
  check("no migration: the pupil's topic list still loads (old order)", r.status === 200 && r.data.topics.map((t) => t.id).filter((x) => /^t[a-c]$/.test(x)).join() === "ta,tb", r.data);
  r = await get(env, "/api/teacher/attention", "admin");
  check("no migration: Needs-attention still works and says review ticks are unavailable", r.status === 200 && r.data.items.length === 1 && r.data.reviewTracking === false, r.data);
  r = await post(env, "/api/teacher/attention/bulk", "admin", { ids: ["m1"], action: "reviewed" });
  check("no migration: bulk 'reviewed' answers 409; bulk 'archive' still works", r.status === 409 && (await post(env, "/api/teacher/attention/bulk", "admin", { ids: ["m1"], action: "archive" })).data.done === 1);
  r = await get(env, "/api/submissions/m1", "pup1");
  check("no migration: a pupil's own result still loads (no note, no crash)", r.status === 200 && r.data.submission.teacherComment === undefined);
  r = await get(env, "/api/teacher/analytics", "admin");
  check("no migration: analytics unaffected", r.status === 200);
}

// ================= Needs attention =================
{
  const env = baseEnv();
  const subs = env.CCv6_DB._state.submissions;
  const add = (o) => subs.push(subRow(o));
  add({ id: "ok", name: "A", cls: "5ig", at: NOW - 1 * 1000, final: 20 });
  add({ id: "off", name: "B", cls: "5ig", at: NOW - 2 * 1000, final: 15, rounds: offline(), degraded: true });
  add({ id: "flag", name: "C", cls: "5ig", at: NOW - 3 * 1000, final: 18, flagged: true });
  add({ id: "coach", name: "D", cls: "5ig", at: NOW - 4 * 1000, final: 18, rounds: coachy() });
  add({ id: "low", name: "E", cls: "5ig", at: NOW - 5 * 1000, final: 8 });
  add({ id: "noimp", name: "F", cls: "5ig", at: NOW - 6 * 1000, final: 18, rounds: noImproved() });
  add({ id: "multi", name: "G", cls: "5ig", at: NOW - 7 * 1000, final: 5, flagged: true, rounds: coachy() });
  add({ id: "reviewed", name: "H", cls: "5ig", at: NOW - 8 * 1000, final: 5, extra: { reviewed_at: NOW } });
  add({ id: "arch", name: "I", cls: "5ig", at: NOW - 9 * 1000, final: 5, archived: true });
  add({ id: "prac", name: "J", cls: "5ig", at: NOW - 10 * 1000, final: 5, practice: true });
  add({ id: "elsewhere", name: "K", cls: "6ha", at: NOW - 11 * 1000, final: 5 });

  let r = await get(env, "/api/teacher/attention");
  check("attention: not logged in -> 403", r.status === 403);
  r = await get(env, "/api/teacher/attention", "pup1");
  check("attention: a pupil -> 403", r.status === 403);
  r = await get(env, "/api/teacher/attention", "admin");
  const ids = r.data.items.map((i) => i.id);
  check("attention: lists offline / flagged / coach / low / missing-improved; skips healthy, reviewed, archived and practice", ["off", "flag", "coach", "low", "noimp", "multi", "elsewhere"].every((x) => ids.includes(x)) && !["ok", "reviewed", "arch", "prac"].some((x) => ids.includes(x)), ids);
  check("attention: the one with the most reasons comes first", ids[0] === "multi" && r.data.items[0].reasons.length >= 3, r.data.items[0]);
  const code = (id) => r.data.items.find((i) => i.id === id).reasons.map((x) => x.code).join();
  check("attention: reasons are named per item", code("off") === "offline" && code("flag") === "flagged" && code("coach") === "coach" && code("low") === "low" && code("noimp") === "noimproved", [code("off"), code("flag"), code("coach"), code("low"), code("noimp")]);
  check("attention: carries what the row needs (pupil, class, topic, score)", r.data.items[0].pupilName && r.data.items[0].pupilClass && r.data.items[0].topicTitle && r.data.items[0].maxScore === 25);
  r = await get(env, "/api/teacher/attention", "scoped-in");
  check("attention: a class teacher only sees their class", r.data.items.length > 0 && r.data.items.every((i) => i.pupilClass === "5ig") && !r.data.items.some((i) => i.id === "elsewhere"));
  r = await get(env, "/api/teacher/attention", "scoped-out");
  check("attention: and the other class teacher sees only theirs", r.data.items.map((i) => i.id).join() === "elsewhere");
  r = await get(env, "/api/teacher/attention?class=6ha", "admin");
  check("attention: the class filter narrows it", r.data.items.map((i) => i.id).join() === "elsewhere");
  r = await post(env, "/api/teacher/alert-settings", "admin", { settings: { lowScore: 6 } });
  const r2 = await get(env, "/api/teacher/attention?class=5ig", "admin");
  check("attention: the low-score threshold is the teacher's setting (6 -> 8/25 no longer low)", r.status === 200 && !r2.data.items.find((i) => i.id === "low"), r2.data.items.map((i) => i.id));
  check("attention: (unit) attentionReasons reads rounds the same way", attentionReasons({ rounds: [q1Round(10, { markedBy: "fallback" })], gradingDegraded: true, flagged: false, finalScore: 10, maxScore: 25 }, { lowScore: 10 }).map((x) => x.code).join() === "offline");
}

// ================= bulk actions =================
{
  const env = baseEnv();
  const subs = env.CCv6_DB._state.submissions;
  subs.push(subRow({ id: "b1", name: "A", cls: "5ig", rounds: offline(), degraded: true }));
  subs.push(subRow({ id: "b2", name: "B", cls: "5ig", rounds: noImproved() }));
  subs.push(subRow({ id: "b3", name: "C", cls: "5ig" }));
  subs.push(subRow({ id: "b4", name: "D", cls: "6ha" }));
  let r = await post(env, "/api/teacher/attention/bulk", "pup1", { ids: ["b1"], action: "archive" });
  check("bulk: a pupil -> 403", r.status === 403);
  r = await post(env, "/api/teacher/attention/bulk", "admin", { ids: ["b1"], action: "explode" });
  check("bulk: unknown action -> 400", r.status === 400);
  r = await post(env, "/api/teacher/attention/bulk", "admin", { ids: [], action: "archive" });
  check("bulk: no ids -> 400", r.status === 400);
  r = await post(env, "/api/teacher/attention/bulk", "admin", { ids: Array.from({ length: 11 }, (_, i) => "x" + i), action: "remark" });
  check("bulk: AI actions are limited to 10 ids a request", r.status === 400 && /10/.test(r.data.error));
  r = await post(env, "/api/teacher/attention/bulk", "admin", { ids: Array.from({ length: 101 }, (_, i) => "x" + i), action: "archive" });
  check("bulk: other actions are limited to 100", r.status === 400);
  r = await post(env, "/api/teacher/attention/bulk", "scoped-in", { ids: ["b3", "b4", "ghost"], action: "archive" });
  const byId = Object.fromEntries(r.data.results.map((x) => [x.id, x]));
  check("bulk archive: in-class ones archived; out-of-class and unknown ones refused with a reason, not silently", subs[2].archived === 1 && subs[3].archived === 0 && byId.b3.ok && !byId.b4.ok && /classes/.test(byId.b4.message) && !byId.ghost.ok && r.data.done === 1 && r.data.failed === 2, r.data);
  r = await post(env, "/api/teacher/attention/bulk", "scoped-in", { ids: ["b1", "b2"], action: "reviewed" });
  check("bulk reviewed: stamps each", r.data.done === 2 && subs[0].reviewed_at > 0 && subs[1].reviewed_by === "mrslim");
  r = await post(env, "/api/teacher/attention/bulk", "admin", { ids: ["b1"], action: "remark" });
  check("bulk remark: with the AI unavailable the row is reported as not done, with a plain message (and unchanged)", r.status === 200 && r.data.results[0].ok === false && /(unavailable|not available)/i.test(r.data.results[0].message) && JSON.parse(subs[0].rounds)[0].markedBy === "fallback", r.data);
  r = await post(env, "/api/teacher/attention/bulk", "admin", { ids: ["b3"], action: "remark" });
  check("bulk remark: a row with nothing offline is a harmless no-op", r.data.results[0].ok === true && /Nothing needed/.test(r.data.results[0].message));
  r = await post(env, "/api/teacher/attention/bulk", "admin", { ids: ["b2"], action: "retry-improved" });
  check("bulk retry-improved: with the AI unavailable it is reported, not faked", r.data.results[0].ok === false && /(unavailable|not available)/i.test(r.data.results[0].message) && JSON.parse(subs[1].rounds)[0].modelAnswer === "", r.data);
  r = await post(env, "/api/teacher/attention/bulk", "admin", { ids: ["b4"], action: "retry-improved" });
  check("bulk retry-improved: a row that already has its improved answers is a no-op", r.data.results[0].ok === true && /Nothing needed/.test(r.data.results[0].message));
}

// ================= linked first/second try =================
{
  const env = baseEnv();
  const subs = env.CCv6_DB._state.submissions;
  subs.push(subRow({ id: "f1", name: "Jovan", cls: "5ig", at: NOW - 5000, final: 12 }));
  subs.push(subRow({ id: "f2", name: "Jovan", cls: "5ig", at: NOW - 1000, final: 18, retryOf: "f1" }));
  subs.push(subRow({ id: "solo", name: "Mei", cls: "5ig" }));
  subs.push(subRow({ id: "x1", name: "Ravi", cls: "6ha", at: NOW - 5000 }));
  subs.push(subRow({ id: "x2", name: "Ravi", cls: "6ha", at: NOW - 1000, retryOf: "x1" }));
  let r = await get(env, "/api/teacher/submissions/f2/linked", "scoped-in");
  check("linked: from the second try -> the first try", r.status === 200 && r.data.relation === "this-is-second" && r.data.linked.id === "f1" && r.data.linked.rounds[0].score !== undefined);
  r = await get(env, "/api/teacher/submissions/f1/linked", "scoped-in");
  check("linked: from the first try -> the second try", r.data.relation === "this-is-first" && r.data.linked.id === "f2");
  r = await get(env, "/api/teacher/submissions/solo/linked", "admin");
  check("linked: a stand-alone attempt -> nothing linked", r.status === 200 && r.data.linked === null && r.data.relation === null);
  r = await get(env, "/api/teacher/submissions/x2/linked", "scoped-in");
  check("linked: another class's pair is refused -> 403", r.status === 403);
  r = await get(env, "/api/teacher/submissions/f1/linked", "pup1");
  check("linked: a pupil cannot use it -> 403", r.status === 403);
  r = await get(env, "/api/teacher/submissions/ghost/linked", "admin");
  check("linked: unknown id -> 404", r.status === 404);
}

// ================= one submission, for the teacher =================
{
  const env = baseEnv();
  env.CCv6_DB._state.submissions.push(subRow({ id: "s1", name: "Jovan", cls: "5ig" }), subRow({ id: "s2", name: "Ravi", cls: "6ha" }));
  let r = await get(env, "/api/teacher/submissions/s1", "scoped-in");
  check("one: a class teacher can open a submission from their class (full marks and coach data)", r.status === 200 && r.data.submission.id === "s1" && r.data.submission.rounds[0].coachUsed !== undefined);
  r = await get(env, "/api/teacher/submissions/s2", "scoped-in");
  check("one: another class's submission -> 403", r.status === 403);
  r = await get(env, "/api/teacher/submissions/s1", "pup1");
  check("one: a pupil -> 403", r.status === 403);
  r = await get(env, "/api/teacher/submissions/nope", "admin");
  check("one: unknown -> 404", r.status === 404);
  r = await get(env, "/api/teacher/submissions/export", "admin");
  check("one: /export is not swallowed by it", r.status === 200);
}

// ================= teacher report for one pupil =================
{
  const env = baseEnv();
  const subs = env.CCv6_DB._state.submissions;
  subs.push(subRow({ id: "p1", name: "Jovan", cls: "5ig", at: NOW - 3 * DAY, final: 12 }));
  subs.push(subRow({ id: "p2", name: "Jovan", cls: "5ig", at: NOW - 2 * DAY, final: 19, retryOf: "p1", extra: { teacher_comment: "Great improvement!", comment_by: "mrslim", comment_at: NOW } }));
  subs.push(subRow({ id: "p3", name: "Jovan", cls: "5ig", at: NOW - 1 * DAY, final: 17, practice: true }));
  subs.push(subRow({ id: "q1", name: "Mei", cls: "5ig", at: NOW - 1 * DAY, final: 20 }));
  let r = await get(env, "/api/teacher/pupil-progress?name=Jovan&class=5ig", "scoped-in");
  check("report: a class teacher gets the pupil's series, attempts, retries and notes", r.status === 200 && r.data.series.entries.length === 3 && r.data.attempts.length === 3 && r.data.retries.length === 1 && r.data.comments.length === 1, r.data && Object.keys(r.data));
  check("report: retry pair shows first -> second and the gain", r.data.retries[0].first === 12 && r.data.retries[0].second === 19 && r.data.retries[0].gain === 7);
  check("report: contains only that pupil, oldest first", r.data.attempts.map((a) => a.id).join() === "p1,p2,p3" && r.data.comments[0].comment === "Great improvement!");
  check("report: same summary the pupil sees (best, most improved)", r.data.series.summary.best.id === "p2" && r.data.series.summary.mostImproved.gain === 7);
  r = await get(env, "/api/teacher/pupil-progress?name=Jovan&class=5ig", "scoped-out");
  check("report: a teacher of another class -> 403", r.status === 403);
  r = await get(env, "/api/teacher/pupil-progress?name=Jovan&class=5ig", "pup1");
  check("report: a pupil -> 403 (they use /api/pupil/progress)", r.status === 403);
  r = await get(env, "/api/teacher/pupil-progress?class=5ig", "admin");
  check("report: missing name -> 400", r.status === 400);
  r = await get(env, "/api/teacher/pupil-progress?name=Nobody&class=5ig", "admin");
  check("report: a pupil with no attempts -> empty report, not an error", r.status === 200 && r.data.attempts.length === 0);
}

// ================= analytics: date range, heatmap, weekly, cap =================
{
  const env = baseEnv();
  const subs = env.CCv6_DB._state.submissions;
  const d = (y, m, day) => Date.UTC(y, m - 1, day, 5);
  subs.push(subRow({ id: "a1", cls: "5ig", topic: "Helping Others", at: d(2026, 9, 7), final: 10 }));   // Monday
  subs.push(subRow({ id: "a2", cls: "5ig", topic: "Helping Others", at: d(2026, 9, 9), final: 20 }));   // same week
  subs.push(subRow({ id: "a3", cls: "5ig", topic: "My Hobby", at: d(2026, 9, 15), final: 25 }));
  subs.push(subRow({ id: "a4", cls: "6ha", topic: "My Hobby", at: d(2026, 9, 16), final: 5 }));
  subs.push(subRow({ id: "a5", cls: "5ig", topic: "My Hobby", at: d(2026, 9, 16), final: 15, practice: true }));
  let r = await get(env, "/api/teacher/analytics", "admin");
  check("analytics: counts non-practice rows (practice excluded)", r.status === 200 && r.data.submissions === 4 && r.data.capped === false);
  check("analytics: weekly trend groups by Monday and averages as a percentage", r.data.weekly.length === 2 && r.data.weekly[0].weekStart === "2026-09-07" && r.data.weekly[0].n === 2 && r.data.weekly[0].avgPct === 60 && r.data.weekly[1].weekStart === "2026-09-14", r.data.weekly);
  check("analytics: heatmap has a row per topic with a % per criterion (null where it never applied)", r.data.heatmap.criteria.length > 0 && r.data.heatmap.topics.length === 2 && r.data.heatmap.topics[0].topic === "Helping Others" && r.data.heatmap.topics[0].cells.length === r.data.heatmap.criteria.length && r.data.heatmap.topics[0].cells.every((c) => c === null || (c >= 0 && c <= 100)), r.data.heatmap);
  r = await get(env, "/api/teacher/analytics?from=2026-09-10&to=2026-09-15", "admin");
  check("analytics: from/to (YYYY-MM-DD, inclusive of the whole 'to' day) narrow the window", r.data.submissions === 1 && r.data.range.from === Date.UTC(2026, 8, 10) && r.data.range.to === Date.UTC(2026, 8, 15) + DAY - 1, [r.data.submissions, r.data.range]);
  r = await get(env, "/api/teacher/analytics?from=" + d(2026, 9, 9) + "&to=" + d(2026, 9, 9), "admin");
  check("analytics: epoch-millisecond bounds work too", r.data.submissions === 1);
  r = await get(env, "/api/teacher/analytics?from=garbage", "admin");
  check("analytics: an unreadable date is ignored, not an error", r.status === 200 && r.data.submissions === 4);
  r = await get(env, "/api/teacher/analytics", "scoped-out");
  check("analytics: still class-scoped (the 6ha teacher sees only 6ha)", r.data.submissions === 1 && r.data.heatmap.topics.length === 1);
  const big = baseEnv();
  for (let i = 0; i < 2100; i++) big.CCv6_DB._state.submissions.push(subRow({ id: "g" + i, cls: "5ig", at: NOW - i * 1000, final: 15 }));
  r = await get(big, "/api/teacher/analytics", "admin");
  check("analytics: the window is 2000 submissions and says so when it was cut", r.data.submissions === 2000 && r.data.capped === true && r.data.window === 2000, [r.data.submissions, r.data.capped]);
  check("analytics: (unit) extras tolerate rows without dates or maxima", computeAnalyticsExtras([{ rounds: "[]", topic_title: "T" }, { rounds: "oops" }]).weekly.length === 0);
}

// ================= dashboard alerts + settings =================
{
  const env = baseEnv();
  const subs = env.CCv6_DB._state.submissions;
  for (let i = 0; i < 10; i++) subs.push(subRow({ id: "h" + i, cls: "5ig", at: NOW - (i + 1) * 60000, rounds: i < 3 ? offline() : undefined }));
  let r = await get(env, "/api/teacher/alerts", "pup1");
  check("alerts: a pupil -> 403", r.status === 403);
  r = await get(env, "/api/teacher/alerts", "admin");
  check("alerts: 3 of the last 10 marked offline raises the AI warning", r.status === 200 && r.data.alerts.some((a) => a.code === "fallback" && /3 of the last 10/.test(a.message)), r.data.alerts);
  check("alerts: it is not 'no AI at all' while other submissions were AI-marked", !r.data.alerts.some((a) => a.code === "no-ai"));
  check("alerts: provider usage counts each marked unit in the last day and week", r.data.providers.day.fallback === 3 && r.data.providers.day.groq === 17 && r.data.providers.week.groq === 17, r.data.providers);
  check("alerts: carries how many need attention", typeof r.data.attentionCount === "number" && r.data.attentionCount >= 3);
  await post(env, "/api/teacher/alert-settings", "admin", { settings: { fallbackCount: 4 } });
  r = await get(env, "/api/teacher/alerts", "admin");
  check("alerts: the threshold is a setting (4 -> 3 offline no longer alerts)", !r.data.alerts.some((a) => a.code === "fallback"), r.data.alerts);
  const env2 = baseEnv();
  for (let i = 0; i < 4; i++) env2.CCv6_DB._state.submissions.push(subRow({ id: "z" + i, cls: "5ig", at: NOW - (i + 1) * 3600000, rounds: offline() }));
  r = await get(env2, "/api/teacher/alerts", "admin");
  check("alerts: every recent submission offline -> 'none marked by AI' alert", r.data.alerts.some((a) => a.code === "no-ai") && r.data.alerts.some((a) => a.code === "fallback"), r.data.alerts);
  const quiet = baseEnv();
  r = await get(quiet, "/api/teacher/alerts", "admin");
  check("alerts: no submissions at all is quiet, not an alarm", r.status === 200 && r.data.alerts.length === 0);
  r = await get(env2, "/api/teacher/alerts", "scoped-out");
  check("alerts: scoped - a teacher with no pupils in the data sees nothing", r.data.alerts.length === 0 && r.data.attentionCount === 0);

  r = await get(env, "/api/teacher/alert-settings", "scoped-in");
  check("settings: any teacher can read the thresholds", r.status === 200 && r.data.settings.fallbackCount === 4 && r.data.defaults.lowScore === 10);
  r = await post(env, "/api/teacher/alert-settings", "scoped-in", { settings: { lowScore: 1 } });
  check("settings: only the super admin can change them", r.status === 403);
  r = await post(env, "/api/teacher/alert-settings", "admin", { settings: { lowScore: 99, fallbackCount: 0, noAiHours: "abc" } });
  check("settings: values are clamped / defaulted", r.data.settings.lowScore === 25 && r.data.settings.fallbackCount === 1 && r.data.settings.noAiHours === 24, r.data.settings);
}

// ================= topic tools + coach templates =================
{
  const env = baseEnv();
  const topics = env.CCv6_DB._state.topics;
  topics.push(topicRow("t1", "Helping Others", { created_at: NOW - 3000, coach: JSON.stringify([{ starters: ["Last week..."], resources: [] }]) }), topicRow("t2", "My Hobby", { created_at: NOW - 2000 }), topicRow("t3", "A Hero", { created_at: NOW - 1000 }));
  let r = await get(env, "/api/topics", "pup1");
  const mine = (res) => res.data.topics.map((t) => t.id).filter((x) => /^t\d$/.test(x)).join();
  check("topics: default order is oldest first", mine(r) === "t1,t2,t3", mine(r));
  r = await post(env, "/api/teacher/topics/reorder", "scoped-in", { ids: ["t3", "t1", "t2"] });
  check("topics: reorder is super-admin only", r.status === 403);
  r = await post(env, "/api/teacher/topics/reorder", "admin", { ids: ["t3", "t1"] });
  check("topics: reorder saves positions", r.status === 200 && r.data.count === 2);
  r = await get(env, "/api/topics", "pup1");
  check("topics: pupils then see the teacher's order first; never-ordered topics follow", mine(r) === "t3,t1,t2" && r.data.topics.map((t) => t.id).indexOf("t2") < r.data.topics.map((t) => t.id).indexOf("keeping-school-clean"), r.data.topics.map((t) => t.id));
  r = await post(env, "/api/teacher/topics/reorder", "admin", { ids: [] });
  check("topics: reorder with nothing -> 400", r.status === 400);
  r = await post(env, "/api/teacher/topics/t1/duplicate", "scoped-in");
  check("topics: duplicate is super-admin only", r.status === 403);
  r = await post(env, "/api/teacher/topics/nope/duplicate", "admin");
  check("topics: duplicating an unknown topic -> 404", r.status === 404);
  r = await post(env, "/api/teacher/topics/t1/duplicate", "admin");
  const copy = r.data.topic;
  check("topics: duplicate makes a new topic '(copy)' with the same questions and coach tips, new id", r.status === 200 && copy.id !== "t1" && copy.title === "Helping Others (copy)" && copy.questions.length === 3 && copy.coach[0].starters[0] === "Last week..." && topics.some((t) => t.id === copy.id), r.data);
  check("topics: the original is untouched", topics.find((t) => t.id === "t1").title === "Helping Others");

  r = await get(env, "/api/teacher/coach-templates", "pup1");
  check("templates: a pupil cannot read them -> 403", r.status === 403);
  r = await get(env, "/api/teacher/coach-templates", "scoped-in");
  check("templates: a teacher gets saved + built-in suggestions (none saved yet)", r.status === 200 && r.data.templates.length === 0 && r.data.builtin.length >= 3 && r.data.builtin.every((t) => t.builtin && ["starters", "story", "lesson"].includes(t.kind)));
  r = await post(env, "/api/teacher/coach-templates", "scoped-in", { templates: [] });
  check("templates: only the super admin can save them", r.status === 403);
  r = await post(env, "/api/teacher/coach-templates", "admin", { templates: [
    { name: "  Canteen starters ", kind: "starters", lines: ["At recess I...", "  ", "In the canteen..."] },
    { name: "bad kind", kind: "nope", lines: ["x"] },
    { name: "", kind: "story", lines: ["x"] },
    { name: "no lines", kind: "lesson", lines: [] },
    { id: "builtin-sneaky", name: "Sneaky", kind: "lesson", lines: ["keep me out of the builtin id space"] },
  ] });
  check("templates: invalid ones are dropped, names/lines trimmed, ids generated (never 'builtin-')", r.status === 200 && r.data.templates.length === 2 && r.data.templates[0].name === "Canteen starters" && r.data.templates[0].lines.length === 2 && r.data.templates.every((t) => t.id && !t.id.startsWith("builtin-")), r.data);
  r = await get(env, "/api/teacher/coach-templates", "scoped-in");
  check("templates: saved ones come back for every teacher", r.data.templates.length === 2 && r.data.templates[0].kind === "starters");
  r = await get(env, "/api/topics", "pup1");
  check("templates: pupils never receive the template library", !JSON.stringify(r.data).includes("Canteen starters"));
}

// ================= CSV =================
{
  const env = baseEnv();
  env.CCv6_DB._state.submissions.push(subRow({ id: "c1", name: "Jovan", cls: "5ig", at: NOW, extra: { teacher_comment: 'Nice, "detail"', comment_by: "t", comment_at: NOW, reviewed_at: NOW } }));
  env.CCv6_DB._state.submissions.push(subRow({ id: "c2", name: "Mei", cls: "5ig", at: NOW - 5000 }));
  const res = await (await import("../src/index.js")).default.fetch(new Request("https://x.dev/api/teacher/submissions/export", { headers: { authorization: "Bearer admin" } }), env, {});
  const csv = await res.text();
  const lines = csv.split("\r\n");
  check("csv: header ends with teacherComment, reviewedAt", /,teacherComment,reviewedAt$/.test(lines[0]), lines[0].slice(-60));
  check("csv: the note is exported (quotes escaped) and the review time is ISO", lines[1].includes('"Nice, ""detail"""') && /\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(lines[1]), lines[1].slice(-90));
  check("csv: rows without a note keep the columns empty", /,,$/.test(lines[2]));
}
summary("v7.9 backend");
