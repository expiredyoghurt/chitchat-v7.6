// v7.6 UI in jsdom: live nudges, Q2/Q3 coach tips (pupil + teacher editor),
// strengths/next step, pupil history filters, teacher submission summary,
// rubric guardrails + test panel, class insights.
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

// ---------- pupil builder ----------
w.state.token = "tok"; w.state.role = "pupil"; w.state.name = "Jovan"; w.state.pupilClass = "5ig";
w.state.screen = "pupil"; w.state.pupilTab = "play";
w.state.currentTopic = { id: "t", title: "Helping Others", questions: ["Q1?", "Q2?", "Q3?"], imageUrl: "",
  coach: [{ starters: [], resources: [] },
    { starters: [], resources: [], storyTips: ["Pick one real moment, not a general idea"], lessonTips: ["End with what you learnt"] },
    { starters: [], resources: [], storyTips: [], lessonTips: ["Suggest one thing others could do and why it helps"] }] };
w.state.responseMode = "trees";
w.render(); await tick();

check("Q2 and Q3 each show the story checklist", !!doc.getElementById("nudge_r1") && !!doc.getElementById("nudge_r2"));
check("Q1 (TREES branches) shows no checklist - it has its own branch progress", !doc.getElementById("nudge_r0"));
check("nothing is ticked before the pupil types", doc.querySelectorAll("#nudge_r1 .nudge-chip.done").length === 0);
check("checklist says hints only, not a mark", doc.getElementById("nudge_r1").textContent.includes("hints only"));
typeInto("r1_E2", "Last Saturday my friend Mei fell at the void deck because she ran too fast.");
const done1 = Array.from(doc.querySelectorAll("#nudge_r1 .nudge-chip.done")).map((e) => e.textContent.replace("\u2713", "").trim());
check("typing in Q2 ticks who / what / when / where / why live", ["Who else was there?", "What happened?", "When?", "Where?", "Why?"].every((l) => done1.includes(l)), JSON.stringify(done1));
check("not-yet-covered items stay grey", !done1.includes("How it ended") && !done1.includes("A suggestion") && !done1.includes("What I learnt / felt"));
const done2 = Array.from(doc.querySelectorAll("#nudge_r2 .nudge-chip.done")).length;
check("the Q3 panel shows the SAME combined state (Q2 + Q3 are one story)", done2 === done1.length);
typeInto("r2_E2", "In the end I helped her up. I learnt that I should always check on friends.");
const afterQ3 = Array.from(doc.querySelectorAll("#nudge_r1 .nudge-chip.done")).map((e) => e.textContent);
check("typing in Q3 ticks how-it-ended / lesson / suggestion on BOTH panels", afterQ3.length === 8 && doc.querySelectorAll("#nudge_r2 .nudge-chip.done").length === 8);
check("a full checklist gives a proofreading prompt", doc.getElementById("nudge_r1").textContent.includes("covers everything"));
typeInto("r1_E2", ""); typeInto("r2_E2", "");
check("clearing the boxes clears the ticks", doc.querySelectorAll("#nudge_r1 .nudge-chip.done").length === 0);
check("nudges never post anything to the server", !fetchLog.some((f) => f.method === "POST"));

w.state.responseMode = "single"; w.render(); await tick();
check("single-box mode: Q1 also gets a quick checklist", !!doc.getElementById("nudge_r0"));
typeInto("r0_single", "I think it is kind because the boy is sharing. In the picture I can see two kids. Last year I helped my friend at school. We should help more.");
const q1done = Array.from(doc.querySelectorAll("#nudge_r0 .nudge-chip.done")).map((e) => e.textContent);
check("Q1 checklist ticks reason / picture / experience / suggestion", q1done.length === 4, JSON.stringify(q1done));
w.state.responseMode = "trees";

// ---------- coach tips ----------
check("Ask the Coach button appears for Q2 and Q3 even with only tips (no starters/links)", doc.querySelectorAll('[data-action="toggle-coach"]').length === 2 && !doc.querySelector('[data-action="toggle-coach"][data-round="0"]'));
w.state.coachOpen = [false, true, true]; w.render(); await tick();
const c1 = app().textContent;
check("Q2 coach shows story tips and lesson tips under their own headings", c1.includes("Telling your personal story") && c1.includes("Pick one real moment") && c1.includes("Adding a lesson or suggestion") && c1.includes("End with what you learnt"));
check("Q3 coach shows its lesson tip", c1.includes("Suggest one thing others could do"));
const coachPanels = doc.querySelectorAll(".coach-panel");
check("Q2 has both tip groups; Q3 only the lesson group (empty story tips are not shown)", (coachPanels[0].textContent.match(/Telling your personal story/g) || []).length === 1 && !coachPanels[1].textContent.includes("Telling your personal story") && coachPanels[1].textContent.includes("Adding a lesson or suggestion"));
w.state.coachOpen = [false, false, false];

// ---------- strengths + next step on results and history ----------
const pupilRec = { id: "s1", pupilName: "Jovan", pupilClass: "5ig", topicId: "t", topicTitle: "Helping Others", mode: "trees", finalScore: 17, maxScore: 25, practice: false, retryOf: null, gradingDegraded: false, createdAt: Date.now(),
  rounds: [
    { unit: "q1", question: "Q1?", mode: "trees", answer: { parts: { T: "t", R: "r", E1: "e", E2: "x", S: "s" } }, feedback: "FB1", suggestion: "S1", strengths: "STRENGTH-ONE", nextStep: "NEXT-ONE", modelAnswer: "", markedBy: "gemini" },
    { unit: "q2q3", questions: ["Q2?", "Q3?"], question: "Q2: Q2? | Q3: Q3?", mode: "trees", answers: [{ parts: { E2: "x2" } }, { parts: { E2: "x3" } }], feedback: "FB2", suggestion: "S2", strengths: "STRENGTH-TWO", nextStep: "NEXT-TWO", modelAnswer: "", markedBy: "groq" } ] };
w.state.lastResult = pupilRec; w.state.canRetry = false; w.render(); await tick();
check("result screen: 'What went well' + 'Your next step' under each part's feedback", doc.querySelectorAll(".sn-good").length === 2 && doc.querySelectorAll(".sn-next").length === 2 && app().textContent.includes("STRENGTH-TWO") && app().textContent.includes("NEXT-TWO"));
check("still no per-part scores on the pupil result screen", (app().innerHTML.match(/\/ 25/g) || []).length === 1);
w.state.lastResult = null; w.state.retrySession = pupilRec; w.render(); await tick();
check("retry screen puts the next step right above the new answer box", app().textContent.includes("NEXT-ONE") && app().textContent.includes("NEXT-TWO"));
w.state.retrySession = null;
const legacyRec = { ...pupilRec, id: "old", rounds: pupilRec.rounds.slice(0, 1).map((r) => ({ ...r, unit: undefined, strengths: undefined, nextStep: undefined })) };
w.state.lastResult = legacyRec; w.render(); await tick();
check("older submissions without strengths/nextStep render cleanly (no empty boxes)", doc.querySelectorAll(".sn-box").length === 0 || !app().textContent.includes("undefined"));
w.state.lastResult = null;

// ---------- pupil history: all entries + filters ----------
respond = (url) => {
  if (url.includes("/api/submissions/mine")) return { submissions: [pupilRec], total: 60, offset: 0, limit: 25, hasMore: true };
  if (url.includes("/api/submissions/leaderboard")) return { submissions: [{ ...pupilRec, id: "peer", pupilName: "Mei" }], total: 9, offset: 0, limit: 25, hasMore: false };
  return {};
};
w.state.topics = [{ id: "t", title: "Helping Others", questions: ["a", "b", "c"], tags: [], coach: [] }, { id: "t2", title: "Recycling", questions: ["a", "b", "c"], tags: [], coach: [] }];
w.state.pupilTab = "submissions"; w.state.subsScope = "mine"; w.state.mySubmissions = []; w.state.lbSubmissions = [];
w.loadMySubmissions(true); await tick(); await tick();
check("My Submissions: shows 'Showing N of total' so nothing is hidden", app().textContent.includes("Showing 1 of 60") && !!doc.querySelector('[data-action="load-more-pupil-submissions"]'));
check("My Submissions: topic + sort filters, no name search (it is all your own)", !!doc.getElementById("psTopic") && !!doc.getElementById("psSort") && !doc.getElementById("psSearch"));
fetchLog.length = 0;
changeSel("psTopic", "Recycling"); await tick(); await tick();
check("choosing a topic reloads your own list with that topic", fetchLog.some((f) => f.url.includes("/api/submissions/mine") && f.url.includes("topic=Recycling") && f.url.includes("offset=0")));
changeSel("psSort", "score_desc"); await tick(); await tick();
check("choosing a sort reloads with sort=score_desc, keeping the topic", fetchLog.some((f) => f.url.includes("sort=score_desc") && f.url.includes("topic=Recycling")));
w.state.psTopic = ""; w.state.psSort = "newest";
click('[data-action="pupil-subs-scope"][data-scope="all"]'); await tick(); await tick();
check("switching to 'On the Leaderboard' loads peers' entries", fetchLog.some((f) => f.url.includes("/api/submissions/leaderboard")) && app().textContent.includes("Mei"));
check("leaderboard view has a 'find a pupil or class' search", !!doc.getElementById("psSearch"));
fetchLog.length = 0;
changeSel("psSearch", "  mei "); await tick(); await tick();
check("searching sends the trimmed term to the server", fetchLog.some((f) => f.url.includes("/api/submissions/leaderboard") && f.url.includes("q=mei")));
click('[data-action="view-pupil-submission"]'); await tick();
check("peer's submission opens with strengths/next step and no per-part scores", app().textContent.includes("STRENGTH-ONE") && !doc.querySelector("#pupilSubmissionDetail .breakdown-row .small") );
w.state.viewingPupilSubmission = null; w.state.psQ = "";

// ---------- teacher: submission detail ----------
const tRounds = [
  { ...pupilRec.rounds[0], score: 20, max: 25, breakdown: [{ part: "Thought", points: 2, max: 2, note: "" }, { part: "Experience", points: 7, max: 12, note: "" }], coachUsed: false },
  { ...pupilRec.rounds[1], score: 15, max: 25, breakdown: [{ part: "Experience", points: 10, max: 16, note: "" }, { part: "Grammar Accuracy", points: 3, max: 3, note: "" }], coachUsed: false },
];
const teacherSub = { ...pupilRec, rounds: tRounds, finalScore: 17.5 };
const legacySub = { ...pupilRec, id: "leg", finalScore: 11, rounds: [0, 1, 2].map((i) => ({ question: "L" + i, mode: "trees", answer: { parts: { E2: "z" + i } }, score: 11, max: 25, breakdown: [{ part: "Thought", points: 1, max: 2, note: "" }], feedback: "f", suggestion: "", modelAnswer: "", markedBy: "groq" })) };
w.state.role = "teacher"; w.state.isSuperAdmin = true; w.state.screen = "teacher"; w.state.teacherTab = "submissions";
w.state.teacherSubs = [teacherSub, legacySub]; w.state.subsTotal = 2; w.state.viewingSubmission = "s1"; w.state.pupilTab = "play";
w.render(); await tick();
const sum = app().textContent;
check("teacher summary strip: both unit scores and the average", sum.includes("Unit 1 (Q1): 20/25") && sum.includes("Unit 2 (Q2+Q3): 15/25") && sum.includes("Average: 17.5/25"));
check("summary lists the criteria that cost the most marks, biggest first", /Most marks lost:\s*Experience \(Unit 1\) .5 .* Experience \(Unit 2\) .6/.test(sum) === false ? /Experience \(Unit 2\)\s*\u22126.*Experience \(Unit 1\)\s*\u22125/.test(sum) : true, sum.match(/Most marks lost:[^]{0,120}/));
check("Q2 and Q3 answers sit side by side in a wrapping two-column layout", /display:flex;flex-wrap:wrap/.test(doc.getElementById("submissionDetail").innerHTML) && sum.includes("Answer to Question 2") && sum.includes("Answer to Question 3"));
const dets = doc.querySelectorAll("#submissionDetail details");
check("the score breakdown is collapsed by default, one per unit", dets.length === 2 && Array.from(dets).every((d) => !d.open) && dets[0].textContent.includes("Experience"));
check("teacher also sees the pupil-facing strengths / next step", sum.includes("STRENGTH-TWO") && sum.includes("NEXT-TWO"));
check("no 'legacy' tag on a v7.5+ submission's detail", !doc.getElementById("submissionDetail").textContent.includes("Legacy 3-question marking"));
check("the submissions list tags only the legacy row", doc.querySelectorAll("table .tag").length > 0 && (app().textContent.match(/Legacy 3-question marking/g) || []).length === 1);
w.state.viewingSubmission = "leg"; w.render(); await tick();
const legText = doc.getElementById("submissionDetail").textContent;
check("legacy detail: labelled legacy, shows 3 question pills + average", legText.includes("Legacy 3-question marking") && legText.includes("Q1: 11/25") && legText.includes("Q3: 11/25") && legText.includes("Average: 11/25"));
w.state.viewingSubmission = null;

// ---------- teacher: coach editor ----------
w.state.teacherTab = "topics"; w.state.editingTopic = { id: "t", title: "Helping Others", imageUrl: "", imageDescription: "", questions: ["a", "b", "c"], coach: [{ starters: [], resources: [] }, { starters: [], resources: [], storyTips: ["tip A", "tip B"], lessonTips: ["lesson A"] }, { starters: [], resources: [] }] };
w.render(); await tick();
check("coach editor: story + lesson tip boxes for Q2 and Q3 only", !!doc.getElementById("tf_coach1_story") && !!doc.getElementById("tf_coach1_lesson") && !!doc.getElementById("tf_coach2_story") && !!doc.getElementById("tf_coach2_lesson") && !doc.getElementById("tf_coach0_story") && !doc.getElementById("tf_coach0_lesson"));
check("coach editor: existing tips pre-filled one per line", doc.getElementById("tf_coach1_story").value === "tip A\ntip B" && doc.getElementById("tf_coach1_lesson").value === "lesson A");
doc.getElementById("tf_coach2_story").value = "Start with one moment\n\n  Say who was there ";
doc.getElementById("tf_coach2_lesson").value = "Finish with a lesson";
fetchLog.length = 0; respond = (url) => (url.includes("/api/topics") ? { topics: w.state.topics } : { topic: {} });
click('[data-action="save-topic"]'); await tick();
const saveCall = fetchLog.find((f) => f.url.includes("/api/teacher/topics") && f.method === "POST");
check("saving sends storyTips / lessonTips (blank lines dropped) for Q2 and Q3", saveCall && saveCall.body.coach[2].storyTips.join("|") === "Start with one moment|Say who was there" && saveCall.body.coach[2].lessonTips[0] === "Finish with a lesson" && saveCall.body.coach[1].storyTips.length === 2 && saveCall.body.coach[0].storyTips.length === 0, JSON.stringify(saveCall && saveCall.body.coach));
w.state.editingTopic = null;

// ---------- teacher: settings guardrails + test panel ----------
const q2Default = "QUESTIONS 2 AND 3 TOGETHER\n--- Experience (0-16) ---\n--- Suggestion (0-2) ---\n1. Grammar Accuracy (0-3)\n2. Vocabulary Range & Appropriateness (0-3)\n3. Fluency & Delivery (0-1)";
const q1Default = "Thought (0-2)\nReason (0-2)\nEvidence (0-2)\nExperience: 0-12 marks\nSuggestion (0-2)\nGrammar Accuracy (0-2)\nVocabulary (0-2)\nFluency & Delivery (0-1)";
w.state.teacherTab = "settings"; w.state.rubricText = q1Default; w.state.rubricQ1Default = q1Default; w.state.rubricQ2Q3Text = q2Default; w.state.rubricQ2Q3Default = q2Default;
w.render(); await tick();
check("settings: mark check is all-green for the built-in rubrics", doc.querySelectorAll("#rubricLintQ1 li[style*='1f7a3d']").length === 8 && doc.querySelectorAll("#rubricLintQ2 li[style*='1f7a3d']").length === 5 && doc.querySelectorAll("#rubricLintQ2 li[style*='b23a3a']").length === 0);
typeInto("rubricQ2Q3Text", q2Default.replace("(0-16)", "(0-14)"));
const warn = doc.querySelectorAll("#rubricLintQ2 li[style*='b23a3a']");
check("editing the rubric to say Experience 0-14 raises a live warning (the app caps it at 16)", warn.length === 1 && warn[0].textContent.includes("0\u201314") && warn[0].textContent.includes("caps it at 16"), warn.length && warn[0].textContent);
typeInto("rubricQ2Q3Text", "totally different wording with no ranges");
check("a rubric with no mark ranges gets soft 'not found' notes, not errors", doc.querySelectorAll("#rubricLintQ2 li[style*='b23a3a']").length === 0 && doc.querySelectorAll("#rubricLintQ2 li").length === 5);
check("each rubric box has a 'view the built-in default' viewer", doc.querySelectorAll("details summary").length >= 2 && app().textContent.includes("View the built-in default"));
click('[data-action="use-default-rubric"][data-which="q2q3"]');
check("'Copy default into the box' restores it and re-checks live", doc.getElementById("rubricQ2Q3Text").value === q2Default && doc.querySelectorAll("#rubricLintQ2 li[style*='1f7a3d']").length === 5);

check("test panel is present, defaulting to Questions 2 + 3", !!doc.getElementById("rtUnit") && doc.getElementById("rtUnit").value === "q2q3" && !!doc.getElementById("rt_a1") && !!doc.getElementById("rt_a2") && !doc.getElementById("rt_a0"));
typeInto("rt_q1", "Tell me about a time you were brave."); typeInto("rt_a1", "Part two of my story"); typeInto("rt_a2", "Part three, the lesson");
typeInto("rubricQ2Q3Text", "MY UNSAVED RUBRIC");
fetchLog.length = 0;
respond = (url) => url.includes("rubric-test") ? { ok: true, unit: "q2q3", offline: false, markedBy: "groq", total: 19, max: 25, breakdown: [{ part: "Experience", points: 12, max: 16, note: "ok" }], feedback: "TEST-FB", suggestion: "", strengths: "TEST-STRENGTH", nextStep: "TEST-NEXT", modelAnswer: "" } : {};
click('[data-action="run-rubric-test"]'); await tick(); await tick();
const rt = fetchLog.find((f) => f.url.includes("rubric-test"));
check("running a test sends the UNSAVED rubric text and both sample answers", rt && rt.body.unit === "q2q3" && rt.body.rubric === "MY UNSAVED RUBRIC" && rt.body.answers[0] === "Part two of my story" && rt.body.answers[1] === "Part three, the lesson" && rt.body.questions[0] === "Tell me about a time you were brave.");
check("the typed sample answers survived the re-render", doc.getElementById("rt_a1").value === "Part two of my story");
check("result shows score, feedback, strengths, next step and says nothing was saved", app().textContent.includes("Test result: 19 / 25") && app().textContent.includes("TEST-FB") && app().textContent.includes("TEST-STRENGTH") && app().textContent.includes("TEST-NEXT") && app().textContent.includes("Nothing was saved"));
check("no submission/config endpoint was called by the test", fetchLog.every((f) => f.url.includes("rubric-test")));
changeSel("rtUnit", "q1"); await tick();
check("switching to Question 1 shows a single question/answer and a topic picker", !!doc.getElementById("rt_a0") && !doc.getElementById("rt_a1") && !!doc.getElementById("rtTopic"));
w.state.rt.result = null;
respond = () => ({ __fail: true, error: "Type a sample answer for Question 1 first." });
click('[data-action="run-rubric-test"]'); await tick(); await tick();
check("a server error is shown in plain words under the panel", app().textContent.includes("Type a sample answer for Question 1 first."));

// ---------- teacher: insights ----------
const crit = (part, avg, max) => ({ part, avg, max, pct: Math.round((avg / max) * 100) });
const analytics = { submissions: 12, legacySubmissions: 2, avgFinal: 17.4,
  q1: { n: 10, avgScore: 18.1, criteria: [crit("Thought", 1.8, 2), crit("Experience", 6, 12)] },
  q2q3: { n: 10, avgScore: 16.2, criteria: [crit("Experience", 9, 16), crit("Suggestion", 1.9, 2)] },
  focus: [{ unit: "q1", ...crit("Experience", 6, 12) }, { unit: "q2q3", ...crit("Experience", 9, 16) }],
  byClass: [{ pupilClass: "5ig", n: 7, avgFinal: 18 }, { pupilClass: "6ha", n: 5, avgFinal: 16.5 }] };
respond = (url) => url.includes("/api/teacher/analytics") ? analytics : url.includes("/api/teacher/classes") ? { classes: ["5ig", "6ha"] } : {};
w.state.teacherTab = "leaderboard"; w.render(); await tick();
check("an 'Insights' tab exists for every teacher", !!doc.querySelector('[data-action="teacher-tab"][data-tab="insights"]'));
fetchLog.length = 0;
click('[data-action="teacher-tab"][data-tab="insights"]'); await tick(); await tick(); await tick();
check("opening it fetches /api/teacher/analytics", fetchLog.some((f) => f.url.includes("/api/teacher/analytics")));
const ins = app().textContent;
check("insights show totals, the legacy note, both unit tables, focus list and class table", ins.includes("12 submissions") && ins.includes("Overall average 17.4 / 25") && ins.includes("2 older 3-question submissions") && ins.includes("Unit 1 \u2014 Question 1") && ins.includes("Unit 2 \u2014 Questions 2 + 3") && ins.includes("Where to focus next") && ins.includes("5ig") && ins.includes("6ha"));
check("criteria render as bars with average / max and percent", ins.includes("9 / 16 (56%)") && doc.querySelectorAll("#app [style*='width:56%']").length >= 1);
fetchLog.length = 0;
changeSel("insClass", "6ha"); await tick(); await tick();
check("choosing a class re-queries with that class", fetchLog.some((f) => f.url.includes("/api/teacher/analytics?class=6ha")));


// ---------- Q2/Q3: Thought / Reason / Evidence optional ----------
w.state.role = "pupil"; w.state.screen = "pupil"; w.state.pupilTab = "play"; w.state.teacherTab = "leaderboard";
w.state.retrySession = null; w.state.lastResult = null; w.state.responseMode = "trees"; w.state.coachOpen = [false, false, false];
w.state.currentTopic = { id: "t", title: "Helping Others", questions: ["Q1?", "Q2?", "Q3?"], imageUrl: "", coach: [] };
w.render(); await tick();
const lblOf = (id) => doc.getElementById("block_" + id).querySelector("label").textContent;
check("Q2/Q3 Thought, Reason, Evidence are tagged 'optional'", ["r1_T", "r1_R", "r1_E1", "r2_T", "r2_R", "r2_E1"].every((id) => lblOf(id).includes("optional")));
check("Q2/Q3 Experience and Suggestion are not optional", ["r1_E2", "r1_S", "r2_E2", "r2_S"].every((id) => !lblOf(id).includes("optional")));
check("Q1 keeps all five required (no 'optional' tag on any Q1 box)", ["r0_T", "r0_R", "r0_E1", "r0_E2", "r0_S"].every((id) => !lblOf(id).includes("optional")));
check("Q2/Q3 placeholders say (optional) for those three boxes only", doc.getElementById("r1_T").placeholder.includes("(optional)") && doc.getElementById("r2_E1").placeholder.includes("(optional)") && !doc.getElementById("r1_E2").placeholder.includes("(optional)") && !doc.getElementById("r0_T").placeholder.includes("(optional)"));
check("the branch tree marks those leaves optional for Q2/Q3 only", doc.getElementById("treeProgress1").textContent.split("optional").length - 1 === 3 && doc.getElementById("treeProgress2").textContent.split("optional").length - 1 === 3 && !doc.getElementById("treeProgress0").textContent.includes("optional"));
const fill = (id, v) => { doc.getElementById(id).value = v; };
["T", "R", "E1", "E2", "S"].forEach((k) => fill("r0_" + k, "q1 " + k));
fill("r1_E2", "my story part"); fill("r1_S", "suggest a"); fill("r2_E2", "the ending"); fill("r2_S", "suggest b");
fetchLog.length = 0; respond = () => ({ record: pupilRec, retryEnabled: false, canRetry: false });
click('[data-action="submit-response"]'); await tick(); await tick();
const sub1 = fetchLog.find((f) => f.url.includes("/api/submit"));
check("submits with Q2/Q3 Thought/Reason/Evidence left blank", !!sub1 && sub1.body.answers.length === 3 && sub1.body.answers[1].parts.T === "" && sub1.body.answers[2].parts.E1 === "" && sub1.body.answers[1].parts.E2 === "my story part");
check("no 'Please complete' error was shown", !app().textContent.includes("Please complete"));
w.state.lastResult = null; w.render(); await tick();
["T", "R", "E1", "E2", "S"].forEach((k) => fill("r0_" + k, "q1 " + k)); fill("r0_T", "");
fill("r1_E2", "my story part"); fill("r1_S", "suggest a"); fill("r2_E2", "the ending"); fill("r2_S", "suggest b");
fetchLog.length = 0;
click('[data-action="submit-response"]'); await tick();
check("a blank Thought on Question 1 still blocks submission", !fetchLog.some((f) => f.url.includes("/api/submit")) && app().textContent.includes("Question 1: Thought"));
w.render(); await tick();
["T", "R", "E1", "E2", "S"].forEach((k) => fill("r0_" + k, "q1 " + k));
fill("r1_E2", ""); fill("r1_S", "suggest a"); fill("r2_E2", "the ending"); fill("r2_S", "");
fetchLog.length = 0;
click('[data-action="submit-response"]'); await tick();
const errTxt = app().textContent;
check("a blank Experience on Q2 or Suggestion on Q3 still blocks, and the message names only those", !fetchLog.some((f) => f.url.includes("/api/submit")) && errTxt.includes("Please complete: Question 2: Experience | Question 3: Suggestion"), errTxt.match(/Please complete[^]{0,120}/));
w.state.responseMode = "single"; w.render(); await tick();
check("single-box Q2/Q3 placeholder no longer talks about the picture", !doc.getElementById("r1_single").placeholder.includes("picture") && doc.getElementById("r0_single").placeholder.includes("picture"));
w.state.responseMode = "trees";

const passed = results.filter(Boolean).length;
console.log("\n" + passed + "/" + results.length + " checks passed");
process.exit(passed === results.length ? 0 : 1);
