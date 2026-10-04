// Drives the real rendered page in jsdom: result screen -> Try Again ->
// copy previous -> edit -> resubmit -> improvement panel.
import { JSDOM } from "jsdom";
import { PAGE_HTML } from "../frontend.js";

const calls = [];
let submitResponsePayload = null;
let policyResponse = { global: true, canEditGlobal: true, classes: [] };

const dom = new JSDOM(PAGE_HTML, { runScripts: "dangerously", url: "https://example.com/" });
const { window } = dom;

window.fetch = (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url, method: (opts && opts.method) || "GET", body });
  let data = {};
  if (url.endsWith("/api/submit")) data = submitResponsePayload(body);
  else if (url.includes("/api/leaderboard")) data = { leaderboard: [] };
  else if (url.includes("/api/topics")) data = { topics: [] };
  else if (url.includes("retry-policy")) data = policyResponse;
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
};

const results = [];
function check(label, cond, extra) {
  results.push({ label, cond: !!cond, extra });
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  -> " + extra));
}
const tick = () => new Promise((r) => setTimeout(r, 0));

await new Promise((r) => window.addEventListener("load", r));
const w = window;
const doc = window.document;

const makeRound = (i, score, text) => ({
  question: "Question text " + (i + 1),
  mode: "trees",
  answer: { parts: { T: "t" + i, R: "r" + i, E1: "e1_" + i, E2: "my experience " + i, S: "s" + i } },
  score,
  max: 25,
  breakdown: [{ part: "Thought", points: 1, max: 2, note: "n" }],
  feedback: "feedback " + i,
  suggestion: "suggestion " + i,
  modelAnswer: "a stronger version " + i,
  markedBy: "gemini",
});

const firstAttempt = {
  id: "sub_first",
  pupilName: "Jovan",
  pupilClass: "5ig",
  topicId: "topic_1",
  topicTitle: "Helping Others",
  mode: "trees",
  rounds: [makeRound(0, 12), makeRound(1, 14), makeRound(2, 10)],
  finalScore: 12,
  maxScore: 25,
  practice: false,
  retryOf: null,
};

// --- set up a logged-in pupil sitting on their result screen ---
w.state.token = "tok";
w.state.role = "pupil";
w.state.name = "Jovan";
w.state.pupilClass = "5ig";
w.state.screen = "pupil";
w.state.pupilTab = "play";
w.state.currentTopic = { id: "topic_1", title: "Helping Others", questions: ["Q1?", "Q2?", "Q3?"], imageUrl: "" };
w.state.lastResult = firstAttempt;
w.state.retryEnabled = true;
w.state.canRetry = true;
w.render();

const tryBtn = doc.querySelector('[data-action="start-retry"]');
check("Try Again button shown when canRetry", !!tryBtn);

// canRetry false -> no button
w.state.canRetry = false;
w.render();
check("Try Again hidden when canRetry is false", !doc.querySelector('[data-action="start-retry"]'));
w.state.canRetry = true;
w.render();

// --- enter the retry screen ---
doc.querySelector('[data-action="start-retry"]').click();
await tick();
check("retry screen rendered", !!doc.querySelector('[data-action="submit-retry"]'));
check("previous answer shown", doc.body.innerHTML.includes("my experience 0"));
check("previous feedback shown", doc.body.innerHTML.includes("feedback 0"));
check("previous model answer shown", doc.body.innerHTML.includes("a stronger version 0"));
check("new answer boxes are blank", doc.getElementById("r0_E2").value === "", JSON.stringify(doc.getElementById("r0_E2").value));
check("3 questions rendered", doc.querySelectorAll('[data-action="copy-previous"]').length === 3);
check("no network call to enter retry", calls.length === 0, JSON.stringify(calls));

// --- submitting with blank boxes is blocked client-side ---
doc.querySelector('[data-action="submit-retry"]').click();
await tick();
check("blank retry blocked before any request", calls.length === 0 && /Please write a new answer/.test(w.state.error), w.state.error);

// re-render happened on error; retry screen should still be up
check("still on retry screen after validation error", !!doc.querySelector('[data-action="submit-retry"]'));

// --- copy previous, then edit ---
doc.querySelector('[data-action="copy-previous"][data-round="0"]').click();
check("copy filled every TREES part", doc.getElementById("r0_E2").value === "my experience 0", doc.getElementById("r0_E2").value);
check("copy left other questions alone", doc.getElementById("r1_E2").value === "");

for (let i = 0; i < 3; i++) {
  doc.querySelector('[data-action="copy-previous"][data-round="' + i + '"]').click();
  doc.getElementById("r" + i + "_E2").value = "a much longer and more detailed experience for question " + i;
}

// --- resubmit ---
const secondAttempt = {
  ...firstAttempt,
  id: "sub_second",
  rounds: [makeRound(0, 18), makeRound(1, 14), makeRound(2, 8)],
  finalScore: 13.3,
  retryOf: "sub_first",
};
submitResponsePayload = (body) => {
  check("retryOf sent with resubmission", body.retryOf === "sub_first", JSON.stringify(body.retryOf));
  check("practice flag inherited from first attempt", body.practice === false);
  check("same topic sent", body.topicId === "topic_1");
  check("edited answer sent", body.answers[0].parts.E2.startsWith("a much longer"));
  return { record: secondAttempt, warning: null, retryEnabled: true, canRetry: false };
};
doc.querySelector('[data-action="submit-retry"]').click();
await tick();
await tick();

check("back on result screen", !!doc.querySelector('[data-action="play-again"]'));
check("improvement panel shown", doc.body.innerHTML.includes("You improved by 1.3 points"), doc.body.innerHTML.includes("Second try") ? "panel present, wrong text" : "no panel");
check("v7.5: per-question before->after scores are NOT shown to the pupil (overall average only)", !(doc.body.innerHTML.includes("12 &rarr; 18") || doc.body.innerHTML.includes("12 → 18")));
check("v7.5: no per-round 'was' score tag for the pupil", !doc.body.innerHTML.includes("(was 12)"));
check("no second Try Again offered", !doc.querySelector('[data-action="start-retry"]'));
check("second-try note shown", doc.body.innerHTML.includes("That was your second try"));

// --- cancel path ---
w.state.lastResult = firstAttempt;
w.state.previousResult = null;
w.state.canRetry = true;
w.render();
doc.querySelector('[data-action="start-retry"]').click();
await tick();
doc.querySelector('[data-action="cancel-retry"]').click();
await tick();
check("cancel returns to the original result screen", !!doc.querySelector('[data-action="start-retry"]') && w.state.retrySession === null);

// --- single mode retry ---
const singleFirst = {
  ...firstAttempt,
  id: "sub_single",
  mode: "single",
  rounds: [0, 1, 2].map((i) => ({ ...makeRound(i, 10), mode: "single", answer: { text: "my single answer " + i } })),
};
w.state.lastResult = singleFirst;
w.state.canRetry = true;
w.render();
doc.querySelector('[data-action="start-retry"]').click();
await tick();
check("single mode: locked to single", w.state.responseMode === "single");
check("single mode: previous text shown", doc.body.innerHTML.includes("my single answer 0"));
check("single mode: single box rendered", !!doc.getElementById("r0_single") && !doc.getElementById("r0_E2"));
doc.querySelector('[data-action="copy-previous"][data-round="0"]').click();
check("single mode: copy works", doc.getElementById("r0_single").value === "my single answer 0");

// --- score went down ---
w.state.previousResult = firstAttempt;
w.state.lastResult = { ...secondAttempt, finalScore: 9, rounds: [makeRound(0, 8), makeRound(1, 9), makeRound(2, 10)] };
w.state.retrySession = null;
w.state.canRetry = false;
w.render();
check("lower score reported honestly", doc.body.innerHTML.includes("lower than your first"));

// --- teacher: retry badge + policy tab ---
w.state.role = "teacher";
w.state.screen = "teacher";
w.state.isSuperAdmin = true;
w.state.teacherTab = "submissions";
w.state.teacherSubs = [
  { id: "a", pupilName: "Jovan", pupilClass: "5ig", topicTitle: "T", mode: "trees", rounds: [], finalScore: 12, maxScore: 25, retryOf: null, createdAt: Date.now() },
  { id: "b", pupilName: "Jovan", pupilClass: "5ig", topicTitle: "T", mode: "trees", rounds: [], finalScore: 13, maxScore: 25, retryOf: "a", createdAt: Date.now() },
];
w.render();
const tableHtml = doc.querySelector("table.teacher-table").innerHTML;
check("retry badge on the retry row only", (tableHtml.match(/>retry</g) || []).length === 1);
const rowB = [...doc.querySelectorAll("table.teacher-table tbody tr")][1].innerHTML;
check("badge is on the row whose retryOf is set", rowB.includes(">retry<"));

w.state.teacherTab = "retry";
policyResponse = {
  global: true,
  canEditGlobal: true,
  classes: [
    { pupilClass: "5ig", override: null, effective: true },
    { pupilClass: "5ha", override: false, effective: false },
  ],
};
w.state.retryPolicy = policyResponse;
w.render();
check("policy tab renders global toggle", !!doc.querySelector('[data-action="set-retry-global"]'));
check("policy tab renders per-class selects", doc.querySelectorAll('[data-action="set-retry-class"]').length === 2);
const sel = doc.querySelector('[data-action="set-retry-class"][data-class="5ha"]');
check("existing override preselected", sel.value === "off", sel.value);

calls.length = 0;
const globalOff = [...doc.querySelectorAll('[data-action="set-retry-global"]')].find((b) => b.getAttribute("data-on") === "0");
globalOff.click();
await tick();
await tick();
await tick();
check("global toggle posts the policy", calls.some((c) => c.url.includes("/api/teacher/retry-policy") && c.body && c.body.global === false), JSON.stringify(calls));

calls.length = 0;
const sel2 = doc.querySelector('[data-action="set-retry-class"][data-class="5ha"]');
sel2.value = "inherit";
sel2.dispatchEvent(new window.Event("change", { bubbles: true }));
await tick();
const ov = calls.find((c) => c.body && "pupilClass" in c.body);
check("class override cleared as null", ov && ov.body.pupilClass === "5ha" && ov.body.override === null, JSON.stringify(ov && ov.body));

const failed = results.filter((r) => !r.cond).length;
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed");
process.exit(failed ? 1 : 0);
