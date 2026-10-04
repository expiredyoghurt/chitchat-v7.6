// v7.5 UI in jsdom: the pupil result screen shows only the overall average
// (no per-unit scores/breakdown), Q2+Q3 are presented as one marked unit, the
// teacher submission detail shows the per-unit breakdown, and a legacy
// 3-round submission still renders as three questions.
import { JSDOM } from "jsdom";
import { PAGE_HTML } from "../frontend.js";

const dom = new JSDOM(PAGE_HTML, { runScripts: "dangerously", url: "https://example.com/" });
const { window } = dom;
window.fetch = (url) => {
  let data = {};
  if (url.includes("/api/leaderboard")) data = { leaderboard: [] };
  else if (url.includes("/api/topics")) data = { topics: [] };
  else if (url.includes("rubric-q2q3")) data = { rubric: "Q2Q3 RUBRIC BODY", isDefault: true };
  else if (url.includes("/api/teacher/rubric")) data = { rubric: "Q1 RUBRIC BODY", isDefault: true };
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
};
const results = [];
function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  -> " + extra));
}
const tick = () => new Promise((r) => setTimeout(r, 0));
await new Promise((r) => window.addEventListener("load", r));
const w = window, doc = window.document;

// ---- pupil-facing record exactly as the server now sends it (no scores) ----
const pupilRecord = {
  id: "s1", pupilName: "Jovan", pupilClass: "5ig", topicId: "t", topicTitle: "Helping Others", mode: "trees",
  finalScore: 17.5, maxScore: 25, practice: false, retryOf: null, gradingDegraded: false,
  rounds: [
    { unit: "q1", question: "Q1 about the picture?", mode: "trees", answer: { parts: { T: "t", R: "r", E1: "e", E2: "x", S: "s" } }, feedback: "FB-UNIT-ONE", suggestion: "SUG-ONE", modelAnswer: "STRONGER-ONE", markedBy: "gemini" },
    { unit: "q2q3", questions: ["Q2 theme?", "Q3 follow-up?"], question: "Q2: Q2 theme? | Q3: Q3 follow-up?", mode: "trees", answers: [{ parts: { T: "t", R: "r", E1: "e", E2: "x2", S: "s" } }, { parts: { T: "t", R: "r", E1: "e", E2: "x3", S: "s" } }], feedback: "FB-UNIT-TWO", suggestion: "SUG-TWO", modelAnswer: "STRONGER-TWO", markedBy: "groq", overridden: true },
  ],
};
w.state.token = "tok"; w.state.role = "pupil"; w.state.name = "Jovan"; w.state.pupilClass = "5ig";
w.state.screen = "pupil"; w.state.pupilTab = "play";
w.state.currentTopic = { id: "t", title: "Helping Others", questions: ["Q1?", "Q2?", "Q3?"], imageUrl: "" };
w.state.lastResult = pupilRecord; w.state.canRetry = false;
w.render(); await tick();
let html = doc.getElementById('app').innerHTML;
check("result: overall score shown", html.includes("17.5 / 25"));
check("result: labelled as the average of 2 parts", html.includes("average of your 2 parts"));
check("result: Q1 and 'Questions 2 & 3 (marked together)' cards are shown", html.includes("Question 1") && html.includes("Questions 2 &amp; 3 (marked together)"));
check("result: both Q2 and Q3 prompts displayed in the combined card", html.includes("Q2 theme?") && html.includes("Q3 follow-up?"));
check("result: written feedback/suggestion/stronger version shown for both units", ["FB-UNIT-ONE", "FB-UNIT-TWO", "SUG-ONE", "SUG-TWO", "STRONGER-ONE", "STRONGER-TWO"].every((t) => html.includes(t)));
check("result: no per-unit '/ 25' pills (only the overall one)", (html.match(/\/ 25/g) || []).length === 1, (html.match(/\/ 25/g) || []).length);
check("result: no TREES breakdown rows leak to the pupil", doc.querySelectorAll("#app .breakdown-row").length === 0);
check("result: 'Score adjusted' tag still shown, without teacher name", html.includes("Score adjusted") && !html.includes("Score adjusted by"));

// ---- builder: Q2/Q3 are visibly linked and tags are honest ----
w.state.lastResult = null; w.state.retrySession = null; w.render(); await tick();
html = doc.getElementById('app').innerHTML;
check("builder: explains Q2+Q3 are one story marked together", html.includes("one story told in two parts"));
check("builder: Q1 keeps its per-branch marks", doc.getElementById("block_r0_T").innerHTML.includes("2 marks"));
check("builder: Q2 Thought/Reason/Evidence are NOT advertised as worth marks", doc.getElementById("block_r1_T").innerHTML.includes("optional - not marked") && doc.getElementById("block_r2_E1").innerHTML.includes("optional - not marked"));
check("builder: Q2/Q3 Experience and Suggestion tags describe the unit", doc.getElementById("block_r1_E2").innerHTML.includes("one story across Q2 + Q3") && doc.getElementById("block_r2_S").innerHTML.includes("in Q2 or Q3"));
check("builder: still 3 questions to answer", !!doc.getElementById("r2_E2"));
check("builder: intro describes the 2-part marking", html.includes("marked as 2 parts"));

// ---- retry screen with a two-unit first attempt ----
w.state.retrySession = pupilRecord; w.state.lastResult = null;
w.render(); await tick();
html = doc.getElementById('app').innerHTML;
check("retry: shows overall 'Last time' score only", html.includes("Last time: 17.5 / 25"));
check("retry: Q2 and Q3 each show the matching previous answer", html.includes("x2") && html.includes("x3"));
check("retry: unit feedback appears above Q2 only, with a pointer under Q3", (html.match(/FB-UNIT-TWO/g) || []).length === 1 && html.includes("feedback is shown above Question 2"));
w.document.querySelector('[data-action="copy-previous"][data-round="2"]').click();
check("retry: copy-previous on Q3 fills Q3 from answers[1]", doc.getElementById("r2_E2").value === "x3", doc.getElementById("r2_E2").value);
w.document.querySelector('[data-action="copy-previous"][data-round="1"]').click();
check("retry: copy-previous on Q2 fills Q2 from answers[0]", doc.getElementById("r1_E2").value === "x2");
w.state.retrySession = null;

// ---- teacher view: per-unit breakdown visible ----
const teacherSub = {
  ...pupilRecord, id: "s1",
  rounds: [
    { ...pupilRecord.rounds[0], score: 20, max: 25, coachUsed: true, breakdown: [{ part: "Thought", points: 2, max: 2, note: "" }, { part: "Experience", points: 10, max: 12, note: "" }] },
    { ...pupilRecord.rounds[1], score: 15, max: 25, overriddenBy: "palpatine", coachUsed: true, coachUsedQuestions: [false, true], breakdown: [{ part: "Experience", points: 11, max: 16, note: "", subBreakdown: [{ label: "Depth & Development Across Both Answers", points: 2, max: 2 }] }, { part: "Suggestion", points: 2, max: 2, note: "" }] },
  ],
};
w.state.role = "teacher"; w.state.isSuperAdmin = true; w.state.screen = "teacher"; w.state.teacherTab = "submissions";
w.state.teacherSubs = [teacherSub]; w.state.subsTotal = 1; w.state.viewingSubmission = "s1";
w.render(); await tick();
html = doc.getElementById('app').innerHTML;
const ttext = doc.getElementById("app").textContent;
check("teacher: sees Unit 1 and Unit 2 titles with per-unit scores", ttext.includes("Unit 1 \u2014 Question 1 (picture) \u2014 20/25") && ttext.includes("Unit 2 \u2014 Questions 2 & 3 (marked together) \u2014 15/25"));
check("teacher: sees the Unit 2 breakdown incl. the new Depth sub-criterion", html.includes("Depth &amp; Development Across Both Answers") && html.includes("11 / 16"));
check("teacher: sees both Q2 and Q3 answers under Unit 2", html.includes("Answer to Question 2") && html.includes("Answer to Question 3") && html.includes("x2") && html.includes("x3"));
check("teacher: coach-used tag says which of Q2/Q3", html.includes("Coach used (Q3)"));
check("teacher: has an override form button for each unit (independent controls)", doc.querySelectorAll('[data-action="start-override"]').length === 2);
check("teacher: two-unit explanation banner present, states pupils see only overall", html.includes("Marked as <strong>2 units</strong>") && html.includes("Pupils only see the overall score"));
check("teacher: final-score line says average of the 2 parts", html.includes("average of the 2 parts"));

// ---- teacher settings: second rubric box ----
w.state.teacherTab = "settings"; w.state.rubricText = "Q1 RUBRIC BODY"; w.state.rubricQ2Q3Text = "Q2Q3 RUBRIC BODY";
w.render(); await tick();
check("settings: separate Q2+Q3 rubric textarea with its own save/reset", !!doc.getElementById("rubricQ2Q3Text") && doc.getElementById("rubricQ2Q3Text").value === "Q2Q3 RUBRIC BODY" && !!doc.querySelector('[data-action="save-rubric-q2q3"]') && !!doc.querySelector('[data-action="reset-rubric-q2q3"]'));
check("settings: Question 1 rubric box unchanged", doc.getElementById("rubricText").value === "Q1 RUBRIC BODY" && !!doc.querySelector('[data-action="save-rubric"]'));

// ---- legacy 3-round teacher/pupil rendering still works ----
const legacy = { ...teacherSub, id: "old", rounds: [0, 1, 2].map((i) => ({ question: "Legacy Q" + (i + 1), mode: "trees", answer: { parts: { E2: "legacy answer " + i } }, score: 10 + i, max: 25, breakdown: [{ part: "Thought", points: 1, max: 2, note: "" }], feedback: "legacy fb " + i, suggestion: "", modelAnswer: "", markedBy: "groq" })), finalScore: 11 };
w.state.teacherTab = "submissions"; w.state.teacherSubs = [legacy]; w.state.viewingSubmission = "old"; w.render(); await tick();
html = doc.getElementById('app').innerHTML;
const ltext = doc.getElementById("app").textContent;
check("legacy: renders 3 'Question N' cards with their own scores", ["Question 1 \u2014 10/25", "Question 2 \u2014 11/25", "Question 3 \u2014 12/25"].every((t) => ltext.includes(t)));
check("legacy: says average of the 3 questions, no 2-unit banner", html.includes("average of the 3 questions") && !html.includes("Marked as <strong>2 units</strong>"));

const passed = results.filter(Boolean).length;
console.log("\n" + passed + "/" + results.length + " checks passed");
process.exit(passed === results.length ? 0 : 1);
