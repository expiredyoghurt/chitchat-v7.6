// v8.0 UI in jsdom: tappable chart, words-first summaries, keyboard focus, first-use hint,
// Skill Coach + quest, and the teacher's mini skill shapes.
import { JSDOM } from "jsdom";
import { PAGE_HTML } from "../frontend.js";

const results = [];
function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra))));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = async () => { for (let i = 0; i < 5; i++) await sleep(0); };

async function make(role, opts) {
  opts = opts || {};
  const dom = new JSDOM(PAGE_HTML, { runScripts: "dangerously", url: "https://example.com/", pretendToBeVisual: true, beforeParse(win) {
    win.Element.prototype.scrollIntoView = () => {}; win.scrollTo = () => {}; win.print = () => {};
    if (opts.storage) for (const [k, v] of Object.entries(opts.storage)) win.localStorage.setItem(k, v);
    if (opts.brokenStorage) Object.defineProperty(win, "localStorage", { get() { throw new Error("blocked"); } });
  } });
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
  await new Promise((r) => (doc.readyState === "complete" ? r() : w.addEventListener("load", r)));
  w.state.token = "tok"; w.state.role = role;
  if (role === "teacher") { w.state.name = "palpatine"; w.state.isSuperAdmin = true; w.state.screen = "teacher"; w.state.teacherTab = "leaderboard"; w.state.classesList = ["5ig", "6ha"]; }
  else { w.state.name = opts.name || "Jovan"; w.state.pupilClass = "5ig"; w.state.screen = "pupil"; w.state.pupilTab = "play"; }
  w.render();
  return a;
}
const click = (a, sel) => { const el = a.doc.querySelector(sel); if (!el) throw new Error("missing " + sel); el.dispatchEvent(new a.w.MouseEvent("click", { bubbles: true, cancelable: true })); };
const key = (a, el, k) => el.dispatchEvent(new a.w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const KEYS = ["Thought", "Reason", "Evidence", "Experience", "Suggestion", "Grammar", "Vocabulary", "Fluency"];
const axes = (pcts, prev) => KEYS.map((k, i) => ({ key: k, label: k, pct: pcts[i], prevPct: prev ? prev[i] : null, delta: prev && pcts[i] !== null && prev[i] !== null ? pcts[i] - prev[i] : null }));
const webOf = (pcts, o) => ({ window: 5, n: 4, nPrev: o && o.prev ? 5 : 0, practiceOnly: false, axes: axes(pcts, o && o.prev), sub: [{ label: "Relevance", pct: 100, prevPct: null }, { label: "5W1H Specificity", pct: 50, prevPct: null }], excludedRounds: 0, staffMarked: 0, adjusted: false });
const dummy = { id: "d1", createdAt: 1000, topicId: "t1", topicTitle: "Helping Others", finalScore: 15, maxScore: 25, practice: false, retryOf: null, units: [{ score: 15, max: 25 }, { score: 15, max: 25 }], criteria: [] };
const skillMap = (pcts) => { const ax = {}; KEYS.forEach((k, i) => { if (pcts[i] !== null) ax[k] = { points: pcts[i], max: 100 }; }); return { axes: ax, sub: {}, used: 2, excluded: 0, staffMarked: 0, adjusted: false, total: 2 }; };
const progress = (web, entries) => ({ entries: entries || [dummy], summary: { attempts: 4, best: null, mostImproved: null, strongest: null, weakest: null, criteria: [], skillWeb: web, skillWebAll: web } });
const goProgress = async (a, data) => { a.respond = (u) => (/\/api\/pupil\/progress/.test(u) ? data : {}); click(a, '.tab[data-tab="progress"]'); await tick(); };
const WEB = webOf([100, 80, 50, 64, 40, 100, 20, null], { prev: [50, 80, 50, 50, 60, 90, 20, null] });

// ===== 1. tappable chart =====
{
  const a = await make("pupil");
  await goProgress(a, progress(WEB));
  const svg = a.doc.querySelector("#skillWebCard svg.skillweb");
  const hits = [...svg.querySelectorAll(".sw-hit")];
  check("chart: every skill label is a real button on the chart (8), reachable by keyboard", hits.length === 8 && hits.every((h) => h.getAttribute("role") === "button" && h.getAttribute("tabindex") === "0" && h.getAttribute("data-action") === "skill-focus"));
  check("chart: each button says the skill, its value and what it does", /^Thought, 100 percent\. Show details\.$/.test(hits[0].getAttribute("aria-label")) && /^Fluency, no data yet/.test(hits[7].getAttribute("aria-label")));
  check("chart: the interactive chart is a labelled group (an image role would hide its buttons)", svg.getAttribute("role") === "group" && /Skill web\./.test(svg.getAttribute("aria-label")));
  check("chart: nothing is selected to begin with (aria-pressed false everywhere)", hits.every((h) => h.getAttribute("aria-pressed") === "false") && !a.doc.querySelector(".sw-focus"));
  hits[3].querySelector("text").dispatchEvent(new a.w.MouseEvent("click", { bubbles: true }));
  const sel = a.doc.querySelector('.sw-hit[data-skill="Experience"]');
  check("chart: tapping the Experience label on the chart opens its details", !!a.doc.querySelector(".sw-focus") && /Experience/.test(a.doc.querySelector(".sw-focus").textContent) && /Relevance/.test(a.doc.querySelector(".sw-focus").textContent));
  check("chart: the tapped label is marked (pressed, ring), its spoke is drawn thicker, and the matching list row is highlighted", sel.getAttribute("aria-pressed") === "true" && sel.classList.contains("on") && /stroke-width="3"/.test(a.doc.querySelector("svg.skillweb").innerHTML) && a.doc.querySelector('.sw-row[data-skill="Experience"]').classList.contains("on") && a.doc.querySelector('.sw-row[data-skill="Experience"]').getAttribute("aria-expanded") === "true");
  check("chart: the details panel sits right under the chart, above the list", !!(a.doc.querySelector("svg.skillweb").compareDocumentPosition(a.doc.querySelector(".sw-focus")) & 4) && !!(a.doc.querySelector(".sw-focus").compareDocumentPosition(a.doc.querySelector(".sw-list")) & 4));
  check("chart: after the re-render the keyboard is still on the same chart button", a.doc.activeElement === a.doc.querySelector('.sw-hit[data-skill="Experience"]'), a.doc.activeElement && a.doc.activeElement.outerHTML.slice(0, 80));
  key(a, a.doc.querySelector('.sw-hit[data-skill="Experience"]'), "Enter");
  check("chart: Enter on the focused label toggles it closed again (SVG elements have no .click(), handled)", !a.doc.querySelector(".sw-focus"));
  key(a, a.doc.querySelector('.sw-hit[data-skill="Thought"]'), " ");
  check("chart: Space opens Thought, and it is marked as pressed", /Deep Thinker/.test(a.doc.querySelector(".sw-focus").textContent) && a.doc.querySelector('.sw-hit[data-skill="Thought"]').getAttribute("aria-pressed") === "true");
  click(a, '.sw-row[data-skill="Reason"]');
  check("chart: choosing a skill from the list marks it on the chart too", a.doc.querySelector('.sw-hit[data-skill="Reason"]').classList.contains("on") && !a.doc.querySelector('.sw-hit[data-skill="Thought"]').classList.contains("on") && a.doc.activeElement === a.doc.querySelector('.sw-row[data-skill="Reason"]'));
  click(a, '.sw-focus [data-action="skill-focus"]');
  check("chart: the Close button closes the panel and returns the keyboard to that skill's row", !a.doc.querySelector(".sw-focus") && a.doc.activeElement === a.doc.querySelector('.sw-row[data-skill="Reason"]'));
}

// ===== 2. words-first summary =====
{
  const a = await make("pupil");
  const w = a.w;
  const strip = (h) => h.replace(/<[^>]+>/g, "").replace(/&rarr;/g, "->").replace(/&[a-z#0-9]+;/g, " ");
  const up = strip(w.skillMovesHtml([100, 50, 50, 50, 50, 50, 50, 50], [50, 50, 50, 50, 50, 50, 50, 50]));
  check("words: one level-up is named with level names (Thought grew from Sapling to Grand Oak)", /Level up!/.test(up) && /Thought grew from Sapling to Grand Oak/.test(up), up);
  const two = strip(w.skillMovesHtml([100, 100, 100, 50, 50, 50, 50, 50], [10, 10, 10, 50, 50, 50, 50, 50]));
  check("words: several level-ups: the two biggest are named, the rest counted", /\(and 1 more\)/.test(two) && (two.match(/grew from/g) || []).length === 2, two);
  const dip = strip(w.skillMovesHtml([50, 50, 50, 50, 50, 50, 10, 50], [50, 50, 50, 50, 50, 50, 50, 50]));
  check("words: a drop is framed gently ('a little dip'), with the level change", /A little dip: Vocabulary \(Sapling -> Seedling\)/.test(dip) && /worth another look/.test(dip) && !/fell|worse|bad|weak/i.test(dip), dip);
  const both = strip(w.skillMovesHtml([100, 50, 50, 50, 50, 50, 10, 50], [50, 50, 50, 50, 50, 50, 50, 50]));
  check("words: ups and dips together, good news first", /Level up!.*A little dip/.test(both) && both.indexOf("Level up") < both.indexOf("dip"), both);
  const gain = strip(w.skillMovesHtml([55, 50, 50, 50, 50, 50, 50, 50], [44, 50, 50, 50, 50, 50, 50, 50]));
  check("words: a big gain inside the same level is called out ('Biggest gain')", /Biggest gain: Thought \(\+11 points\)/.test(gain), gain);
  const steady = strip(w.skillMovesHtml([50, 50, 50, 50, 50, 50, 50, 50], [52, 50, 50, 50, 50, 50, 50, 50]));
  check("words: nothing moved -> 'steady'", /Right on your usual shape/.test(steady), steady);
  const first = strip(w.skillMovesHtml([100, 80, 50, 70, 100, 100, 20, 60], null));
  check("words: no earlier attempts -> strongest skill and the next quest", /strongest skill this time: Thought \(100%\)/.test(first) && /Next quest: Vocabulary/.test(first), first);
  check("words: the sentence is announced politely (role=status) and has no raw undefined/NaN", /role="status"/.test(w.skillMovesHtml([50, 50, 50, 50, 50, 50, 50, 50], null)) && !/undefined|NaN/.test(w.skillMovesHtml([null, null, null, null, null, null, null, null], [null, null, null, null, null, null, null, null])));
}
const rec = (id, pcts, extra) => ({ id, pupilName: "Jovan", pupilClass: "5ig", topicId: "t1", topicTitle: "Helping Others", mode: "trees", finalScore: 15, maxScore: 25, practice: false, flagged: false, gradingDegraded: false, retryOf: null, createdAt: 2000,
  rounds: [{ unit: "q1", question: "Q1?", answer: { parts: {} }, score: 15, max: 25, breakdown: [], feedback: "f", markedBy: "groq" }, { unit: "q2q3", questions: ["a", "b"], answers: [{ parts: {} }, { parts: {} }], score: 15, max: 25, breakdown: [], feedback: "f", markedBy: "groq", modelAnswers: ["", ""], observed: [] }],
  skills: skillMap(pcts), ...(extra || {}) });
const showResult = async (a, r, prev) => { a.w.state.pupilTab = "play"; a.w.state.lastResult = r; a.w.state.previousResult = prev || null; a.w.render(); await tick(); };
{
  const a = await make("pupil");
  a.respond = (u) => (/\/api\/pupil\/progress/.test(u) ? progress(WEB, [
    { id: "o1", createdAt: 1000, practice: false, skills: skillMap([40, 40, 40, 40, 40, 40, 40, 40]) },
    { id: "now1", createdAt: 2000, practice: false, skills: skillMap([100, 80, 50, 70, 100, 100, 20, 60]) }]) : {});
  await showResult(a, rec("now1", [100, 80, 50, 70, 100, 100, 20, 60]));
  const box = a.doc.getElementById("resultSkillWeb");
  const first = box.firstElementChild.nextElementSibling;
  check("result: a plain-words sentence comes first, before the chart", first.classList.contains("sw-moves") && /Level up!/.test(first.textContent) && /Thought grew from Sapling to Grand Oak/.test(first.textContent), first.textContent);
  const det = box.querySelector("details.sw-more");
  check("result: the eight per-skill chips are tucked behind 'See every skill' (closed by default)", !!det && !det.open && /See every skill/.test(det.querySelector("summary").textContent) && det.querySelectorAll(".sw-chip").length === 8);
  check("result: the chart itself is not interactive here (nothing to tap), still an image with a table", !box.querySelector(".sw-hit") && box.querySelector("svg").getAttribute("role") === "img");
  const b = await make("pupil");
  b.respond = (u) => (/\/api\/pupil\/progress/.test(u) ? progress(WEB, [{ id: "only", createdAt: 2000, practice: false, skills: skillMap([100, 80, 50, 70, 100, 100, 20, 60]) }]) : {});
  await showResult(b, rec("only", [100, 80, 50, 70, 100, 100, 20, 60]));
  check("result: a first attempt says its strongest skill and next quest in words", /strongest skill this time: Thought/.test(b.doc.querySelector("#resultSkillWeb .sw-moves").textContent));
  const c = await make("pupil"); c.respond = () => ({});
  await showResult(c, rec("s", [80, 80, 80, 80, 80, 80, 80, 80], { retryOf: "f", finalScore: 21 }), rec("f", [20, 20, 20, 20, 20, 20, 20, 20]));
  const rt = c.doc.getElementById("retrySkillWeb");
  check("retry: the comparison also leads with a sentence ('Second try: Level up! ... Sprout to Grand Oak'), chips are tucked away", /Second try:/.test(rt.querySelector(".sw-moves").textContent) && /Sprout to Grand Oak/.test(rt.querySelector(".sw-moves").textContent) && !!rt.querySelector("details.sw-more") && !rt.querySelector("details.sw-more").open);
}

// ===== 3. keyboard focus =====
{
  const a = await make("pupil");
  const css = a.doc.querySelector("style").textContent;
  check("focus: a visible two-tone ring (blue outline + white halo) for buttons, role=button, summaries, selects, links and topic cards", /:focus-visible\{outline:3px solid #1f5c9b/.test(css) && /button:focus-visible,\[role=button\]:focus-visible[^{]*summary:focus-visible[^{]*select:focus-visible[^{]*\.topic-card:focus-visible\{box-shadow:0 0 0 2px #fff/.test(css));
  check("focus: the chart's own labels get a drawn ring on focus (SVG ignores box-shadow)", /\.sw-hit:focus-visible \.sw-ring\{stroke:#1f5c9b;stroke-width:3\.5/.test(css) && /\.sw-hit\{cursor:pointer;outline:none/.test(css));
  a.w.state.topics = [{ id: "t1", title: "Helping Others", imageUrl: "", tags: [], questions: ["q1", "q2", "q3"], coach: [] }]; a.w.state.screen = "pupil"; a.w.state.pupilTab = "play"; a.w.render();
  const card = a.doc.querySelector(".topic-card");
  check("focus: topic cards are keyboard buttons now (role, tabindex, name) - they were mouse-only", card.getAttribute("role") === "button" && card.getAttribute("tabindex") === "0" && /Choose topic: Helping Others/.test(card.getAttribute("aria-label")));
  key(a, card, "Enter");
  check("focus: Enter on a topic card starts the topic", a.w.state.currentTopic && a.w.state.currentTopic.id === "t1");
  const b = await make("pupil");
  await goProgress(b, progress(WEB));
  const bad = [...b.doc.querySelectorAll("#skillWebCard [data-action]")].filter((el) => !/^(BUTTON|A|INPUT|SELECT)$/.test(el.tagName) && !(el.getAttribute("role") === "button" && el.getAttribute("tabindex") === "0"));
  check("focus: everything clickable in the skill web card can be reached with Tab (button or role=button+tabindex)", bad.length === 0, bad.map((e) => e.outerHTML.slice(0, 60)));
}

// ===== 4. first-use hint =====
{
  const a = await make("pupil", { name: "Jovan" });
  await goProgress(a, progress(WEB));
  const hint = a.doc.querySelector(".sw-hint");
  check("hint: shown the first time, one short line that explains solid vs dashed, with a Got it button", !!hint && /solid shape/.test(hint.textContent) && /dashed outline/.test(hint.textContent) && /Tap a skill/.test(hint.textContent) && !!hint.querySelector('[data-action="dismiss-sw-hint"]'));
  check("hint: it is a polite note, not a modal (no focus trap)", hint.getAttribute("role") === "note");
  click(a, '[data-action="dismiss-sw-hint"]');
  check("hint: Got it hides it, remembers it for this pupil on this device, and returns the keyboard to the card", !a.doc.querySelector(".sw-hint") && a.w.localStorage.getItem("chitchat:swhint:v1:jovan|5ig") === "1" && a.doc.activeElement === a.doc.getElementById("skillWebCard"));
  click(a, '[data-action="toggle-skill-practice"]'); click(a, '[data-action="toggle-skill-practice"]');
  check("hint: it stays hidden after re-renders", !a.doc.querySelector(".sw-hint"));
  const b = await make("pupil", { name: "Jovan", storage: { "chitchat:swhint:v1:jovan|5ig": "1" } });
  await goProgress(b, progress(WEB));
  check("hint: a returning pupil on the same device never sees it again", !b.doc.querySelector(".sw-hint"));
  const c = await make("pupil", { name: "Mei", storage: { "chitchat:swhint:v1:jovan|5ig": "1" } });
  await goProgress(c, progress(WEB));
  check("hint: another pupil on a shared device still gets it", !!c.doc.querySelector(".sw-hint"));
  const d = await make("pupil", { name: "Jovan" });
  await goProgress(d, progress(webOf([100, 80, 50, 64, 40, 100, 20, null])));
  check("hint: before there is an 'earlier' outline it says one will appear after a few more attempts", /After a few more attempts/.test(d.doc.querySelector(".sw-hint").textContent) && !/is where you were before/.test(d.doc.querySelector(".sw-hint").textContent));
  const e = await make("pupil", { name: "Jovan", brokenStorage: true });
  await goProgress(e, progress(WEB));
  click(e, '[data-action="dismiss-sw-hint"]');
  check("hint: if the browser blocks storage, dismissing still works for the session (no error)", !e.doc.querySelector(".sw-hint"));
  const f = await make("pupil", { name: "Jovan" });
  await goProgress(f, progress({ ...webOf([null, null, null, null, null, null, null, null]), n: 0 }));
  check("hint: not shown when there is no web yet", !f.doc.querySelector(".sw-hint"));
}

// ===== 5. Skill Coach and quest =====
{
  const a = await make("pupil");
  await goProgress(a, progress(WEB));
  click(a, '.sw-row[data-skill="Evidence"]');
  const ask = a.doc.querySelector('.sw-focus [data-action="skill-coach"]');
  check("coach: every skill panel offers 'Ask the Coach about <skill>' and 'Practise this skill'", /Ask the Coach about Evidence/.test(ask.textContent) && ask.getAttribute("aria-expanded") === "false" && !!a.doc.querySelector('.sw-focus [data-action="skill-quest"]') && !a.doc.querySelector(".sw-focus .coach-panel"));
  click(a, '.sw-focus [data-action="skill-coach"]');
  const panel = a.doc.querySelector(".sw-focus .coach-panel");
  check("coach: it shows three sentence starters, a tip and where the skill counts, in the familiar Coach panel", !!panel && panel.querySelectorAll("li").length === 3 && /In the picture, I can see/.test(panel.textContent) && /Counts in: Question 1/.test(panel.textContent) && a.doc.querySelector('.sw-focus [data-action="skill-coach"]').getAttribute("aria-expanded") === "true" && a.doc.activeElement === a.doc.querySelector('.sw-focus [data-action="skill-coach"]'));
  check("coach: it is separate from the topic Coach used during an attempt (no coach-use flags change)", JSON.stringify(a.w.state.coachUsed) === JSON.stringify([false, false, false]) && JSON.stringify(a.w.state.coachOpen) === JSON.stringify([false, false, false]));
  click(a, '.sw-focus [data-action="skill-coach"]');
  check("coach: it closes again", !a.doc.querySelector(".sw-focus .coach-panel"));
  check("coach: every skill has starters, a tip and a place (8 of 8)", a.w.SKILLS.every((s) => a.w.SKILL_COACH[s.key] && a.w.SKILL_COACH[s.key].starters.length === 3 && a.w.SKILL_COACH[s.key].tip && a.w.SKILL_COACH[s.key].where));
  click(a, '.sw-row[data-skill="Evidence"]');
  const nq = a.doc.querySelector('.sw-quest [data-action="skill-coach-open"]');
  check("coach: 'Next quest' has its own button for the lowest skill (Vocabulary)", /Ask the Coach about Vocabulary/.test(nq.textContent));
  nq.dispatchEvent(new a.w.MouseEvent("click", { bubbles: true }));
  check("coach: it opens that skill's panel with the Coach already showing, and moves the keyboard to it", /Vocabulary/.test(a.doc.querySelector(".sw-focus").textContent) && !!a.doc.querySelector(".sw-focus .coach-panel") && a.doc.activeElement === a.doc.querySelector(".sw-focus"));
  // quest
  click(a, '.sw-focus [data-action="skill-quest"]');
  check("quest: 'Practise this skill' sets the quest and goes to the topic list, which shows a quest banner", a.w.state.questSkill === "Vocabulary" && a.w.state.pupilTab === "play" && /Your quest:/.test(a.doc.body.textContent) && /Vocabulary/.test(a.doc.querySelector(".sw-quest-banner").textContent));
  click(a, '[data-action="clear-quest"]');
  check("quest: Clear quest removes it", a.w.state.questSkill === "" && !a.doc.querySelector(".sw-quest-banner"));
}
{
  const a = await make("pupil");
  a.w.state.topics = [{ id: "t1", title: "Helping Others", imageUrl: "", tags: [], questions: ["Q one?", "Q two?", "Q three?"], coach: [{ starters: [], resources: [] }, { starters: [], resources: [] }, { starters: [], resources: [] }] }];
  a.w.state.currentTopic = a.w.state.topics[0]; a.w.state.questSkill = "Evidence"; a.w.render();
  const chips = [...a.doc.querySelectorAll(".sw-quest-chip")];
  check("quest: a Question-1-only skill (Evidence) shows its chip on Question 1 only", chips.length === 1 && /Evidence/.test(chips[0].textContent) && /Question 1 of 3/.test(chips[0].closest(".card").textContent));
  a.w.state.questSkill = "Experience"; a.w.render();
  check("quest: a skill that counts in every question (Experience) shows on all three", a.doc.querySelectorAll(".sw-quest-chip").length === 3);
  a.w.state.questSkill = ""; a.w.render();
  check("quest: no quest, no chips", a.doc.querySelectorAll(".sw-quest-chip").length === 0);
  // result closure
  const b = await make("pupil");
  b.respond = (u) => (/\/api\/pupil\/progress/.test(u) ? progress(WEB, [{ id: "o1", createdAt: 1000, practice: false, skills: skillMap([40, 40, 40, 40, 40, 40, 40, 40]) }, { id: "n1", createdAt: 2000, practice: false, skills: skillMap([100, 80, 60, 70, 100, 100, 20, 60]) }]) : {});
  b.w.state.questSkill = "Evidence";
  await showResult(b, rec("n1", [100, 80, 60, 70, 100, 100, 20, 60]));
  check("quest: the result says how the quest skill did (Evidence 60% against a usual 40%)", /Quest check: Evidence is at 60% \(your usual: 40%\)/.test(b.doc.querySelector("#resultSkillWeb").textContent.replace(/\s+/g, " ")), b.doc.querySelector("#resultSkillWeb").textContent.slice(0, 300));
  const c = await make("pupil"); c.respond = () => ({});
  c.w.state.questSkill = "Fluency";
  await showResult(c, rec("m", [100, 80, 60, 70, 100, 100, 20, null]));
  check("quest: if the quest skill was not marked this time it says so kindly", /Fluency wasn.t marked this time/.test(c.doc.querySelector("#resultSkillWeb").textContent));
}

// ===== 6. teacher mini shapes =====
{
  const a = await make("teacher");
  const minis = { pupils: [
    { name: "Jovan", pupilClass: "5ig", n: 5, pcts: [100, 80, 50, 64, 40, 100, 20, null] },
    { name: "Mei", pupilClass: "5ig", n: 0, pcts: [null, null, null, null, null, null, null, null] },
    { name: "Ravi", pupilClass: "6ha", n: 1, pcts: [50, null, null, null, 30, null, null, null] }], capped: false };
  a.respond = (u) => (/pupil-skills/.test(u) ? minis : (/\/api\/teacher\/pupils/.test(u) ? { pupils: [
    { name: "Jovan", pupilClass: "5ig", attempts: 6, bestScore: 20 }, { name: "Mei", pupilClass: "5ig", attempts: 2, bestScore: 9 }, { name: "Ravi", pupilClass: "6ha", attempts: 1, bestScore: 8 }] } : {}));
  click(a, '.tab[data-tab="pupils"]'); await tick(); await tick();
  const rows = [...a.doc.querySelectorAll(".board-row")];
  check("minis: every pupil row has a slot at the start; Jovan's is a small web with a plain-words label", rows.length === 3 && !!rows[0].querySelector("svg.sw-mini") && /strongest Thought 100 percent, lowest Vocabulary 20 percent/.test(rows[0].querySelector("svg.sw-mini").getAttribute("aria-label")));
  check("minis: a pupil with nothing usable shows a dash with an explanation, not an empty chart", !rows[1].querySelector("svg") && /–/.test(rows[1].querySelector(".sw-mini-slot").textContent) && /No AI- or teacher-marked/.test(rows[1].querySelector(".sw-mini-slot").getAttribute("title")));
  check("minis: a pupil with only two skills marked still gets a line, not a broken polygon", !!rows[2].querySelector("svg.sw-mini polyline") && !rows[2].querySelector("svg.sw-mini polygon[fill^='rgba']"));
  check("minis: the plot has the pupil's shape drawn (filled polygon) and a dot per marked skill", !!rows[0].querySelector("svg.sw-mini polygon[fill^='rgba']") && rows[0].querySelectorAll("svg.sw-mini circle").length === 7);
  check("minis: a short key explains the order of the spokes", /starts at the top with Thought and goes clockwise/.test(a.doc.body.textContent));
  check("minis: the rows still carry the View Progress button", rows.every((r) => !!r.querySelector('[data-action="view-pupil"]')));
  const calls = a.log.filter((l) => /pupil-skills/.test(l.url)).length;
  check("minis: loaded once when the list loaded", calls === 1, calls);
  const sel = a.doc.getElementById("pupilsClassFilter"); sel.value = "6ha"; sel.dispatchEvent(new a.w.Event("change", { bubbles: true })); await tick(); await tick();
  check("minis: changing the class filter asks for that class's shapes", a.log.some((l) => /pupil-skills\?class=6ha/.test(l.url)));
  a.w.invalidateSkillCaches();
  check("minis: a re-mark or override drops the cached shapes", a.w.state.pupilMinis === null);
  click(a, '.tab[data-tab="leaderboard"]'); click(a, '.tab[data-tab="pupils"]'); await tick(); await tick();
  check("minis: coming back to the Pupils tab fetches fresh shapes", a.log.filter((l) => /pupil-skills/.test(l.url)).length >= 3 && !!a.w.state.pupilMinis, a.log.filter((l) => /pupil-skills/.test(l.url)).length);
  const b = await make("teacher");
  b.respond = (u) => (/pupil-skills/.test(u) ? { __fail: true, error: "x" } : (/\/api\/teacher\/pupils/.test(u) ? { pupils: [{ name: "Jovan", pupilClass: "5ig", attempts: 1, bestScore: 5 }] } : {}));
  click(b, '.tab[data-tab="pupils"]'); await tick(); await tick();
  check("minis: if the shapes cannot be loaded the list still works (quiet empty slot, no error text)", b.doc.querySelectorAll(".board-row").length === 1 && !!b.doc.querySelector(".sw-mini-slot") && !/error|failed/i.test(b.doc.getElementById("app").textContent));
}

// ===== 7. chart line colours are readable (WCAG 1.4.11: graphics need 3:1 against the chart background) =====
{
  const lum = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const a = await make("pupil");
  const svg = a.w.skillWebSvg([{ name: "c", pcts: [50, 50, 50, 50, 50, 50, 50, 50], style: "class" }, { name: "p", pcts: [40, 40, 40, 40, 40, 40, 40, 40], style: "prev" }, { name: "n", pcts: [60, 60, 60, 60, 60, 60, 60, 60], style: "now" }]);
  const strokes = [...new Set([...svg.matchAll(/stroke="(#[0-9a-f]{6})"/g)].map((m) => m[1]))].filter((c) => !["#dbe6d6", "#b9cdb9"].includes(c));
  check("contrast: every data line / marker colour in the chart is at least 3:1 on the chart background (" + strokes.join(", ") + ")", strokes.length >= 3 && strokes.every((c) => cr(c, "#fbfdf9") >= 3), strokes.map((c) => c + " " + cr(c, "#fbfdf9").toFixed(2)));
}

const failed = results.filter((x) => !x).length;
console.log("\nv8.0 frontend: " + results.filter(Boolean).length + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
