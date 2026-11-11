// v7.8 pupil UI in jsdom: draft autosave, My Progress, retry comparison + "Use this sentence", "what's new" highlight.
import { JSDOM } from "jsdom";
import { PAGE_HTML } from "../src/frontend.js";

const results = [];
function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra))));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(0);

const TOPIC = { id: "t1", title: "Helping Others", questions: ["What is happening in the picture?", "Tell me about a time you helped.", "What did you learn?"], imageUrl: "", coach: [] };

async function makeApp(opts) {
  opts = opts || {};
  const dom = new JSDOM(PAGE_HTML, { runScripts: "dangerously", url: "https://example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.Element.prototype.scrollIntoView = () => {};
      if (opts.noStorage) Object.defineProperty(win, "localStorage", { get() { throw new Error("SecurityError: storage blocked"); } });
    } });
  const w = dom.window, doc = w.document;
  const app = { w, doc, fetchLog: [], respond: () => ({}), dom };
  w.fetch = (url, o) => {
    const body = o && o.body ? JSON.parse(o.body) : null;
    app.fetchLog.push({ url, method: (o && o.method) || "GET", body });
    let data = app.respond(url, body);
    if (data === undefined) data = {};
    if (/\/api\/leaderboard/.test(url)) data = { leaderboard: [] };
    return Promise.resolve({ ok: !data.__fail, json: () => Promise.resolve(data) });
  };
  w.confirm = () => true; w.alert = () => {};
  await new Promise((r) => (doc.readyState === "complete" ? r() : w.addEventListener("load", r)));
  if (opts.storage) for (const [k, v] of Object.entries(opts.storage)) { try { w.localStorage.setItem(k, v); } catch (e) {} }
  w.state.token = "tok"; w.state.role = "pupil"; w.state.name = opts.name || "Jovan"; w.state.pupilClass = opts.cls || "5ig";
  w.state.screen = "pupil"; w.state.pupilTab = "play"; w.state.topics = [TOPIC];
  w.render();
  return app;
}
const typeInto = (a, id, v) => { const el = a.doc.getElementById(id); el.value = v; el.dispatchEvent(new a.w.Event("input", { bubbles: true })); };
const click = (a, sel) => { const el = a.doc.querySelector(sel); if (!el) throw new Error("no element " + sel); el.click(); };
const draftKeys = (a) => { const out = []; for (let i = 0; i < a.w.localStorage.length; i++) { const k = a.w.localStorage.key(i); if (k.startsWith("chitchat:draft:v1:")) out.push(k); } return out; };

// ============ A1: draft autosave ============
{
  const a = await makeApp();
  click(a, '[data-action="pick-topic"]'); await tick();
  check("draft: builder shows a quiet 'saved on this device' line and a 'Not you? Log out' link", a.doc.getElementById("draftStatus") && /saved on this device/i.test(a.doc.getElementById("draftStatus").textContent) && /Not you\? Log out/.test(a.doc.getElementById("app").textContent));
  check("draft: every answer shows a live word count (0 words to begin with)", /0 words/.test(a.doc.getElementById("draftMeta0").textContent) && a.doc.getElementById("draftMeta2"));
  typeInto(a, "r0_E2", "Last week I shared my lunch with a friend at school");
  typeInto(a, "r1_E2", "My friend fell at the canteen");
  check("draft: word counts update as the pupil types (without redrawing)", a.doc.getElementById("draftMeta0").textContent === "11 words" && a.doc.getElementById("draftMeta1").textContent === "6 words", [a.doc.getElementById("draftMeta0").textContent, a.doc.getElementById("draftMeta1").textContent]);
  check("draft: nothing is written until the pause (debounce ~800 ms)", draftKeys(a).length === 0);
  await sleep(950);
  const keys = draftKeys(a);
  check("draft: after the pause one draft is stored under a key that includes name, class, topic, mode", keys.length === 1 && /jovan/.test(keys[0]) && /5ig/.test(keys[0]) && /t1/.test(keys[0]) && /trees/.test(keys[0]), keys);
  const saved = JSON.parse(a.w.localStorage.getItem(keys[0]));
  check("draft: stores every box, the mode and the practice choice", saved.values.r0_E2.startsWith("Last week") && saved.values.r1_E2 === "My friend fell at the canteen" && saved.mode === "trees" && saved.practice === false && typeof saved.savedAt === "number");
  check("draft: the status line now says 'Saved on this device'", a.doc.getElementById("draftStatus").textContent === "Saved on this device");
  // re-render must not eat typed words (opening the coach used to wipe the boxes)
  a.w.state.currentTopic.coach = [{ starters: ["x"], storyTips: [], lessonTips: [], resources: [] }, {}, {}];
  a.w.state.coachOpen = [true, false, false]; a.w.render(); await tick();
  check("draft: a redraw (e.g. opening the coach) keeps what was typed", a.doc.getElementById("r0_E2").value.startsWith("Last week") && a.doc.getElementById("r1_E2").value === "My friend fell at the canteen");
  a.w.state.currentTopic.coach = [];
  // practice choice
  const pt = a.doc.getElementById("practiceToggle"); pt.checked = true; pt.dispatchEvent(new a.w.Event("change", { bubbles: true })); await sleep(950);
  check("draft: the practice choice is saved too", JSON.parse(a.w.localStorage.getItem(draftKeys(a)[0])).practice === true);

  // ---- "reload": a fresh page that shares this device's storage ----
  const storage = {}; for (const k of draftKeys(a)) storage[k] = a.w.localStorage.getItem(k);
  const b = await makeApp({ storage });
  click(b, '[data-action="pick-topic"]'); await tick();
  check("resume: returning to the same topic offers Continue / Start fresh", !!b.doc.getElementById("draftOffer") && !!b.doc.querySelector('[data-action="draft-continue"]') && !!b.doc.querySelector('[data-action="draft-fresh"]') && /Continue where you left off/.test(b.doc.getElementById("app").textContent));
  check("resume: nothing is filled in until the pupil chooses", b.doc.getElementById("r0_E2").value === "");
  click(b, '[data-action="draft-continue"]'); await tick();
  check("resume: Continue restores every box, the word counts and the practice tick", b.doc.getElementById("r0_E2").value.startsWith("Last week") && b.doc.getElementById("r1_E2").value === "My friend fell at the canteen" && b.doc.getElementById("draftMeta0").textContent === "11 words" && b.doc.getElementById("practiceToggle").checked === true && !b.doc.getElementById("draftOffer"));
  check("resume: the TREES leaves and the story checklist reflect the restored text", b.doc.querySelectorAll("#treeProgress0 .leaf.done").length >= 1);
  // start fresh
  const c = await makeApp({ storage });
  click(c, '[data-action="pick-topic"]'); await tick();
  click(c, '[data-action="draft-fresh"]'); await tick();
  check("resume: Start fresh clears the saved draft and shows empty boxes", c.doc.getElementById("r0_E2").value === "" && draftKeys(c).length === 0 && !c.doc.getElementById("draftOffer"));
  // typing without choosing = start fresh
  const d = await makeApp({ storage });
  click(d, '[data-action="pick-topic"]'); await tick();
  typeInto(d, "r0_T", "I think so");
  check("resume: typing straight away dismisses the offer (treated as starting fresh)", !d.doc.getElementById("draftOffer") && d.doc.getElementById("r0_E2").value === "");
  // other topic / other pupil / expired / corrupt
  const other = await makeApp({ storage, name: "Mei" });
  click(other, '[data-action="pick-topic"]'); await tick();
  check("shared computer: a DIFFERENT pupil on the same device is never offered this draft", !other.doc.getElementById("draftOffer"));
  const otherClass = await makeApp({ storage, cls: "6ha" });
  click(otherClass, '[data-action="pick-topic"]'); await tick();
  check("shared computer: same name, different class -> no draft either", !otherClass.doc.getElementById("draftOffer"));
  const old = {}; for (const [k, v] of Object.entries(storage)) { const o = JSON.parse(v); o.savedAt = Date.now() - 8 * 86400000; old[k] = JSON.stringify(o); }
  const expired = await makeApp({ storage: old });
  click(expired, '[data-action="pick-topic"]'); await tick();
  check("expiry: a draft older than 7 days is not offered (and is removed)", !expired.doc.getElementById("draftOffer") && draftKeys(expired).length === 0);
  const corrupt = {}; for (const k of Object.keys(storage)) corrupt[k] = "{broken";
  const bad = await makeApp({ storage: corrupt });
  click(bad, '[data-action="pick-topic"]'); await tick();
  check("robust: a corrupt draft is ignored, the page still works", !bad.doc.getElementById("draftOffer") && !!bad.doc.getElementById("r0_E2"));
  // logout clears this pupil's drafts
  const e = await makeApp({ storage });
  e.w.localStorage.setItem("chitchat:draft:v1:" + encodeURIComponent("mei") + "|" + encodeURIComponent("5ig") + "|t1|trees|", JSON.stringify({ v: 1, mode: "trees", values: { r0_E2: "mei text" }, practice: false, savedAt: Date.now() }));
  e.w.doLogout(); await tick();
  const left = draftKeys(e);
  check("logout: clears the pupil's own drafts, leaves another pupil's alone", left.length === 1 && /mei/.test(left[0]), left);
  // submit clears
  const f = await makeApp();
  click(f, '[data-action="pick-topic"]'); await tick();
  for (const id of ["r0_T", "r0_R", "r0_E1", "r0_E2", "r0_S", "r1_E2", "r1_S", "r2_E2", "r2_S"]) typeInto(f, id, "some words here");
  await sleep(950);
  check("submit: (setup) a draft exists before submitting", draftKeys(f).length === 1);
  f.respond = (url) => (url.includes("/api/submit") ? { record: { id: "s9", pupilName: "Jovan", pupilClass: "5ig", topicId: "t1", topicTitle: "Helping Others", mode: "trees", finalScore: 15, maxScore: 25, practice: false, retryOf: null, rounds: [] }, retryEnabled: false, canRetry: false } : {});
  click(f, '[data-action="submit-response"]'); await tick(); await tick();
  check("submit: a successful submission removes the draft", draftKeys(f).length === 0 && !!f.w.state.lastResult);
  // storage blocked
  const g = await makeApp({ noStorage: true });
  click(g, '[data-action="pick-topic"]'); await tick();
  typeInto(g, "r0_E2", "words with no storage available");
  await sleep(950);
  check("no storage: the page still works and says drafts are not saved on this browser", /not saved on this browser/i.test(g.doc.getElementById("draftStatus").textContent) && g.doc.getElementById("draftMeta0").textContent === "5 words");
}

// ============ A2: Progress tab ============
{
  const a = await makeApp();
  const T0 = Date.UTC(2026, 8, 1), DAY = 86400000;
  const entry = (id, topicTitle, topicId, score, day, extra) => ({ id, createdAt: T0 + day * DAY, topicId, topicTitle, finalScore: score, maxScore: 25, practice: false, retryOf: null, units: [{ score, max: 25 }], criteria: [], ...(extra || {}) });
  const payload = { entries: [entry("a", "Helping Others", "t1", 14, 0), entry("b", "My Hobby", "t2", 17, 1, { practice: true }), entry("c", "Helping Others", "t1", 20, 2, { retryOf: "a" })],
    summary: { attempts: 3, best: { id: "c", topicTitle: "Helping Others", finalScore: 20, maxScore: 25, practice: false }, strongest: { part: "Experience", pct: 82, n: 4 }, weakest: { part: "Suggestion", pct: 40, n: 4 }, criteria: [], mostImproved: { topicTitle: "Helping Others", from: 14, to: 20, max: 25, gain: 6, gainPct: 24 } } };
  a.respond = (url) => (url.includes("/api/pupil/progress") ? payload : {});
  check("progress: a 'Progress' tab sits beside Play / Leaderboard / Submissions", Array.from(a.doc.querySelectorAll(".tab")).map((t) => t.textContent).join("|") === "Play|Leaderboard|Submissions|Progress");
  check("progress: tabs are reachable by keyboard (role=button, tabindex)", Array.from(a.doc.querySelectorAll(".tab")).every((t) => t.getAttribute("role") === "button" && t.getAttribute("tabindex") === "0"));
  click(a, '.tab[data-tab="progress"]'); await tick(); await tick();
  const txt = a.doc.getElementById("app").textContent;
  check("progress: loads from /api/pupil/progress", a.fetchLog.some((f) => f.url.includes("/api/pupil/progress")));
  check("progress: shows personal best, strongest and weakest criteria in plain words, and most improved", /personal best/i.test(txt) && txt.includes("20 / 25") && /strongest at/i.test(txt) && txt.includes("Experience") && txt.includes("82%") && /practising next/i.test(txt) && txt.includes("Suggestion") && txt.includes("40%") && /Most improved/.test(txt) && txt.includes("from 14 to 20"));
  const svgs = a.doc.querySelectorAll("#app svg.spark");
  check("progress: one inline-SVG score line per topic (no chart library)", svgs.length === 2 && Array.from(svgs).every((s) => /Scores:/.test(s.getAttribute("aria-label"))), svgs.length);
  const hollow = a.doc.querySelectorAll('#app svg.spark circle[fill="#fff"]').length, filled = a.doc.querySelectorAll('#app svg.spark circle[fill="#1f5c46"]').length;
  check("progress: practice attempts are hollow dots, counted ones filled (not colour alone) and the key says so", hollow === 1 && filled === 2 && /Hollow dot = practice/.test(txt), [hollow, filled]);
  check("progress: the score sequence is also written out as text", txt.includes("14 → 20") || txt.includes("14 \u2192 20"));
  const rows = a.doc.querySelectorAll('[data-action="progress-view"]');
  check("progress: a recent-attempts list (newest first) with View buttons, retry and practice tagged", rows.length === 3 && rows[0].getAttribute("data-id") === "c" && /retry/.test(txt) && /practice/.test(txt));
  a.respond = (url) => (url.includes("/api/submissions/c") ? { submission: { id: "c", topicTitle: "Helping Others", finalScore: 20, maxScore: 25, retryOf: "a", rounds: [], practice: false } } : (url.includes("/api/submissions/a") ? { submission: { id: "a", topicTitle: "Helping Others", finalScore: 14, maxScore: 25, retryOf: null, rounds: [] } } : (url.includes("/api/submissions/mine") ? { submissions: [], total: 0, hasMore: false } : {})));
  rows[0].click(); await tick(); await tick(); await tick();
  check("progress: View opens that attempt in Submissions (fetched by id) and loads the first try of a retry", a.w.state.pupilTab === "submissions" && a.w.state.viewingPupilSubmission === "c" && !!a.doc.getElementById("pupilSubmissionDetail") && a.fetchLog.some((f) => f.url.endsWith("/api/submissions/a")));
  // empty state
  const e = await makeApp();
  e.respond = (url) => (url.includes("/api/pupil/progress") ? { entries: [], summary: { attempts: 0, best: null, strongest: null, weakest: null, criteria: [], mostImproved: null } } : {});
  click(e, '.tab[data-tab="progress"]'); await tick(); await tick();
  check("progress: a friendly empty state with a way to start", /Nothing here yet/.test(e.doc.getElementById("app").textContent) && !!e.doc.querySelector('[data-action="pupil-tab"][data-tab="play"].btn-primary'));
  const x = await makeApp();
  x.respond = (url) => (url.includes("/api/pupil/progress") ? { __fail: true, error: "Nope" } : {});
  click(x, '.tab[data-tab="progress"]'); await tick(); await tick();
  check("progress: a failed load shows the message and a Try again button, not a blank page", /Nope/.test(x.doc.getElementById("app").textContent) && !!x.doc.querySelector('[data-action="reload-progress"]'));
  const one = await makeApp();
  one.respond = (url) => (url.includes("/api/pupil/progress") ? { entries: [entry("z", "Solo", "t9", 10, 0)], summary: { attempts: 1, best: { id: "z", topicTitle: "Solo", finalScore: 10, maxScore: 25, practice: false }, strongest: null, weakest: null, criteria: [], mostImproved: null } } : {});
  click(one, '.tab[data-tab="progress"]'); await tick(); await tick();
  check("progress: one attempt only -> a single dot, no most-improved / strongest lines, no errors", one.doc.querySelectorAll("#app svg.spark circle").length === 1 && !/Most improved/.test(one.doc.getElementById("app").textContent) && !/strongest at/i.test(one.doc.getElementById("app").textContent));
}

// ============ A3 + A4: retry comparison, Use this sentence, what's new ============
const crit = (part, points, max) => ({ part, points, max, note: "" });
const q1 = (score, answerE2, model, extra) => ({ unit: "q1", question: "What is happening in the picture?", mode: "trees", answer: { parts: { T: "I think it is kind", R: "because he shares", E1: "I can see a boy", E2: answerE2, S: "We should help" } }, score, max: 25, breakdown: [crit("Thought", 2, 2)], feedback: "FB1", suggestion: "", strengths: "", nextStep: "", modelAnswer: model, markedBy: "groq", ...(extra || {}) });
const q23 = (score, a2, a3, models, extra) => ({ unit: "q2q3", questions: ["Tell me about a time you helped.", "What did you learn?"], question: "q", mode: "trees", answers: [{ parts: { T: "", R: "", E1: "", E2: a2, S: "" } }, { parts: { T: "", R: "", E1: "", E2: a3, S: "" } }], score, max: 25, breakdown: [crit("Experience", 9, 16)], observed: [], feedback: "FB23", suggestion: "", strengths: "", nextStep: "", modelAnswer: models.join("\n\n"), modelAnswers: models, markedBy: "groq", ...(extra || {}) });
const rec = (id, final, rounds, extra) => ({ id, pupilName: "Jovan", pupilClass: "5ig", topicId: "t1", topicTitle: "Helping Others", mode: "trees", finalScore: final, maxScore: 25, practice: false, retryOf: null, gradingDegraded: false, createdAt: Date.now(), rounds, ...(extra || {}) });
const FIRST = rec("first", 15, [q1(12, "Last week I shared my lunch", "I think it is kind because he shares. Last week at school I shared my lunch with Mei because she forgot hers. In the end we both felt happy."), q23(18, "My friend fell", "He thanked me", ["Yesterday at the canteen my friend Ali fell down, so I helped him up. In future, teachers should watch the stairs.", "In the end he thanked me and I learnt to help quickly."])]);
const SECOND = rec("second", 20, [q1(18, "Last week at school I shared my lunch with Mei because she forgot hers", "Second try improved Q1."), q23(22, "Yesterday at the canteen Ali fell and I helped him", "He thanked me, so I learnt to help", ["Improved second Q2.", "Improved second Q3."])], { retryOf: "first" });
{
  const a = await makeApp();
  // ---- the Try Again screen: Use this sentence ----
  a.w.state.currentTopic = TOPIC; a.w.state.retrySession = FIRST; a.w.state.responseMode = "trees"; a.w.state.lastResult = null; a.w.render(); await tick();
  const useBtns = Array.from(a.doc.querySelectorAll('[data-action="use-sentence"]'));
  check("retry: each sentence of the improved answer has a 'Use this sentence' button (touch-sized)", useBtns.length >= 5 && useBtns.every((b) => b.classList.contains("tap")), useBtns.length);
  check("retry: a draft status line is shown on the Try Again screen too", !!a.doc.getElementById("draftStatus"));
  const q1Btns = useBtns.filter((b) => b.getAttribute("data-round") === "0");
  q1Btns[1].click(); await tick();
  check("retry: Use this sentence appends that sentence to the Experience box (branch mode)", a.doc.getElementById("r0_E2").value === "Last week at school I shared my lunch with Mei because she forgot hers.", a.doc.getElementById("r0_E2").value);
  q1Btns[2].click(); await tick();
  check("retry: a second tap appends after it with a space (never replaces)", a.doc.getElementById("r0_E2").value === "Last week at school I shared my lunch with Mei because she forgot hers. In the end we both felt happy.", a.doc.getElementById("r0_E2").value);
  check("retry: the live word count and filled highlight follow", /words$/.test(a.doc.getElementById("draftMeta0").textContent) && a.doc.getElementById("block_r0_E2").classList.contains("filled"));
  const q2Btn = useBtns.filter((b) => b.getAttribute("data-round") === "1")[0]; q2Btn.click(); await tick();
  check("retry: Question 2's sentence goes into Question 2's own box, not Question 1's", a.doc.getElementById("r1_E2").value.startsWith("Yesterday at the canteen") && !a.doc.getElementById("r0_E2").value.includes("canteen"));
  const q3Btn = useBtns.filter((b) => b.getAttribute("data-round") === "2")[0]; q3Btn.click(); await tick();
  check("retry: Question 3 uses its own improved answer (modelAnswers[1])", a.doc.getElementById("r2_E2").value.startsWith("In the end he thanked me and I learnt"));
  await sleep(950);
  check("retry: the sentences added are autosaved in the second try's own draft (key ends with the first try's id)", draftKeys(a).length === 1 && draftKeys(a)[0].endsWith("|first"), draftKeys(a));
  // single-box mode
  a.w.state.responseMode = "single"; a.w.render(); await tick();
  const single = Array.from(a.doc.querySelectorAll('[data-action="use-sentence"]')).filter((b) => b.getAttribute("data-round") === "0")[0]; single.click(); await tick();
  check("retry: in single-box mode the sentence goes into the single box", a.doc.getElementById("r0_single").value.startsWith("I think it is kind"), a.doc.getElementById("r0_single").value);
  a.w.state.responseMode = "trees";

  // ---- the second try's result: three columns + chips ----
  const b = await makeApp();
  b.w.state.currentTopic = TOPIC; b.w.state.previousResult = FIRST; b.w.state.lastResult = SECOND; b.w.render(); await tick();
  const tables = Array.from(b.doc.querySelectorAll("#app table.resp-table"));
  check("compare: the table reads First try | Second try | Improved response", tables.length === 2 && tables.every((t) => Array.from(t.querySelectorAll("th")).map((x) => x.textContent).join("|") === "First try|Second try|Improved response"));
  const q1cells = tables[0].querySelectorAll("tbody tr:not(.resp-q) td");
  check("compare: Q1 row has the first try beside the second try", q1cells.length === 3 && q1cells[0].textContent.includes("Last week I shared my lunch") && q1cells[1].textContent.includes("Last week at school I shared my lunch with Mei"));
  const q23cells = Array.from(tables[1].querySelectorAll("tbody tr:not(.resp-q)")).map((r) => Array.from(r.querySelectorAll("td")).map((c) => c.textContent));
  check("compare: Q2 and Q3 rows each show their own first try and second try", q23cells.length === 2 && q23cells[0][0].includes("My friend fell") && q23cells[0][1].includes("Yesterday at the canteen Ali fell") && q23cells[1][0].includes("He thanked me") && q23cells[1][1].includes("so I learnt"), q23cells);
  check("compare: cells carry data-label so a phone can stack them", tables[0].querySelector("td[data-label='First try']") && tables[0].querySelector("td[data-label='Second try']") && tables[0].querySelector("td[data-label='Improved response']"));
  const chips = Array.from(b.doc.querySelectorAll("#app .delta-chip")).map((c) => c.textContent);
  check("compare: unit score chips for the owner (12 → 18 up 6, 18 → 22 up 4), in words as well as arrows", chips.length === 2 && chips[0].includes("12 \u2192 18") && chips[0].includes("up 6") && chips[1].includes("18 \u2192 22") && chips[1].includes("up 4"), chips);
  check("compare: the existing overall before/after panel is still there", /You improved by 5 points/.test(b.doc.getElementById("app").textContent) && /15\s*\u2192\s*20/.test(b.doc.getElementById("app").textContent));
  // a classmate's / marks-less entry never shows chips
  const nomarks = JSON.parse(JSON.stringify(SECOND)); nomarks.rounds.forEach((r) => { delete r.score; delete r.max; delete r.breakdown; });
  const c = await makeApp();
  c.w.state.currentTopic = TOPIC; c.w.state.previousResult = FIRST; c.w.state.lastResult = nomarks; c.w.render(); await tick();
  check("compare: rounds without marks (a classmate's view) show no score chips", c.doc.querySelectorAll("#app .delta-chip").length === 0);
  // second try opened later from My Submissions: first try loaded by retryOf
  const d = await makeApp();
  d.respond = (url) => (url.endsWith("/api/submissions/first") ? { submission: FIRST } : {});
  d.w.state.pupilTab = "submissions"; d.w.state.subsScope = "mine"; d.w.state.mySubmissions = [SECOND]; d.w.state.mySubsTotal = 1; d.w.render(); await tick();
  click(d, '[data-action="view-pupil-submission"]'); await tick(); await tick(); await tick();
  const dt = d.doc.querySelector("#pupilSubmissionDetail table.resp-table");
  check("compare: opening a second try from the list fetches its first try and shows three columns", d.fetchLog.some((f) => f.url.endsWith("/api/submissions/first")) && dt && Array.from(dt.querySelectorAll("th")).map((x) => x.textContent).join("|") === "First try|Second try|Improved response");
  // a plain first attempt is unchanged
  const e = await makeApp();
  e.w.state.currentTopic = TOPIC; e.w.state.lastResult = FIRST; e.w.render(); await tick();
  check("compare: a first attempt keeps the two-column 'Your response | Improved response' table and no chips", Array.from(e.doc.querySelector("#app table.resp-table th").parentNode.children).map((x) => x.textContent).join("|") === "Your response|Improved response" && e.doc.querySelectorAll("#app .delta-chip").length === 0);

  // ---- A4: what's new ----
  const cell = e.doc.querySelector("#app table.resp-table td[data-label='Improved response']");
  const marks = Array.from(cell.querySelectorAll("mark.added")).map((m) => m.textContent);
  check("new: sentences the pupil did not already write are underlined/marked (the 'shares' sentence was already said)", marks.length >= 1 && marks.some((m) => /Mei because she forgot hers/.test(m)) && !marks.some((m) => /^I think it is kind because he shares/.test(m)), marks);
  const chipTxt = Array.from(cell.querySelectorAll(".added-chip")).map((c) => c.textContent).join("|");
  check("new: chips name what was added (here: when/where detail and how it ended)", /Added/.test(chipTxt) && /how it ended/.test(chipTxt), chipTxt);
  check("new: a legend explains the underline (not colour alone)", /Underlined/.test(e.doc.getElementById("app").textContent) && getComputedStyleUnderlined(e));
  function getComputedStyleUnderlined(app) { return /mark\.added\{[^}]*underline/.test(app.doc.querySelector("style").textContent); }
  click(e, '[data-action="toggle-new"]'); await tick();
  check("new: 'Show what's new' toggle turns the marking off, and remembers it on this device", e.doc.querySelectorAll("#app mark.added").length === 0 && e.w.localStorage.getItem("chitchat:pref:shownew") === "0" && e.doc.querySelector('[data-action="toggle-new"]').getAttribute("aria-pressed") === "false");
  const e2 = await makeApp({ storage: { "chitchat:pref:shownew": "0" } });
  e2.w.state.showNew = e2.w.readShowNew(); e2.w.state.currentTopic = TOPIC; e2.w.state.lastResult = FIRST; e2.w.render(); await tick();
  check("new: the saved 'off' choice is honoured on the next visit", e2.doc.querySelectorAll("#app mark.added").length === 0);
  // injection safety
  const evil = JSON.parse(JSON.stringify(FIRST)); evil.rounds[0].modelAnswer = 'Totally new idea <img src=x onerror="window.__pwn=1"> and <b>bold</b>. Another brand new sentence about gardens.';
  const f = await makeApp(); f.w.state.currentTopic = TOPIC; f.w.state.lastResult = evil; f.w.render(); await tick();
  check("new: HTML in an improved answer is escaped, never executed", !f.doc.querySelector("#app img") && f.w.__pwn === undefined && f.doc.querySelector("#app table.resp-table td[data-label='Improved response']").textContent.includes("<img src=x"));
  // identical rewrite -> nothing highlighted, no chips
  const same = JSON.parse(JSON.stringify(FIRST)); same.rounds[0].modelAnswer = "I think it is kind. because he shares. I can see a boy. Last week I shared my lunch. We should help.";
  const g = await makeApp(); g.w.state.currentTopic = TOPIC; g.w.state.lastResult = same; g.w.render(); await tick();
  const firstTable = (app) => app.doc.querySelector("#app table.resp-table");
check("new: if the improved answer adds nothing new, nothing is marked and there are no chips", firstTable(g).querySelectorAll("mark.added").length === 0 && firstTable(g).querySelectorAll(".added-chip").length === 0);
  // blank pupil answer -> nothing to compare
  const blank = JSON.parse(JSON.stringify(FIRST)); blank.rounds[0].answer = { parts: { T: "", R: "", E1: "", E2: "", S: "" } };
  const h = await makeApp(); h.w.state.currentTopic = TOPIC; h.w.state.lastResult = blank; h.w.render(); await tick();
  check("new: an empty pupil answer shows the improved text plainly (no highlight storm)", firstTable(h).querySelectorAll("mark.added").length === 0);
  // sentence engine
  const w = e.w;
  check("new: sentence splitter keeps abbreviations-free sentences intact", w.splitSentences("One. Two! Three?  Four").join("|") === "One.|Two!|Three?|Four");
  check("new: a sentence reusing >=60% of one pupil sentence's words is not 'new'; a fresh one is", w.compareImproved("I went to the market yesterday.", "I went to the market yesterday morning. We found fresh mangoes and learnt about prices.", false).sentences.map((s) => s.isNew).join() === "false,true");
}
const failed = results.filter((x) => !x).length;
console.log("\nv7.8 frontend: " + results.filter(Boolean).length + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
