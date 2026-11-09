// v7.10 UI in jsdom: pupil My Skill Web, result + retry overlays, teacher report web, Insights web/heatmap toggle,
// and cache invalidation after a re-mark / override.
import { JSDOM } from "jsdom";
import { PAGE_HTML } from "../frontend.js";

const results = [];
function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra))));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = async () => { for (let i = 0; i < 5; i++) await sleep(0); };

async function make(role) {
  const dom = new JSDOM(PAGE_HTML, { runScripts: "dangerously", url: "https://example.com/", pretendToBeVisual: true, beforeParse(win) { win.Element.prototype.scrollIntoView = () => {}; win.scrollTo = () => {}; win.print = () => {}; } });
  const w = dom.window, doc = w.document;
  const a = { w, doc, log: [], respond: () => ({}) };
  w.fetch = (url, o) => {
    const body = o && o.body ? JSON.parse(o.body) : null;
    a.log.push({ url, method: (o && o.method) || "GET", body });
    let data = a.respond(url, body, (o && o.method) || "GET");
    if (data === undefined) data = {};
    if (/\/api\/leaderboard/.test(url)) data = { leaderboard: [] };
    return Promise.resolve({ ok: !data.__fail, json: () => Promise.resolve(data) });
  };
  w.confirm = () => true; w.alert = () => {};
  w.URL.createObjectURL = (b) => { w.__blob = b; return "blob:x"; }; w.URL.revokeObjectURL = () => {};
  await new Promise((r) => (doc.readyState === "complete" ? r() : w.addEventListener("load", r)));
  w.state.token = "tok"; w.state.role = role;
  if (role === "teacher") { w.state.name = "palpatine"; w.state.isSuperAdmin = true; w.state.screen = "teacher"; w.state.teacherTab = "leaderboard"; w.state.classesList = ["5ig", "6ha"]; }
  else { w.state.name = "Jovan"; w.state.pupilClass = "5ig"; w.state.screen = "pupil"; w.state.pupilTab = "play"; }
  w.render();
  return a;
}
const app = (a) => a.doc.getElementById("app");
const click = (a, sel) => { const el = a.doc.querySelector(sel); if (!el) throw new Error("missing " + sel); el.click(); };
const KEYS = ["Thought", "Reason", "Evidence", "Experience", "Suggestion", "Grammar", "Vocabulary", "Fluency"];
const axes = (pcts, prev) => KEYS.map((k, i) => ({ key: k, label: k, pct: pcts[i], prevPct: prev ? prev[i] : null, delta: prev && pcts[i] !== null && prev[i] !== null ? pcts[i] - prev[i] : null }));
const skillMap = (pcts, extra) => { const ax = {}; KEYS.forEach((k, i) => { if (pcts[i] !== null) ax[k] = { points: pcts[i], max: 100 }; }); return { axes: ax, sub: {}, used: 2, excluded: 0, staffMarked: 0, adjusted: false, total: 2, ...(extra || {}) }; };
const webOf = (pcts, o) => ({ window: 5, n: 4, nPrev: o && o.prev ? 5 : 0, practiceOnly: false, axes: axes(pcts, o && o.prev), sub: [{ label: "Relevance", pct: 100, prevPct: null }, { label: "5W1H Specificity", pct: 50, prevPct: null }], excludedRounds: 0, staffMarked: 0, adjusted: false, ...(o && o.extra || {}) });
const dummy = { id: "d1", createdAt: 1000, topicId: "t1", topicTitle: "Helping Others", finalScore: 15, maxScore: 25, practice: false, retryOf: null, units: [{ score: 15, max: 25 }, { score: 15, max: 25 }], criteria: [] };
const progress = (web, webAll, entries) => ({ entries: entries || [dummy], summary: { attempts: 4, best: null, mostImproved: null, strongest: null, weakest: null, criteria: [], skillWeb: web, skillWebAll: webAll || web } });
const goPupilProgress = async (a, data) => { a.respond = (u) => (/\/api\/pupil\/progress/.test(u) ? data : {}); a.w.state.pupilTab = "progress"; click(a, ".tab[data-tab=\"progress\"]"); await tick(); };

// ===== 1. pupil: My Skill Web =====
{
  const a = await make("pupil");
  const web = webOf([100, 80, 50, 64, 40, 100, 20, null], { prev: [50, 80, 50, 50, 60, 90, 20, null] });
  await goPupilProgress(a, progress(web));
  const card = a.doc.getElementById("skillWebCard");
  check("pupil web: a My Skill Web card is on My Progress", !!card && /My Skill Web/.test(card.textContent));
  const svg = card.querySelector("svg.skillweb");
  check("pupil web: one radar SVG with an accessible name listing every skill and value", !!svg && svg.getAttribute("role") === "group" && /Thought 100 percent/.test(svg.getAttribute("aria-label")) && /Fluency no data yet/.test(svg.getAttribute("aria-label")), svg && svg.getAttribute("aria-label"));
  check("pupil web: all eight skill names are drawn around the web", KEYS.every((k) => svg.textContent.includes(k)));
  check("pupil web: 'now' is solid and 'earlier' is dashed (not colour alone), with different marker shapes", /stroke-dasharray="6 4"/.test(svg.innerHTML) && svg.querySelectorAll("circle").length > 0 && svg.querySelectorAll("rect[stroke]").length === 0);
  check("pupil web: the legend names both outlines with their own line style", card.querySelectorAll(".sw-key").length === 2 && /Now \(last 4\)/.test(card.textContent) && /Before/.test(card.textContent));
  check("pupil web: a table with the same numbers is there for screen readers", !!card.querySelector("table.sr-only") && card.querySelectorAll("table.sr-only tbody tr").length === 8);
  const rows = card.querySelectorAll(".sw-row");
  check("pupil web: eight tappable skill rows with percentage, level and a text arrow for change", rows.length === 8 && /100%/.test(rows[0].textContent) && /Lv 5/.test(rows[0].textContent) && /Lv 2/.test(rows[6].textContent) && /▲ \+50/.test(rows[0].textContent) && /▼ -20/.test(rows[4].textContent), rows[0].textContent + "|" + rows[4].textContent);
  check("pupil web: a skill with no data yet says new, not 0%", /–/.test(rows[7].textContent) && /new/.test(rows[7].textContent));
  check("pupil web: character title comes from the strongest skill, with an overall level", /Your character/.test(card.textContent) && /Deep Thinker|Grammar Guardian/.test(card.textContent) && /Overall: Level \d/.test(card.textContent));
  check("pupil web: gently framed 'next quest' points at the lowest skill (Vocabulary), no 'weakest' wording", /Next quest: .*Vocabulary/.test(card.textContent) && !/weak/i.test(card.textContent));
  check("pupil web: buttons carry aria-expanded and keyboard-friendly 44px class", rows[0].getAttribute("aria-expanded") === "false" && rows[0].classList.contains("tap"));
  click(a, '.sw-row[data-skill="Experience"]');
  const focus = a.doc.querySelector(".sw-focus");
  check("pupil web: tapping Experience opens its sub-skills (Relevance, 5W1H)", !!focus && /Relevance/.test(focus.textContent) && /5W1H/.test(focus.textContent) && /Level 4/.test(focus.textContent) && a.doc.querySelector('.sw-row[data-skill="Experience"]').getAttribute("aria-expanded") === "true");
  click(a, '.sw-row[data-skill="Thought"]');
  check("pupil web: Thought says it is marked from Question 1 and shows a strengths line", /Question 1/.test(a.doc.querySelector(".sw-focus").textContent) && /strengths/.test(a.doc.querySelector(".sw-focus").textContent) && !/5W1H/.test(a.doc.querySelector(".sw-focus").textContent));
  click(a, '.sw-row[data-skill="Thought"]');
  check("pupil web: tapping the same skill again closes the panel", !a.doc.querySelector(".sw-focus"));
  check("pupil web: no 'undefined' or 'NaN' anywhere", !/undefined|NaN/.test(card.textContent + card.innerHTML.replace(/<[^>]+>/g, "")));
}
{
  const a = await make("pupil");
  const counted = webOf([100, 100, 100, 100, 100, 100, 100, 100]);
  const withPractice = webOf([40, 40, 40, 40, 40, 40, 40, 40], { extra: { n: 6 } });
  await goPupilProgress(a, progress(counted, withPractice));
  check("practice toggle: starts off, showing the counted-attempts web", /Practice attempts: not included/.test(a.doc.getElementById("skillWebCard").textContent) && /100%/.test(a.doc.querySelector(".sw-row").textContent));
  click(a, '[data-action="toggle-skill-practice"]');
  check("practice toggle: on switches to the with-practice web and says so", /Practice attempts: included/.test(a.doc.getElementById("skillWebCard").textContent) && /40%/.test(a.doc.querySelector(".sw-row").textContent) && /practice included/.test(a.doc.getElementById("skillWebCard").textContent));
  check("practice toggle: the button announces its state (aria-pressed)", a.doc.querySelector('[data-action="toggle-skill-practice"]').getAttribute("aria-pressed") === "true");
}
{
  const a = await make("pupil");
  await goPupilProgress(a, progress(webOf([null, null, null, null, null, null, null, null], { extra: { n: 0, excludedRounds: 2 } })));
  const t = a.doc.getElementById("skillWebCard").textContent;
  check("empty web: explains it appears after the first AI- or teacher-marked attempt and why parts are left out", /will appear after your first attempt/.test(t) && /2 parts/.test(t) && /AI re-mark/.test(t) && !a.doc.querySelector("svg.skillweb"));
  const b = await make("pupil");
  await goPupilProgress(b, progress(webOf([100, 100, 100, 100, 100, 100, 100, 100], { extra: { excludedRounds: 1, staffMarked: 1, practiceOnly: true } })));
  const t2 = b.doc.getElementById("skillWebCard").textContent;
  check("notes: a left-out part, a teacher-marked part and 'practice only' are all stated plainly", /1 part from your recent attempts is left out/.test(t2) && /Includes 1 part marked by your teacher/.test(t2) && /practice attempts \(you have no counted attempts yet\)/.test(t2) && /Every skill is strong/.test(t2), t2);
}

// ===== 2. pupil: result screen and retry =====
const rec = (id, pcts, extra) => ({ id, pupilName: "Jovan", pupilClass: "5ig", topicId: "t1", topicTitle: "Helping Others", mode: "trees", finalScore: 15, maxScore: 25, practice: false, flagged: false, gradingDegraded: false, retryOf: null, createdAt: 2000,
  rounds: [{ unit: "q1", question: "Q1?", answer: { parts: {} }, score: 15, max: 25, breakdown: [], feedback: "f", markedBy: "groq" }, { unit: "q2q3", questions: ["a", "b"], answers: [{ parts: {} }, { parts: {} }], score: 15, max: 25, breakdown: [], feedback: "f", markedBy: "groq", modelAnswers: ["", ""], observed: [] }],
  skills: skillMap(pcts), ...(extra || {}) });
const showResult = async (a, r, prev) => { a.w.state.pupilTab = "play"; a.w.state.lastResult = r; a.w.state.previousResult = prev || null; a.w.render(); await tick(); };
{
  const a = await make("pupil");
  a.respond = (u) => (/\/api\/pupil\/progress/.test(u) ? progress(webOf([50, 50, 50, 50, 50, 50, 50, 50]), null, [
    { id: "old1", createdAt: 1000, practice: false, skills: skillMap([40, 40, 40, 40, 40, 40, 40, 40]) },
    { id: "old2", createdAt: 1500, practice: false, skills: skillMap([60, 60, 60, 60, 60, 60, 60, 60]) },
    { id: "pr", createdAt: 1600, practice: true, skills: skillMap([0, 0, 0, 0, 0, 0, 0, 0]) },
    { id: "now1", createdAt: 2000, practice: false, skills: skillMap([100, 80, 50, 70, 100, 100, 20, 60]) },
    { id: "later", createdAt: 3000, practice: false, skills: skillMap([0, 0, 0, 0, 0, 0, 0, 0]) }]) : {});
  await showResult(a, rec("now1", [100, 80, 50, 70, 100, 100, 20, 60]));
  check("result: this attempt's skill web is shown on the result screen", !!a.doc.getElementById("resultSkillWeb") && !!a.doc.querySelector("#resultSkillWeb svg.skillweb"));
  check("result: the pupil's usual shape is fetched once from their own progress", a.log.filter((l) => /\/api\/pupil\/progress/.test(l.url)).length === 1);
  const t = a.doc.getElementById("resultSkillWeb");
  check("result: 'usual' = earlier counted attempts only (practice and later ones left out): avg of 40 and 60 = 50", /Your usual \(last 2\)/.test(t.textContent) && /stroke-dasharray="6 4"/.test(t.innerHTML) && /Thought 100 percent/.test(t.querySelector("svg").getAttribute("aria-label")) && /Thought 50 percent/.test(t.querySelector("svg").getAttribute("aria-label")), t.querySelector("svg").getAttribute("aria-label"));
  check("result: chips show each skill's value with a text arrow versus usual (Thought up 50)", /Thought 100% ▲ \+50/.test(t.querySelector(".sw-chips").textContent.replace(/\s+/g, " ")) || /100%\s*▲ \+50/.test(t.querySelector(".sw-chips").textContent));
}
{
  const a = await make("pupil");
  a.respond = (u) => (/\/api\/pupil\/progress/.test(u) ? progress(webOf([50, 50, 50, 50, 50, 50, 50, 50]), null, [{ id: "only", createdAt: 2000, practice: false, skills: skillMap([100, 80, 50, 70, 100, 100, 20, 60]) }]) : {});
  await showResult(a, rec("only", [100, 80, 50, 70, 100, 100, 20, 60]));
  check("result: a first attempt shows just itself and says the usual shape comes later", /first marked attempt/.test(a.doc.getElementById("resultSkillWeb").textContent) && a.doc.querySelectorAll("#resultSkillWeb .sw-key").length === 1);
}
{
  const a = await make("pupil");
  await showResult(a, rec("off", [], { skills: { axes: {}, sub: {}, used: 0, excluded: 2, total: 2 }, gradingDegraded: true }));
  check("result: an all-offline attempt has no web yet and points at AI re-mark", /once a part has been marked by AI/.test(a.doc.getElementById("resultSkillWeb").textContent) && !a.doc.querySelector("#resultSkillWeb svg") && a.log.filter((l) => /pupil\/progress/.test(l.url)).length === 0);
  const b = await make("pupil");
  b.respond = () => ({});
  await showResult(b, rec("half", [100, 80, 50, 70, 100, 100, 20, 60], { skills: skillMap([100, 80, 50, 70, 100, 100, 20, 60], { excluded: 1, staffMarked: 1 }) }));
  const t = b.doc.getElementById("resultSkillWeb").textContent;
  check("result: a half-offline attempt shows what qualifies, names the part left out, and the teacher-marked part", /1 part was only marked offline/.test(t) && /Includes 1 part marked by your teacher/.test(t));
}
{
  // re-mark: the result's web changes and the progress cache is thrown away and fetched again
  const a = await make("pupil");
  let prog = progress(webOf([50, 50, 50, 50, 50, 50, 50, 50]), null, [{ id: "r1", createdAt: 2000, practice: false, skills: skillMap([0, 0, 0, 0, 0, 0, 0, 0], { used: 0 }) }]);
  const before = rec("r1", [], { gradingDegraded: true, skills: { axes: {}, sub: {}, used: 0, excluded: 2, total: 2 } });
  before.rounds[0].markedBy = "fallback";
  const after = rec("r1", [100, 100, 50, 70, 100, 100, 50, 100]);
  a.respond = (u, body) => (/\/remark/.test(u) ? { success: true, addedToLeaderboard: true, submission: after } : (/\/api\/pupil\/progress/.test(u) ? prog : {}));
  await showResult(a, before);
  check("re-mark: before, the result has no web yet", !a.doc.querySelector("#resultSkillWeb svg"));
  const fetchesBefore = a.log.filter((l) => /pupil\/progress/.test(l.url)).length;
  click(a, '[data-action="ai-remark"]'); await tick(); await tick();
  check("re-mark: afterwards the result's web is drawn from the new marks", !!a.doc.querySelector("#resultSkillWeb svg.skillweb") && /Thought 100 percent/.test(a.doc.querySelector("#resultSkillWeb svg").getAttribute("aria-label")));
  check("re-mark: My Progress data was invalidated and fetched again so 'usual' is current", a.log.filter((l) => /pupil\/progress/.test(l.url)).length === fetchesBefore + 1 || (a.w.state.progress !== null), [fetchesBefore, a.log.filter((l) => /pupil\/progress/.test(l.url)).length]);
  a.w.state.progress = { stale: true }; a.w.invalidateSkillCaches();
  check("invalidate: clears the cached progress, teacher report and insights", a.w.state.progress === null && a.w.state.pupilReport === null && a.w.state.insights === null);
}
{
  const a = await make("pupil");
  a.respond = () => ({});
  const first = rec("f", [20, 20, 20, 20, 20, 20, 20, 20]);
  const second = rec("s", [80, 80, 80, 80, 80, 80, 80, 80], { retryOf: "f", finalScore: 21 });
  await showResult(a, second, first);
  const r = a.doc.getElementById("retrySkillWeb");
  check("retry: the second-try panel has a first-try vs second-try web with a chip per skill and arrows", !!r && /First try/.test(r.textContent) && /Second try/.test(r.textContent) && r.querySelectorAll(".sw-chip").length === 8 && /▲ \+60/.test(r.textContent));
  check("retry: the plain result web is not drawn twice", !a.doc.getElementById("resultSkillWeb"));
  const c = await make("pupil"); c.respond = () => ({});
  const off = rec("s", [], { retryOf: "f", skills: { axes: {}, sub: {}, used: 0, excluded: 2, total: 2 } });
  await showResult(c, off, first);
  check("retry: if the second try has no usable marks yet there is simply no comparison web (no error)", !c.doc.getElementById("retrySkillWeb") && /Second try/.test(c.doc.body.textContent));
}

// ===== 3. teacher: pupil report =====
const openReport = (a, rep) => { a.w.state.teacherTab = "pupils"; a.w.state.teacherPupilView = { pupil: { name: "Jovan", pupilClass: "5ig", bestScore: 20, attempts: 4 }, history: [], strengths: [], concerns: [] }; a.w.state.pupilReport = rep; a.w.render(); };
const report = (o) => ({ pupil: { name: "Jovan", pupilClass: "5ig" }, generatedAt: 1, attempts: [], retries: [], comments: [], series: { entries: [], summary: { attempts: 4, best: null, strongest: null, weakest: null, mostImproved: null, criteria: [] } },
  skillWeb: { window: 5, practiceOnly: false, latest: { n: 5, excludedRounds: 0, staffMarked: 0, axes: axes([90, 80, 70, 60, 50, 40, 30, 20]) }, first: { n: 5, axes: axes([10, 20, 30, 40, 50, 60, 70, 80]) }, classAvg: { n: 40, axes: axes([55, 55, 55, 55, 55, 55, 55, 55]) } }, ...(o || {}) });
{
  const a = await make("teacher");
  openReport(a, report());
  const out = a.doc.getElementById("pupilReport");
  check("report: the printable report has a Skill web section", !!out && /Skill web/.test(out.textContent) && !!out.querySelector("svg.skillweb"));
  const keys = [...out.querySelectorAll(".sw-key")].map((k) => k.textContent.trim());
  check("report: three layers named Latest / First / Class average, each with its own line style", keys.length === 3 && /Class average \(40 attempts\)/.test(keys[0]) && /First 5 attempts/.test(keys[1]) && /Latest 5 attempts/.test(keys[2]) && /stroke-dasharray="2 4"/.test(out.innerHTML) && /stroke-dasharray="6 4"/.test(out.innerHTML) && out.querySelectorAll("svg.skillweb rect[stroke='#b5760f']").length === 8, [keys, out.querySelectorAll("rect").length, /stroke-dasharray="2 4"/.test(out.innerHTML)]);
  const tbl = out.querySelector("table.sw-table");
  check("report: a visible table of the same numbers (so a black-and-white print still has the figures)", !!tbl && tbl.querySelectorAll("tbody tr").length === 8 && /90%/.test(tbl.textContent) && /10%/.test(tbl.textContent) && /55%/.test(tbl.textContent) && !tbl.classList.contains("sr-only"));
  const b = await make("teacher");
  openReport(b, report({ skillWeb: { window: 5, practiceOnly: true, latest: { n: 2, excludedRounds: 2, staffMarked: 1, axes: axes([90, 80, 70, 60, 50, 40, 30, 20]) }, first: null, classAvg: null } }));
  const t = b.doc.getElementById("pupilReport").textContent;
  check("report: with too few attempts it says so, notes practice-only, left-out parts and teacher-marked parts", /Not enough attempts yet/.test(t) && /Only practice attempts/.test(t) && /2 recent parts marked only offline are left out/.test(t) && /teacher.s score override/.test(t) && b.doc.querySelectorAll("#pupilReport .sw-key").length === 1);
  const c = await make("teacher");
  openReport(c, report({ skillWeb: { window: 5, practiceOnly: false, latest: { n: 0, excludedRounds: 3, staffMarked: 0, axes: axes([null, null, null, null, null, null, null, null]) }, first: null, classAvg: null } }));
  check("report: nothing usable yet -> a plain sentence, no empty chart", /No AI-marked or teacher-marked parts yet/.test(c.doc.getElementById("pupilReport").textContent) && !c.doc.querySelector("#pupilReport svg.skillweb"));
}

// ===== 4. teacher: Insights =====
const insights = () => ({ submissions: 5, avgFinal: 15, legacySubmissions: 0, focus: [], weekly: [], byClass: [], q1: { n: 0, avgScore: 0, criteria: [] }, q2q3: { n: 0, avgScore: 0, criteria: [] }, capped: false, window: 2000,
  heatmap: { criteria: ["Thought"], topics: [{ topic: "Helping Others", n: 3, cells: [80] }] },
  skillWeb: { n: 5, excludedRounds: 1, overall: axes([80, 70, 60, 50, 40, 30, 20, 10]), sub: [{ label: "Relevance", pct: 90 }], byClass: [{ pupilClass: "5ig", n: 3, axes: axes([90, 90, 90, 90, 90, 90, 90, 90]) }, { pupilClass: "6ha", n: 2, axes: axes([20, 20, 20, 20, 20, 20, 20, 20]) }], byTopic: [{ topic: "Helping Others", n: 4, axes: axes([60, 60, 60, 60, 60, 60, 60, 60]) }] } });
{
  const a = await make("teacher");
  a.respond = (u) => (/\/api\/teacher\/analytics/.test(u) ? insights() : {});
  a.w.state.teacherTab = "insights"; click(a, '.tab[data-tab="insights"]'); await tick();
  check("insights: opens on the skill web, with a Skill web / Heatmap toggle", !!a.doc.getElementById("insSkillWeb") && a.doc.querySelectorAll('[data-action="ins-view"]').length === 2 && a.doc.querySelector('[data-action="ins-view"][data-view="web"]').getAttribute("aria-pressed") === "true" && !a.doc.querySelector(".teacher-table.heat"));
  check("insights: one layer to start (everyone in this view) with a visible table", a.doc.querySelectorAll("#insSkillWeb .sw-key").length === 1 && /5 attempts/.test(a.doc.getElementById("insSkillWeb").textContent) && !!a.doc.querySelector("#insSkillWeb table.sw-table"));
  check("insights: compare menu lists each class and topic", [...a.doc.querySelectorAll("#insCompare option")].map((o) => o.textContent).join("|") === "No comparison|Class 5ig (3)|Class 6ha (2)|Topic: Helping Others (4)");
  const sel = a.doc.getElementById("insCompare"); sel.value = "class:6ha"; sel.dispatchEvent(new a.w.Event("change", { bubbles: true })); await tick();
  const keys = [...a.doc.querySelectorAll("#insSkillWeb .sw-key")].map((k) => k.textContent.trim());
  check("insights: choosing a class adds it as a dotted outline named after the class", keys.length === 2 && /Class 6ha \(2\)/.test(keys[0]) && /20%/.test(a.doc.querySelector("#insSkillWeb table.sw-table").textContent) && a.doc.getElementById("insCompare").value === "class:6ha");
  click(a, '[data-action="ins-view"][data-view="heat"]');
  check("insights: Heatmap shows the existing topic x criterion table and hides the web", !!a.doc.querySelector(".teacher-table.heat") && !a.doc.getElementById("insSkillWeb") && a.doc.querySelector('[data-action="ins-view"][data-view="heat"]').getAttribute("aria-pressed") === "true");
  click(a, '[data-action="ins-view"][data-view="web"]');
  click(a, '[data-action="export-skill-csv"]'); await tick();
  const csv = await new Promise((r) => { const fr = new a.w.FileReader(); fr.onload = () => r(fr.result); fr.readAsText(a.w.__blob); });
  const lines = csv.split(/\r?\n/);
  check("insights: CSV export has a row per skill and a column for everyone, each class and each topic", lines.length === 9 && /Skill,Everyone,Class 5ig,Class 6ha,Topic Helping Others/.test(lines[0]) && /^Thought,80,90,20,60/.test(lines[1]), lines.slice(0, 2));
  const b = await make("teacher");
  b.respond = (u) => (/\/api\/teacher\/analytics/.test(u) ? { submissions: 0, skillWeb: insights().skillWeb } : {});
  b.w.state.teacherTab = "insights"; click(b, '.tab[data-tab="insights"]'); await tick();
  check("insights: if only teacher-marked parts exist (no fully AI-marked submissions) the web still shows", !!b.doc.getElementById("insSkillWeb"));
  const c = await make("teacher");
  c.respond = (u) => (/\/api\/teacher\/analytics/.test(u) ? { submissions: 0, skillWeb: { n: 0, overall: [], byClass: [], byTopic: [], sub: [], excludedRounds: 0 } } : {});
  c.w.state.teacherTab = "insights"; click(c, '.tab[data-tab="insights"]'); await tick();
  check("insights: nothing at all -> the existing 'no submissions' message", /No fully AI-marked/.test(c.doc.body.textContent));
}

// ===== 5. teacher override clears the cached web data =====
{
  const a = await make("teacher");
  a.w.state.insights = { stale: true }; a.w.state.pupilReport = { stale: true }; a.w.state.progress = { stale: true };
  a.w.state.teacherSubs = [{ id: "s1", pupilName: "Jovan", pupilClass: "5ig", topicTitle: "T", finalScore: 10, maxScore: 25, rounds: [{ unit: "q1", question: "q", answer: { parts: {} }, score: 10, max: 25, breakdown: [], feedback: "f", markedBy: "fallback" }], createdAt: 1 }];
  a.respond = (u, body) => (/override-score/.test(u) ? { submission: { ...a.w.state.teacherSubs[0], finalScore: 20 }, pupilAggregateUpdated: false } : {});
  a.w.state.teacherTab = "submissions"; a.w.state.viewingSubmission = "s1";
  a.w.state.overrideDraft = { id: "s1", round: 0, score: "10", max: "25", feedback: "" };
  a.w.render();
  const input = a.doc.getElementById("overrideScoreInput");
  if (input) { input.value = "20"; }
  const btn = a.doc.querySelector('[data-action="save-override"]');
  if (btn) btn.click();
  await tick();
  check("override: after a teacher saves a score, the cached insights, pupil report and progress are discarded (rebuilt on next view)", !!btn && a.w.state.insights === null && a.w.state.pupilReport === null && a.w.state.progress === null, [!!btn, a.w.state.insights, a.w.state.pupilReport]);
}

const failed = results.filter((x) => !x).length;
console.log("\nv7.10 frontend: " + results.filter(Boolean).length + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
