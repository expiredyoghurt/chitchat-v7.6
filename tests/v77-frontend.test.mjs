// v7.7 UI in jsdom: pupil's own marks + Present/Not observed, the 'Your response | Improved response' table,
// Q2&3 labelling, teacher 'Retry AI suggested answer'.
import { JSDOM } from "jsdom";
import { PAGE_HTML } from "../frontend.js";

const fetchLog = [];
let respond = () => ({});
const dom = new JSDOM(PAGE_HTML, { runScripts: "dangerously", url: "https://example.com/" });
const { window } = dom;
window.fetch = (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  fetchLog.push({ url, method: (opts && opts.method) || "GET", body });
  let data = respond(url, body);
  if (data === undefined) data = {};
  if (url.includes("/api/leaderboard")) data = { leaderboard: [] };
  return Promise.resolve({ ok: !data.__fail, json: () => Promise.resolve(data) });
};
window.Element.prototype.scrollIntoView = () => {};
window.confirm = () => true; window.alert = () => {};
const results = [];
function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  -> " + extra));
}
const tick = () => new Promise((r) => setTimeout(r, 0));
await new Promise((r) => window.addEventListener("load", r));
const w = window, doc = window.document;
const app = () => doc.getElementById("app");
const typeInto = (id, v) => { const el = doc.getElementById(id); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
const changeSel = (id, v) => { const el = doc.getElementById(id); el.value = v; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
const click = (sel) => doc.querySelector(sel).click();


const crit = (part, points, max, note, sub) => ({ part, points, max, note: note || "", ...(sub ? { subBreakdown: sub } : {}) });
const SUBS = ["Relevance", "5W1H Specificity", "Authenticity / Personal Voice", "Clarity & Sequence", "Reflection / Lesson Learnt", "Depth & Development Across Both Answers"].map((l, i) => ({ label: l, points: 1, max: [2, 6, 2, 2, 2, 2][i] }));
const q1Round = (extra) => ({ unit: "q1", question: "What is happening in the picture?", mode: "trees", answer: { parts: { T: "I think it is kind", R: "because he shares", E1: "I can see a boy giving food", E2: "Last week I shared my lunch", S: "We should help more" } },
  score: 20, max: 25, breakdown: [crit("Thought", 2, 2, "Clear opinion."), crit("Experience", 9, 12, "Good detail on who and where."), crit("Grammar Accuracy", 2, 2)], feedback: "FB-Q1", suggestion: "SUG-Q1", strengths: "S-Q1", nextStep: "N-Q1", modelAnswer: "IMPROVED-Q1 paragraph", markedBy: "gemini", ...(extra || {}) });
const q23Round = (extra) => ({ unit: "q2q3", questions: ["Tell me about a time you helped.", "What did you learn?"], question: "Q2: a | Q3: b", mode: "trees",
  answers: [{ parts: { T: "", R: "", E1: "", E2: "My friend fell at the canteen and I helped him up", S: "Teachers should watch the stairs" } }, { parts: { T: "", R: "", E1: "", E2: "In the end he thanked me", S: "" } }],
  score: 16, max: 25, breakdown: [crit("Experience", 11, 16, "Specific who and where.", SUBS), crit("Suggestion", 2, 2, "Practical."), crit("Grammar Accuracy", 2, 3), crit("Vocabulary Range & Appropriateness", 1, 3), crit("Fluency & Delivery", 0, 1)],
  observed: [{ part: "Thought", status: "Not observed" }, { part: "Reason", status: "Present" }, { part: "Evidence", status: "Present" }],
  feedback: "FB-Q23", suggestion: "SUG-Q23", strengths: "S-Q23", nextStep: "N-Q23", modelAnswer: "IMPROVED-Q2\n\nIMPROVED-Q3", modelAnswers: ["IMPROVED-Q2 text", "IMPROVED-Q3 text"], markedBy: "groq", ...(extra || {}) });
const record = (extra) => ({ id: "s1", pupilName: "Jovan", pupilClass: "5ig", topicId: "t", topicTitle: "Helping Others", mode: "trees", finalScore: 18, maxScore: 25, practice: false, retryOf: null, gradingDegraded: false, createdAt: Date.now(), rounds: [q1Round(), q23Round()], ...(extra || {}) });

w.state.token = "tok"; w.state.role = "pupil"; w.state.name = "Jovan"; w.state.pupilClass = "5ig";
w.state.screen = "pupil"; w.state.pupilTab = "play"; w.state.canRetry = false;
w.state.currentTopic = { id: "t", title: "Helping Others", questions: ["What is happening in the picture?", "Tell me about a time you helped.", "What did you learn?"], imageUrl: "", coach: [] };

// ---------- 1. result screen: own marks ----------
w.state.lastResult = record(); w.render(); await tick();
let text = () => app().textContent;
let html = () => app().innerHTML;
const cards = () => Array.from(doc.querySelectorAll("#app .card.stack"));
check("result: a 'Your marks' card on each unit with the unit score", doc.querySelectorAll("#app .card strong").length > 0 && text().includes("Your marks") && text().includes("20 / 25") && text().includes("16 / 25"));
check("result: every criterion shows points / max and the AI's note", text().includes("Thought") && text().includes("2 / 2") && text().includes("Experience") && text().includes("9 / 12") && text().includes("Good detail on who and where.") && text().includes("11 / 16") && text().includes("Fluency & Delivery") && text().includes("0 / 1"));
const detailsEls = Array.from(doc.querySelectorAll("#app details"));
const subDetails = detailsEls.filter((d) => d.textContent.includes("See detail") && d.textContent.includes("Depth & Development Across Both Answers"));
check("result: the six Experience sub-criteria sit under a collapsed 'See detail' toggle", subDetails.length === 1 && !subDetails[0].open && subDetails[0].querySelectorAll(".breakdown-row").length === 6);
check("result: Unit 1 (Q1) has no Present/Not observed block", !cards()[0].textContent.includes("Not observed") && !cards()[0].textContent.includes("for information only"));
const unit2Text = cards()[1].textContent;
check("result: Q2&3 states Thought: Not observed, Reason: Present, Evidence: Present, labelled information only", unit2Text.includes("Thought: Not observed") && unit2Text.includes("Reason: Present") && unit2Text.includes("Evidence: Present") && unit2Text.includes("no marks are given for these"));
check("result: observed items are chips, ticked only when Present", doc.querySelectorAll("#app .nudge-chip.done").length === 2 && doc.querySelectorAll("#app .nudge-chip").length === 3);
check("result: heading says 'Questions 2 & 3 (assessed together)', both questions are stated", unit2Text.includes("Questions 2 & 3 (assessed together)") && unit2Text.includes("Question 2: Tell me about a time you helped.") && unit2Text.includes("Question 3: What did you learn?"));
check("result: the 'assessed together, holistically, as one story' line is shown", unit2Text.includes("Questions 2 and 3 are assessed together, holistically, as one story."));
check("result: the final score is still prominent", text().includes("18 / 25 points"));

// ---------- 2. the table ----------
const tables = Array.from(doc.querySelectorAll("#app table.resp-table"));
check("table: one per unit, headed 'Your response | Improved response'", tables.length === 2 && tables.every((t) => Array.from(t.querySelectorAll("th")).map((x) => x.textContent).join("|") === "Your response|Improved response"));
check("table Q1: one row; branch-mode boxes are combined into ONE paragraph with sentence punctuation", tables[0].querySelectorAll("tbody tr:not(.resp-q)").length === 1 && tables[0].querySelector("td[data-label='Your response']").textContent.trim() === "I think it is kind. because he shares. I can see a boy giving food. Last week I shared my lunch. We should help more.", tables[0].querySelector("td[data-label='Your response']").textContent);
check("table Q1: the improved response sits beside it", tables[0].querySelector("td[data-label='Improved response']").textContent.includes("IMPROVED-Q1 paragraph"));
const q23rows = Array.from(tables[1].querySelectorAll("tbody tr"));
check("table Q2&3: two rows, each headed by its own question", tables[1].querySelectorAll("tr.resp-q").length === 2 && tables[1].querySelectorAll("tr.resp-q")[0].textContent.includes("Question 2: Tell me about a time you helped.") && tables[1].querySelectorAll("tr.resp-q")[1].textContent.includes("Question 3: What did you learn?"));
const respCells = Array.from(tables[1].querySelectorAll("td[data-label='Your response']")).map((c) => c.textContent.trim());
check("table Q2&3: blank Thought/Reason/Evidence boxes are skipped; the story reads as a paragraph per answer", respCells[0] === "My friend fell at the canteen and I helped him up. Teachers should watch the stairs." && respCells[1] === "In the end he thanked me.", JSON.stringify(respCells));
const impCells = Array.from(tables[1].querySelectorAll("td[data-label='Improved response']")).map((c) => c.textContent.trim());
check("table Q2&3: each answer has its OWN improved response", impCells[0] === "IMPROVED-Q2 text" && impCells[1] === "IMPROVED-Q3 text");
check("the old single 'stronger version' panel is gone", !text().includes("A stronger version of your answer"));
check("on a phone the columns stack (CSS)", /@media \(max-width:640px\)\{[^}]*\.resp-table[^}]*display:block/.test(PAGE_HTML) && /td\[data-label\]::before/.test(PAGE_HTML));
check("every response/improved cell carries a data-label for the stacked layout", Array.from(tables[1].querySelectorAll("tbody tr:not(.resp-q) td")).every((c) => c.getAttribute("data-label")));
// single-box mode
const singleRec = record({ mode: "single", rounds: [q1Round({ mode: "single", answer: { text: "I think it is kind because he shares." } }), q23Round({ mode: "single", answers: [{ text: "Story part one." }, { text: "Story part two" }] })] });
w.state.lastResult = singleRec; w.render(); await tick();
const sRows = Array.from(doc.querySelectorAll("#app td[data-label='Your response']")).map((c) => c.textContent.trim());
check("single-box mode: the pupil's text is shown as written", sRows[0] === "I think it is kind because he shares." && sRows[1] === "Story part one." && sRows[2] === "Story part two");

// ---------- 3. improved answer unavailable ----------
const gap = record({ rounds: [q1Round({ modelAnswer: "" }), q23Round({ modelAnswers: ["IMPROVED-Q2 text", ""] })] });
w.state.lastResult = gap; w.render(); await tick();
const gapCells = Array.from(doc.querySelectorAll("#app td[data-label='Improved response']")).map((c) => c.textContent.trim());
check("pupil: a missing improved answer says 'AI suggested answer is currently not available' (only in that cell)", gapCells[0].includes("currently not available") && gapCells[1] === "IMPROVED-Q2 text" && gapCells[2].includes("currently not available"));
check("pupil: no retry button for pupils", !doc.querySelector('[data-action="retry-model-answer"]'));

// ---------- 4. classmate's entry: answers + improved, no marks ----------
const peerRound1 = q1Round(); delete peerRound1.score; delete peerRound1.max; delete peerRound1.breakdown;
const peerRound2 = q23Round(); delete peerRound2.score; delete peerRound2.max; delete peerRound2.breakdown; delete peerRound2.observed;
const peer = record({ id: "peer", pupilName: "Mei", rounds: [peerRound1, peerRound2] });
w.state.lastResult = null; w.state.pupilTab = "submissions"; w.state.subsScope = "all"; w.state.lbSubmissions = [peer]; w.state.viewingPupilSubmission = "peer"; w.state.mySubmissions = [];
w.render(); await tick();
check("classmate view: no 'Your marks', no per-criterion points, no observed chips", !text().includes("Your marks") && doc.querySelectorAll("#pupilSubmissionDetail .breakdown-row").length === 0 && doc.querySelectorAll("#pupilSubmissionDetail .nudge-chip").length === 0);
check("classmate view: reads their answers and the improved responses in the same table", doc.querySelectorAll("#pupilSubmissionDetail table.resp-table").length === 2 && text().includes("IMPROVED-Q2 text") && text().includes("their marks are private"));
// own entry in My Submissions
w.state.subsScope = "mine"; w.state.mySubmissions = [record()]; w.state.viewingPupilSubmission = "s1"; w.render(); await tick();
check("My Submissions: own entry shows the full marks and the table", text().includes("Your marks") && doc.querySelectorAll("#pupilSubmissionDetail table.resp-table").length === 2 && text().includes("11 / 16") && text().includes("Reason: Present"));
w.state.viewingPupilSubmission = null; w.state.pupilTab = "play";

// ---------- 5. legacy 3-question entry (own) ----------
const legacy = record({ id: "old", finalScore: 11, rounds: [0, 1, 2].map((i) => ({ question: "Legacy question " + (i + 1), mode: "trees", answer: { parts: { T: "t" + i, R: "", E1: "", E2: "legacy story " + i, S: "" } }, score: 10 + i, max: 25, breakdown: [crit("Thought", 1, 2, "ok"), crit("Experience", 6, 12)], feedback: "legacy fb " + i, suggestion: "", modelAnswer: "legacy improved " + i, markedBy: "groq" })) });
w.state.lastResult = legacy; w.render(); await tick();
check("legacy 3-question entry: three 'Your marks' cards and three one-row tables", (text().match(/Your marks/g) || []).length === 3 && doc.querySelectorAll("#app table.resp-table").length === 3 && text().includes("10 / 25") && text().includes("12 / 25") && text().includes("legacy improved 2"));
check("legacy entry: not labelled 'assessed together'", !text().includes("assessed together"));
// old combined sample (one story, no per-answer rewrites)
const oldCombined = record({ rounds: [q1Round(), q23Round({ modelAnswers: undefined, modelAnswer: "ONE-COMBINED-STORY" })] });
w.state.lastResult = oldCombined; w.render(); await tick();
check("an old combined improved story is still shown, as a full-width row", text().includes("Improved story (Questions 2 & 3):") && text().includes("ONE-COMBINED-STORY"));

// ---------- 6. retry screen ----------
w.state.lastResult = null; w.state.retrySession = record(); w.render(); await tick();
const rt = doc.getElementById("app");
check("retry: Q2 card states both questions and the holistic note", rt.textContent.includes("Question 2: Tell me about a time you helped.") && rt.textContent.includes("Question 3: What did you learn?") && rt.textContent.includes("assessed together, holistically, as one story"));
check("retry: the screen says Questions 2 & 3 are one story", rt.textContent.includes("Questions 2 & 3: one story"));
const retryCards = Array.from(doc.querySelectorAll("#app .card.stack")).filter((c) => c.querySelector("h3"));
check("retry: each question shows ITS improved version (Q1, Q2 and Q3)", retryCards[0].textContent.includes("IMPROVED-Q1 paragraph") && retryCards[1].textContent.includes("IMPROVED-Q2 text") && !retryCards[1].textContent.includes("IMPROVED-Q3 text") && retryCards[2].textContent.includes("IMPROVED-Q3 text"));
check("retry: the 'Last time' panel is still the overall score only", rt.textContent.includes("Last time: 18 / 25") && !rt.textContent.includes("Last time: 20"));
w.state.retrySession = null;

// ---------- 7. builder wording ----------
w.state.responseMode = "trees"; w.state.lastResult = null; w.render(); await tick();
check("builder: Q2 says 'assessed together, holistically' and one story told in two parts", text().includes("assessed together, holistically") && text().includes("one story told in two parts"));

// ---------- 8. teacher view ----------
const tRec = record({ rounds: [q1Round({ coachUsed: false }), q23Round({ coachUsed: false, coachUsedQuestions: [false, false], modelAnswers: ["IMPROVED-Q2 text", ""] })] });
w.state.role = "teacher"; w.state.isSuperAdmin = true; w.state.screen = "teacher"; w.state.teacherTab = "submissions";
w.state.teacherSubs = [tRec]; w.state.subsTotal = 1; w.state.viewingSubmission = "s1"; w.render(); await tick();
const sd = () => doc.getElementById("submissionDetail");
check("teacher: Unit 2 titled 'Questions 2 & 3 (assessed together)' with both questions and the holistic line", sd().textContent.includes("Unit 2 \u2014 Questions 2 & 3 (assessed together) \u2014 16/25") && sd().textContent.includes("Question 2: Tell me about a time you helped.") && sd().textContent.includes("Question 3: What did you learn?") && sd().textContent.includes("assessed together, holistically, as one story"));
check("teacher: sees Present / Not observed for Thought, Reason, Evidence", sd().textContent.includes("Thought: Not observed") && sd().textContent.includes("Reason: Present"));
check("teacher: sees the same table the pupil sees", sd().querySelectorAll("table.resp-table").length === 2);
const btns = Array.from(doc.querySelectorAll('#submissionDetail [data-action="retry-model-answer"]'));
check("teacher: a 'Retry AI suggested answer' button appears only on the round with a missing improved answer", btns.length === 1 && btns[0].textContent === "Retry AI suggested answer" && btns[0].getAttribute("data-round") === "1" && btns[0].getAttribute("data-id") === "s1");
check("teacher: the missing cell reads 'AI currently not available'", sd().textContent.includes("AI currently not available for this answer."));
fetchLog.length = 0;
respond = (url) => url.includes("retry-model-answer") ? { ok: true, success: false, message: "The AI is currently not available. Please try again in a few minutes.", submission: tRec } : {};
btns[0].click(); await tick(); await tick();
const call = fetchLog.find((f) => f.url.includes("/api/teacher/submissions/s1/retry-model-answer"));
check("clicking it POSTs the round index to the retry endpoint", call && call.method === "POST" && call.body.roundIndex === 1);
check("when the AI is still down the teacher is told so, in plain words, next to the button", sd().textContent.includes("The AI is currently not available. Please try again in a few minutes.") && !!doc.querySelector('#submissionDetail [data-action="retry-model-answer"]'));
const healedRec = record({ rounds: [q1Round({ coachUsed: false }), q23Round({ coachUsed: false, coachUsedQuestions: [false, false], modelAnswers: ["IMPROVED-Q2 text", "NEW-IMPROVED-Q3"] })] });
respond = (url) => url.includes("retry-model-answer") ? { ok: true, success: true, message: "", submission: healedRec } : {};
doc.querySelector('#submissionDetail [data-action="retry-model-answer"]').click(); await tick(); await tick();
check("on success the new improved answer appears and the button goes away", sd().textContent.includes("NEW-IMPROVED-Q3") && !doc.querySelector('#submissionDetail [data-action="retry-model-answer"]'));
check("teacher banner: pupils see their own marks, classmates never do", sd().textContent.includes("Pupils see their own marks and breakdown") && sd().textContent.includes("Assessed as 2 units"));
check("teacher: still has the score breakdown, override and unit summary", sd().querySelectorAll('[data-action="start-override"]').length === 2 && sd().textContent.includes("Unit 1 (Q1): 20/25") && sd().textContent.includes("Score breakdown"));

const passed = results.filter(Boolean).length;
console.log("\n" + passed + "/" + results.length + " checks passed");
process.exit(passed === results.length ? 0 : 1);
