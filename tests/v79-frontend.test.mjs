// v7.9 teacher UI + pupil note in jsdom.
import { JSDOM } from "jsdom";
import { PAGE_HTML } from "../src/frontend.js";

const results = [];
function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra))));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = async () => { for (let i = 0; i < 4; i++) await sleep(0); };

async function make(role, opts) {
  opts = opts || {};
  const dom = new JSDOM(PAGE_HTML, { runScripts: "dangerously", url: "https://example.com/", pretendToBeVisual: true, beforeParse(win) { win.Element.prototype.scrollIntoView = () => {}; win.scrollTo = () => {}; win.print = () => { win.__printed = (win.__printed || 0) + 1; }; } });
  const w = dom.window, doc = w.document;
  const a = { w, doc, log: [], respond: () => ({}) };
  w.fetch = (url, o) => {
    const body = o && o.body ? JSON.parse(o.body) : null;
    a.log.push({ url, method: (o && o.method) || "GET", body });
    let data = a.respond(url, body, (o && o.method) || "GET");
    if (data === undefined) data = {};
    if (/\/api\/teacher\/submissions\?/.test(url)) data = { submissions: [], total: 0, hasMore: false };
    if (/\/api\/leaderboard/.test(url)) data = { leaderboard: [] };
    return Promise.resolve({ ok: !data.__fail, json: () => Promise.resolve(data) });
  };
  w.confirm = () => true; w.alert = () => {}; w.prompt = () => "";
  w.URL.createObjectURL = (b) => { w.__blob = b; return "blob:x"; }; w.URL.revokeObjectURL = () => {};
  await new Promise((r) => (doc.readyState === "complete" ? r() : w.addEventListener("load", r)));
  w.state.token = "tok"; w.state.role = role;
  if (role === "teacher") { w.state.name = "palpatine"; w.state.isSuperAdmin = opts.super !== false; w.state.screen = "teacher"; w.state.teacherTab = "leaderboard"; w.state.classesList = ["5ig", "6ha"]; }
  else { w.state.name = "Jovan"; w.state.pupilClass = "5ig"; w.state.screen = "pupil"; w.state.pupilTab = "submissions"; }
  w.render();
  return a;
}
const click = (a, sel) => { const el = a.doc.querySelector(sel); if (!el) throw new Error("missing " + sel); el.click(); };
const app = (a) => a.doc.getElementById("app");
const last = (a, re) => a.log.filter((l) => re.test(l.url)).pop();

const crit = (part, points, max) => ({ part, points, max, note: "" });
const q1 = (score, e2, extra) => ({ unit: "q1", question: "Q1?", mode: "trees", answer: { parts: { T: "t", R: "r", E1: "e1", E2: e2, S: "s" } }, score, max: 25, breakdown: [crit("Thought", 2, 2), crit("Experience", Math.round(score / 2), 12)], feedback: "fb1", suggestion: "", strengths: "", nextStep: "", modelAnswer: "Improved Q1 answer with new detail about the canteen.", markedBy: "groq", coachUsed: false, ...(extra || {}) });
const q23 = (score, a2, a3, extra) => ({ unit: "q2q3", questions: ["Q2?", "Q3?"], question: "q", mode: "trees", answers: [{ parts: { T: "", R: "", E1: "", E2: a2, S: "" } }, { parts: { T: "", R: "", E1: "", E2: a3, S: "" } }], score, max: 25, breakdown: [crit("Experience", Math.round(score * 0.6), 16), crit("Suggestion", 1, 2)], observed: [], feedback: "fb23", suggestion: "", strengths: "", nextStep: "", modelAnswer: "x", modelAnswers: ["Improved Q2 text.", "Improved Q3 text."], markedBy: "groq", coachUsed: false, ...(extra || {}) });
const sub = (id, final, rounds, extra) => ({ id, pupilName: "Jovan", pupilClass: "5ig", topicId: "t1", topicTitle: "Helping Others", mode: "trees", finalScore: final, maxScore: 25, practice: false, flagged: false, gradingDegraded: false, archived: false, retryOf: null, createdAt: Date.now(), teacherComment: null, reviewedAt: null, rounds, ...(extra || {}) });
const FIRST = sub("first", 14, [q1(12, "I shared lunch"), q23(16, "My friend fell", "He thanked me")]);
const SECOND = sub("second", 20, [q1(18, "Last week at school I shared my lunch with Mei"), q23(22, "Yesterday at the canteen Ali fell and I helped him", "He thanked me so I learnt")], { retryOf: "first" });

// ================= B6 banner + tab badge =================
{
  const a = await make("teacher");
  a.w.state.alerts = { alerts: [{ code: "fallback", level: "warn", message: "3 of the last 10 submissions were marked offline instead of by AI." }], providers: { day: { groq: 5, fallback: 3 }, week: { groq: 20, fallback: 3 } }, attentionCount: 4, settings: {} };
  a.w.render();
  check("alerts: a visible warning banner (role=alert) with the message", !!app(a).querySelector('.alert-banner[role="alert"]') && /3 of the last 10/.test(app(a).textContent));
  check("alerts: the Needs attention tab shows how many", /Needs attention \(4\)/.test(app(a).textContent));
  click(a, '[data-action="dismiss-alerts"]'); await tick();
  check("alerts: dismissing hides the banner for the session", !app(a).querySelector(".alert-banner") && a.w.state.alertsDismissed === true);
  const alertsData = a.w.state.alerts;
  a.respond = (url) => (/\/alerts/.test(url) ? alertsData : (/ai-health/.test(url) ? { candidates: [] } : {}));
  click(a, '.tab[data-tab="aihealth"]'); await tick();
  check("alerts: opening AI Health refreshes the alerts", a.log.some((l) => /\/api\/teacher\/alerts/.test(l.url)));
  check("alerts: provider usage table lists markers with counts", /offline fallback/.test(app(a).textContent) && /groq/.test(app(a).textContent) && /20/.test(app(a).textContent));
  const b = await make("teacher"); b.w.state.alerts = { alerts: [], providers: { day: {}, week: {} }, attentionCount: 0 }; b.w.render();
  check("alerts: no alerts -> no banner, no count", !app(b).querySelector(".alert-banner") && !/Needs attention \(/.test(app(b).textContent));
}

// ================= B1 Needs attention =================
{
  const a = await make("teacher");
  const items = [
    { id: "i1", pupilName: "Jovan", pupilClass: "5ig", topicTitle: "Helping Others", finalScore: 8, maxScore: 25, createdAt: Date.now(), reasons: [{ code: "offline", label: "Marked offline - needs an AI re-mark" }, { code: "low", label: "Low score (8 / 25)" }] },
    { id: "i2", pupilName: "Mei", pupilClass: "5ig", topicTitle: "My Hobby", finalScore: 18, maxScore: 25, createdAt: Date.now(), reasons: [{ code: "noimproved", label: "Improved answer missing" }] },
    { id: "i3", pupilName: "Ravi", pupilClass: "6ha", topicTitle: "A Hero", finalScore: 22, maxScore: 25, createdAt: Date.now(), reasons: [{ code: "flagged", label: "Language was flagged" }] },
  ];
  a.respond = (url, body) => {
    if (/\/api\/teacher\/attention\/bulk/.test(url)) return { ok: true, results: body.ids.map((id) => ({ id, ok: id !== "i2", message: id === "i2" ? "The AI is currently not available." : "Done." })), done: 1, failed: 0 };
    if (/\/api\/teacher\/attention/.test(url)) return { items, total: 3, scanned: 10, settings: {}, reviewTracking: true };
    if (/\/api\/teacher\/alerts/.test(url)) return { alerts: [], providers: { day: {}, week: {} }, attentionCount: 3, settings: {} };
    if (/\/api\/teacher\/submissions\/i1\/linked/.test(url)) return { relation: null, linked: null };
    if (/\/api\/teacher\/submissions\/i1$/.test(url)) return { submission: sub("i1", 8, [q1(8, "x"), q23(8, "a", "b")], { gradingDegraded: true }) };
    return {};
  };
  click(a, '.tab[data-tab="attention"]'); await tick();
  check("attention: the tab loads the queue", !!last(a, /\/api\/teacher\/attention$/) && app(a).querySelectorAll(".att-row").length === 3);
  const first = app(a).querySelector(".att-row").textContent;
  check("attention: each row names the pupil, topic, score and every reason as words", /Jovan/.test(first) && /Helping Others/.test(first) && /8\/25/.test(first) && /Marked offline/.test(first) && /Low score/.test(first));
  check("attention: checkboxes are large and labelled (touch + screen reader)", Array.from(app(a).querySelectorAll(".att-check")).every((c) => /Select /.test(c.getAttribute("aria-label"))));
  check("attention: no bulk bar until something is selected", !app(a).querySelector(".att-bulk"));
  a.doc.querySelector('[data-action="att-select"][data-id="i1"]').click(); await tick();
  a.doc.querySelector('[data-action="att-select"][data-id="i2"]').click(); await tick();
  const bulk = app(a).querySelector(".att-bulk");
  check("attention: selecting shows the bulk bar with the four actions", bulk && /2 selected/.test(bulk.textContent) && ["remark", "retry-improved", "reviewed", "archive"].every((x) => bulk.querySelector('[data-bulk="' + x + '"]')));
  a.log.length = 0;
  click(a, '[data-bulk="remark"]'); await sleep(60); await tick();
  const bulkCalls = a.log.filter((l) => /attention\/bulk/.test(l.url));
  check("attention: AI actions go one submission per request (so one slow AI call cannot stall the rest)", bulkCalls.length === 2 && bulkCalls.every((c) => c.body.ids.length === 1 && c.body.action === "remark"), bulkCalls.map((c) => c.body));
  check("attention: the outcome lists what did not work, by pupil and topic, in words", /AI re-marked 1 of 2/.test(app(a).textContent) && /Mei \(5ig\) - My Hobby: The AI is currently not available/.test(app(a).textContent), app(a).querySelector(".att-msg") && app(a).querySelector(".att-msg").textContent);
  check("attention: selection clears and the queue reloads afterwards", Object.keys(a.w.state.attSel).length === 0 && a.log.filter((l) => /\/api\/teacher\/attention$/.test(l.url)).length >= 1);
  a.doc.querySelector('[data-action="att-select-all"]').click(); await tick();
  a.log.length = 0;
  click(a, '[data-bulk="archive"]'); await sleep(60); await tick();
  const arch = a.log.filter((l) => /attention\/bulk/.test(l.url));
  check("attention: archive asks first and sends all ids in ONE request", arch.length === 1 && arch[0].body.ids.length === 3 && arch[0].body.action === "archive");
  a.doc.querySelector('[data-action="att-select"][data-id="i1"]').click(); await tick();
  click(a, '[data-bulk="reviewed"]'); await sleep(60); await tick();
  check("attention: Mark reviewed uses the bulk endpoint too", a.log.filter((l) => /attention\/bulk/.test(l.url)).pop().body.action === "reviewed");
  a.doc.querySelector('[data-action="att-view"][data-id="i1"]').click(); await sleep(30); await tick();
  check("attention: View opens the full submission in the Submissions tab", a.w.state.teacherTab === "submissions" && a.w.state.viewingSubmission === "i1" && !!a.doc.getElementById("submissionDetail"));
  const empty = await make("teacher"); empty.respond = (url) => (/\/attention/.test(url) ? { items: [], total: 0, scanned: 5, settings: {}, reviewTracking: false } : {});
  click(empty, '.tab[data-tab="attention"]'); await tick();
  check("attention: empty queue says so kindly; explains reviewed ticks need the update when the migration is missing", /Nothing needs your attention/.test(app(empty).textContent) && /v7_9\.sql/.test(app(empty).textContent));
  const f = await make("teacher"); f.respond = (url) => (/\/attention/.test(url) ? { items, total: 3, scanned: 3, settings: {}, reviewTracking: true } : {});
  click(f, '.tab[data-tab="attention"]'); await tick();
  f.doc.getElementById("attClass").value = "6ha"; f.doc.getElementById("attClass").dispatchEvent(new f.w.Event("change", { bubbles: true })); await tick();
  check("attention: the class filter is sent to the server", f.log.some((l) => /attention\?class=6ha/.test(l.url)));
}

// ================= B2 note + reviewed, B4 comparison =================
{
  const a = await make("teacher");
  const mine = JSON.parse(JSON.stringify(SECOND));
  a.w.state.teacherTab = "submissions"; a.w.state.teacherSubs = [mine]; a.w.state.viewingSubmission = "second";
  a.respond = (url, body) => {
    if (/second\/linked/.test(url)) return { relation: "this-is-second", linked: JSON.parse(JSON.stringify(FIRST)) };
    if (/second\/comment/.test(url)) return { ok: true, teacherComment: body.comment ? { text: body.comment, by: "palpatine", at: Date.now() } : null };
    if (/second\/reviewed/.test(url)) return { ok: true, reviewedAt: body.reviewed ? Date.now() : null, reviewedBy: "palpatine" };
    if (/\/alerts/.test(url)) return { alerts: [], providers: { day: {}, week: {} }, attentionCount: 0 };
    return {};
  };
  a.w.ensureLinked("second"); a.w.render(); await tick();
  const note = a.doc.getElementById("noteText");
  check("note: the detail view has a note box (600 max) with a counter and a Reviewed tick", !!note && note.getAttribute("maxlength") === "600" && /0 \/ 600/.test(app(a).textContent) && !!app(a).querySelector('[data-action="toggle-reviewed"]'));
  note.value = "Lovely canteen detail!"; note.dispatchEvent(new a.w.Event("input", { bubbles: true }));
  check("note: the counter follows typing", a.doc.getElementById("noteCount").textContent === "22");
  a.w.render();
  check("note: a redraw (e.g. a list refresh) does not lose what the teacher typed", a.doc.getElementById("noteText").value === "Lovely canteen detail!");
  click(a, '[data-action="save-note"]'); await tick();
  const saved = last(a, /second\/comment/);
  check("note: Save posts the text to that submission", saved && saved.method === "POST" && saved.body.comment === "Lovely canteen detail!");
  check("note: after saving it shows who saved it, the Remove button appears, and the list row gets a note tag", /saved by palpatine/.test(app(a).textContent) && !!app(a).querySelector('[data-action="remove-note"]') && /note/.test(app(a).querySelector(".teacher-table").textContent));
  click(a, '[data-action="remove-note"]'); await tick();
  check("note: Remove sends an empty note", last(a, /second\/comment/).body.comment === "" && !app(a).querySelector('[data-action="remove-note"]'));
  a.doc.querySelector('[data-action="toggle-reviewed"]').click(); await tick();
  check("note: ticking Reviewed posts reviewed=true, shows a reviewed tag in the list, and refreshes the alert count", last(a, /second\/reviewed/).body.reviewed === true && /reviewed/.test(app(a).querySelector(".teacher-table").textContent) && a.log.some((l) => /\/alerts/.test(l.url)));
  a.respond = (url) => (/comment/.test(url) ? { __fail: true, error: "This feature needs the v7.9 database update. Run migrations/v7_9.sql." } : {});
  a.doc.getElementById("noteText").value = "again"; a.doc.getElementById("noteText").dispatchEvent(new a.w.Event("input", { bubbles: true }));
  click(a, '[data-action="save-note"]'); await tick();
  check("note: when the database update has not been run the teacher is told what to do, and keeps their text", /v7_9\.sql/.test(app(a).textContent) && a.doc.getElementById("noteText").value === "again");

  // comparison
  const box = Array.from(app(a).querySelectorAll(".card")).find((c) => /First try vs second try/.test(c.textContent));
  check("compare: a second try shows an overall first -> second line with the change", box && /14 \u2192 20/.test(box.textContent) && /\+6/.test(box.textContent), box && box.textContent.slice(0, 200));
  check("compare: and each unit with a per-criterion table (first, second, change)", box && /Unit 1 \(Q1\):\s*12 \u2192 18/.test(box.textContent) && /Unit 2 \(Q2\+Q3\):\s*16 \u2192 22/.test(box.textContent) && /Criterion/.test(box.textContent) && /Experience/.test(box.textContent));
  const tables = Array.from(app(a).querySelectorAll("table.resp-table"));
  check("compare: the response tables read First try | Second try | Improved response", tables.length === 2 && tables.every((t) => Array.from(t.querySelectorAll("th")).map((x) => x.textContent).join("|") === "First try|Second try|Improved response"));
  check("compare: an 'Open the first try' button is offered", !!app(a).querySelector('[data-action="open-linked"]') && /Open the first try/.test(app(a).textContent));
  a.respond = (url) => (/first\/linked/.test(url) ? { relation: "this-is-first", linked: JSON.parse(JSON.stringify(SECOND)) } : {});
  click(a, '[data-action="open-linked"]'); await tick();
  check("compare: opening the other attempt switches the detail to it", a.w.state.viewingSubmission === "first" && /Open the second try/.test(app(a).textContent));
  const lone = await make("teacher"); lone.w.state.teacherTab = "submissions"; lone.w.state.teacherSubs = [sub("solo", 15, [q1(15, "x"), q23(15, "a", "b")])]; lone.w.state.viewingSubmission = "solo"; lone.w.state.linkedCache = { solo: { relation: null, linked: null } }; lone.w.render();
  check("compare: a stand-alone attempt shows no comparison box and keeps the two-column table", !/First try vs second try/.test(app(lone).textContent) && /Your response/.test(app(lone).textContent));
}

// ================= pupil sees the note =================
{
  const a = await make("pupil");
  const own = sub("n1", 15, [q1(12, "x"), q23(16, "a", "b")], { teacherComment: { text: "Great detail. Now add how it ended.\nKeep going!", at: Date.UTC(2026, 9, 5) } });
  a.w.state.subsScope = "mine"; a.w.state.mySubmissions = [own]; a.w.state.viewingPupilSubmission = "n1"; a.w.render();
  const note = app(a).querySelector(".teacher-note");
  check("pupil: their own result shows 'Note from your teacher' with the date and the text (line breaks kept)", note && /Note from your teacher/.test(note.textContent) && /Great detail/.test(note.textContent) && /Keep going/.test(note.textContent) && note.getAttribute("role") === "note");
  const inj = sub("n2", 15, [q1(12, "x"), q23(16, "a", "b")], { teacherComment: { text: '<img src=x onerror="window.__pwn=1">hi', at: 1 } });
  a.w.state.mySubmissions = [inj]; a.w.state.viewingPupilSubmission = "n2"; a.w.render();
  check("pupil: a note is escaped, never run as HTML", !app(a).querySelector("img") && a.w.__pwn === undefined && /<img src=x/.test(app(a).querySelector(".teacher-note").textContent));
  a.w.state.mySubmissions = [sub("n3", 15, [q1(12, "x"), q23(16, "a", "b")])]; a.w.state.viewingPupilSubmission = "n3"; a.w.render();
  check("pupil: no note -> no note box", !app(a).querySelector(".teacher-note"));
  a.w.state.subsScope = "all"; a.w.state.lbSubmissions = [{ ...own, pupilName: "Mei", teacherComment: undefined }]; a.w.state.viewingPupilSubmission = "n1"; a.w.render();
  check("pupil: a classmate's entry (server strips the note) shows none", !app(a).querySelector(".teacher-note"));
}

// ================= B3 pupil report =================
{
  const a = await make("teacher");
  const rep = { pupil: { name: "Jovan", pupilClass: "5ig" }, generatedAt: Date.now(),
    series: { entries: [{ id: "a", createdAt: 1000, topicId: "t1", topicTitle: "Helping Others", finalScore: 12, maxScore: 25, practice: false, retryOf: null, units: [{ score: 12, max: 25 }], criteria: [] }, { id: "b", createdAt: 2000, topicId: "t1", topicTitle: "Helping Others", finalScore: 19, maxScore: 25, practice: false, retryOf: "a", units: [{ score: 19, max: 25 }], criteria: [] }, { id: "c", createdAt: 3000, topicId: "t2", topicTitle: "My Hobby", finalScore: 15, maxScore: 25, practice: true, retryOf: null, units: [{ score: 15, max: 25 }], criteria: [] }],
      summary: { attempts: 3, best: { id: "b", topicTitle: "Helping Others", finalScore: 19, maxScore: 25, practice: false }, strongest: { part: "Experience", pct: 80, n: 3 }, weakest: { part: "Suggestion", pct: 30, n: 3 }, criteria: [], mostImproved: { topicTitle: "Helping Others", from: 12, to: 19, max: 25, gain: 7, gainPct: 28 } } },
    attempts: [{ id: "a", createdAt: 1000, topicTitle: "Helping Others", finalScore: 12, maxScore: 25, practice: false, retryOf: null, units: [{ score: 12 }], comment: "" }, { id: "b", createdAt: 2000, topicTitle: "Helping Others", finalScore: 19, maxScore: 25, practice: false, retryOf: "a", units: [{ score: 19 }], comment: "Big jump!" }, { id: "c", createdAt: 3000, topicTitle: "My Hobby", finalScore: 15, maxScore: 25, practice: true, retryOf: null, units: [{ score: 15 }], comment: "" }],
    retries: [{ topicTitle: "Helping Others", firstId: "a", secondId: "b", first: 12, second: 19, max: 25, gain: 7 }], comments: [{ id: "b", createdAt: 2000, topicTitle: "Helping Others", comment: "Big jump!" }] };
  a.respond = (url) => (/pupil-progress/.test(url) ? rep : {});
  a.w.state.teacherTab = "pupils";
  a.w.state.teacherPupilView = { pupil: { name: "Jovan", pupilClass: "5ig", bestScore: 19, attempts: 3 }, history: [], strengths: [], concerns: [], rows: [] };
  a.w.render();
  click(a, '[data-action="load-pupil-report"]'); await tick();
  check("report: the button fetches /api/teacher/pupil-progress for that pupil", /pupil-progress\?name=Jovan&class=5ig/.test(last(a, /pupil-progress/).url));
  const r = a.doc.getElementById("pupilReport");
  check("report: shows best, strongest, weakest, most improved, second tries and teacher notes", r && /Personal best/.test(r.textContent) && /Strongest criterion: Experience/.test(r.textContent) && /Weakest criterion: Suggestion/.test(r.textContent) && /Most improved/.test(r.textContent) && /12 \u2192 19 \(\+7\)/.test(r.textContent) && /Big jump!/.test(r.textContent));
  check("report: one score line per topic, practice shown as a hollow dot", r.querySelectorAll("svg.spark").length === 2 && r.querySelectorAll('circle[fill="#fff"]').length === 1);
  check("report: has an all-attempts table", /All attempts/.test(r.textContent) && r.querySelectorAll("table tbody tr").length === 3);
  click(a, '[data-action="print-report"]');
  check("report: Print / save as PDF calls the browser print dialog", a.w.__printed === 1);
  check("report: print styles show only the report", /@media print/.test(a.doc.querySelector("style").textContent) && /#pupilReport/.test(a.doc.querySelector("style").textContent) && !!r.querySelector(".no-print"));
}

// ================= B5 insights =================
{
  const a = await make("teacher");
  const data = { submissions: 12, legacySubmissions: 0, avgFinal: 17, q1: { n: 12, avgScore: 16, criteria: [{ part: "Thought", avg: 1.5, max: 2, pct: 75 }] }, q2q3: { n: 12, avgScore: 18, criteria: [] }, focus: [], byClass: [{ pupilClass: "5ig", n: 12, avgFinal: 17 }], capped: true, window: 2000,
    heatmap: { criteria: ["Thought", "Suggestion"], topics: [{ topic: "Helping Others", n: 8, cells: [80, 30] }, { topic: "My Hobby", n: 4, cells: [60, null] }] },
    weekly: [{ weekStart: "2026-09-07", n: 5, avgPct: 60 }, { weekStart: "2026-09-14", n: 7, avgPct: 72 }], range: {} };
  a.respond = (url) => (/analytics/.test(url) ? data : {});
  a.w.state.teacherTab = "insights"; a.w.state.insights = data; a.w.render();
  const t = app(a).querySelector("table.heat");
  check("insights: topic x criterion heatmap with the number in every cell (not colour alone)", t && /80%/.test(t.textContent) && /30%/.test(t.textContent) && /60%/.test(t.textContent) && t.querySelectorAll("td")[7].textContent.trim() === "\u2013", t && t.textContent);
  check("insights: low / middle / high cells are shaded differently", /fbdcc0/.test(t.innerHTML) && /fff3c4/.test(t.innerHTML) && /d6efda/.test(t.innerHTML));
  check("insights: a weekly trend chart with a text fallback and numbers on demand", !!app(a).querySelector('svg.spark[aria-label*="Weekly"]') && /Show the numbers/.test(app(a).textContent) && /2026-09-14/.test(app(a).textContent));
  check("insights: says clearly when the window was cut at 2000", /more than 2000 submissions/.test(app(a).textContent));
  a.log.length = 0;
  const from = a.doc.getElementById("insFrom"); from.value = "2026-09-01"; from.dispatchEvent(new a.w.Event("change", { bubbles: true })); await tick();
  const to = a.doc.getElementById("insTo"); to.value = "2026-09-30"; to.dispatchEvent(new a.w.Event("change", { bubbles: true })); await tick();
  check("insights: From / To dates are sent to the server", /from=2026-09-01/.test(last(a, /analytics/).url) && /to=2026-09-30/.test(last(a, /analytics/).url), last(a, /analytics/).url);
  check("insights: the date boxes keep their values after the reload", a.doc.getElementById("insFrom").value === "2026-09-01" && a.doc.getElementById("insTo").value === "2026-09-30");
  click(a, '[data-action="export-insights-csv"]');
  const csv = await a.w.__blob.text();
  check("insights: CSV export of the heatmap (header, rows, blanks for n/a, quotes handled)", csv.split("\r\n")[0] === "Topic,Submissions,Thought,Suggestion" && csv.split("\r\n")[1] === "Helping Others,8,80,30" && csv.split("\r\n")[2] === "My Hobby,4,60,", csv);
}

// ================= B7 settings sub-tabs =================
{
  const a = await make("teacher");
  a.respond = (url) => (/alert-settings/.test(url) ? { settings: { lowScore: 10, fallbackCount: 3, noAiHours: 24 }, defaults: { lowScore: 10, fallbackCount: 3, noAiHours: 24 } } : (/coach-templates/.test(url) ? { templates: [{ id: "u1", name: "Canteen starters", kind: "starters", lines: ["At recess I..."] }], builtin: [{ id: "builtin-starters-1", builtin: true, name: "Story starters", kind: "starters", lines: ["Last week, I..."] }] } : {}));
  a.w.state.teacherTab = "settings"; a.w.state.rubricText = "Q1 BODY"; a.w.state.rubricQ2Q3Text = "Q2 BODY"; a.w.render();
  const tabs = Array.from(app(a).querySelectorAll('[data-action="settings-tab"]')).map((x) => x.textContent);
  check("settings: five sub-tabs: Marking, AI models, Alerts, Coach templates, Account", tabs.join("|") === "Marking|AI models|Alerts|Coach templates|Account", tabs);
  check("settings: opens on Marking with both rubric boxes and the test panel; the long page is split up", !!a.doc.getElementById("rubricText") && !!a.doc.getElementById("rubricQ2Q3Text") && !a.doc.getElementById("newPw") && !a.doc.getElementById("groqModelSelect"));
  check("settings: the active sub-tab is marked for screen readers", app(a).querySelector('[data-action="settings-tab"][data-tab="marking"]').getAttribute("aria-selected") === "true");
  click(a, '[data-action="settings-tab"][data-tab="models"]'); await tick();
  check("settings: AI models holds Groq and OpenRouter", !!a.doc.getElementById("groqModelSelect") && !!a.doc.getElementById("openrouterModelSelect") && !a.doc.getElementById("rubricText"));
  click(a, '[data-action="settings-tab"][data-tab="account"]'); await tick();
  check("settings: Account holds the password form", !!a.doc.getElementById("newPw") && !!app(a).querySelector('[data-action="change-password"]'));
  click(a, '[data-action="settings-tab"][data-tab="alerts"]'); await tick();
  check("settings: Alerts loads the thresholds into three number boxes", a.doc.getElementById("alLow").value === "10" && a.doc.getElementById("alFallback").value === "3" && a.doc.getElementById("alNoAi").value === "24");
  a.doc.getElementById("alLow").value = "8"; a.doc.getElementById("alFallback").value = "2";
  click(a, '[data-action="save-alert-settings"]'); await tick();
  const sv = last(a, /alert-settings/);
  check("settings: saving sends the numbers and confirms", sv.method === "POST" && sv.body.settings.lowScore === "8" && sv.body.settings.fallbackCount === "2" && /Saved\./.test(app(a).textContent));
  click(a, '[data-action="settings-tab"][data-tab="coach"]'); await tick();
  check("settings: Coach templates lists the saved ones and the built-in suggestions", /Canteen starters/.test(app(a).textContent) && /Built-in suggestions/.test(app(a).textContent));
  a.doc.getElementById("tplName").value = "Lesson lines"; a.doc.getElementById("tplKind").value = "lesson"; a.doc.getElementById("tplLines").value = "Say what you learnt\n\nSuggest one thing";
  click(a, '[data-action="add-template"]'); await tick();
  const post = last(a, /coach-templates/);
  check("settings: adding a template posts the whole list with the new one (blank lines dropped)", post.method === "POST" && post.body.templates.length === 2 && post.body.templates[1].name === "Lesson lines" && post.body.templates[1].lines.length === 2, post.body);
  click(a, '[data-action="delete-template"]'); await tick();
  check("settings: deleting a template posts the list without it", last(a, /coach-templates/).body.templates.every((x) => x.id !== "u1"));
  const scoped = await make("teacher", { super: false }); scoped.w.render();
  check("settings: a class-scoped teacher still has no Topics / Settings tabs, but does have Needs attention", !/Settings/.test(app(scoped).querySelector(".tabs").textContent) && /Needs attention/.test(app(scoped).querySelector(".tabs").textContent));
}

// ================= B8 topic tools =================
{
  const a = await make("teacher");
  const topics = [{ id: "t1", title: "Helping Others", imageUrl: "", imageDescription: "", questions: ["q1", "q2", "q3"], tags: [], coach: [{ starters: ["Last week..."], resources: [] }, { starters: [], storyTips: ["Say who was there"], lessonTips: ["Say what you learnt"], resources: [{ title: "Article", url: "https://x.y", type: "article" }] }, {}] }, { id: "t2", title: "My Hobby", imageUrl: "", imageDescription: "", questions: ["a", "b", "c"], tags: [], coach: [] }, { id: "t3", title: "A Hero", imageUrl: "", imageDescription: "", questions: ["a", "b", "c"], tags: [], coach: [] }];
  a.respond = (url, body) => {
    if (/topics\/reorder/.test(url)) return { ok: true, count: body.ids.length };
    if (/duplicate/.test(url)) return { topic: { ...topics[0], id: "t9", title: "Helping Others (copy)" } };
    if (/\/api\/topics/.test(url)) return { topics };
    if (/coach-templates/.test(url)) return { templates: [{ id: "u1", name: "Canteen starters", kind: "starters", lines: ["At recess I...", "Last week..."] }], builtin: [{ id: "builtin-story-1", builtin: true, name: "Tell it in order", kind: "story", lines: ["Say WHEN first"] }] };
    return {};
  };
  a.w.state.topics = topics; a.w.state.teacherTab = "topics"; a.w.state.coachTemplates = [{ id: "u1", name: "Canteen starters", kind: "starters", lines: ["At recess I...", "Last week..."] }]; a.w.state.coachBuiltin = [{ id: "builtin-story-1", builtin: true, name: "Tell it in order", kind: "story", lines: ["Say WHEN first"] }]; a.w.render();
  check("topics: each topic has Edit, Preview, Duplicate, move up / down (touch-sized, labelled)", ["edit-topic", "preview-topic", "duplicate-topic", "move-topic"].every((x) => app(a).querySelector('[data-action="' + x + '"]')) && app(a).querySelectorAll('[data-action="move-topic"]').length === 6 && /Move Helping Others earlier/.test(app(a).innerHTML));
  click(a, '[data-action="move-topic"][data-id="t2"][data-dir="-1"]'); await tick();
  check("topics: moving a topic up posts the new full order and reloads the list", last(a, /topics\/reorder/).body.ids.join() === "t2,t1,t3" && a.log.some((l) => /\/api\/topics$/.test(l.url)));
  a.log.length = 0;
  click(a, '[data-action="move-topic"][data-id="t1"][data-dir="-1"]'); await tick();
  check("topics: moving the first one up does nothing", !last(a, /reorder/));
  a.respond = (url) => (/reorder/.test(url) ? { __fail: true, error: "This feature needs the v7.9 database update. Run migrations/v7_9.sql." } : { topics });
  click(a, '[data-action="move-topic"][data-id="t2"][data-dir="1"]'); await tick();
  check("topics: without the database update the teacher is told what to run", /v7_9\.sql/.test(app(a).textContent));
  a.respond = (url) => (/duplicate/.test(url) ? { topic: { ...topics[0], id: "t9", title: "Helping Others (copy)" } } : { topics });
  click(a, '[data-action="duplicate-topic"][data-id="t1"]'); await tick();
  check("topics: Duplicate posts and the list reloads", /topics\/t1\/duplicate/.test(last(a, /duplicate/).url) && a.log.some((l) => /\/api\/topics$/.test(l.url)));
  click(a, '[data-action="preview-topic"][data-id="t1"]');
  const pv = app(a).querySelector(".preview-card");
  check("topics: preview shows the questions and exactly what the coach would show a pupil, read-only", pv && /Question 2/.test(pv.textContent) && /Say who was there/.test(pv.textContent) && /Say what you learnt/.test(pv.textContent) && /Last week/.test(pv.textContent) && /Nothing here is saved/.test(pv.textContent) && !pv.querySelector("textarea,input"));
  click(a, '[data-action="close-preview"]');
  check("topics: closing the preview removes it", !app(a).querySelector(".preview-card"));
  a.w.state.editingTopic = { ...topics[0] }; a.w.render();
  const starterBox = a.doc.getElementById("tf_coach0_starters");
  check("topics: the editor offers an 'Insert template' picker for starters (and for story / lesson tips on Q2-Q3)", !!a.doc.getElementById("tplpick_0_starters") && !!a.doc.getElementById("tplpick_1_story") && !a.doc.getElementById("tplpick_0_story"));
  a.doc.getElementById("tplpick_0_starters").value = "u1";
  a.doc.querySelector('[data-action="insert-template"][data-target="tf_coach0_starters"]').click();
  check("topics: inserting adds the template's lines once each (existing line not duplicated)", starterBox.value === "Last week...\nAt recess I...", starterBox.value);
  a.doc.querySelector('[data-action="insert-template"][data-target="tf_coach0_starters"]').click();
  check("topics: inserting twice changes nothing more", starterBox.value === "Last week...\nAt recess I...");
}
const failed = results.filter((x) => !x).length;
console.log("\nv7.9 frontend: " + results.filter(Boolean).length + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
