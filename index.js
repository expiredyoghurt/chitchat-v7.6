/**
 * Just a Chit-Chat
 * Cloudflare Worker backend + single-file frontend.
 *
 * Storage (v7-d1)
 *   Sessions live in KV (binding CCv6_DATA) for free TTL-based expiry.
 *   Everything else - topics, submissions, pupils, pupil history,
 *   teacher-admins, and settings (teacher password / rubric / groq model) -
 *   lives in D1 (binding CCv6_DB). See schema.sql for the table layout;
 *   apply it with: wrangler d1 execute chitchat-v7 --remote --file=schema.sql
 *
 *   session:<token>  (KV) -> { name, pupilClass, role, isSuperAdmin, assignedClasses, createdAt }
 *   topics            (D1) -> id, title, image_url, image_description, questions (JSON), tags (JSON), coach (JSON), created_at
 *   submissions       (D1) -> id, pupil_name, pupil_class, topic_id, topic_title, mode, rounds (JSON: 2 entries since v7.5 - Unit 1 = Q1, Unit 2 = Q2+Q3 marked together; 3 entries on older submissions),
 *                              final_score, max_score, practice, grading_degraded, repeated_ideas_penalty, archived, flagged, created_at
 *   pupils            (D1) -> id, name, pupil_class, best_score, total_score, attempts   (UNIQUE(name,pupil_class); practice/degraded attempts never update this)
 *   pupil_history     (D1) -> id, pupil_id, timestamp, topic_id, topic_title, final_score, max_score, breakdown (JSON)
 *                              (used for the teacher's per-pupil strengths/concerns view - most recent 50 read via LIMIT, see loadPupilHistory)
 *   teacher_admins    (D1) -> username, salt, hash, classes (JSON), created_at   (a scoped teacher-admin account created by palpatine; can only see/administer pupils in `classes`. palpatine itself is NOT stored here - it's the hardcoded super-admin, see TEACHER_USERNAME)
 *   config            (D1) -> key/value: "teacher_password" (JSON {salt,hash}), "rubric" (free text, Question 1 / Unit 1), "rubric_q2q3" (free text, Questions 2+3 / Unit 2, v7.5), "model_groq" (Groq model id)
 *
 * Roles
 *   Every teacher-side session still has role:"teacher" (see requireTeacher), but
 *   carries two extra fields that scope what it can see/do:
 *     isSuperAdmin: true for palpatine only - full access to every class, plus the
 *       Topics/Settings/Admins tabs (see requireSuperAdmin).
 *     assignedClasses: for a scoped teacher-admin, the array of class names (as typed
 *       by palpatine when creating them) they're allowed to view/administer. null for
 *       palpatine (meaning "all classes"). Endpoints that list or mutate pupil/submission
 *       data filter by this in SQL - see classAllowed() and buildSubmissionsFilter().
 *
 * Class-name matching note: a pupil's name/class as stored on their pupils
 * row is exact-case (matches how they typed it at login, same as the old KV
 * key scheme) - so "Jovan@5ig" and "Jovan@5IG" are still different pupils.
 * Permission/filter matching (classAllowed, the ?class=/?topic= query params)
 * is case-insensitive, same as v7's KV-era JS did, just expressed as SQL
 * LOWER() comparisons now instead of .toLowerCase() in JS.
 *
 * Secrets / bindings
 *   env.GEMINI_API_KEY       Vision-capable, 1st tier tried, wrangler secret put GEMINI_API_KEY (aistudio.google.com/apikey)
 *   env.GEMINI_API_KEY_2     Optional 2nd Gemini key, tried right after the first if it fails/is rate-limited (2nd account/key)
 *   env.GROQ_API_KEY         2nd tier tried, wrangler secret put GROQ_API_KEY (console.groq.com)
 *   env.GROQ_API_KEY_2       Optional 2nd Groq key, same idea as GEMINI_API_KEY_2
 *   env.OPENROUTER_API_KEY   3rd tier tried, wrangler secret put OPENROUTER_API_KEY (openrouter.ai/keys)
 *   env.OPENROUTER_API_KEY_2 Optional 2nd OpenRouter key, same idea as GEMINI_API_KEY_2
 *   env.AI                   4th and final AI tier, Cloudflare Workers AI (free, [ai] binding in wrangler.toml)
 *
 *   Every question in a submission is marked with the same fixed chain (see
 *   aiScore): both Gemini keys, then both Groq keys, then both OpenRouter
 *   keys, then Workers AI. Any tier with no key/binding configured is simply
 *   skipped. Gemini goes first because it's the only vision-capable provider
 *   here - whenever a Gemini attempt runs, it's sent the actual topic
 *   picture (fetched + base64-encoded server-side) so the Evidence (E1) part
 *   can be checked against what's really in the picture, not just judged on
 *   plausibility. Every other provider (Groq, OpenRouter, Workers AI) is
 *   text-only and instead uses the teacher's optional imageDescription field
 *   for the Evidence part (or, failing that, is told plainly it can't see
 *   the picture and to mark E1 on plausibility only).
 *
 *   Questions are marked one at a time, not concurrently (see the
 *   /api/submit handler), specifically to avoid bursting simultaneous
 *   requests at the same provider/key - a common trigger for rate-limiting.
 *   If a question's entire chain fails on the first pass (transient
 *   rate-limits being the most likely cause), the whole chain is retried in
 *   full up to AI_MARKING_MAX_PASSES times, with a pause in between, before
 *   that question falls back to the offline rule-based scorer - this is the
 *   main safeguard that keeps AI marking landing successfully rather than
 *   silently degrading to the weaker offline scorer.
 * *   Settings and again at call time in aiScore, so this fallback tier can
 *   never end up calling a paid model.
 */

import { VULGAR_WORDS } from "./vulgarity-list.js";
import { PAGE_HTML } from "./frontend.js";
import { SEED_TOPICS } from "./seed-topics.js";

const TEACHER_USERNAME = "palpatine"; // trigger username for hidden teacher tools

// Teacher-configurable via Settings (config table, key model_groq); this is
// only the default used until a teacher picks something else. Kept in sync
// with Groq's currently-active model list - see console.groq.com/docs/models.
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
// Models a teacher can pick from Settings without having to know exact model
// IDs. If Groq deprecates one of these, update this list and redeploy - a
// teacher can still type any other valid Groq model ID directly, this is
// just the convenience list shown in the dropdown.
const GROQ_MODEL_OPTIONS = [
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B (default - high reasoning, agentic)" },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B (faster, lighter)" },
  { id: "qwen/qwen3.6-27b", label: "Qwen3.6 27B" },
];

// OpenRouter is the 3rd AI tier tried for every question (see aiScore) -
// after both Gemini keys and both Groq keys have failed, and before Workers
// AI. Only free models are ever allowed here (see isFreeOpenRouterModel) -
// this fallback tier exists to keep the app from hard-failing, not to run
// up a bill, so the app enforces this both when a teacher saves a model in
// Settings and again at call time in aiScore, in case the config table ever
// ends up with something else by some other route.
//
// The default, "openrouter/free", is OpenRouter's own free-model router: it
// auto-selects a free model for each request (filtering for the features
// the request needs - see openrouter.ai/openrouter/free) rather than
// pinning to one model ID, so it keeps working even as OpenRouter's
// specific free-tier model lineup changes over time. A teacher can still
// pin a specific model instead via the options below or by typing any other
// model ID that ends in ":free" (OpenRouter's own naming convention for its
// free-tier model variants - see openrouter.ai/models?max_price=0).
const DEFAULT_OPENROUTER_MODEL = "openrouter/free";
const OPENROUTER_MODEL_OPTIONS = [
  { id: "openrouter/free", label: "Free Models Router (default - auto-picks a free model)" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B (free tier)" },
  { id: "google/gemini-2.0-flash-exp:free", label: "Gemini 2.0 Flash (free tier, via OpenRouter)" },
  { id: "qwen/qwen-2.5-72b-instruct:free", label: "Qwen 2.5 72B (free tier)" },
  { id: "deepseek/deepseek-chat:free", label: "DeepSeek Chat (free tier)" },
];

// True for OpenRouter's own free-model router, or any model slug ending in
// OpenRouter's ":free" suffix convention. Anything else - a paid model, or a
// typo missing the suffix - is rejected wherever this is checked, so
// OpenRouter can never be configured (accidentally or otherwise) to call a
// paid model.
function isFreeOpenRouterModel(modelId) {
  const id = String(modelId || "").trim();
  return id === "openrouter/free" || /:free$/i.test(id);
}

// Cap on an uploaded topic picture's data: URL length (Teacher Tools ->
// Topics -> "Upload a picture"). D1 caps a single row at 2,000,000 bytes
// total (see developers.cloudflare.com/d1/platform/limits) - this leaves
// headroom in that row for the topic's title/questions/tags/coach JSON
// alongside the image itself. The frontend already compresses uploads to
// fit well under this before they're ever sent here; this is a server-side
// backstop, not the primary size control.
const MAX_TOPIC_IMAGE_DATA_URL_LENGTH = 1900000;

const DEFAULT_RUBRIC = `The total score is 25 marks: 20 marks for TREES and 5 marks for Language Use.

TREES is marked out of 20 marks total, distributed as follows:
- T Thought: 0-2 marks
- R Reason: 0-2 marks
- E Example (evidence or example from the picture/topic to support the reasons and/or thoughts): 0-2 marks
- E Experience: 0-12 marks (the most heavily weighted part)
- S Suggestion: 0-2 marks

--- T Thought (0-2) ---
0 = no clear thought given
1 = simple or vague thought
2 = clear, relevant thought that answers the question directly

--- R Reason (0-2) ---
0 = no reason given, or vague/weak reason
1 = relevant reason but with limited explanation
2 = clear, relevant reason with some elaboration connecting clearly to thoughts

--- E Example or Evidence from picture/topic (0-2) ---
0 = no reference to the picture or topic, or mentions it only vaguely
1 = identifies a relevant detail or provides a clear example from the picture or topic
2 = uses a specific detail or example and explains how it supports the answer/thoughts/reasons

--- E Experience (0-12) ---
This is the main focus of the rubric. Do NOT reward length alone - reward
specific, believable, relevant personal details. A long but generic or
memorised-sounding answer should score LOW. Break this into 5 sub-criteria
and sum them for the Experience total:

1. Relevance to the topic/question (0-2)
   0 = missing or unrelated, 1 = weakly related, 2 = clearly relevant

2. Specificity using 5W1H details (0-6) - award up to 1 mark each for clear:
   Who was involved / What happened / When it happened / Where it happened /
   Why it happened or why the pupil acted / How it ended or was resolved

3. Authenticity / personal voice (0-2)
   0 = no personal experience, clearly copied/generic, or only a generic reference
   1 = sounds mostly personal and believable
   2 = sounds authentic and natural, with realistic details, feelings or reactions
   Look for: first-person language (I/my/we), natural small believable details,
   realistic Singapore settings (void deck, MRT, canteen, CCA), genuine feelings.

4. Clarity and sequence (0-1)
   0 = confusing, incomplete, or jumps around
   1 = clearly sequenced with a beginning, middle and ending

5. Reflection / lesson learnt (0-1)
   0 = no reflection, or only a simple feeling/lesson stated
   1 = meaningful reflection that links back to the topic

If the pupil's Experience answer lacks depth (vague on WHO/WHAT/WHEN/WHERE,
or reads as generic/memorised), say so plainly in the feedback - name what
was missing (e.g. "unclear where and when this happened, and who else was
there") - and suggest 1-2 concrete example experiences the pupil could have
shared instead, related to the topic, to model what a specific answer looks
like.

--- S Suggestion (0-2) ---
0 = no suggestion given
1 = simple or vague suggestion
2 = practical, relevant suggestion (ideally: who/what should do something + why it helps)

--- Language Use (0-5 total, separate from TREES content above) ---
Judge this ONLY from the pupil's actual grammar, word choice, and delivery -
not from how good their ideas or experience are. A pupil with a weak
experience but strong grammar should still score well here, and vice versa.

1. Grammar Accuracy (0-2)
   0 = frequent errors that make meaning hard to follow
   1 = some errors (tense, subject-verb agreement, articles) but meaning is clear
   2 = largely accurate grammar throughout

2. Vocabulary Range & Appropriateness (0-2)
   0 = very basic, repetitive vocabulary
   1 = adequate vocabulary for the topic
   2 = varied, precise, topic-appropriate vocabulary used naturally

3. Fluency & Delivery (0-1)
   0 = frequent filler words (um/uh/like) or halting, hard-to-follow delivery
   1 = mostly smooth delivery with minimal filler words`;

// v7.5 - rubric for Unit 2 (Questions 2 + 3 marked TOGETHER). Question 1 is a
// "respond to a prompt while referencing a picture" task and keeps the full
// TREES rubric above. Questions 2 and 3 move away from the picture toward
// broader themes and read as ONE extended personal-narrative task split across
// two prompts, so they are read and marked as a single piece of work. Thought,
// Reason and Evidence are not marked here (their 6 marks are redistributed:
// Experience 12 -> 16, Language 5 -> 7; Suggestion stays 2). Max is 25 so the
// two units weigh the same when averaged.
const DEFAULT_RUBRIC_Q2Q3 = `This rubric is for QUESTIONS 2 AND 3 TOGETHER. The pupil answered two linked prompts that move away from the picture and toward broader themes, often asking directly for personal experiences. Read BOTH answers as ONE extended personal-narrative response (e.g. a detail introduced in Question 2 and its outcome in Question 3 form one story) and mark them ONCE, as a single unit.

The unit is marked out of 25 marks: Experience 16 + Suggestion 2 + Language Use 7.
Thought, Reason and Evidence are NOT marked separately in this unit, and the pupil is NOT expected to refer to the picture. If the pupil's answers are laid out in labelled parts (Thought / Reason / Evidence / Experience / Suggestion), treat the labels only as the pupil's own structuring aid: credit relevant personal detail, reflection or suggestion wherever it appears in either answer.

--- Experience (0-16) ---
This is the main focus of the rubric. Do NOT reward length alone - reward
specific, believable, relevant personal details. A long but generic or
memorised-sounding response should score LOW. Judge the experience ACROSS BOTH
answers as one story: do not penalise Question 2 for something the pupil
delivers in Question 3 (or vice versa), and do not give credit twice for the
same detail simply repeated in both answers. Break this into 6 sub-criteria
and sum them for the Experience total:

1. Relevance to the prompts (0-2)
   0 = missing or unrelated, 1 = weakly related to the two prompts, 2 = clearly relevant to both prompts

2. Specificity using 5W1H details (0-6) - award up to 1 mark each for clear:
   Who was involved / What happened / When it happened / Where it happened /
   Why it happened or why the pupil acted / How it ended or was resolved
   (a detail may come from either answer)

3. Authenticity / personal voice (0-2)
   0 = no personal experience, clearly copied/generic, or only a generic reference
   1 = sounds mostly personal and believable
   2 = sounds authentic and natural, with realistic details, feelings or reactions
   Look for: first-person language (I/my/we), natural small believable details,
   realistic Singapore settings (void deck, MRT, canteen, CCA), genuine feelings.

4. Clarity and sequence across both answers (0-2)
   0 = confusing, incomplete, or jumps around
   1 = mostly clear, but the two answers feel disconnected or the story lacks a beginning, middle or ending
   2 = the two answers flow as one clearly sequenced story with a beginning, middle and ending

5. Reflection / lesson learnt (0-2)
   0 = no reflection, or only a simple feeling stated
   1 = some reflection, but generic or only loosely linked to the story
   2 = meaningful reflection that links back to the story and the prompts (the payoff of the story, often in Question 3)

6. Depth and development across both answers (0-2)
   0 = the second answer repeats the first or adds nothing new
   1 = the second answer adds some new information but stays shallow
   2 = the answers build on each other - a detail raised in one is developed, explained or paid off in the other

If the Experience lacks depth (vague on WHO/WHAT/WHEN/WHERE, or reads as
generic/memorised), say so plainly in the feedback - name what was missing
(e.g. "unclear where and when this happened, and who else was there") - and
suggest 1-2 concrete example experiences the pupil could have shared instead,
related to the prompts, to model what a specific answer looks like.

--- Suggestion (0-2) ---
A suggestion need only appear in EITHER answer (not both).
0 = no suggestion given in either answer
1 = simple or vague suggestion
2 = practical, relevant suggestion (ideally: who/what should do something + why it helps)

--- Language Use (0-7 total, separate from the content above) ---
Make ONE holistic judgement over the pupil's combined text from both answers
(more text makes this more reliable than judging each answer separately).
Judge this ONLY from the pupil's actual grammar, word choice, and delivery -
not from how good their ideas or experience are. A pupil with a weak
experience but strong grammar should still score well here, and vice versa.

1. Grammar Accuracy (0-3)
   0 = frequent errors that make meaning hard to follow
   1 = many errors (tense, subject-verb agreement, articles), though meaning is mostly clear
   2 = some errors, but meaning is clear
   3 = largely accurate grammar throughout

2. Vocabulary Range & Appropriateness (0-3)
   0 = very basic, repetitive vocabulary
   1 = limited vocabulary, adequate for simple ideas
   2 = adequate vocabulary for the topic, with some variety
   3 = varied, precise, topic-appropriate vocabulary used naturally

3. Fluency & Delivery (0-1)
   0 = frequent filler words (um/uh/like) or halting, hard-to-follow delivery
   1 = mostly smooth delivery with minimal filler words`;

function csvEscape(val) {
  const s = val === undefined || val === null ? "" : String(val);
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8", "access-control-allow-origin": "*" },
  });
}

function badRequest(msg) {
  return json({ error: msg }, 400);
}

function uid() {
  return crypto.randomUUID();
}

// ---------- NPC "Coach" content (sentence starters + teacher-set resources) ----------
// One coach entry per question (3 total per topic). Resources are manually
// set by the teacher via Teacher Tools -> Topics -> Coach fields - there is
// no AI-generated link suggestion here on purpose (an LLM can hallucinate
// plausible-looking article/video links that don't actually exist).
// ---------- Pupil tracking by name@class ----------
// Row identity on the pupils table is exact-case (name, pupil_class) - see
// the header comment. getOrCreatePupilId upserts in one round trip using
// D1's ON CONFLICT ... RETURNING.
async function getOrCreatePupilId(env, pupilClass, name) {
  const row = await env.CCv6_DB.prepare("SELECT id FROM pupils WHERE name = ? AND pupil_class = ?").bind(name, pupilClass).first();
  if (row) return row.id;
  const inserted = await env.CCv6_DB
    .prepare("INSERT INTO pupils (name, pupil_class, best_score, total_score, attempts) VALUES (?, ?, 0, 0, 0) RETURNING id")
    .bind(name, pupilClass)
    .first();
  return inserted.id;
}

const PUPIL_HISTORY_CAP = 50; // only the most recent 50 attempts are read back (LIMIT), see loadPupilHistory - older rows simply accumulate in D1 rather than being pruned

function rowToPupil(row) {
  return { name: row.name, pupilClass: row.pupil_class, bestScore: row.best_score, totalScore: row.total_score, attempts: row.attempts };
}

function rowToHistoryEntry(row) {
  return {
    timestamp: row.timestamp,
    topicId: row.topic_id,
    topicTitle: row.topic_title,
    finalScore: row.final_score,
    maxScore: row.max_score,
    breakdown: JSON.parse(row.breakdown || "[]"),
  };
}

async function pushPupilHistory(env, pupilId, entry) {
  await env.CCv6_DB
    .prepare("INSERT INTO pupil_history (pupil_id, timestamp, topic_id, topic_title, final_score, max_score, breakdown) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(pupilId, entry.timestamp, entry.topicId, entry.topicTitle, entry.finalScore, entry.maxScore, JSON.stringify(entry.breakdown))
    .run();
}

// Recomputes a pupil's leaderboard aggregate (attempts/total_score/
// best_score) directly from their own submissions, rather than nudging the
// existing counters up or down. This is what makes a teacher's score
// override safe: the pupils table has no idea a submission's score just
// changed, but a full COUNT/SUM/MAX over that pupil's leaderboard_counted
// rows is correct by construction no matter how many times a score has
// been corrected after the fact - there's no running total to drift.
async function recomputePupilAggregate(env, pupilName, pupilClass) {
  const pupilId = await getOrCreatePupilId(env, pupilClass, pupilName);
  const agg = await env.CCv6_DB
    .prepare("SELECT COUNT(*) as attempts, COALESCE(SUM(final_score), 0) as total, COALESCE(MAX(final_score), 0) as best FROM submissions WHERE pupil_name = ? AND pupil_class = ? AND leaderboard_counted = 1")
    .bind(pupilName, pupilClass)
    .first();
  await env.CCv6_DB
    .prepare("UPDATE pupils SET attempts = ?, total_score = ?, best_score = ? WHERE id = ?")
    .bind(agg.attempts, agg.total, agg.best, pupilId)
    .run();
  return pupilId;
}

// Most recent PUPIL_HISTORY_CAP attempts, oldest-first (matches the order
// the old KV rolling-array log kept them in).
async function loadPupilHistory(env, pupilId) {
  const { results } = await env.CCv6_DB
    .prepare("SELECT * FROM pupil_history WHERE pupil_id = ? ORDER BY timestamp DESC LIMIT ?")
    .bind(pupilId, PUPIL_HISTORY_CAP)
    .all();
  return results.reverse().map(rowToHistoryEntry);
}

// Averages each breakdown criterion (Thought, Reason, ..., Fluency & Delivery)
// across a submission's marking units (3 rounds for a pre-v7.5 submission,
// 2 for v7.5+), so one attempt collapses to one compact history entry instead
// of full per-round breakdowns. Averaged per criterion over only the rounds
// that actually contain it (Thought/Reason/Evidence exist only on Unit 1 in
// v7.5), and the MAX is averaged the same way - Experience is out of 12 on
// Unit 1 but 16 on Unit 2, so a single remembered max would be wrong.
function averageRoundBreakdown(rounds) {
  const sums = {};
  const maxSums = {};
  const counts = {};
  const order = [];
  for (const r of rounds) {
    for (const b of r.breakdown || []) {
      if (!(b.part in sums)) {
        sums[b.part] = 0;
        maxSums[b.part] = 0;
        counts[b.part] = 0;
        order.push(b.part);
      }
      sums[b.part] += b.points;
      maxSums[b.part] += b.max;
      counts[b.part] += 1;
    }
  }
  return order.map((part) => ({
    part,
    points: Math.round((sums[part] / counts[part]) * 10) / 10,
    max: Math.round((maxSums[part] / counts[part]) * 10) / 10,
  }));
}

// Rolls a pupil's history into per-criterion averages, then flags the
// weakest as "areas to grow" and strongest as "strengths" - purely
// arithmetic on already-stored scores, no AI call needed. Percentages are
// computed from summed points over summed max (not average points over the
// LAST max seen), because a criterion's max can differ between entries once
// pre-v7.5 and v7.5 attempts are mixed in one history (e.g. Experience
// averaged 12 before, 14 after).
function computeStrengthsConcerns(history) {
  if (!history || !history.length) return { strengths: [], concerns: [], rows: [] };
  const totals = {};
  for (const h of history) {
    for (const b of h.breakdown || []) {
      if (!totals[b.part]) totals[b.part] = { sum: 0, sumMax: 0, n: 0 };
      totals[b.part].sum += b.points;
      totals[b.part].sumMax += b.max;
      totals[b.part].n += 1;
    }
  }
  const rows = Object.keys(totals).map((part) => {
    const t = totals[part];
    const avg = t.n > 0 ? t.sum / t.n : 0;
    const avgMax = t.n > 0 ? t.sumMax / t.n : 0;
    return { part, avg: Math.round(avg * 10) / 10, max: Math.round(avgMax * 10) / 10, pct: t.sumMax > 0 ? t.sum / t.sumMax : 0 };
  });
  const sorted = [...rows].sort((a, b) => a.pct - b.pct);
  const concerns = sorted.slice(0, 2).map((r) => r.part);
  const strengths = [...sorted].reverse().slice(0, 2).map((r) => r.part);
  return { strengths, concerns, rows };
}

function sanitizeCoach(raw) {
  const entries = Array.isArray(raw) ? raw : [];
  const out = [];
  for (let i = 0; i < 3; i++) {
    const e = entries[i] || {};
    const starters = Array.isArray(e.starters) ? e.starters.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 6) : [];
    const resourcesRaw = Array.isArray(e.resources) ? e.resources : [];
    const resources = [];
    for (const r of resourcesRaw) {
      const url = String((r && r.url) || "").trim();
      if (!url) continue;
      if (!/^https?:\/\//i.test(url)) continue; // never store a non-http(s) "link"
      const type = r && r.type === "video" ? "video" : "article";
      const title = String((r && r.title) || url).trim().slice(0, 200);
      resources.push({ title, url, type });
      if (resources.length >= 3) break;
    }
    // v7.6: Questions 2 and 3 (indexes 1 and 2) carry two extra teacher-written
    // tip lists: how to tell a personal story, and how to add a lesson or
    // suggestion. Question 1 is about the picture, so it never stores them.
    const cleanTips = (v) => (Array.isArray(v) ? v.map((t) => String(t || "").trim().slice(0, 240)).filter(Boolean).slice(0, 5) : []);
    const storyTips = i >= 1 ? cleanTips(e.storyTips) : [];
    const lessonTips = i >= 1 ? cleanTips(e.lessonTips) : [];
    out.push({ starters, resources, storyTips, lessonTips });
  }
  return out;
}

// ---------- Password comparison / hashing ----------
// Compares two strings in constant time (relative to a fixed-length buffer)
// so a failed login attempt doesn't leak how many leading characters were
// correct via response timing.
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length, 32);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (i < aBytes.length ? aBytes[i] : 0) ^ (i < bBytes.length ? bBytes[i] : 0);
  }
  return diff === 0;
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(salt + ":" + password));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------- Settings (D1 config table: key/value) ----------
async function getConfig(env, key) {
  const row = await env.CCv6_DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}
async function setConfig(env, key, value) {
  await env.CCv6_DB.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}
async function deleteConfig(env, key) {
  await env.CCv6_DB.prepare("DELETE FROM config WHERE key = ?").bind(key).run();
}

// Thrown from inside a handler when the right response is a plain,
// pupil-readable 400 rather than a 500 "Server error: ..." - see the outer
// catch in fetch().
class HandledSubmitError extends Error {}

// ---------- "Try Again" (retry) policy ----------
// Whether a pupil is offered a "Try Again" button on their results screen is
// teacher-controlled: one global default, plus optional per-class overrides.
// Stored as a single config row so it's one read per submission rather than a
// row per class. Shape: { global: true, classes: { "5ig": false } } - class
// keys are lowercased, and a class with no entry simply follows `global`.
//
// Default is ON: a retry is marked, stored and leaderboarded exactly like a
// fresh attempt (it's a genuinely new submission, just traceably linked to
// the one it revises), so it's additive rather than something that changes
// how existing attempts are scored. Turn it off globally, or per class, from
// Teacher Tools -> Try Again when a class is doing a real assessment.
const RETRY_POLICY_KEY = "retry_policy";

function normalizeClassKey(pupilClass) {
  return String(pupilClass || "unassigned").trim().toLowerCase();
}

async function getRetryPolicy(env) {
  const stored = await getConfig(env, RETRY_POLICY_KEY);
  let parsed = null;
  if (stored) {
    try {
      parsed = JSON.parse(stored);
    } catch (e) {
      parsed = null; // corrupt value - fall back to the default rather than 500
    }
  }
  const classes = {};
  if (parsed && parsed.classes && typeof parsed.classes === "object") {
    for (const [k, v] of Object.entries(parsed.classes)) classes[normalizeClassKey(k)] = !!v;
  }
  return { global: parsed && typeof parsed.global === "boolean" ? parsed.global : true, classes };
}

// A per-class override always wins over the global default, including when it
// switches retries ON for one class while they're off everywhere else.
function isRetryEnabledForClass(policy, pupilClass) {
  const key = normalizeClassKey(pupilClass);
  if (Object.prototype.hasOwnProperty.call(policy.classes, key)) return !!policy.classes[key];
  return !!policy.global;
}

// The teacher password is stored as { salt, hash } (SHA-256), never in
// plaintext. Older deployments may still have a plain string in the config
// table from before this change - if a login with that plaintext value
// succeeds, we transparently upgrade the stored value to the salted-hash
// format so the plaintext isn't left sitting there any longer than necessary.
async function verifyTeacherPassword(env, password) {
  const stored = await getConfig(env, "teacher_password");
  if (!stored) return { ok: false, unset: true };

  let record = null;
  try {
    record = JSON.parse(stored);
  } catch (e) {
    record = null;
  }

  if (record && typeof record.salt === "string" && typeof record.hash === "string") {
    const candidateHash = await hashPassword(password, record.salt);
    return { ok: timingSafeEqualStr(candidateHash, record.hash) };
  }

  // Legacy plaintext format.
  const matches = timingSafeEqualStr(password, stored);
  if (matches) {
    await setTeacherPassword(env, password); // migrate to hashed storage
  }
  return { ok: matches };
}

async function setTeacherPassword(env, newPassword) {
  const salt = uid();
  const hash = await hashPassword(newPassword, salt);
  await setConfig(env, "teacher_password", JSON.stringify({ salt, hash }));
}

// ---------- Teacher-admin accounts ----------
// Scoped admins created by palpatine, each restricted to a set of classes.
// Stored the same salted-hash way as the palpatine password.
async function getTeacherAdmin(env, username) {
  const row = await env.CCv6_DB.prepare("SELECT * FROM teacher_admins WHERE username = ?").bind(username).first();
  if (!row) return null;
  return { username: row.username, salt: row.salt, hash: row.hash, classes: JSON.parse(row.classes || "[]"), createdAt: row.created_at };
}

async function verifyTeacherAdminPassword(record, password) {
  if (!record || typeof record.salt !== "string" || typeof record.hash !== "string") return false;
  const candidateHash = await hashPassword(password, record.salt);
  return timingSafeEqualStr(candidateHash, record.hash);
}

async function listTeacherAdmins(env) {
  const { results } = await env.CCv6_DB.prepare("SELECT username, classes, created_at FROM teacher_admins ORDER BY username").all();
  return results.map((r) => ({ username: r.username, classes: JSON.parse(r.classes || "[]"), createdAt: r.created_at }));
}

// Every class a pupil has ever logged in under. Used to populate class
// filter dropdowns and is intersected with a scoped teacher-admin's
// assignedClasses where relevant.
async function getAllKnownClasses(env) {
  const { results } = await env.CCv6_DB.prepare("SELECT DISTINCT pupil_class FROM pupils ORDER BY pupil_class").all();
  return results.map((r) => r.pupil_class);
}

// True if this session is allowed to see/administer the given class -
// palpatine (isSuperAdmin) can see everything; a scoped teacher-admin only
// their own assignedClasses (case-insensitive match).
function classAllowed(session, pupilClass) {
  if (!session || session.role !== "teacher") return false;
  if (session.isSuperAdmin) return true;
  const cls = (pupilClass || "unassigned").toLowerCase();
  return (session.assignedClasses || []).some((c) => String(c).toLowerCase() === cls);
}

async function getSession(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const raw = await env.CCv6_DATA.get(`session:${token}`);
  if (!raw) return null;
  return { token, ...JSON.parse(raw) };
}

function requireTeacher(session) {
  return session && session.role === "teacher";
}

// palpatine only - Topics, Settings, and managing teacher-admin accounts are
// global and out of scope for a class-scoped teacher-admin.
function requireSuperAdmin(session) {
  return session && session.role === "teacher" && session.isSuperAdmin === true;
}

// ---------- Vulgarity filter ----------
function scanVulgarity(text) {
  if (!text) return { clean: text || "", flagged: false, hits: [] };
  const hits = [];
  let clean = text;
  for (const word of VULGAR_WORDS) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    if (re.test(clean)) {
      hits.push(word);
      clean = clean.replace(re, (m) => "*".repeat(m.length));
    }
  }
  return { clean, flagged: hits.length > 0, hits };
}

function scanAllParts(parts) {
  const flaggedFields = [];
  const cleaned = {};
  let anyFlag = false;
  for (const [key, val] of Object.entries(parts || {})) {
    const { clean, flagged } = scanVulgarity(val);
    cleaned[key] = clean;
    if (flagged) {
      anyFlag = true;
      flaggedFields.push(key);
    }
  }
  return { cleaned, anyFlag, flaggedFields };
}

// ---------- Topics (D1) ----------
function rowToTopic(row) {
  return {
    id: row.id,
    title: row.title,
    imageUrl: row.image_url,
    imageDescription: row.image_description,
    questions: JSON.parse(row.questions || "[]"),
    tags: JSON.parse(row.tags || "[]"),
    coach: JSON.parse(row.coach || "[]"),
  };
}

async function ensureSeeded(env) {
  const row = await env.CCv6_DB.prepare("SELECT COUNT(*) as c FROM topics").first();
  if (row && row.c > 0) return;
  for (const t of SEED_TOPICS) {
    await env.CCv6_DB
      .prepare("INSERT INTO topics (id, title, image_url, image_description, questions, tags, coach, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(t.id, t.title || "Untitled topic", t.imageUrl || "", t.imageDescription || "", JSON.stringify(t.questions || []), JSON.stringify(t.tags || []), JSON.stringify(t.coach || []), Date.now())
      .run();
  }
}

// ---------- Rubric fallback (no AI key configured) ----------
const TREES_ORDER = [
  ["T", "Thought", 2],
  ["R", "Reason", 2],
  ["E1", "Evidence", 2],
  ["E2", "Experience", 12],
  ["S", "Suggestion", 2],
];
const TREES_MAX_TOTAL = TREES_ORDER.reduce((sum, [, , max]) => sum + max, 0); // 20

const EXPERIENCE_SUB = [
  ["Relevance", 2],
  ["5W1H Specificity", 6],
  ["Authenticity / Personal Voice", 2],
  ["Clarity & Sequence", 1],
  ["Reflection / Lesson Learnt", 1],
];

// ---------- Language Use (v6) - additive to TREES, not part of it ----------
// Modeled on (not copied from) the real PSLE oral exam's separate weighting
// of content vs language. Kept as its own small block so a teacher can see
// exactly which part of the mark is about WHAT was said vs HOW it was said.
const LANGUAGE_ORDER = [
  ["Grammar", "Grammar Accuracy", 2],
  ["Vocabulary", "Vocabulary Range & Appropriateness", 2],
  ["Fluency", "Fluency & Delivery", 1],
];
const LANGUAGE_MAX_TOTAL = LANGUAGE_ORDER.reduce((sum, [, , max]) => sum + max, 0); // 5
const FULL_MAX_TOTAL = TREES_MAX_TOTAL + LANGUAGE_MAX_TOTAL; // 25

// ---------- v7.5: two marking units instead of three ----------
// Unit 1 (Question 1 alone) = full TREES against the picture + Language Use,
// exactly as before. Unit 2 (Questions 2 + 3 together) = one AI call that sees
// both answers, marked on a modified rubric with no T/R/E1: Experience 16,
// Suggestion 2, Language Use 7 (Grammar 3 + Vocabulary 3 + Fluency 1) = 25, so
// the two units weigh the same when averaged into finalScore.
//
// Stored shape (submissions.rounds JSON) - rounds has 2 entries for a v7.5
// submission:
//   rounds[0] = { unit:"q1",   question, answer,            score, max, breakdown, ... }
//   rounds[1] = { unit:"q2q3", questions:[q2,q3], answers:[a2,a3], question (q2+q3 joined, display fallback), ... }
// Submissions saved before v7.5 have 3 rounds and no `unit` tag; every code
// path treats an untagged round as a Unit-1-style (full TREES) round, and
// divides by rounds.length rather than a hard-coded 3, so they keep working
// and keep their original scores.
const UNIT_Q1 = "q1";
const UNIT_Q2Q3 = "q2q3";
function roundUnit(r) {
  return r && r.unit === UNIT_Q2Q3 ? UNIT_Q2Q3 : UNIT_Q1;
}

const UNIT2_EXPERIENCE_SUB = [
  ["Relevance", 2],
  ["5W1H Specificity", 6],
  ["Authenticity / Personal Voice", 2],
  ["Clarity & Sequence", 2],
  ["Reflection / Lesson Learnt", 2],
  ["Depth & Development Across Both Answers", 2],
];
// Thought / Reason / Evidence earn no marks in Unit 2, so pupils may leave
// those boxes empty on Questions 2 and 3 (the page marks them optional). A blank
// one must never count against the pupil.
const UNIT2_OPTIONAL_PARTS = new Set(["T", "R", "E1"]);
const UNIT2_CONTENT_ORDER = [
  ["E2", "Experience", 16],
  ["S", "Suggestion", 2],
];
const UNIT2_LANGUAGE_ORDER = [
  ["Grammar", "Grammar Accuracy", 3],
  ["Vocabulary", "Vocabulary Range & Appropriateness", 3],
  ["Fluency", "Fluency & Delivery", 1],
];
const UNIT2_MAX_TOTAL =
  UNIT2_CONTENT_ORDER.reduce((sum, [, , max]) => sum + max, 0) + UNIT2_LANGUAGE_ORDER.reduce((sum, [, , max]) => sum + max, 0); // 25
if (UNIT2_MAX_TOTAL !== FULL_MAX_TOTAL) throw new Error("Unit 2 rubric must total the same as Unit 1 (" + FULL_MAX_TOTAL + ") - got " + UNIT2_MAX_TOTAL);
if (UNIT2_EXPERIENCE_SUB.reduce((sum, [, max]) => sum + max, 0) !== 16) throw new Error("Unit 2 Experience sub-criteria must sum to 16");

// The "stronger version" for Unit 2 rewrites TWO answers' worth of story as
// one, so it gets proportionally more room than Unit 1's single answer.
const UNIT2_MODEL_ANSWER_MAX_CHARS = 2800;
const UNIT2_MODEL_ANSWER_CEILING_WORDS = 400;

// Applied once per submission (not per round) when the pupil's three answers
// reuse essentially the same idea/story across all three questions - see
// detectRepeatedIdeas(). A flat deduction rather than a per-round rubric
// line, since it's about the *set* of three answers, not any one of them.
const REPEATED_IDEAS_PENALTY = 5;

// Filler words / disfluency markers, used to inform the Fluency sub-score.
// NOTE: the transcript comes from the browser's Web Speech API, which is
// known to smooth over or drop disfluencies rather than transcribe them
// faithfully - this is a best-effort signal, not a precise measurement.
const FILLER_RE = /\b(um+|uh+|erm+|ah+|hmm+|like|you know)\b/gi;
function countFillers(text) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  const totalWords = words.length;
  const matches = (text || "").match(FILLER_RE) || [];
  const count = matches.length;
  const density = totalWords > 0 ? count / totalWords : 0;
  return { count, totalWords, density };
}

// crude 5W1H / authenticity heuristics used only when no AI key is configured.
// These are deliberately strict: a pupil who just writes a lot of words with
// no real content should NOT score well offline, since this scorer has no
// real language understanding and is meant to be a conservative stand-in,
// not a generous one, while a teacher fixes the AI marking setup.
const WHO_RE = /\b(i|my|me|mother|father|mum|dad|grandmother|grandfather|friend|classmate|teacher|uncle|auntie|sister|brother|we)\b/i;
const WHEN_RE = /\b(yesterday|last\s+\w+|today|during|after|before|one\s+day|morning|afternoon|evening|weekend|recess|holiday)\b/i;
const WHERE_RE = /\b(at|in|near|school|canteen|mrt|bus|void\s+deck|park|home|classroom|market|centre|center|station)\b/i;
const WHY_RE = /\b(because|so\s+that|since|as\s+a\s+result|therefore|due\s+to)\b/i;
const HOW_RE = /\b(then|after\s+that|finally|in\s+the\s+end|eventually|so\s+i|i\s+decided|i\s+helped|i\s+felt)\b/i;
// concrete action/detail words - a rough proxy for "something specific actually
// happened" rather than a vague generic sentence padded out with filler words
const WHAT_RE = /\b(\d+|played|ran|fell|helped|broke|lost|found|won|cried|laughed|shouted|forgot|dropped|caught|fixed|built|cooked|cleaned|carried|shared|apologi[sz]ed|argued|comforted)\b/i;
const REFLECT_RE = /\b(felt|learnt|learned|realised|realized|proud|happy|taught\s+me|lesson|since\s+then)\b/i;
const SEQUENCE_RE = /\b(at\s+first|then|after\s+that|in\s+the\s+end|finally|next|later\s+on|once)\b/i;

const THOUGHT_RE = /\b(i think|in my opinion|i believe|i feel that)\b/i;
const REASON_RE = /\bbecause\b/i;
const EVIDENCE_RE = /\b(in the picture|i can see|the picture shows|this shows)\b/i;
const SUGGESTION_RE = /\b(i suggest|should|could|in future|we can|in the future)\b/i;

const STOPWORDS = new Set(["this", "that", "with", "from", "about", "your", "their", "which", "there", "would", "could", "should", "picture", "topic", "image"]);

// Pulls a handful of meaningful keywords out of the topic (title + tags) so
// the offline scorer can do a rough check for on-topic content, instead of
// only ever measuring word count.
function topicKeywords(topic) {
  const raw = [topic && topic.title, ...((topic && topic.tags) || [])].filter(Boolean).join(" ");
  const words = (raw.toLowerCase().match(/[a-z]+/g) || []).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return Array.from(new Set(words));
}

function mentionsTopic(text, keywords) {
  if (!keywords.length) return false;
  const lower = (text || "").toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

// ---------- Repeated-ideas-across-prompts penalty ----------
// A flat deduction applied once per submission (not per round) when all
// three answers are largely the same idea/story reused across different
// questions - deliberately deterministic and word-overlap based rather than
// an AI judgement call, since it's comparing across rounds that were each
// scored independently.
function extractRoundText(answer) {
  if (!answer) return "";
  if (typeof answer.text === "string") return answer.text;
  if (answer.parts && typeof answer.parts === "object") return Object.values(answer.parts).join(" ");
  return "";
}
function significantWordSet(text) {
  const words = (text || "").toLowerCase().match(/[a-z']+/g) || [];
  return new Set(words.filter((w) => w.length >= 4 && !STOPWORDS.has(w)));
}
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}
const REPEATED_IDEAS_MIN_WORDS = 6; // each answer needs at least this many significant words to be judged
const REPEATED_IDEAS_THRESHOLD = 0.45; // Jaccard similarity - all 3 pairwise comparisons must clear this
function detectRepeatedIdeas(roundTexts) {
  if (roundTexts.length < 3) return false;
  const sets = roundTexts.map(significantWordSet);
  if (sets.some((s) => s.size < REPEATED_IDEAS_MIN_WORDS)) return false; // not enough content in one of them to judge fairly
  const pairs = [
    [sets[0], sets[1]],
    [sets[0], sets[2]],
    [sets[1], sets[2]],
  ];
  return pairs.every(([a, b]) => jaccardSimilarity(a, b) >= REPEATED_IDEAS_THRESHOLD);
}

function scoreExperienceFallback(text, keywords) {
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const onTopic = mentionsTopic(text, keywords);
  const sub = {};

  // Relevance now requires BOTH enough length AND an actual mention of the
  // topic/picture - a long but completely off-topic answer no longer scores here.
  sub["Relevance"] = words >= 10 && onTopic ? 2 : (words >= 10 || onTopic) && words >= 3 ? 1 : 0;

  let whCount = 0;
  if (WHO_RE.test(text)) whCount++;
  if (WHEN_RE.test(text)) whCount++;
  if (WHERE_RE.test(text)) whCount++;
  if (WHY_RE.test(text)) whCount++;
  if (HOW_RE.test(text)) whCount++;
  if (WHAT_RE.test(text)) whCount++; // requires a concrete detail, not just length
  sub["5W1H Specificity"] = Math.min(6, whCount);

  // Authenticity now needs a real spread of WH-markers, not just "I" plus enough words.
  sub["Authenticity / Personal Voice"] = WHO_RE.test(text) && whCount >= 3 && words >= 15 ? 2 : WHO_RE.test(text) && whCount >= 2 ? 1 : 0;

  // Clarity now requires actual sequencing language - length alone no longer earns a point.
  const sequenceMatches = (text.match(new RegExp(SEQUENCE_RE, "gi")) || []).length;
  sub["Clarity & Sequence"] = sequenceMatches >= 1 ? 1 : 0;

  // Reflection now requires both the reflective language AND enough length to be a real reflection.
  sub["Reflection / Lesson Learnt"] = REFLECT_RE.test(text) && words >= 10 ? 1 : 0;

  const total = Object.values(sub).reduce((a, b) => a + b, 0);
  return { total: Math.min(12, total), sub };
}

// ---------- Language Use fallback (no AI key configured) ----------
// Crude, deterministic proxies only - never claims to be real grammar/vocab
// assessment, and says so in its own notes. Grammar uses basic punctuation/
// sentence-length signals; Vocabulary uses type-token ratio (distinct words
// / total words), a standard rough lexical-diversity measure; Fluency uses
// the filler-word density computed by countFillers().
function scoreLanguageFallback(text, fillerStats, maxes) {
  // maxes lets Unit 2 (Grammar 3 / Vocabulary 3) reuse the same crude
  // proxies on the same scale; omitted = Unit 1's 2 / 2.
  const gMax = (maxes && maxes.grammar) || 2;
  const vMax = (maxes && maxes.vocab) || 2;
  const trimmed = (text || "").trim();
  const words = trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;
  const breakdown = [];

  const startsCapital = /^[A-Z]/.test(trimmed);
  const endsWithPunct = /[.!?]$/.test(trimmed);
  const sentenceCount = (trimmed.match(/[.!?]+/g) || []).length;
  const avgSentenceLen = sentenceCount > 0 ? wordCount / sentenceCount : wordCount;
  const grammarPts =
    wordCount >= 15 && startsCapital && endsWithPunct && avgSentenceLen <= 35
      ? gMax
      : wordCount >= 8 && (startsCapital || endsWithPunct)
      ? Math.ceil(gMax / 2)
      : 0;
  breakdown.push({ part: "Grammar Accuracy", points: grammarPts, max: gMax, note: "Estimated from punctuation and sentence-length patterns - not real grammar checking." });

  const lowerWords = words.map((w) => w.toLowerCase().replace(/[^a-z']/g, "")).filter(Boolean);
  const uniqueWords = new Set(lowerWords);
  const ttr = lowerWords.length > 0 ? uniqueWords.size / lowerWords.length : 0;
  const vocabPts = wordCount >= 15 && ttr >= 0.6 ? vMax : wordCount >= 5 && ttr >= 0.45 ? Math.ceil(vMax / 2) : 0;
  breakdown.push({ part: "Vocabulary Range & Appropriateness", points: vocabPts, max: vMax, note: "Estimated from word variety (distinct vs repeated words) - not real vocabulary assessment." });

  const fluencyPts = wordCount >= 5 && fillerStats.density < 0.05 ? 1 : 0;
  breakdown.push({
    part: "Fluency & Delivery",
    points: fluencyPts,
    max: 1,
    note: fillerStats.count > 0 ? `${fillerStats.count} filler word(s) detected (um/uh/like/etc.).` : "No filler words detected.",
  });

  const total = breakdown.reduce((sum, b) => sum + b.points, 0);
  return { total, breakdown };
}

// The text a pupil produced for one question, whichever mode they answered in.
function combinedAnswerText(mode, data) {
  if (!data) return "";
  return mode === "single" ? data.text || "" : TREES_ORDER.map(([key]) => (data.parts && data.parts[key]) || "").join(" ");
}

// ---------- Unit 2 (Questions 2 + 3 together) offline stand-in ----------
// Same philosophy as the Unit 1 fallback: deliberately strict, keyword-based,
// and never pretending to be real marking. Reads BOTH answers as one
// narrative (experience cues may come from either), on the Unit 2 scale
// (Experience 16, Suggestion 2, Language 7).
function scoreExperienceFallbackUnit2(answerTexts, keywords) {
  const texts = answerTexts.map((t) => (t || "").trim());
  const combined = texts.join(" ").trim();
  const words = countWords(combined);
  const eachWords = texts.map(countWords);
  const onTopic = mentionsTopic(combined, keywords);
  const sub = {};

  let whCount = 0;
  if (WHO_RE.test(combined)) whCount++;
  if (WHEN_RE.test(combined)) whCount++;
  if (WHERE_RE.test(combined)) whCount++;
  if (WHY_RE.test(combined)) whCount++;
  if (HOW_RE.test(combined)) whCount++;
  if (WHAT_RE.test(combined)) whCount++;

  // Questions 2/3 move away from the picture, so mentioning the topic is a
  // bonus signal here rather than a requirement - but a long answer with no
  // concrete who/when/where/why detail still doesn't earn full relevance.
  sub["Relevance"] = words >= 15 && (onTopic || whCount >= 2) ? 2 : words >= 8 ? 1 : 0;
  sub["5W1H Specificity"] = Math.min(6, whCount);
  sub["Authenticity / Personal Voice"] = WHO_RE.test(combined) && whCount >= 3 && words >= 25 ? 2 : WHO_RE.test(combined) && whCount >= 2 ? 1 : 0;

  const sequenceCount = (combined.match(new RegExp(SEQUENCE_RE, "gi")) || []).length;
  sub["Clarity & Sequence"] = sequenceCount >= 2 && eachWords.every((w) => w >= 8) ? 2 : sequenceCount >= 1 ? 1 : 0;

  // The payoff of the story usually lands in the second answer.
  const laterText = texts.length > 1 ? texts[texts.length - 1] : combined;
  sub["Reflection / Lesson Learnt"] = REFLECT_RE.test(laterText) && words >= 20 ? 2 : REFLECT_RE.test(combined) && words >= 10 ? 1 : 0;

  // Depth: both answers have real content AND the second isn't just the
  // first repeated (high word overlap between the two is expected for one
  // story, so only near-duplication counts against it).
  const overlap = texts.length > 1 ? jaccardSimilarity(significantWordSet(texts[0]), significantWordSet(texts[1])) : 0;
  sub["Depth & Development Across Both Answers"] = eachWords.every((w) => w >= 15) && words >= 40 && overlap < 0.8 ? 2 : eachWords.every((w) => w >= 8) && overlap < 0.9 ? 1 : 0;

  const total = Object.values(sub).reduce((a, b) => a + b, 0);
  return { total: Math.min(16, total), sub };
}

function ruleBasedScoreUnit2(mode, answers, topic, fillerStats) {
  const keywords = topicKeywords(topic);
  const list = Array.isArray(answers) ? answers : [];
  const fullTexts = list.map((a) => combinedAnswerText(mode, a));
  const combined = fullTexts.join(" ").trim();
  const exp = scoreExperienceFallbackUnit2(fullTexts, keywords);
  const breakdown = [
    {
      part: "Experience",
      points: exp.total,
      max: 16,
      note: combined ? "Estimated from both answers together using simple keyword checks (who/when/where/why/how) - not full AI marking." : "Both answers are empty.",
      subBreakdown: UNIT2_EXPERIENCE_SUB.map(([label, max]) => ({ label, points: exp.sub[label] || 0, max })),
    },
  ];

  // Suggestion only has to appear in EITHER answer (and, in split mode, may
  // be written outside the Suggestion box too).
  const sugText = (mode === "single" ? fullTexts : list.map((a) => (a && a.parts && a.parts.S) || "")).join(" ").trim();
  const sugWords = countWords(sugText);
  let sugPts = 0;
  if (SUGGESTION_RE.test(sugText)) sugPts = sugWords >= 5 ? 2 : 1;
  else if (SUGGESTION_RE.test(combined)) sugPts = 1;
  else if (mode === "single" && countWords(combined) >= 50) sugPts = 1;
  breakdown.push({
    part: "Suggestion",
    points: sugPts,
    max: 2,
    note: sugPts >= 2 ? "Clear suggestion found." : "Estimated from simple keyword checks across both answers - not full AI marking.",
  });

  const fillers = fillerStats || countFillers(combined);
  const lang = scoreLanguageFallback(combined, fillers, { grammar: 3, vocab: 3 });
  const total = exp.total + sugPts + lang.total;
  return {
    total,
    max: UNIT2_MAX_TOTAL,
    breakdown: [...breakdown, ...lang.breakdown],
    feedback:
      "Automatic marking (no AI marker configured): scored with simple keyword/relevance/grammar-pattern checks, not real understanding. Ask your teacher to add an AI key for accurate marking.",
    suggestion: "Try telling one connected story across both answers: who was there, what happened, when and where, why, how it ended, and what you learnt.",
    ...deriveStrengthsNextStep([...breakdown, ...lang.breakdown]),
    modelAnswer: "",
  };
}

function ruleBasedScoreTrees(parts, keywords) {
  let total = 0;
  const breakdown = [];
  for (const [key, label, max] of TREES_ORDER) {
    const text = (parts[key] || "").trim();
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;

    if (key === "E2") {
      const exp = scoreExperienceFallback(text, keywords);
      total += exp.total;
      breakdown.push({
        part: label,
        points: exp.total,
        max,
        note: words === 0 ? "This part is empty." : "Estimated with simple keyword checks (who/when/where/why/how) - not full AI marking.",
        subBreakdown: EXPERIENCE_SUB.map(([subLabel, subMax]) => ({ label: subLabel, points: exp.sub[subLabel] || 0, max: subMax })),
      });
      continue;
    }

    // Each part now needs content matching what it's actually meant to contain
    // (a thought, a reason, evidence, a suggestion) - word count alone is only
    // ever enough for partial credit, never full marks.
    let pts = 0;
    if (key === "T") {
      pts = THOUGHT_RE.test(text) && words >= 5 ? max : THOUGHT_RE.test(text) || words >= 8 ? Math.min(max, 1) : 0;
    } else if (key === "R") {
      pts = REASON_RE.test(text) && words >= 8 ? max : REASON_RE.test(text) || words >= 10 ? Math.min(max, 1) : 0;
    } else if (key === "E1") {
      const onTopic = mentionsTopic(text, keywords);
      pts = EVIDENCE_RE.test(text) && onTopic ? max : EVIDENCE_RE.test(text) || onTopic ? Math.min(max, 1) : 0;
    } else {
      pts = SUGGESTION_RE.test(text) && words >= 5 ? max : SUGGESTION_RE.test(text) ? Math.min(max, 1) : 0;
    }
    total += pts;
    breakdown.push({
      part: label,
      points: pts,
      max,
      note: words === 0 ? "This part is empty." : pts >= max ? "Clear, on-topic content." : "Estimated with simple keyword checks - not full AI marking.",
    });
  }
  return { total, breakdown };
}

function ruleBasedScoreSingle(text, keywords) {
  text = text || "";
  const words = text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  const onTopic = mentionsTopic(text, keywords);
  let total = 0;
  const breakdown = [];
  for (const [key, label, max] of TREES_ORDER) {
    if (key === "E2") {
      const exp = scoreExperienceFallback(text, keywords);
      total += exp.total;
      breakdown.push({
        part: label,
        points: exp.total,
        max,
        note: "Estimated from the combined answer using keyword checks - not full AI marking.",
        subBreakdown: EXPERIENCE_SUB.map(([subLabel, subMax]) => ({ label: subLabel, points: exp.sub[subLabel] || 0, max: subMax })),
      });
      continue;
    }
    const re = key === "T" ? THOUGHT_RE : key === "R" ? REASON_RE : key === "E1" ? EVIDENCE_RE : SUGGESTION_RE;
    let pts = 0;
    if (key === "E1") {
      // evidence in a combined answer should also actually reference the topic
      pts = re.test(text) && onTopic ? max : re.test(text) || onTopic ? Math.min(max, 1) : 0;
    } else if (re.test(text)) {
      pts = max;
    } else if (words >= 25) {
      // a long combined answer with no matching phrase at all gets minimal credit
      pts = Math.min(max, 1);
    }
    total += pts;
    breakdown.push({
      part: label,
      points: pts,
      max,
      note: "Estimated from the combined answer using keyword checks - not full AI marking.",
    });
  }
  return { total, breakdown };
}

function ruleBasedScore(mode, data, topic, fillerStats) {
  const keywords = topicKeywords(topic);
  const contentResult = mode === "single" ? ruleBasedScoreSingle(data.text, keywords) : ruleBasedScoreTrees(data.parts, keywords);
  const combinedText = mode === "single" ? data.text || "" : TREES_ORDER.map(([key]) => data.parts[key] || "").join(" ");
  const fillers = fillerStats || countFillers(combinedText);
  const lang = scoreLanguageFallback(combinedText, fillers);
  return {
    total: contentResult.total + lang.total,
    max: FULL_MAX_TOTAL,
    breakdown: [...contentResult.breakdown, ...lang.breakdown],
    feedback:
      "Automatic marking (no AI marker configured): scored with simple keyword/relevance/grammar-pattern checks, not real understanding. Ask your teacher to add an AI key for accurate marking.",
    suggestion: "Try adding a specific personal experience with who, what, when, where, why and how it ended, plus how you felt.",
    ...deriveStrengthsNextStep([...contentResult.breakdown, ...lang.breakdown]),
    modelAnswer: "",
  };
}

// ---------- AI marking ----------
// =====================================================================
// AI RELIABILITY LAYER
// =====================================================================
// Every provider call in this file goes through the same three stages:
//   classify (turn an HTTP status / thrown error into one of a fixed set
//             of failure categories) -> health (record it against that
//             specific provider+model+key, and cool it down if it keeps
//             failing) -> select (choose the next candidate to try, in
//             priority order, skipping anything currently cooling down).
// The point of separating these is that "a 429 from Gemini key 2" and "a
// 404 from a Groq model a teacher mistyped" call for completely different
// responses (wait-and-retry vs. never touch that model again for a while),
// and a flat list of "try key 1, then key 2, then key 3..." can't tell
// them apart.

// ---- Failure categories ----
// Every category a provider call can fail with. Kept as plain strings
// (not an enum object) so they read directly in logs and health snapshots.
const AI_ERROR = {
  RATE_LIMIT: "rate_limit", // 429 - provider/account quota hit
  OVERLOADED: "overloaded", // 5xx / 503 - provider having a bad time, usually transient
  TIMEOUT: "timeout", // our own request timeout fired
  NETWORK: "network", // fetch itself failed (DNS, connection reset, etc.)
  AUTH: "auth", // 401/403 - this specific key is bad/revoked
  MODEL_NOT_FOUND: "model_not_found", // 404 or equivalent - model id wrong/deprecated
  INVALID_REQUEST: "invalid_request", // 400 that isn't context-length or content-policy
  CONTEXT_TOO_LONG: "context_too_long", // 400 specifically about token/context limits
  CONTENT_POLICY: "content_policy", // provider refused the content itself
  MALFORMED_RESPONSE: "malformed_response", // 200 OK but the body isn't usable JSON in our shape
  UNKNOWN: "unknown",
};

// Transient categories worth one short in-place retry (same provider, same
// key) before giving up on that candidate for this pass - see
// runProviderAttempt. Everything else (a bad credential, a wrong model id,
// a content rejection, a malformed body) will not fix itself by asking
// the same question again, so those go straight to the next candidate.
const AI_RETRY_IN_PLACE = new Set([AI_ERROR.RATE_LIMIT, AI_ERROR.OVERLOADED, AI_ERROR.TIMEOUT, AI_ERROR.NETWORK]);

// Categories that should take this provider+model+key OUT of rotation for a
// while, rather than just being "this attempt didn't work" - see
// recordAiFailure. A single overload blip shouldn't cool anything down (the
// in-place retry above handles that); it's *repeated* overload, or anything
// that clearly won't self-resolve on the next request (bad key, bad model
// id, malformed model id), that earns a cooldown.
const AI_COOLDOWN_CATEGORIES = new Set([AI_ERROR.RATE_LIMIT, AI_ERROR.OVERLOADED, AI_ERROR.AUTH, AI_ERROR.MODEL_NOT_FOUND, AI_ERROR.INVALID_REQUEST]);

// Base cooldown per category (ms) before exponential backoff by consecutive
// failures; capped at AI_COOLDOWN_MAX_MS for that category. AUTH and
// MODEL_NOT_FOUND get a much longer base, because "this key was revoked" or
// "this model id doesn't exist" won't be fixed by Anthropic^H^H^H the
// provider in the next few minutes - it needs a human to update a key or a
// Settings dropdown.
const AI_COOLDOWN_BASE_MS = {
  [AI_ERROR.RATE_LIMIT]: 20_000,
  [AI_ERROR.OVERLOADED]: 5_000,
  [AI_ERROR.AUTH]: 30 * 60_000,
  [AI_ERROR.MODEL_NOT_FOUND]: 60 * 60_000,
  [AI_ERROR.INVALID_REQUEST]: 15 * 60_000,
};
const AI_COOLDOWN_MAX_MS = {
  [AI_ERROR.RATE_LIMIT]: 10 * 60_000,
  [AI_ERROR.OVERLOADED]: 5 * 60_000,
  [AI_ERROR.AUTH]: 6 * 60 * 60_000,
  [AI_ERROR.MODEL_NOT_FOUND]: 24 * 60 * 60_000,
  [AI_ERROR.INVALID_REQUEST]: 2 * 60 * 60_000,
};

// A failed provider call always throws one of these, never a bare Error -
// see classifyHttpError / classifyThrownError. category drives every
// decision downstream (retry in place? cool down? reorder by context
// window?); statusCode/retryAfterMs are kept for logging and for honoring
// a provider's own Retry-After.
class AiError extends Error {
  constructor(category, message, opts) {
    super(message);
    this.name = "AiError";
    this.category = category;
    this.statusCode = (opts && opts.statusCode) || null;
    this.retryAfterMs = (opts && opts.retryAfterMs) || null;
  }
}

// Retry-After can be either a number of seconds or an HTTP-date. Returns ms,
// or null if absent/unparseable - callers fall back to their own backoff.
function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const asSeconds = Number(headerValue);
  if (isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(headerValue);
  if (!isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

// Turns a non-OK HTTP response into a typed AiError. bodyText is inspected
// for provider-specific phrasing (context-length vs. generic 400, safety
// rejections) since the status code alone doesn't distinguish them for
// every provider. providerId is only used for the error message text.
function classifyHttpError(providerId, status, bodyText, retryAfterHeader) {
  const text = (bodyText || "").toLowerCase();
  const snippet = (bodyText || "").slice(0, 300);
  if (status === 429) return new AiError(AI_ERROR.RATE_LIMIT, `${providerId}: rate limited (429)`, { statusCode: status, retryAfterMs: parseRetryAfterMs(retryAfterHeader) });
  if (status === 401 || status === 403) return new AiError(AI_ERROR.AUTH, `${providerId}: auth failure (${status})`, { statusCode: status });
  if (status === 404) return new AiError(AI_ERROR.MODEL_NOT_FOUND, `${providerId}: model not found (404)`, { statusCode: status });
  if (status >= 500) return new AiError(AI_ERROR.OVERLOADED, `${providerId}: provider overloaded (${status})`, { statusCode: status });
  if (status === 400 || status === 422) {
    if (/context.?length|token.?limit|maximum context|too many tokens|input is too long/.test(text)) {
      return new AiError(AI_ERROR.CONTEXT_TOO_LONG, `${providerId}: context/token limit exceeded`, { statusCode: status });
    }
    if (/content polic|safety|blocked|flagged|harassment|hate speech/.test(text)) {
      return new AiError(AI_ERROR.CONTENT_POLICY, `${providerId}: content rejected by provider`, { statusCode: status });
    }
    return new AiError(AI_ERROR.INVALID_REQUEST, `${providerId}: invalid request (${status}) ${snippet}`, { statusCode: status });
  }
  return new AiError(AI_ERROR.UNKNOWN, `${providerId}: HTTP ${status} ${snippet}`, { statusCode: status });
}

// For errors that never reach classifyHttpError - the fetch() call itself
// threw, or a provider-specific finish-reason check threw. An AbortError is
// our own timeout firing (see runProviderAttempt); a bare TypeError from
// fetch is a network failure (DNS, connection reset, offline); anything
// already an AiError (e.g. thrown deliberately by a call function for a
// safety-block finishReason) passes through unchanged.
function classifyThrownError(providerId, err) {
  if (err instanceof AiError) return err;
  if (err && err.name === "AbortError") return new AiError(AI_ERROR.TIMEOUT, `${providerId}: request timed out`);
  if (err instanceof TypeError) return new AiError(AI_ERROR.NETWORK, `${providerId}: network error - ${err.message}`);
  return new AiError(AI_ERROR.UNKNOWN, `${providerId}: ${(err && err.message) || String(err)}`);
}

function extractJson(text) {
  let parsed;
  try {
    const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "");
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new AiError(AI_ERROR.MALFORMED_RESPONSE, "response was not valid JSON");
  }
  if (!parsed || !Array.isArray(parsed.breakdown)) throw new AiError(AI_ERROR.MALFORMED_RESPONSE, "response JSON was missing the expected \"breakdown\" array");
  return parsed;
}

// ---- Health tracking (per provider+model+key) ----
// A module-level Map, not KV/D1: this is meant to be cheap, in-request-path
// state ("skip the key that just 429'd a second ago"), not a durable
// record. It lives for as long as this Worker isolate does, which in
// practice is anywhere from one request to many hours - so it meaningfully
// reduces repeated hammering of a cooling-down key within a burst of
// traffic, but does NOT persist across a cold start and is NOT shared
// across simultaneously-running isolates at the edge. If you need health
// state that's durable and shared across every edge location (e.g. to
// build an admin dashboard of provider uptime over days), that needs a
// Durable Object or a KV-backed counter instead - out of scope here, and
// unnecessary for what this layer is actually for: not re-trying a key
// that just failed, for the next little while, in this isolate.
const aiHealth = new Map();

// Test-only escape hatch: clears all in-memory provider/model/key health
// state. Not used anywhere in production request handling - the Worker's
// actual entry point is the default export below, which never calls this.
// Exists purely so tests can isolate scenarios from each other without
// waiting out real cooldown timers (see tests/ai-reliability.test.mjs).
export function __resetAiHealthForTests() {
  aiHealth.clear();
}


function aiHealthKey(providerId, modelId, keyId) {
  return providerId + "::" + modelId + "::" + keyId;
}
function getAiHealth(key) {
  return aiHealth.get(key) || { consecutiveFailures: 0, cooldownUntil: 0, lastSuccessAt: 0, lastFailureAt: 0, lastFailureCategory: null, lastLatencyMs: null };
}
function isAiCoolingDown(key) {
  const h = aiHealth.get(key);
  return !!h && h.cooldownUntil > Date.now();
}
function recordAiSuccess(key, latencyMs) {
  const prev = getAiHealth(key);
  aiHealth.set(key, { consecutiveFailures: 0, cooldownUntil: 0, lastSuccessAt: Date.now(), lastFailureAt: prev.lastFailureAt, lastFailureCategory: prev.lastFailureCategory, lastLatencyMs: latencyMs });
}
// After a cooldown expires, the very next request that reaches this
// candidate again is effectively "half-open": it gets tried normally, and
// either recordAiSuccess resets consecutiveFailures to 0 or another
// recordAiFailure extends the cooldown again. There's no separate
// half-open state to manage - letting the cooldown simply expire achieves
// the same "test it again after a break" behaviour with less bookkeeping.
function recordAiFailure(key, aiErr) {
  const prev = getAiHealth(key);
  const consecutiveFailures = prev.consecutiveFailures + 1;
  let cooldownMs = 0;
  if (AI_COOLDOWN_CATEGORIES.has(aiErr.category)) {
    const base = AI_COOLDOWN_BASE_MS[aiErr.category] || 5_000;
    const max = AI_COOLDOWN_MAX_MS[aiErr.category] || 10 * 60_000;
    cooldownMs = Math.min(base * Math.pow(2, consecutiveFailures - 1), max);
    // A provider's own Retry-After is more informed than our guess - never
    // cool down for LESS time than it explicitly asked for.
    if (aiErr.retryAfterMs) cooldownMs = Math.max(cooldownMs, Math.min(aiErr.retryAfterMs, max));
  }
  aiHealth.set(key, {
    consecutiveFailures,
    cooldownUntil: cooldownMs ? Date.now() + cooldownMs : 0,
    lastSuccessAt: prev.lastSuccessAt,
    lastFailureAt: Date.now(),
    lastFailureCategory: aiErr.category,
    lastLatencyMs: prev.lastLatencyMs,
  });
}

// Structured, key-free logging for every attempt - see requirement to log
// enough to diagnose failures without ever logging credentials or pupil
// text. One line per attempt, machine-parseable if you ever pipe Worker
// logs somewhere.
function logAiAttempt(entry) {
  try {
    console.log("[ai-attempt] " + JSON.stringify(entry));
  } catch (e) {
    // logging must never be the reason a marking request fails
  }
}

function clampNumber(n, min, max) {
  const num = typeof n === "number" && isFinite(n) ? n : 0;
  return Math.min(max, Math.max(min, Math.round(num)));
}

// ---------- "Stronger version" (modelAnswer) length policy ----------
// The model answer exists to show a pupil what THEIR OWN answer could sound
// like if it were better - so a rewrite that is shorter and thinner than what
// the pupil actually wrote is worse than showing nothing at all. A fixed
// absolute target ("60-120 words") predictably undershoots for any pupil who
// wrote more than that, and the 7-attempt marking chain makes this worse:
// weaker fallback models (Workers AI, free OpenRouter models) under-elaborate
// compared to Gemini, so length used to vary by whichever provider happened
// to answer. Instead the target is now derived from the pupil's own word
// count, restated in the prompt, and checked server-side afterwards.
const MODEL_ANSWER_MAX_CHARS = 1500; // hard ceiling stored/returned (was 900 - too tight for a legitimately longer rewrite of a wordy pupil)
const MODEL_ANSWER_MIN_RATIO = 1.1; // rewrite must be at least this many times the pupil's word count
const MODEL_ANSWER_FLOOR_WORDS = 60; // ...but never ask for less than this, or a 10-word pupil answer gets an 11-word "model answer"
const MODEL_ANSWER_CEILING_WORDS = 220; // ...and never ask for more than roughly fits in MODEL_ANSWER_MAX_CHARS

function countWords(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}

// How many words the rewrite must reach to count as "stronger" for a pupil
// answer of pupilWords words. Returns 0 when there is nothing to improve on
// (blank answer) - in that case no length rule is applied at all.
function modelAnswerTargetWords(pupilWords, ceilingWords) {
  if (!pupilWords) return 0;
  const ceiling = ceilingWords || MODEL_ANSWER_CEILING_WORDS;
  const scaled = Math.ceil(pupilWords * MODEL_ANSWER_MIN_RATIO);
  return Math.min(ceiling, Math.max(MODEL_ANSWER_FLOOR_WORDS, scaled));
}

// Which part of the pupil's response the rewrite is actually based on: the
// Experience part in split mode, the whole thing in single mode. Comparing
// against the wrong one would demand a rewrite ~4x too long in split mode.
function pupilAnswerForModelAnswer(mode, data) {
  return mode === "single" ? (data.text || "") : (data.parts && data.parts.E2) || "";
}
// Unit 2: the rewrite covers the pupil's story across BOTH answers.
function pupilAnswerForModelAnswerUnit2(mode, answers) {
  return (answers || []).map((a) => pupilAnswerForModelAnswer(mode, a || {})).join(" ").trim();
}

// Truncation that doesn't guillotine a sentence in half. Prefers to end on
// the last full sentence inside the cap; only if that would throw away most
// of the text does it fall back to a word-boundary cut with an ellipsis.
function trimModelAnswer(text, maxChars) {
  const cap = maxChars || MODEL_ANSWER_MAX_CHARS;
  const clean = (text || "").trim();
  if (clean.length <= cap) return clean;
  const slice = clean.slice(0, cap);
  const lastStop = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"));
  if (lastStop > cap * 0.6) return slice.slice(0, lastStop + 1).trim();
  const room = clean.slice(0, cap - 3); // leave space for the ellipsis so the cap still holds
  const lastSpace = room.lastIndexOf(" ");
  return (lastSpace > 0 ? room.slice(0, lastSpace) : room).trim() + "...";
}

// The AI is asked to self-report a "total", but models occasionally return a
// total that doesn't match the sum of their own breakdown, or sub-scores that
// exceed their stated max. Rather than trust the model's arithmetic, we
// re-derive every number from the breakdown it gave us, clamping each part
// to its rubric max. This also normalizes shape (missing/malformed parts,
// missing notes, etc.) so a slightly-off AI response can't crash rendering
// or silently distort a pupil's score.
// Plain-language names for each criterion, used to turn a breakdown into a
// "strength" and a "next step" when the AI didn't supply (or couldn't supply)
// its own - purely arithmetic on already-stored scores, never an AI call.
const STRENGTH_NEXT_COPY = {
  Thought: ["giving a clear opinion", "State your main thought clearly in one sentence."],
  Reason: ["explaining why you think so", "Add a 'because...' to explain your reason."],
  Evidence: ["using the picture to support your point", "Point to one specific thing you can see in the picture."],
  Experience: ["telling a real personal experience", "Tell it as a story: who was there, what happened, when, where, why, and how it ended."],
  Suggestion: ["giving a practical suggestion", "End with something someone could do, and why it would help."],
  "Grammar Accuracy": ["writing clear, accurate sentences", "Re-read for tense and subject-verb agreement before you finish."],
  "Vocabulary Range & Appropriateness": ["choosing good words", "Swap one simple word for a more exact one."],
  "Fluency & Delivery": ["speaking smoothly", "Pause quietly instead of saying 'um', 'uh' or 'like'."],
};
function deriveStrengthsNextStep(breakdown) {
  const rows = (breakdown || [])
    .filter((b) => b && b.max > 0 && STRENGTH_NEXT_COPY[b.part])
    .map((b) => ({ part: b.part, pct: b.points / b.max }));
  if (!rows.length) return { strengths: "", nextStep: "" };
  const best = rows.reduce((a, b) => (b.pct > a.pct ? b : a));
  const worst = rows.reduce((a, b) => (b.pct < a.pct ? b : a));
  const strengths = best.pct > 0 ? "You did well at " + STRENGTH_NEXT_COPY[best.part][0] + "." : "";
  const nextStep = worst.pct < 1 ? STRENGTH_NEXT_COPY[worst.part][1] : "Keep it up - try adding one more specific detail.";
  return { strengths, nextStep };
}

function normalizeWithSpec(raw, markedBy, spec) {
  const rawBreakdown = Array.isArray(raw.breakdown) ? raw.breakdown : [];
  const normalized = [];
  let total = 0;
  for (const [key, label, max] of spec.contentOrder) {
    const part = rawBreakdown.find((b) => b && b.part === label) || {};
    if (key === "E2") {
      const rawSub = Array.isArray(part.subBreakdown) ? part.subBreakdown : [];
      const subBreakdown = spec.experienceSub.map(([subLabel, subMax]) => {
        const sub = rawSub.find((s) => s && s.label === subLabel) || {};
        return { label: subLabel, points: clampNumber(sub.points, 0, subMax), max: subMax };
      });
      const subTotal = subBreakdown.reduce((sum, s) => sum + s.points, 0);
      total += subTotal;
      normalized.push({
        part: label,
        points: subTotal,
        max,
        note: typeof part.note === "string" ? part.note.slice(0, 300) : "",
        subBreakdown,
      });
      continue;
    }
    const pts = clampNumber(part.points, 0, max);
    total += pts;
    normalized.push({
      part: label,
      points: pts,
      max,
      note: typeof part.note === "string" ? part.note.slice(0, 300) : "",
    });
  }
  for (const [, label, max] of spec.languageOrder) {
    const part = rawBreakdown.find((b) => b && b.part === label) || {};
    const pts = clampNumber(part.points, 0, max);
    total += pts;
    normalized.push({
      part: label,
      points: pts,
      max,
      note: typeof part.note === "string" ? part.note.slice(0, 300) : "",
    });
  }
  return {
    total,
    max: spec.maxTotal,
    breakdown: normalized,
    feedback: typeof raw.feedback === "string" && raw.feedback.trim() ? raw.feedback.slice(0, 600) : "Marked - see the breakdown below for details.",
    suggestion: typeof raw.suggestion === "string" ? raw.suggestion.slice(0, 300) : "",
    // v7.6: strengths + next step. Prefer the AI's own (specific to the
    // pupil's words); fall back to the arithmetic version if it left them out.
    strengths: typeof raw.strengths === "string" && raw.strengths.trim() ? raw.strengths.trim().slice(0, 280) : deriveStrengthsNextStep(normalized).strengths,
    nextStep: typeof raw.nextStep === "string" && raw.nextStep.trim() ? raw.nextStep.trim().slice(0, 240) : deriveStrengthsNextStep(normalized).nextStep,
    modelAnswer: typeof raw.modelAnswer === "string" && raw.modelAnswer.trim() ? trimModelAnswer(raw.modelAnswer, spec.modelAnswerMaxChars) : "",
    markedBy,
  };
}

const UNIT1_NORMALIZE_SPEC = {
  contentOrder: TREES_ORDER,
  experienceSub: EXPERIENCE_SUB,
  languageOrder: LANGUAGE_ORDER,
  maxTotal: FULL_MAX_TOTAL,
  modelAnswerMaxChars: MODEL_ANSWER_MAX_CHARS,
};
const UNIT2_NORMALIZE_SPEC = {
  contentOrder: UNIT2_CONTENT_ORDER,
  experienceSub: UNIT2_EXPERIENCE_SUB,
  languageOrder: UNIT2_LANGUAGE_ORDER,
  maxTotal: UNIT2_MAX_TOTAL,
  modelAnswerMaxChars: UNIT2_MODEL_ANSWER_MAX_CHARS,
};
// Unit 1 (Question 1): full TREES + Language Use, out of 25.
function normalizeAiResult(raw, markedBy) {
  return normalizeWithSpec(raw, markedBy, UNIT1_NORMALIZE_SPEC);
}
// Unit 2 (Questions 2 + 3 together): Experience 16 + Suggestion 2 + Language 7, out of 25.
function normalizeAiResultUnit2(raw, markedBy) {
  return normalizeWithSpec(raw, markedBy, UNIT2_NORMALIZE_SPEC);
}

function buildPrompts(topic, question, mode, data, rubricText, opts) {
  opts = opts || {};
  const imageAttached = !!opts.imageAttached;
  const imageDescription = (opts.imageDescription || "").trim();
  const fillerStats = opts.fillerStats || { count: 0, totalWords: 0, density: 0 };

  const modeInstruction =
    mode === "single"
      ? `The pupil's answer below is ONE continuous piece of spoken text - it is NOT split into labelled parts. Read it carefully and identify each TREES component (Thought, Reason, Evidence, Experience, Suggestion) wherever it appears in the text, even if the pupil blends parts together or states them out of order, then mark each part using the same rubric. If a component is genuinely absent from their answer, score that part 0.`
      : `The pupil's answer below IS already split into 5 labelled parts. Mark each part as given.`;

  // Evidence (E1) instructions vary depending on how much visual grounding
  // this specific call actually has - a text-only model has no way to
  // verify a picture claim, so it should never be scored as if it could.
  let visionInstruction;
  if (imageAttached) {
    visionInstruction = `An image of the picture stimulus is attached below the pupil's answer. Actually look at it. For the Evidence (E1) part, verify whether the pupil's claim accurately describes something really present in the picture - if it's vague, generic, or doesn't match what's actually shown, score E1 low even if it sounds fluent.`;
  } else if (imageDescription) {
    visionInstruction = `You cannot see the actual picture, but the teacher has provided this description of it: "${imageDescription}". Use this description (not guesswork) to judge the Evidence (E1) part - if the pupil's claim contradicts or ignores this description, score E1 low; if it aligns with specific details in it, score E1 well.`;
  } else {
    visionInstruction = `You cannot see the actual picture and no teacher description was provided for it. For the Evidence (E1) part, judge only on plausibility and specificity of the claim - award partial credit for a specific, plausible-sounding reference to the picture, but do not penalise for visual accuracy you have no way to verify.`;
  }

  // Relative, not absolute, length target for the "stronger version" the
  // pupil is shown - see MODEL_ANSWER_* above. A rewrite that is shorter than
  // what the pupil already wrote isn't a model answer, it's a downgrade.
  const pupilWords = opts.pupilWords || 0;
  const targetWords = opts.targetWords || 0;
  const modelAnswerInstruction = targetWords
    ? `Also write "modelAnswer": a rewritten, STRONGER version of the pupil's OWN Experience answer (or their combined answer if in single mode) that keeps their real content and experience but fixes grammar, adds the specific 5W1H detail their version was missing, and reads more fluently - this shows the pupil what a stronger version of THEIR OWN answer could sound like, not a generic unrelated example.
LENGTH RULE for "modelAnswer" (important): the pupil's own answer is ${pupilWords} words long, so your rewrite MUST be at least ${targetWords} words - at least as many words as the original, ideally more. NEVER write a shorter or less detailed answer than the pupil's own. Every extra word must add real, specific detail the original lacked (exactly who was there, what happened, when, where, why, how it ended, and how they felt) - do not pad with repetition, waffle, or praise. Stay under about ${MODEL_ANSWER_CEILING_WORDS} words.`
    : `Also write "modelAnswer": since the pupil left their answer blank or nearly blank, write a short example answer (roughly 60-120 words) for this topic and question showing the kind of specific 5W1H personal experience that would score well.`;

  // Only set on a bounded one-time regenerate: the first response came back
  // shorter than the pupil's own answer, so the model is told exactly how it
  // fell short rather than just being asked again.
  const lengthRetry = opts.lengthRetry;
  const retryInstruction = lengthRetry
    ? `

SECOND ATTEMPT - YOUR PREVIOUS "modelAnswer" WAS TOO SHORT: you returned a rewrite of only ${lengthRetry.modelWords} words for a pupil answer of ${lengthRetry.pupilWords} words. That is a weaker answer than the pupil's own, which is unacceptable. Produce the full JSON again, and this time make "modelAnswer" at least ${lengthRetry.targetWords} words, longer and more specific than the pupil's original, expanding the 5W1H detail rather than repeating yourself.`
    : "";

  const fillerInstruction =
    fillerStats.totalWords > 0
      ? `Filler-word check (already counted by the app, not your job to recount): the pupil's full answer contains ${fillerStats.count} filler word(s) (um/uh/erm/like/you know, etc.) out of ${fillerStats.totalWords} total words (${Math.round(fillerStats.density * 100)}% filler density). Note this is only as reliable as the speech-to-text transcript, which sometimes smooths over disfluencies - use it as one signal, not the only one, when scoring Fluency & Delivery.`
      : `The transcript was too short to meaningfully measure filler-word density - use your own judgement on Fluency & Delivery from the text alone.`;

  const system = `You are a supportive but honest Primary School English oral examiner in Singapore, marking a pupil's spoken response using the TREES framework (Thought, Reason, Evidence, Experience, Suggestion) plus a separate Language Use component.

Marking rubric (set by the teacher), out of ${FULL_MAX_TOTAL} marks total (${TREES_MAX_TOTAL} for TREES content + ${LANGUAGE_MAX_TOTAL} for Language Use):
${rubricText}

${modeInstruction}

${visionInstruction}

${fillerInstruction}

Be encouraging in tone, age-appropriate for a 9-12 year old. For the Experience part specifically, you MUST score and return the 5 sub-criteria (Relevance 0-2, 5W1H Specificity 0-6, Authenticity/Personal Voice 0-2, Clarity & Sequence 0-1, Reflection/Lesson Learnt 0-1) and their sum must equal the Experience "points" value. Do not reward length alone anywhere - reward specific, believable, relevant detail.
If the Experience answer lacks depth (vague on who/what/when/where, or reads as generic/memorised), say so plainly in the Experience part's "note" - name what was actually missing (e.g. "unclear where and when this happened, and who else was there") - and give 1-2 concrete example experiences the pupil could have shared instead, related to the topic, in the "suggestion" field.
Language Use is separate from content - judge Grammar Accuracy (0-2) and Vocabulary Range & Appropriateness (0-2) from the pupil's actual sentences (not from how interesting their ideas are), and Fluency & Delivery (0-1) mainly from the filler-word signal above and general smoothness of the transcript.
Give ONE concrete, actionable suggestion for improvement per weak part in that part's "note".
${modelAnswerInstruction}
Respond with ONLY valid JSON, no markdown fences, no preamble, no explanation before or after, matching exactly this shape:
{
  "breakdown": [
    { "part": "Thought", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Reason", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Evidence", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Experience", "points": 0, "max": 12, "note": "short comment, max 25 words - name what was missing if depth was lacking",
      "subBreakdown": [
        { "label": "Relevance", "points": 0, "max": 2 },
        { "label": "5W1H Specificity", "points": 0, "max": 6 },
        { "label": "Authenticity / Personal Voice", "points": 0, "max": 2 },
        { "label": "Clarity & Sequence", "points": 0, "max": 1 },
        { "label": "Reflection / Lesson Learnt", "points": 0, "max": 1 }
      ]
    },
    { "part": "Suggestion", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Grammar Accuracy", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Vocabulary Range & Appropriateness", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Fluency & Delivery", "points": 0, "max": 1, "note": "short comment, max 25 words" }
  ],
  "total": 0,
  "max": ${FULL_MAX_TOTAL},
  "feedback": "2-3 encouraging sentences summarising strengths and one thing to work on, max 60 words",
  "suggestion": "one concrete practical tip to improve their next experience answer - if depth was lacking, include 1-2 example experiences they could share instead, max 40 words",
  "strengths": "one or two SPECIFIC things the pupil did well, quoting or pointing to something they actually said, in pupil-friendly words, max 30 words",
  "nextStep": "exactly ONE concrete next step for their very next try, starting with a verb, specific to this answer, max 25 words",
  "modelAnswer": ${targetWords ? `"a rewritten, stronger version of the pupil's own answer - at least ${targetWords} words, never shorter than their original"` : `"a short example answer, roughly 60-120 words"`}
}${retryInstruction}`;

  const content =
    mode === "single"
      ? (data.text || "").trim() || "(left blank)"
      : TREES_ORDER.map(([key, label]) => `${label}: ${(data.parts[key] || "").trim() || "(left blank)"}`).join("\n");

  const user = `Topic: ${topic ? topic.title : "General"}
Examiner question: ${question || "Tell me about this topic."}

Pupil's answer (${mode === "single" ? "single combined response" : "TREES, split into parts"}):
${content}`;

  return { system, user };
}

// Prompt for Unit 2: Questions 2 and 3 marked together as ONE extended
// personal-narrative response. One AI call sees both questions and both
// answers; the rubric drops Thought/Reason/Evidence and there is no picture
// (these prompts move toward broader themes), so no image is ever attached.
function buildPromptsUnit2(topic, questions, mode, answers, rubricText, opts) {
  opts = opts || {};
  const fillerStats = opts.fillerStats || { count: 0, totalWords: 0, density: 0 };
  const qs = Array.isArray(questions) ? questions : [];
  const ans = Array.isArray(answers) ? answers : [];

  const modeInstruction =
    mode === "single"
      ? `Each pupil answer below is ONE continuous piece of spoken text (not split into labelled parts). Read the two answers together, as one continuous account.`
      : `Each pupil answer below is split into 5 labelled parts (Thought, Reason, Evidence, Experience, Suggestion). In THIS unit the labels are only the pupil's own structuring aid and are NOT marked separately: Thought, Reason and Evidence earn no marks of their own and are OPTIONAL, so a blank Thought, Reason or Evidence box is expected and must NEVER lower any mark or be mentioned as a weakness. Credit relevant personal detail, reflection or suggestion wherever it appears in either answer, including inside parts not labelled "Experience" or "Suggestion", and read all the parts of both answers together as one account.`;

  const fillerInstruction =
    fillerStats.totalWords > 0
      ? `Filler-word check (already counted by the app, not your job to recount): the pupil's two answers together contain ${fillerStats.count} filler word(s) (um/uh/erm/like/you know, etc.) out of ${fillerStats.totalWords} total words (${Math.round(fillerStats.density * 100)}% filler density). Note this is only as reliable as the speech-to-text transcript, which sometimes smooths over disfluencies - use it as one signal, not the only one, when scoring Fluency & Delivery.`
      : `The transcript was too short to meaningfully measure filler-word density - use your own judgement on Fluency & Delivery from the text alone.`;

  const pupilWords = opts.pupilWords || 0;
  const targetWords = opts.targetWords || 0;
  const modelAnswerInstruction = targetWords
    ? `Also write "modelAnswer": ONE rewritten, STRONGER version of the pupil's OWN story across both answers (their Experience content, told as a single connected account) that keeps their real experience but fixes grammar, adds the specific 5W1H detail their version was missing, links the two answers into one clear sequence ending with a reflection, and reads more fluently - this shows the pupil what a stronger version of THEIR OWN story could sound like, not a generic unrelated example.
LENGTH RULE for "modelAnswer" (important): the pupil's own Experience content across both answers is ${pupilWords} words long, so your rewrite MUST be at least ${targetWords} words - at least as many words as the original, ideally more. NEVER write a shorter or less detailed account than the pupil's own. Every extra word must add real, specific detail the original lacked (exactly who was there, what happened, when, where, why, how it ended, and how they felt) - do not pad with repetition, waffle, or praise. Stay under about ${UNIT2_MODEL_ANSWER_CEILING_WORDS} words.`
    : `Also write "modelAnswer": since the pupil left their answers blank or nearly blank, write a short example account (roughly 80-160 words) responding to the two questions as one connected story, showing the kind of specific 5W1H personal experience that would score well.`;

  const lengthRetry = opts.lengthRetry;
  const retryInstruction = lengthRetry
    ? `

SECOND ATTEMPT - YOUR PREVIOUS "modelAnswer" WAS TOO SHORT: you returned a rewrite of only ${lengthRetry.modelWords} words for a pupil story of ${lengthRetry.pupilWords} words. That is a weaker account than the pupil's own, which is unacceptable. Produce the full JSON again, and this time make "modelAnswer" at least ${lengthRetry.targetWords} words, longer and more specific than the pupil's original, expanding the 5W1H detail rather than repeating yourself.`
    : "";

  const expSubRules = UNIT2_EXPERIENCE_SUB.map(([label, max]) => `${label} 0-${max}`).join(", ");
  const expSubJson = UNIT2_EXPERIENCE_SUB.map(([label, max]) => `        { "label": "${label}", "points": 0, "max": ${max} }`).join(",\n");

  const system = `You are a supportive but honest Primary School English oral examiner in Singapore. A pupil has answered TWO linked spoken questions (Question 2 and Question 3) that together read as ONE extended personal-narrative task split across two prompts. Mark the two answers TOGETHER, ONCE, as a single unit - not as two separate answers. Unlike Question 1, these questions move away from the picture toward broader themes, so do NOT expect or reward references to the picture, and do NOT mark Thought, Reason or Evidence.

Marking rubric (set by the teacher), out of ${UNIT2_MAX_TOTAL} marks total (Experience 16 + Suggestion 2 + Language Use 7):
${rubricText}

${modeInstruction}

${fillerInstruction}

Be encouraging in tone, age-appropriate for a 9-12 year old. Read BOTH answers as one story: a detail raised in Question 2 and its payoff in Question 3 are credited together, and a point should not be marked down in one answer for something the pupil clearly delivers in the other. For the Experience part you MUST score and return the ${UNIT2_EXPERIENCE_SUB.length} sub-criteria (${expSubRules}) and their sum must equal the Experience "points" value (out of 16). Do not reward length alone anywhere - reward specific, believable, relevant detail, and do not credit the same detail twice just because it is repeated in both answers.
If the Experience lacks depth (vague on who/what/when/where, or reads as generic/memorised), say so plainly in the Experience part's "note" - name what was actually missing (e.g. "unclear where and when this happened, and who else was there") - and give 1-2 concrete example experiences the pupil could have shared instead, related to the questions, in the "suggestion" field.
Suggestion (0-2) only has to appear in EITHER answer - do not require it in both.
Language Use is separate from content and is ONE holistic judgement over the pupil's combined text from both answers: Grammar Accuracy (0-3) and Vocabulary Range & Appropriateness (0-3) from the pupil's actual sentences (not from how interesting their ideas are), and Fluency & Delivery (0-1) mainly from the filler-word signal above and general smoothness of the transcript.
Give ONE concrete, actionable suggestion for improvement per weak part in that part's "note".
${modelAnswerInstruction}
Respond with ONLY valid JSON, no markdown fences, no preamble, no explanation before or after, matching exactly this shape:
{
  "breakdown": [
    { "part": "Experience", "points": 0, "max": 16, "note": "short comment, max 25 words - name what was missing if depth was lacking",
      "subBreakdown": [
${expSubJson}
      ]
    },
    { "part": "Suggestion", "points": 0, "max": 2, "note": "short comment, max 25 words" },
    { "part": "Grammar Accuracy", "points": 0, "max": 3, "note": "short comment, max 25 words" },
    { "part": "Vocabulary Range & Appropriateness", "points": 0, "max": 3, "note": "short comment, max 25 words" },
    { "part": "Fluency & Delivery", "points": 0, "max": 1, "note": "short comment, max 25 words" }
  ],
  "total": 0,
  "max": ${UNIT2_MAX_TOTAL},
  "feedback": "2-3 encouraging sentences about the two answers as one story - strengths and one thing to work on, max 60 words",
  "suggestion": "one concrete practical tip to improve their next personal story - if depth was lacking, include 1-2 example experiences they could share instead, max 40 words",
  "strengths": "one or two SPECIFIC things the pupil did well across the two answers, pointing to something they actually said, in pupil-friendly words, max 30 words",
  "nextStep": "exactly ONE concrete next step for their very next try, starting with a verb, specific to this story (e.g. which of who/when/where/why/how it ended, or the lesson, was missing), max 25 words",
  "modelAnswer": ${targetWords ? `"one rewritten, stronger version of the pupil's own story across both answers - at least ${targetWords} words, never shorter than their original"` : `"a short example account, roughly 80-160 words"`}
}${retryInstruction}`;

  const answerBlock = (a) =>
    mode === "single"
      ? ((a && a.text) || "").trim() || "(left blank)"
      : TREES_ORDER.map(([key, label]) => `${label}: ${((a && a.parts && a.parts[key]) || "").trim() || (UNIT2_OPTIONAL_PARTS.has(key) ? "(left blank - optional, not marked)" : "(left blank)")}`).join("\n");

  const user = `Topic: ${topic ? topic.title : "General"}
The pupil answered two linked examiner questions. Mark them together as ONE unit.

Question 2: ${qs[0] || "Tell me more about this topic."}
Pupil's answer to Question 2 (${mode === "single" ? "single combined response" : "split into labelled parts"}):
${answerBlock(ans[0])}

Question 3: ${qs[1] || "Tell me more about this topic."}
Pupil's answer to Question 3 (${mode === "single" ? "single combined response" : "split into labelled parts"}):
${answerBlock(ans[1])}`;

  return { system, user };
}

// Fetches a topic's stimulus picture and base64-encodes it for a multimodal
// AI call. Used so the marker can actually verify Evidence (E1) claims
// against the real picture instead of guessing. Returns null on any failure
// (bad URL, non-image response, too large, network error) - callers must
// treat that as "no image available" and fall back to the teacher's text
// description (topic.imageDescription) if one was set.
//
// Topics uploaded via Teacher Tools -> Topics -> "Upload a picture" store
// the picture as a data: URL (already base64, compressed client-side) in
// this same imageUrl field rather than an http(s) link - handled here by
// parsing it directly instead of trying to fetch it back over the network.
async function fetchImageAsBase64(url) {
  if (!url) return null;
  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([\s\S]*)$/.exec(url);
    if (!match) return null; // not a base64 data URL (e.g. an unsupported data: encoding) - treat as unavailable
    return { mimeType: match[1], base64: match[2] };
  }
  try {
    const resp = await fetch(url, { headers: { accept: "image/*" } });
    if (!resp.ok) return null;
    const contentType = (resp.headers.get("content-type") || "").split(";")[0].trim();
    if (!contentType.startsWith("image/")) return null;
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null; // 8MB safety cap
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return { mimeType: contentType, base64: btoa(binary) };
  } catch (e) {
    return null;
  }
}

// ---------- Provider: Groq (2nd marker, https://console.groq.com) ----------
// ---------- Provider: Groq (https://console.groq.com) ----------
// Two API keys can be configured - env.GROQ_API_KEY and env.GROQ_API_KEY_2 -
// tried in that order, so a second account's free-tier quota is available
// if the first is exhausted or rate-limited. See aiScore for where both get
// queued as separate attempts.
async function callGroq(env, system, user, model, apiKey, signal) {
  let resp;
  try {
    resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        // Model is teacher-configurable from Settings (config:model_groq in
        // the D1 config table), defaulting to DEFAULT_GROQ_MODEL if never set.
        // If Groq deprecates the default, update DEFAULT_GROQ_MODEL /
        // GROQ_MODEL_OPTIONS above (see console.groq.com/docs/deprecations).
        model: model || DEFAULT_GROQ_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        reasoning_effort: "low", // this task doesn't need heavy reasoning - keeps latency down
        temperature: 0.4,
      }),
      signal,
    });
  } catch (e) {
    throw classifyThrownError("groq", e);
  }
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    console.error("Groq API error", resp.status, bodyText.slice(0, 500));
    throw classifyHttpError("groq", resp.status, bodyText, resp.headers.get("retry-after"));
  }
  const data = await resp.json();
  const choice = data.choices && data.choices[0];
  if (choice && choice.finish_reason === "content_filter") {
    throw new AiError(AI_ERROR.CONTENT_POLICY, "groq: content rejected by provider");
  }
  const text = choice && choice.message && choice.message.content;
  if (!text) throw new AiError(AI_ERROR.MALFORMED_RESPONSE, "groq: empty response");
  return extractJson(text);
}

// ---------- Provider: Google Gemini (https://aistudio.google.com/apikey) ----------
// Two API keys can be configured - env.GEMINI_API_KEY and
// env.GEMINI_API_KEY_2 - tried in that order, same reasoning as Groq/
// OpenRouter above: a second account's free-tier quota is available if the
// first is exhausted or rate-limited.
async function callGemini(env, system, user, image, apiKey, signal) {
  const model = "gemini-2.5-flash"; // fast + cheap, generous free tier, multimodal
  const parts = [{ text: user }];
  if (image && image.base64) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
  }
  let resp;
  try {
    resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.4,
          },
        }),
        signal,
      }
    );
  } catch (e) {
    throw classifyThrownError("gemini", e);
  }
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    console.error("Gemini API error", resp.status, bodyText.slice(0, 500));
    throw classifyHttpError("gemini", resp.status, bodyText, resp.headers.get("retry-after"));
  }
  const data = await resp.json();
  const candidate = data.candidates && data.candidates[0];
  // Gemini reports a safety block as a 200 with no text and a finishReason
  // of SAFETY/PROHIBITED_CONTENT rather than an HTTP error - without this
  // check it would just look like a MALFORMED_RESPONSE and get retried
  // pointlessly against providers just as likely to also refuse it.
  if (candidate && candidate.finishReason && /SAFETY|PROHIBITED_CONTENT|BLOCKLIST/.test(candidate.finishReason)) {
    throw new AiError(AI_ERROR.CONTENT_POLICY, "gemini: content rejected by provider (" + candidate.finishReason + ")");
  }
  const respParts = candidate && candidate.content && candidate.content.parts;
  const text = respParts && respParts[0] && respParts[0].text;
  if (!text) throw new AiError(AI_ERROR.MALFORMED_RESPONSE, "gemini: empty response");
  return extractJson(text);
}

// ---------- Provider: Cloudflare Workers AI (final AI-tier marker, free, built into this Worker) ----------
async function callWorkersAI(env, system, user, signal) {
  const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"; // confirmed active, not on Cloudflare's deprecation list as of Aug 2026
  let result;
  try {
    // env.AI.run() doesn't take an AbortSignal directly - the timeout race
    // in runProviderAttempt still bounds the wait even though the
    // underlying call itself isn't cancelled.
    result = await env.AI.run(model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
    });
  } catch (e) {
    console.error("Workers AI call error", e && e.message);
    // Workers AI throws its own Error shapes rather than giving us an HTTP
    // status - inspect the message for the categories that matter, since
    // there's no status code to classify from.
    const msg = String((e && e.message) || e || "").toLowerCase();
    if (/rate limit|429/.test(msg)) throw new AiError(AI_ERROR.RATE_LIMIT, "workers-ai: rate limited");
    if (/not found|unknown model|400.*model/.test(msg)) throw new AiError(AI_ERROR.MODEL_NOT_FOUND, "workers-ai: model unavailable");
    if (/timeout/.test(msg)) throw new AiError(AI_ERROR.TIMEOUT, "workers-ai: request timed out");
    throw new AiError(AI_ERROR.OVERLOADED, "workers-ai: " + ((e && e.message) || "call failed"));
  }
  const text = typeof result === "string" ? result : result.response;
  if (!text) throw new AiError(AI_ERROR.MALFORMED_RESPONSE, "workers-ai: empty response");
  return extractJson(text);
}

// ---------- Provider: OpenRouter (https://openrouter.ai) ----------
// Two API keys can be configured - env.OPENROUTER_API_KEY and
// env.OPENROUTER_API_KEY_2 - tried in that order, so a second account's
// free-tier quota is available if the first is exhausted or rate-limited.
// See aiScore for where both get queued as separate attempts.
async function callOpenRouter(env, system, user, model, apiKey, signal) {
  let resp;
  try {
    resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + apiKey,
        // OpenRouter uses these two headers for attribution/leaderboard
        // purposes only - harmless if left as-is, but feel free to change
        // them to match your actual deployment URL / app name.
        "HTTP-Referer": "https://just-a-chit-chat.pages.dev",
        "X-Title": "Just a Chit-Chat",
      },
      body: JSON.stringify({
        // Model is teacher-configurable from Settings (config:model_openrouter),
        // defaulting to DEFAULT_OPENROUTER_MODEL if never set.
        model: model || DEFAULT_OPENROUTER_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.4,
      }),
      signal,
    });
  } catch (e) {
    throw classifyThrownError("openrouter", e);
  }
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    console.error("OpenRouter API error", resp.status, bodyText.slice(0, 500));
    // OpenRouter proxies many underlying models/providers, and reports an
    // upstream provider error as a 200 with an "error" field in the body
    // rather than a non-2xx status in some cases - both are handled here
    // since classifyHttpError only runs for a non-ok resp.
    throw classifyHttpError("openrouter", resp.status, bodyText, resp.headers.get("retry-after"));
  }
  const data = await resp.json();
  if (data && data.error) {
    const msg = String((data.error.message || data.error.code || "")).toLowerCase();
    if (/rate limit|429/.test(msg)) throw new AiError(AI_ERROR.RATE_LIMIT, "openrouter: upstream rate limited");
    if (/no.*available|no endpoints|model.*not.*found/.test(msg)) throw new AiError(AI_ERROR.MODEL_NOT_FOUND, "openrouter: upstream model unavailable");
    throw new AiError(AI_ERROR.OVERLOADED, "openrouter: upstream error - " + (data.error.message || "unknown"));
  }
  const choice = data.choices && data.choices[0];
  if (choice && choice.finish_reason === "content_filter") {
    throw new AiError(AI_ERROR.CONTENT_POLICY, "openrouter: content rejected by provider");
  }
  const text = choice && choice.message && choice.message.content;
  if (!text) throw new AiError(AI_ERROR.MALFORMED_RESPONSE, "openrouter: empty response");
  return extractJson(text);
}

// ---------- AI marking: 2x Gemini -> 2x Groq -> 2x OpenRouter -> Workers AI -> offline scorer ----------
// Every question is marked with the same chain, tried in this fixed order:
// both Gemini keys, then both Groq keys, then both OpenRouter keys, then
// Workers AI (single, no key). Any tier with no key/binding configured is
// skipped. If the whole chain fails once (e.g. transient rate-limiting), it
// is retried in full up to AI_MARKING_MAX_PASSES times, with a pause between
// passes, before that question falls back to the offline rule-based scorer
// - see aiScore. Questions themselves are marked one at a time (not in
// parallel, see the /api/submit handler) specifically to avoid bursting
// several simultaneous requests at the same provider/key, which is what
// tends to trigger rate limits in the first place.
const AI_MARKING_MAX_PASSES = 2; // how many times to retry the *entire* chain for one question before giving up to the offline scorer
const AI_ATTEMPT_PAUSE_MS = 350; // brief pause between individual provider attempts within a chain
const AI_PASS_RETRY_PAUSE_MS = 3000; // longer pause before retrying the whole chain again (gives transient rate-limits time to clear)
const AI_REQUEST_TIMEOUT_MS = 20_000; // per HTTP call - bounds how long one candidate can hang before we move on
const AI_MAX_TOTAL_MS = 45_000; // wall-clock ceiling for the WHOLE marking attempt (all passes/candidates) before giving up to the offline scorer - prevents one slow/hanging provider from stalling a pupil's submission indefinitely
const AI_INPLACE_BACKOFF_BASE_MS = 400; // base for the single in-place retry's exponential-backoff-with-jitter

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// jitter avoids every simultaneous pupil submission retrying a rate-limited
// key at exactly the same instant, which would just recreate the rate limit
function backoffWithJitter(attemptIndex, baseMs) {
  const exp = baseMs * Math.pow(2, attemptIndex);
  return exp + Math.random() * exp * 0.5;
}

// ---- Provider Registry ----
// The single place that knows which providers exist, which models they
// offer, what those models can do, and which keys/accounts are configured
// for them. Selection, retry and health logic (below) all work off this
// list rather than anything provider-specific - adding a new provider or
// model means adding an entry here, not touching the marking loop.
//
// groqModel/openRouterModel are teacher-configurable (Settings) and
// resolved once per call in aiScore, rather than being static like
// Gemini's and Workers AI's model ids. `image` (already fetched once in
// aiScore, or null) is only ever used by Gemini's call - it's threaded
// through here rather than being part of the "prompts" object, since
// vision is a per-candidate capability, not a per-prompt one.
function buildProviderRegistry(env, groqModel, openRouterModel, image) {
  return [
    {
      id: "gemini",
      priority: 1, // only vision-capable provider, and generally the highest-quality free tier available here
      models: [
        {
          id: "gemini-2.5-flash",
          capabilities: { vision: true, json: true, maxContextTokens: 1_000_000 },
          call: (p, apiKey, signal) => callGemini(env, p.system, p.user, image, apiKey, signal),
          // Two API keys/accounts for the SAME model - not two different
          // providers, and not tried interchangeably with Groq or
          // OpenRouter's keys. A second Gemini account's free-tier quota
          // becomes available if the first is rate-limited, nothing more.
          keys: [
            { id: "key1", apiKey: env.GEMINI_API_KEY },
            { id: "key2", apiKey: env.GEMINI_API_KEY_2 },
          ],
        },
      ],
    },
    {
      id: "groq",
      priority: 2,
      models: [
        {
          id: groqModel,
          capabilities: { vision: false, json: true, maxContextTokens: 128_000 },
          call: (p, apiKey, signal) => callGroq(env, p.system, p.user, groqModel, apiKey, signal),
          keys: [
            { id: "key1", apiKey: env.GROQ_API_KEY },
            { id: "key2", apiKey: env.GROQ_API_KEY_2 },
          ],
        },
      ],
    },
    {
      id: "openrouter",
      priority: 3,
      models: [
        {
          id: openRouterModel,
          // OpenRouter's free-tier models vary in real context window, but
          // are typically smaller than Gemini/Groq's - conservative estimate
          // used only for reordering on a CONTEXT_TOO_LONG error, not enforced.
          capabilities: { vision: false, json: true, maxContextTokens: 32_000 },
          call: (p, apiKey, signal) => callOpenRouter(env, p.system, p.user, openRouterModel, apiKey, signal),
          keys: [
            { id: "key1", apiKey: env.OPENROUTER_API_KEY },
            { id: "key2", apiKey: env.OPENROUTER_API_KEY_2 },
          ],
        },
      ],
    },
    {
      id: "workers-ai",
      priority: 4, // last AI tier before the offline rule-based scorer - always available if the AI binding exists, no external account to be rate-limited
      models: [
        {
          id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          capabilities: { vision: false, json: true, maxContextTokens: 24_000 },
          call: (p, apiKey, signal) => callWorkersAI(env, p.system, p.user, signal),
          // Not an API key - env.AI is a binding, always the same "account".
          // apiKey:true just marks it configured; call() ignores the value.
          keys: [{ id: "binding", apiKey: env.AI ? true : null }],
        },
      ],
    },
  ];
}

// Flattens the registry above into one ordered list of concrete
// (provider, model, key) candidates - what actually gets tried, in order.
// A candidate whose key/binding isn't configured is left out entirely
// (never counted as "attempted", never logged as a failure).
function buildAiCandidates(env, groqModel, openRouterModel, image) {
  const registry = buildProviderRegistry(env, groqModel, openRouterModel, image);
  const candidates = [];
  for (const provider of registry) {
    for (const model of provider.models) {
      for (const key of model.keys) {
        if (!key.apiKey) continue;
        candidates.push({
          providerId: provider.id,
          priority: provider.priority,
          modelId: model.id,
          capabilities: model.capabilities,
          keyId: key.id,
          call: (prompts, signal) => model.call(prompts, key.apiKey === true ? undefined : key.apiKey, signal),
          healthKey: aiHealthKey(provider.id, model.id, key.id),
        });
      }
    }
  }
  // Provider priority first (Gemini > Groq > OpenRouter > Workers AI, per
  // the app's existing quality ordering), key order second (key1 before
  // key2, matching the previous flat-list behaviour). Health does NOT
  // affect this base order - it only affects which candidates are tried
  // in orderCandidatesForPass below.
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates;
}

// Health- and context-aware ordering for one pass through the candidate
// list. Two adjustments on top of the registry's base priority order:
//   - anything currently cooling down is deferred to the end (not dropped -
//     if EVERY candidate is cooling down, we still try them in this order
//     rather than fail the whole request over what might be a short window
//     where every provider happens to be rate-limited at once)
//   - if the previous attempt in THIS pass failed with CONTEXT_TOO_LONG,
//     the remaining candidates are re-sorted by descending context window,
//     since a bigger-context model is the one actually likely to succeed
//     next, regardless of its normal provider-priority position
function orderCandidatesForPass(candidates, preferLargeContext) {
  const healthy = candidates.filter((c) => !isAiCoolingDown(c.healthKey));
  const cooling = candidates.filter((c) => isAiCoolingDown(c.healthKey));
  let ordered = healthy.length ? healthy.concat(cooling) : candidates;
  if (preferLargeContext) {
    ordered = [...ordered].sort((a, b) => b.capabilities.maxContextTokens - a.capabilities.maxContextTokens);
  }
  return ordered;
}

// Runs one candidate: wraps the call in a timeout, does at most one short
// in-place retry for a transient failure (rate limit / overload / timeout /
// network - see AI_RETRY_IN_PLACE), and always records the outcome to
// health and to the log, whether it succeeds or not. Never throws a bare
// Error - always an AiError, so callers can inspect .category.
async function runProviderAttempt(candidate, prompts) {
  let lastErr;
  for (let inPlaceAttempt = 0; inPlaceAttempt <= 1; inPlaceAttempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
    try {
      const raw = await candidate.call(prompts, controller.signal);
      const latencyMs = Date.now() - started;
      recordAiSuccess(candidate.healthKey, latencyMs);
      logAiAttempt({ provider: candidate.providerId, model: candidate.modelId, key: candidate.keyId, inPlaceAttempt, latencyMs, status: "success" });
      return raw;
    } catch (rawErr) {
      const latencyMs = Date.now() - started;
      const aiErr = classifyThrownError(candidate.providerId, rawErr);
      lastErr = aiErr;
      recordAiFailure(candidate.healthKey, aiErr);
      logAiAttempt({
        provider: candidate.providerId,
        model: candidate.modelId,
        key: candidate.keyId,
        inPlaceAttempt,
        latencyMs,
        status: "failure",
        category: aiErr.category,
        statusCode: aiErr.statusCode,
      });
      const canRetryInPlace = inPlaceAttempt === 0 && AI_RETRY_IN_PLACE.has(aiErr.category);
      if (canRetryInPlace) {
        const backoff = aiErr.retryAfterMs || backoffWithJitter(inPlaceAttempt, AI_INPLACE_BACKOFF_BASE_MS);
        await sleep(Math.min(backoff, 5_000)); // never block a pupil's submission on a provider's full Retry-After if it's minutes long - the next candidate will pick it up instead
        continue;
      }
      throw aiErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// Server-side guarantee that the "stronger version" panel is never strictly
// worse than what the pupil wrote. LLMs - especially the weaker fallback
// models in the chain - don't reliably obey length instructions, so the
// prompt's length rule is enforced here rather than trusted:
//
//   1. If the rewrite already meets the target, use it (the common case,
//      no extra API call at all).
//   2. If not, fire ONE extra call back to the SAME provider/key that just
//      answered, telling it exactly how short it came up. Only the
//      modelAnswer from that call is adopted - the scores from the first,
//      already-normalized response are kept, so a retry can't shuffle a
//      pupil's marks around.
//   3. If the retry is still short (or fails), suppress the panel entirely
//      by returning an empty modelAnswer. The frontend already renders
//      nothing for an empty string, so this needs no UI change.
//
// Because step 2 only fires in the minority of cases where the prompt alone
// wasn't enough, this adds very little extra load on the rate-limited free
// tiers.
async function ensureStrongerModelAnswer(result, attempt, makePrompts, pupilWords, targetWords, normalize) {
  normalize = normalize || normalizeAiResult;
  if (!targetWords) return result; // pupil wrote (near) nothing - no comparison to make
  if (!result.modelAnswer) return result; // nothing returned; panel is already hidden
  if (countWords(result.modelAnswer) >= targetWords) return result;

  const firstWords = countWords(result.modelAnswer);
  try {
    await sleep(AI_ATTEMPT_PAUSE_MS);
    const retryPrompts = makePrompts(attempt.vision, { modelWords: firstWords, pupilWords, targetWords });
    const raw = await attempt.run(retryPrompts);
    const retried = normalize(raw, attempt.markedBy || attempt.name);
    if (retried.modelAnswer && countWords(retried.modelAnswer) >= targetWords) {
      return { ...result, modelAnswer: retried.modelAnswer };
    }
    // Retry produced something, but still not longer/more detailed than the
    // pupil's own answer - fall through to suppression rather than show it.
  } catch (e) {
    // Retry call failed outright (rate limit, bad JSON, network) - the
    // pupil's marks and feedback from the first response are unaffected.
  }
  return { ...result, modelAnswer: "" };
}

// Shared provider-chain runner for BOTH marking units. A "plan" says what is
// different about the unit being marked (which rubric config key, whether the
// picture is sent, how to build/normalize prompts, what the offline fallback
// is); everything about HOW the chain is walked (candidate order, health,
// cooldowns, passes, the stronger-model-answer length guard) is identical, so
// Unit 1 behaves exactly as it did in v7.4.
async function runAiMarking(env, topic, plan) {
  const storedRubric = plan.rubricOverride ? null : await getConfig(env, plan.rubricKey);
  const rubricText = (plan.rubricOverride && plan.rubricOverride.trim()) || (storedRubric && storedRubric.trim()) || plan.defaultRubric;
  const storedGroqModel = await getConfig(env, "model_groq");
  const groqModel = (storedGroqModel && storedGroqModel.trim()) || DEFAULT_GROQ_MODEL;
  const storedOpenRouterModel = await getConfig(env, "model_openrouter");
  // Defense in depth: even though POST /api/teacher/model-openrouter already
  // rejects non-free models, re-validate here at call time too - if the
  // config table ever ends up with a non-free value some other way (e.g.
  // edited directly in D1), silently fall back to the safe free default
  // rather than ever actually calling a paid model.
  const candidateOpenRouterModel = (storedOpenRouterModel && storedOpenRouterModel.trim()) || DEFAULT_OPENROUTER_MODEL;
  const openRouterModel = isFreeOpenRouterModel(candidateOpenRouterModel) ? candidateOpenRouterModel : DEFAULT_OPENROUTER_MODEL;

  const fillerStats = countFillers(plan.combinedText);
  const imageDescription = (topic && topic.imageDescription) || "";

  // Only Gemini is vision-capable. Fetch the picture once up front whenever
  // either Gemini key is configured AND this unit actually refers to the
  // picture (Unit 1 only) - every other provider (Groq, Workers AI,
  // OpenRouter) uses the text-only prompt with the teacher's
  // imageDescription instead.
  let image = null;
  if (plan.useImage && (env.GEMINI_API_KEY || env.GEMINI_API_KEY_2) && topic && topic.imageUrl) {
    image = await fetchImageAsBase64(topic.imageUrl);
  }
  // Length target for the "stronger version" shown to the pupil, derived
  // from what the pupil actually wrote rather than a fixed word count.
  const pupilWords = countWords(plan.pupilAnswer);
  const targetWords = modelAnswerTargetWords(pupilWords, plan.ceilingWords);

  // Prompts are rebuilt on demand rather than computed once, because the
  // one-time "your rewrite was too short" regenerate needs the same prompt
  // plus a retry instruction - see ensureStrongerModelAnswer.
  const makePrompts = (useVision, lengthRetry) =>
    plan.buildPrompts(rubricText, {
      imageAttached: useVision && !!image,
      imageDescription,
      fillerStats,
      pupilWords,
      targetWords,
      lengthRetry,
    });
  const visionPrompts = makePrompts(true, null);
  const textOnlyPrompts = image ? makePrompts(false, null) : visionPrompts;
  const promptsFor = (candidate) => (candidate.capabilities.vision ? visionPrompts : textOnlyPrompts);

  const candidates = buildAiCandidates(env, groqModel, openRouterModel, image);
  const startedAt = Date.now();
  const timeIsUp = () => Date.now() - startedAt > AI_MAX_TOTAL_MS;

  let preferLargeContext = false; // flips on after a CONTEXT_TOO_LONG, for the rest of this pass
  for (let pass = 1; pass <= AI_MARKING_MAX_PASSES; pass++) {
    if (timeIsUp()) break; // don't even start another pass once the wall-clock budget for this unit is spent
    const ordered = orderCandidatesForPass(candidates, preferLargeContext);
    for (let i = 0; i < ordered.length; i++) {
      if (timeIsUp()) break;
      const candidate = ordered[i];
      try {
        const raw = await runProviderAttempt(candidate, promptsFor(candidate));
        const result = plan.normalize(raw, candidate.providerId);
        const attempt = { name: candidate.providerId, vision: candidate.capabilities.vision, run: (p) => runProviderAttempt(candidate, p) };
        return await ensureStrongerModelAnswer(result, attempt, makePrompts, pupilWords, targetWords, plan.normalize);
      } catch (aiErr) {
        if (aiErr && aiErr.category === AI_ERROR.CONTEXT_TOO_LONG) preferLargeContext = true;
        // this candidate failed - pause briefly (spreads out load on
        // whichever candidate is next) then try the next one. Cooldowns
        // (recorded inside runProviderAttempt) are what actually keeps a
        // repeatedly-failing candidate out of the way, not this pause.
        if (i < ordered.length - 1) await sleep(AI_ATTEMPT_PAUSE_MS);
      }
    }
    // Every candidate in this pass failed. If this wasn't the last allowed
    // pass, wait longer (transient rate-limits are the most likely cause)
    // and run through the candidate list again before giving up - a
    // candidate that was cooling down at the start of pass 1 may well have
    // cleared its cooldown by the time pass 2 starts.
    if (pass < AI_MARKING_MAX_PASSES && !timeIsUp()) await sleep(AI_PASS_RETRY_PAUSE_MS);
  }

  return { ...plan.fallback(fillerStats), markedBy: "fallback" };
}

// Unit 1: Question 1 alone - full TREES (T/R/E1/E2/S) against the picture +
// Language Use on Q1's own text. Max 25. Unchanged from v7.4.
async function aiScore(env, topic, question, mode, data, opts) {
  return runAiMarking(env, topic, {
    rubricOverride: opts && opts.rubricOverride,
    rubricKey: "rubric",
    defaultRubric: DEFAULT_RUBRIC,
    useImage: true,
    combinedText: combinedAnswerText(mode, data),
    pupilAnswer: pupilAnswerForModelAnswer(mode, data),
    ceilingWords: MODEL_ANSWER_CEILING_WORDS,
    buildPrompts: (rubricText, o) => buildPrompts(topic, question, mode, data, rubricText, o),
    normalize: normalizeAiResult,
    fallback: (fillerStats) => ruleBasedScore(mode, data, topic, fillerStats),
  });
}

// Unit 2: Questions 2 + 3 together - ONE AI call that sees both questions and
// both answers. Experience 16 + Suggestion 2 + Language 7 = 25. No picture.
async function aiScoreUnit2(env, topic, questions, mode, answers, opts) {
  const list = Array.isArray(answers) ? answers : [];
  return runAiMarking(env, topic, {
    rubricOverride: opts && opts.rubricOverride,
    rubricKey: "rubric_q2q3",
    defaultRubric: DEFAULT_RUBRIC_Q2Q3,
    useImage: false,
    combinedText: list.map((a) => combinedAnswerText(mode, a)).join(" "),
    pupilAnswer: pupilAnswerForModelAnswerUnit2(mode, list),
    ceilingWords: UNIT2_MODEL_ANSWER_CEILING_WORDS,
    buildPrompts: (rubricText, o) => buildPromptsUnit2(topic, questions, mode, list, rubricText, o),
    normalize: normalizeAiResultUnit2,
    fallback: (fillerStats) => ruleBasedScoreUnit2(mode, list, topic, fillerStats),
  });
}


// ---------- Submissions: scope + filter + sort (D1) ----------
// Shared by GET /api/teacher/submissions and the CSV export, so both honour
// the same class/topic/archived scoping and the same sort order - expressed
// as real SQL now instead of a full KV scan + in-memory filter/sort. A
// scoped teacher-admin's WHERE clause is built from their assignedClasses,
// so out-of-scope rows are never even read out of D1.
function rowToSubmission(row) {
  return {
    id: row.id,
    pupilName: row.pupil_name,
    pupilClass: row.pupil_class,
    topicId: row.topic_id,
    topicTitle: row.topic_title,
    mode: row.mode,
    rounds: JSON.parse(row.rounds || "[]"),
    finalScore: row.final_score,
    maxScore: row.max_score,
    flagged: !!row.flagged,
    practice: !!row.practice,
    gradingDegraded: !!row.grading_degraded,
    repeatedIdeasPenalty: !!row.repeated_ideas_penalty,
    archived: !!row.archived,
    retryOf: row.retry_of || null,
    leaderboardCounted: !!row.leaderboard_counted,
    createdAt: row.created_at,
  };
}

// coachUsed (whether a pupil opened the NPC Coach on a question) is
// deliberately tracked for the teacher's own view but never disclosed to
// pupils - see the comment on pupilRecord in the submit handler. Any
// endpoint that can return a submission to a pupil (their own, or someone
// else's via the public leaderboard-submissions list) must strip it the
// same way, whether or not the pupil in question is the one being viewed.
function stripCoachUsedForPupil(submission) {
  return {
    ...submission,
    rounds: submission.rounds.map((r) => {
      const { coachUsed, coachUsedQuestions, ...rest } = r;
      return rest;
    }),
  };
}

// v7.5: the per-unit score breakdown is for TEACHERS. A pupil only ever gets
// the overall average (finalScore / maxScore) plus the written feedback,
// suggestion and "stronger version" for each unit - never the per-unit score,
// the per-criterion points/notes, or who adjusted what. Done server-side (not
// just hidden in the UI) for the same reason coachUsed is: the pupil-facing
// endpoints also serve OTHER pupils' submissions via the leaderboard list, so
// anything left in the JSON is effectively public to the class. `overridden`
// stays as a bare yes/no so the "Score adjusted" tag can still show; who/when/
// the pre-override score are teacher-only. Applies to every pupil-facing
// payload: POST /api/submit, /api/submissions/mine, /api/submissions/leaderboard
// and the pupil's own /remark response. Pre-v7.5 (3-round) submissions are
// redacted the same way.
function redactForPupil(submission) {
  const base = stripCoachUsedForPupil(submission);
  return {
    ...base,
    rounds: base.rounds.map((r) => {
      const { score, max, breakdown, originalScore, overriddenBy, overriddenAt, ...rest } = r;
      return rest;
    }),
  };
}

// v7.6 - class insights, from stored rounds only. v7.5+ rows split cleanly by
// unit tag; pre-v7.5 (3-round, untagged) rows are counted in the overall
// average but kept out of the per-unit tables so the two schemes never blur.
function computeAnalytics(rows) {
  const units = { q1: { n: 0, sum: 0, parts: {}, order: [] }, q2q3: { n: 0, sum: 0, parts: {}, order: [] } };
  const classes = {};
  let n = 0;
  let sumFinal = 0;
  let legacy = 0;
  for (const row of rows) {
    let rounds;
    try {
      rounds = JSON.parse(row.rounds || "[]");
    } catch (e) {
      continue;
    }
    n++;
    sumFinal += row.final_score || 0;
    const cls = row.pupil_class || "unassigned";
    if (!classes[cls]) classes[cls] = { pupilClass: cls, n: 0, sum: 0 };
    classes[cls].n++;
    classes[cls].sum += row.final_score || 0;
    const tagged = rounds.length === 2 && rounds.some((r) => r && r.unit);
    if (!tagged) {
      legacy++;
      continue;
    }
    for (const r of rounds) {
      const u = units[roundUnit(r)];
      u.n++;
      u.sum += r.score || 0;
      for (const b of r.breakdown || []) {
        if (!u.parts[b.part]) {
          u.parts[b.part] = { points: 0, max: 0, n: 0 };
          u.order.push(b.part);
        }
        u.parts[b.part].points += b.points;
        u.parts[b.part].max += b.max;
        u.parts[b.part].n++;
      }
    }
  }
  const unitOut = (key) => {
    const u = units[key];
    const criteria = u.order.map((part) => {
      const c = u.parts[part];
      return { part, avg: Math.round((c.points / c.n) * 10) / 10, max: Math.round((c.max / c.n) * 10) / 10, pct: c.max > 0 ? Math.round((c.points / c.max) * 100) : 0 };
    });
    return { n: u.n, avgScore: u.n ? Math.round((u.sum / u.n) * 10) / 10 : 0, criteria };
  };
  const q1 = unitOut("q1");
  const q2q3 = unitOut("q2q3");
  const focus = [...q1.criteria.map((c) => ({ unit: "q1", ...c })), ...q2q3.criteria.map((c) => ({ unit: "q2q3", ...c }))]
    .sort((a, b) => a.pct - b.pct)
    .slice(0, 3);
  return {
    submissions: n,
    legacySubmissions: legacy,
    avgFinal: n ? Math.round((sumFinal / n) * 10) / 10 : 0,
    q1,
    q2q3,
    focus,
    byClass: Object.values(classes)
      .map((c) => ({ pupilClass: c.pupilClass, n: c.n, avgFinal: Math.round((c.sum / c.n) * 10) / 10 }))
      .sort((a, b) => a.pupilClass.localeCompare(b.pupilClass)),
  };
}

function buildSubmissionsFilter(session, url) {
  const classParam = (url.searchParams.get("class") || "").trim();
  const topicParam = (url.searchParams.get("topic") || "").trim();
  const archivedParam = (url.searchParams.get("archived") || "active").trim().toLowerCase(); // active|archived|all
  const sortParam = (url.searchParams.get("sort") || "newest").trim().toLowerCase();

  const where = [];
  const params = [];

  if (!session.isSuperAdmin) {
    const classes = (session.assignedClasses || []).map((c) => String(c).toLowerCase());
    if (!classes.length) {
      where.push("1 = 0"); // no assigned classes -> sees nothing, rather than accidentally matching everything
    } else {
      where.push(`LOWER(pupil_class) IN (${classes.map(() => "?").join(",")})`);
      params.push(...classes);
    }
  }
  if (classParam) {
    where.push("LOWER(pupil_class) = LOWER(?)");
    params.push(classParam);
  }
  if (topicParam) {
    where.push("LOWER(topic_title) = LOWER(?)");
    params.push(topicParam);
  }
  if (archivedParam === "archived") where.push("archived = 1");
  else if (archivedParam !== "all") where.push("archived = 0"); // default "active"

  const sortMap = {
    newest: "created_at DESC",
    oldest: "created_at ASC",
    class: "pupil_class ASC, pupil_name ASC, created_at DESC",
    topic: "topic_title ASC, created_at DESC",
    score_desc: "final_score DESC, created_at DESC",
    score_asc: "final_score ASC, created_at DESC",
  };
  const orderBy = sortMap[sortParam] || sortMap.newest;
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  return { whereSql, params, orderBy };
}

async function countFilteredSubmissions(env, session, url) {
  const { whereSql, params } = buildSubmissionsFilter(session, url);
  const row = await env.CCv6_DB.prepare(`SELECT COUNT(*) as c FROM submissions ${whereSql}`).bind(...params).first();
  return row ? row.c : 0;
}

// opts.limit/opts.offset are optional - omit for the full filtered set (used
// by CSV export), provide for one page (used by the Submissions tab).
async function queryFilteredSubmissions(env, session, url, opts) {
  const { whereSql, params, orderBy } = buildSubmissionsFilter(session, url);
  let sql = `SELECT * FROM submissions ${whereSql} ORDER BY ${orderBy}`;
  const bindParams = params.slice();
  if (opts && Number.isFinite(opts.limit)) {
    sql += " LIMIT ? OFFSET ?";
    bindParams.push(opts.limit, opts.offset || 0);
  }
  const { results } = await env.CCv6_DB.prepare(sql).bind(...bindParams).all();
  return results.map(rowToSubmission);
}

// ---------- AI re-mark (submissions whose grading fell back to offline) ----------
// Shared by POST /api/submissions/:id/remark for both a pupil re-marking
// their own submission and a teacher re-marking any submission in scope.
// Only ever touches the ONE round being re-marked - marking is still done
// one question at a time, same as at original submission time, so a
// re-mark can't suddenly burst 3 simultaneous requests at a provider that
// may have JUST recovered from an outage.
async function remarkSubmissionRound(env, row, roundIndex) {
  const rounds = JSON.parse(row.rounds || "[]");
  const target = rounds[roundIndex];
  if (!target) return { ok: false, error: "That question doesn't exist on this submission." };
  if (target.markedBy !== "fallback") {
    // Not an error - the button simply shouldn't be shown once a round is
    // already AI-marked, but if two teacher tabs race on the same click,
    // the second one lands here and should look like a no-op, not a failure.
    return { ok: true, alreadyMarked: true, submission: rowToSubmission(row) };
  }

  // The topic may have been edited or deleted since the original
  // submission - fall back to a minimal stand-in built from what's already
  // stored on the submission itself (title, question text) so re-marking
  // still works using the rubric alone, just without the picture.
  const topicRow = await env.CCv6_DB.prepare("SELECT * FROM topics WHERE id = ?").bind(row.topic_id).first();
  const topic = topicRow
    ? { id: topicRow.id, title: topicRow.title, imageUrl: topicRow.image_url, imageDescription: topicRow.image_description }
    : { id: row.topic_id, title: row.topic_title, imageUrl: "", imageDescription: "" };

  // The stored answer is already vulgarity-masked from submission time -
  // nothing further to clean before sending it back through aiScore.
  // Re-mark exactly the unit that fell back: Unit 2 (Q2+Q3) goes back through
  // the single combined call; Unit 1 - and every round of a pre-v7.5
  // submission, each of which was a full-TREES single-question round - goes
  // back through the per-question call, exactly as before.
  const result =
    roundUnit(target) === UNIT_Q2Q3
      ? await aiScoreUnit2(env, topic, target.questions || [], row.mode, target.answers || [])
      : await aiScore(env, topic, target.question, row.mode, target.answer);

  if (result.markedBy === "fallback") {
    return { ok: true, success: false, submission: rowToSubmission(row), message: "AI marking is still unavailable for this question - please try again in a few minutes." };
  }

  rounds[roundIndex] = {
    ...target,
    score: result.total,
    max: result.max,
    breakdown: result.breakdown,
    feedback: result.feedback,
    suggestion: result.suggestion,
    strengths: result.strengths || "",
    nextStep: result.nextStep || "",
    modelAnswer: result.modelAnswer || "",
    markedBy: result.markedBy,
  };

  const stillDegraded = rounds.some((r) => r.markedBy === "fallback");
  const scoreSum = rounds.reduce((sum, r) => sum + (r.score || 0), 0);
  const finalScoreRaw = Math.round((scoreSum / rounds.length) * 10) / 10; // 2 units (v7.5) or 3 questions (older submissions)
  // The repeated-ideas penalty (if any) was decided from the pupil's answer
  // text at submission time, which a re-mark never changes - so if it
  // applied before, it keeps applying at the same fixed amount now.
  const finalScore = row.repeated_ideas_penalty ? Math.max(0, Math.round((finalScoreRaw - REPEATED_IDEAS_PENALTY) * 10) / 10) : finalScoreRaw;

  await env.CCv6_DB
    .prepare("UPDATE submissions SET rounds = ?, final_score = ?, grading_degraded = ? WHERE id = ?")
    .bind(JSON.stringify(rounds), finalScore, stillDegraded ? 1 : 0, row.id)
    .run();

  let addedToLeaderboard = false;
  // Only the moment EVERY unit is finally AI-marked - and only
  // for a non-practice attempt that hasn't already been counted - actually
  // updates the leaderboard. A practice submission gets its score/markedBy
  // corrected here but never joins the leaderboard, matching the rule at
  // original submission time.
  if (!stillDegraded && !row.practice && !row.leaderboard_counted) {
    await env.CCv6_DB.prepare("UPDATE submissions SET leaderboard_counted = 1 WHERE id = ?").bind(row.id).run();
    const pupilId = await recomputePupilAggregate(env, row.pupil_name, row.pupil_class);
    await pushPupilHistory(env, pupilId, {
      timestamp: Date.now(),
      topicId: row.topic_id,
      topicTitle: row.topic_title,
      finalScore,
      maxScore: row.max_score,
      breakdown: averageRoundBreakdown(rounds),
    });
    addedToLeaderboard = true;
  }


  const updatedRow = { ...row, rounds: JSON.stringify(rounds), final_score: finalScore, grading_degraded: stillDegraded ? 1 : 0, leaderboard_counted: addedToLeaderboard ? 1 : row.leaderboard_counted };
  return { ok: true, success: true, addedToLeaderboard, submission: rowToSubmission(updatedRow) };
}

// ---------- Teacher score override ----------
// Lets a teacher directly set a question's score (and optionally its
// feedback) - most useful for a question AI never marked (still
// "fallback") when the teacher would rather grade it themselves right now
// than wait for AI to recover, but works equally on an already AI-marked
// question a teacher disagrees with.
//
// Deliberately does NOT touch markedBy, gradingDegraded, or
// leaderboard_counted: whether a question was ever actually assessed BY AI
// stays a separate, honest fact from whatever score is currently showing.
// This matters because peer-visibility (GET /api/submissions/leaderboard)
// and leaderboard placement both key off leaderboard_counted, which in
// turn requires every question's markedBy to be a real AI provider, not
// "fallback" - a teacher override alone can never make a submission that
// wasn't fully AI-marked show up in a classmate's "On the Leaderboard"
// list or count toward that pupil's leaderboard totals. If the teacher
// wants THAT, the question still needs an actual AI re-mark (or AI
// providers need to be back up) - overriding just corrects what's shown to
// the pupil and the teacher's own gradebook/CSV export in the meantime.
//
// The one exception: if the submission was ALREADY on the leaderboard
// (every question was already AI-marked, non-practice) before this
// override, the pupil's aggregate is recomputed immediately so a teacher
// correcting an AI's score doesn't leave stale totals sitting around.
async function overrideSubmissionRoundScore(env, row, roundIndex, newScore, newFeedback, teacherName) {
  const rounds = JSON.parse(row.rounds || "[]");
  const target = rounds[roundIndex];
  if (!target) return { ok: false, error: "That question doesn't exist on this submission." };
  if (!Number.isFinite(newScore) || newScore < 0 || newScore > target.max) {
    return { ok: false, error: `Score must be a number between 0 and ${target.max}.` };
  }

  rounds[roundIndex] = {
    ...target,
    score: newScore,
    feedback: typeof newFeedback === "string" && newFeedback.trim() ? newFeedback.trim().slice(0, 1000) : target.feedback,
    overridden: true,
    overriddenBy: teacherName,
    overriddenAt: Date.now(),
    // Keep the FIRST pre-override value across repeated overrides, so the
    // original AI/offline score is never lost even after several corrections.
    originalScore: typeof target.originalScore === "number" ? target.originalScore : target.score,
  };

  const scoreSum = rounds.reduce((sum, r) => sum + (r.score || 0), 0);
  const finalScoreRaw = Math.round((scoreSum / rounds.length) * 10) / 10;
  const finalScore = row.repeated_ideas_penalty ? Math.max(0, Math.round((finalScoreRaw - REPEATED_IDEAS_PENALTY) * 10) / 10) : finalScoreRaw;

  await env.CCv6_DB.prepare("UPDATE submissions SET rounds = ?, final_score = ? WHERE id = ?").bind(JSON.stringify(rounds), finalScore, row.id).run();

  let pupilAggregateUpdated = false;
  if (row.leaderboard_counted) {
    await recomputePupilAggregate(env, row.pupil_name, row.pupil_class);
    pupilAggregateUpdated = true;
  }

  const updatedRow = { ...row, rounds: JSON.stringify(rounds), final_score: finalScore };
  return { ok: true, pupilAggregateUpdated, submission: rowToSubmission(updatedRow) };
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type,authorization",
          "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        },
      });
    }

    await ensureSeeded(env);

    if (pathname === "/" || pathname === "/index.html") {
      return new Response(PAGE_HTML, { headers: { "content-type": "text/html;charset=UTF-8" } });
    }

    if (!pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    try {
      // ---------- AUTH ----------
      if (pathname === "/api/login" && request.method === "POST") {
        const body = await request.json();
        let raw = (body.name || "").trim();
        if (!raw) return badRequest("Please enter a name.");
        if (raw.length > 60) raw = raw.slice(0, 60);

        // Optional "Name@Class" syntax, e.g. "Jovan@5IG" -> name "Jovan",
        // class "5IG". This is how pupils are tracked and grouped for the
        // teacher's per-pupil history/progress view - see /api/teacher/pupils.
        let name = raw;
        let pupilClass = "";
        const atIdx = raw.indexOf("@");
        if (atIdx > 0 && atIdx < raw.length - 1) {
          name = raw.slice(0, atIdx).trim();
          pupilClass = raw.slice(atIdx + 1).trim();
        }
        if (name.length > 40) name = name.slice(0, 40);
        if (pupilClass.length > 20) pupilClass = pupilClass.slice(0, 20);
        name = scanVulgarity(name).clean;
        pupilClass = scanVulgarity(pupilClass).clean;
        // Keep class names to a safe, predictable charset rather than
        // letting arbitrary punctuation in.
        pupilClass = pupilClass.replace(/[^a-zA-Z0-9 _-]/g, "").trim();

        if (!name) return badRequest("Please enter a name.");
        const lname = name.toLowerCase();
        if (lname === TEACHER_USERNAME || (await getTeacherAdmin(env, lname))) {
          // Teacher / teacher-admin path requires a password on a second step;
          // issue a "pending" marker only, echoing back which username to use
          // in that second step (so a scoped teacher-admin's own username
          // round-trips through the login form correctly).
          return json({ requiresTeacherPassword: true, username: lname });
        }

        const pupilClassKey = pupilClass || "unassigned";
        const token = uid();
        await env.CCv6_DATA.put(
          `session:${token}`,
          JSON.stringify({ name, pupilClass: pupilClassKey, role: "pupil", createdAt: Date.now() }),
          { expirationTtl: 60 * 60 * 6 }
        );
        return json({ token, name, pupilClass: pupilClassKey, role: "pupil" });
      }

      if (pathname === "/api/teacher/login" && request.method === "POST") {
        const body = await request.json();
        const username = (body.username || "").trim().toLowerCase();
        const password = body.password || "";

        let name, isSuperAdmin, assignedClasses;
        if (username === TEACHER_USERNAME) {
          const verdict = await verifyTeacherPassword(env, password);
          if (verdict.unset) {
            return json(
              { error: "No teacher password has been set up yet. Ask an admin to run: wrangler d1 execute chitchat-v7 --remote --command=\"INSERT INTO config (key,value) VALUES ('teacher_password','yourPassword')\" (or use the Cloudflare dashboard's D1 console)" },
              500
            );
          }
          if (!verdict.ok) return json({ error: "Incorrect password." }, 403);
          name = "Teacher";
          isSuperAdmin = true;
          assignedClasses = null;
        } else {
          const record = await getTeacherAdmin(env, username);
          if (!record) return json({ error: "Not authorised." }, 403);
          const ok = await verifyTeacherAdminPassword(record, password);
          if (!ok) return json({ error: "Incorrect password." }, 403);
          name = record.username;
          isSuperAdmin = false;
          assignedClasses = record.classes || [];
        }

        const token = uid();
        await env.CCv6_DATA.put(
          `session:${token}`,
          JSON.stringify({ name, role: "teacher", isSuperAdmin, assignedClasses, createdAt: Date.now() }),
          { expirationTtl: 60 * 60 * 6 }
        );
        return json({ token, name, role: "teacher", isSuperAdmin, assignedClasses });
      }

      // ---------- TOPICS ----------
      if (pathname === "/api/topics" && request.method === "GET") {
        const { results } = await env.CCv6_DB.prepare("SELECT * FROM topics ORDER BY created_at ASC, rowid ASC").all();
        return json({ topics: results.map(rowToTopic) });
      }

      // ---------- SUBMIT ----------
      if (pathname === "/api/submit" && request.method === "POST") {
        const session = await getSession(request, env);
        if (!session || session.role !== "pupil") return json({ error: "Please log in first." }, 401);

        const body = await request.json();
        const { topicId, answers } = body;
        // Which questions the pupil opened the NPC Coach for, before
        // submitting (see /api/topics coach content). This is recorded for
        // the teacher but deliberately never told to the pupil - see
        // requireTeacher-gated endpoints for where it's surfaced.
        const coachUsedIn = Array.isArray(body.coachUsed) ? body.coachUsed : [];
        const mode = body.mode === "single" ? "single" : "trees";
        const practice = !!body.practice;
        if (!topicId || !Array.isArray(answers) || answers.length !== 3) {
          return badRequest("Expected a topic and exactly 3 answers.");
        }

        // ---- "Try Again" resubmission ----
        // Validated BEFORE any AI marking runs, so a rejected retry never
        // burns provider calls. A retry is stored as its own submission row
        // (marked, scored and leaderboarded exactly like a fresh attempt) and
        // only linked back to the original through retry_of.
        const pupilClassForRetry = session.pupilClass || "unassigned";
        const retryPolicy = await getRetryPolicy(env);
        const retryEnabled = isRetryEnabledForClass(retryPolicy, pupilClassForRetry);
        const retryOfRaw = typeof body.retryOf === "string" ? body.retryOf.trim() : "";
        let retryOf = null;
        if (retryOfRaw) {
          if (!retryEnabled) return badRequest("Try Again isn't switched on for your class right now.");
          const orig = await env.CCv6_DB
            .prepare("SELECT id, pupil_name, pupil_class, topic_id, retry_of, created_at FROM submissions WHERE id = ?")
            .bind(retryOfRaw)
            .first();
          if (!orig) return badRequest("That first attempt could not be found.");
          // A pupil may only retry their OWN attempt - never someone else's,
          // even if they somehow learn its id.
          if (orig.pupil_name !== session.name || normalizeClassKey(orig.pupil_class) !== normalizeClassKey(pupilClassForRetry)) {
            return json({ error: "That attempt doesn't belong to you." }, 403);
          }
          // One retry per attempt: neither a retry of a retry...
          if (orig.retry_of) return badRequest("You've already had your second try at this one.");
          if (orig.topic_id !== topicId) return badRequest("A second try has to be on the same topic as the first.");
          // Same session only - nothing to re-fetch, and it keeps "Try Again"
          // an in-the-moment revision rather than a way to farm old attempts.
          // session.createdAt is set when the pupil logs in (see /api/login).
          if (session.createdAt && orig.created_at < session.createdAt) {
            return badRequest("You can only try again during the same session as your first attempt.");
          }
          // ...nor a second retry of the same original. (Also enforced by the
          // UNIQUE index on retry_of, which catches simultaneous resubmits.)
          const existingRetry = await env.CCv6_DB.prepare("SELECT id FROM submissions WHERE retry_of = ?").bind(orig.id).first();
          if (existingRetry) return badRequest("You've already had your second try at this one.");
          retryOf = orig.id;
        }

        const topicRow = await env.CCv6_DB.prepare("SELECT * FROM topics WHERE id = ?").bind(topicId).first();
        const topic = topicRow ? rowToTopic(topicRow) : null;
        const questions = (topic && topic.questions) || [];

        // Prepare the cleaned input for all 3 questions first (vulgarity
        // scanning is synchronous). The pupil still answers 3 questions, but
        // since v7.5 they are MARKED as 2 units: Question 1 on its own
        // (full TREES against the picture), and Questions 2 + 3 together as
        // one extended personal-narrative response - see aiScore /
        // aiScoreUnit2.
        const roundInputs = [];
        let anyFlagTotal = false;
        for (let i = 0; i < 3; i++) {
          const question = questions[i] || "Tell me about this topic.";
          const rawAnswer = answers[i] || {};
          let cleanedData, anyFlag, answerForRecord;

          if (mode === "single") {
            const scanResult = scanVulgarity(rawAnswer.text || "");
            cleanedData = { text: scanResult.clean };
            anyFlag = scanResult.flagged;
            answerForRecord = { text: scanResult.clean };
          } else {
            const scanResult = scanAllParts(rawAnswer.parts || {});
            cleanedData = { parts: scanResult.cleaned };
            anyFlag = scanResult.anyFlag;
            answerForRecord = { parts: scanResult.cleaned };
          }
          if (anyFlag) anyFlagTotal = true;
          roundInputs.push({ question, cleanedData, anyFlag, answerForRecord });
        }

        // Mark the two units one at a time (not Promise.all) - concurrent
        // calls mean simultaneous requests hitting the same provider/key,
        // which is exactly what tends to trigger rate limits. A short pause
        // between units spaces the load out further still. See
        // runAiMarking for the per-unit retry logic that adds further
        // resilience against transient rate-limits.
        const unit1Result = await aiScore(env, topic, roundInputs[0].question, mode, roundInputs[0].cleanedData);
        await sleep(AI_ATTEMPT_PAUSE_MS);
        const unit2Result = await aiScoreUnit2(
          env,
          topic,
          [roundInputs[1].question, roundInputs[2].question],
          mode,
          [roundInputs[1].cleanedData, roundInputs[2].cleanedData]
        );

        const rounds = [
          {
            unit: UNIT_Q1,
            question: roundInputs[0].question,
            mode,
            answer: roundInputs[0].answerForRecord,
            score: unit1Result.total,
            max: unit1Result.max,
            breakdown: unit1Result.breakdown,
            feedback: unit1Result.feedback,
            suggestion: unit1Result.suggestion,
            strengths: unit1Result.strengths || "",
            nextStep: unit1Result.nextStep || "",
            modelAnswer: unit1Result.modelAnswer || "",
            flagged: roundInputs[0].anyFlag,
            markedBy: unit1Result.markedBy,
            // teacher-only - stripped out of the response sent back to the
            // pupil below, and never mentioned in the pupil-facing UI
            coachUsed: !!coachUsedIn[0],
          },
          {
            unit: UNIT_Q2Q3,
            questions: [roundInputs[1].question, roundInputs[2].question],
            // Display fallback for anything that still reads a single
            // `question` string off a round (CSV, older views).
            question: `Q2: ${roundInputs[1].question} | Q3: ${roundInputs[2].question}`,
            mode,
            answers: [roundInputs[1].answerForRecord, roundInputs[2].answerForRecord],
            score: unit2Result.total,
            max: unit2Result.max,
            breakdown: unit2Result.breakdown,
            feedback: unit2Result.feedback,
            suggestion: unit2Result.suggestion,
            strengths: unit2Result.strengths || "",
            nextStep: unit2Result.nextStep || "",
            modelAnswer: unit2Result.modelAnswer || "",
            flagged: roundInputs[1].anyFlag || roundInputs[2].anyFlag,
            markedBy: unit2Result.markedBy,
            coachUsed: !!(coachUsedIn[1] || coachUsedIn[2]),
            coachUsedQuestions: [!!coachUsedIn[1], !!coachUsedIn[2]],
          },
        ];
        const scoreSum = rounds.reduce((sum, r) => sum + r.score, 0);
        const anyFallback = rounds.some((r) => r.markedBy === "fallback");

        const finalScoreRaw = Math.round((scoreSum / rounds.length) * 10) / 10; // average of the two unit scores, 1 decimal place
        // The repeated-ideas check still compares the pupil's three ANSWERS
        // (it is about the pupil reusing one story, not about how marking is
        // grouped). Q2 and Q3 overlapping is expected now - they are one
        // story - so in practice this only fires when Q1 ALSO reuses it.
        const repeatedIdeas = detectRepeatedIdeas(roundInputs.map((ri) => extractRoundText(ri.answerForRecord)));
        const finalScore = repeatedIdeas ? Math.max(0, Math.round((finalScoreRaw - REPEATED_IDEAS_PENALTY) * 10) / 10) : finalScoreRaw;

        const id = uid();
        const pupilClass = session.pupilClass || "unassigned";
        const record = {
          id,
          pupilName: session.name,
          pupilClass,
          topicId,
          topicTitle: topic ? topic.title : "Unknown",
          mode,
          rounds,
          finalScore,
          maxScore: FULL_MAX_TOTAL,
          flagged: anyFlagTotal,
          practice,
          // true when at least one of the 2 marking units fell all the way back
          // to the offline keyword scorer (all AI providers unavailable) -
          // this is much less rigorous than real AI marking, so a
          // non-practice attempt in this state is kept out of the
          // leaderboard rather than silently rewarding a marking outage.
          gradingDegraded: anyFallback,
          repeatedIdeasPenalty: repeatedIdeas,
          archived: false, // v7 bulk archive - Teacher Tools > Submissions
          retryOf, // null unless this is a "Try Again" second attempt
          // Whether this submission is on the leaderboard RIGHT NOW - i.e.
          // whether the INSERT below has already been counted into the
          // pupils table aggregate a few lines down. Starts out matching
          // "not practice and every question was AI-marked"; if one or
          // more questions started out fallback-marked, this stays false
          // until POST /api/submissions/:id/remark clears the last one -
          // see updateSubmissionAfterRemark below.
          leaderboardCounted: !practice && !anyFallback,
          createdAt: Date.now(),
        };
        await env.CCv6_DB
          .prepare(
            `INSERT INTO submissions (id, pupil_name, pupil_class, topic_id, topic_title, mode, rounds, final_score, max_score, practice, grading_degraded, repeated_ideas_penalty, archived, flagged, created_at, retry_of, leaderboard_counted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
          )
          .bind(
            id,
            record.pupilName,
            record.pupilClass,
            record.topicId,
            record.topicTitle,
            record.mode,
            JSON.stringify(record.rounds),
            record.finalScore,
            record.maxScore,
            record.practice ? 1 : 0,
            record.gradingDegraded ? 1 : 0,
            record.repeatedIdeasPenalty ? 1 : 0,
            record.flagged ? 1 : 0,
            record.createdAt,
            record.retryOf,
            record.leaderboardCounted ? 1 : 0
          )
          .run()
          .catch((e) => {
            // The UNIQUE index on retry_of is the last line of defence
            // against two resubmits racing each other (double-tap, two tabs).
            // Report it as the same friendly message as the pre-check rather
            // than a 500.
            if (retryOf && /unique/i.test(String((e && e.message) || ""))) {
              throw new HandledSubmitError("You've already had your second try at this one.");
            }
            throw e;
          });

        const countsForLeaderboard = record.leaderboardCounted;
        if (countsForLeaderboard) {
          // update pupil aggregate (leaderboard) - practice attempts, and
          // attempts marked entirely offline, never count
          const pupilRow = await env.CCv6_DB
            .prepare(
              `INSERT INTO pupils (name, pupil_class, best_score, total_score, attempts)
               VALUES (?, ?, ?, ?, 1)
               ON CONFLICT(name, pupil_class) DO UPDATE SET
                 attempts = attempts + 1,
                 total_score = total_score + ?,
                 best_score = MAX(best_score, ?)
               RETURNING id`
            )
            .bind(session.name, pupilClass, finalScore, finalScore, finalScore, finalScore)
            .first();

          // Progress history - used to compute trend and per-criterion
          // strengths/concerns in Teacher Tools -> Pupils (most recent
          // PUPIL_HISTORY_CAP attempts, see loadPupilHistory). Practice/
          // degraded attempts are excluded for the same reason they don't
          // count toward the leaderboard: they're not a reliable signal of
          // the pupil's actual ability.
          await pushPupilHistory(env, pupilRow.id, {
            timestamp: Date.now(),
            topicId,
            topicTitle: topic ? topic.title : "Unknown",
            finalScore,
            maxScore: FULL_MAX_TOTAL,
            breakdown: averageRoundBreakdown(rounds),
          });
        }

        let warning = null;
        if (anyFlagTotal && anyFallback) {
          warning = "Some words were filtered out, and AI marking wasn't available for at least one part so this attempt won't count on the leaderboard.";
        } else if (anyFlagTotal) {
          warning = "Some words were filtered out. Please keep your answers respectful.";
        } else if (anyFallback) {
          warning = "AI marking wasn't available for at least one part, so this attempt was scored with a simple offline check and won't count on the leaderboard.";
        }
        if (repeatedIdeas) {
          const penaltyNote = `A ${REPEATED_IDEAS_PENALTY}-point penalty was applied because your three answers reused largely the same idea/story - try to use a different example or experience for each question next time.`;
          warning = warning ? `${warning} ${penaltyNote}` : penaltyNote;
        }

        // `record` (with coachUsed per round) is what's stored in KV and
        // shown to the teacher. The pupil only ever sees `pupilRecord`,
        // which has coachUsed stripped out - pupils are not told that
        // opening the NPC Coach is tracked.
        const pupilRecord = redactForPupil(record);
        // retryEnabled tells the pupil's result screen whether to offer a
        // "Try Again" button. canRetry is false on a retry's own result
        // screen - one retry per attempt, so there's no third try.
        return json({ record: pupilRecord, warning, retryEnabled, canRetry: retryEnabled && !retryOf });
      }

      // ---------- LEADERBOARD ----------
      if (pathname === "/api/leaderboard" && request.method === "GET") {
        // Pupil names + scores are only for people who are actually in the
        // class session - this must not be reachable by anyone who just has
        // the .workers.dev URL.
        const session = await getSession(request, env);
        if (!session) return json({ error: "Please log in first." }, 401);

        // A scoped teacher-admin only ever sees pupils in their own assigned
        // classes here, regardless of ?class=. Everyone else (pupils, and
        // palpatine) can optionally narrow with ?class= (used by the Teacher
        // Tools > Leaderboard class filter).
        const where = [];
        const params = [];
        if (session.role === "teacher" && !session.isSuperAdmin) {
          const classes = (session.assignedClasses || []).map((c) => String(c).toLowerCase());
          if (!classes.length) return json({ leaderboard: [] });
          where.push(`LOWER(pupil_class) IN (${classes.map(() => "?").join(",")})`);
          params.push(...classes);
        } else {
          const classParam = (url.searchParams.get("class") || "").trim();
          if (classParam) {
            where.push("LOWER(pupil_class) = LOWER(?)");
            params.push(classParam);
          }
        }
        const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
        const { results } = await env.CCv6_DB
          .prepare(`SELECT * FROM pupils ${whereSql} ORDER BY best_score DESC, total_score DESC LIMIT 50`)
          .bind(...params)
          .all();
        return json({ leaderboard: results.map(rowToPupil) });
      }

      // ---------- Submissions: leaderboard-wide view, own history, and AI re-mark ----------
      // Open to any logged-in session (pupil or teacher), not gated behind
      // requireTeacher - these mirror the existing openness of
      // /api/leaderboard itself (which already shows every pupil's name,
      // class and score to anyone logged in, with no class restriction
      // unless the caller is a class-scoped teacher-admin). Full submission
      // detail (answers, feedback, the model answer) follows the same
      // precedent for anything that's actually ON the leaderboard.
      if (pathname === "/api/submissions/leaderboard" && request.method === "GET") {
        const session = await getSession(request, env);
        if (!session) return json({ error: "Please log in first." }, 401);

        const where = ["leaderboard_counted = 1", "archived = 0"];
        const params = [];
        const classParam = (url.searchParams.get("class") || "").trim();
        if (classParam) {
          where.push("LOWER(pupil_class) = LOWER(?)");
          params.push(classParam);
        }
        const topicParam = (url.searchParams.get("topic") || "").trim();
        if (topicParam) {
          where.push("LOWER(topic_title) = LOWER(?)");
          params.push(topicParam);
        }
        const sortMap = { newest: "created_at DESC", oldest: "created_at ASC", score_desc: "final_score DESC, created_at DESC", score_asc: "final_score ASC, created_at DESC" };
        const orderBy = sortMap[(url.searchParams.get("sort") || "newest").trim().toLowerCase()] || sortMap.newest;

        const limitParam = parseInt(url.searchParams.get("limit"), 10);
        const offsetParam = parseInt(url.searchParams.get("offset"), 10);
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 25;
        const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;
        // v7.6: search by pupil name or class (peers' entries are easier to find)
        const qParam = (url.searchParams.get("q") || "").trim().slice(0, 60).toLowerCase().replace(/[\\%_]/g, "");
        if (qParam) {
          where.push("(LOWER(pupil_name) LIKE ? OR LOWER(pupil_class) LIKE ?)");
          params.push("%" + qParam + "%", "%" + qParam + "%");
        }
        const whereSql = "WHERE " + where.join(" AND ");

        const totalRow = await env.CCv6_DB.prepare(`SELECT COUNT(*) as c FROM submissions ${whereSql}`).bind(...params).first();
        const { results } = await env.CCv6_DB
          .prepare(`SELECT * FROM submissions ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
          .bind(...params, limit, offset)
          .all();
        const submissions = results.map((r) => redactForPupil(rowToSubmission(r)));
        const total = totalRow ? totalRow.c : 0;
        return json({ submissions, total, offset, limit, hasMore: offset + limit < total });
      }

      if (pathname === "/api/submissions/mine" && request.method === "GET") {
        const session = await getSession(request, env);
        if (!session) return json({ error: "Please log in first." }, 401);
        if (session.role !== "pupil") return json({ submissions: [], total: 0, offset: 0, limit: 0, hasMore: false });

        const limitParam = parseInt(url.searchParams.get("limit"), 10);
        const offsetParam = parseInt(url.searchParams.get("offset"), 10);
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 25;
        const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

        // A pupil's OWN history includes everything - practice, degraded,
        // even archived - archiving is a teacher-side organizational tool
        // for the Submissions tab, not a way to erase a pupil's own record
        // of their own work.
        // v7.6: optional topic filter and sort (still ALL of the pupil's own
        // entries by default - no filter, no hidden rows).
        const myTopic = (url.searchParams.get("topic") || "").trim();
        const mySortMap = { newest: "created_at DESC", oldest: "created_at ASC", score_desc: "final_score DESC, created_at DESC", score_asc: "final_score ASC, created_at DESC" };
        const myOrder = mySortMap[(url.searchParams.get("sort") || "newest").trim().toLowerCase()] || mySortMap.newest;
        const topicSql = myTopic ? " AND LOWER(topic_title) = LOWER(?)" : "";
        const myParams = myTopic ? [session.name, session.pupilClass || "unassigned", myTopic] : [session.name, session.pupilClass || "unassigned"];
        const totalRow = await env.CCv6_DB
          .prepare("SELECT COUNT(*) as c FROM submissions WHERE LOWER(pupil_name) = LOWER(?) AND LOWER(pupil_class) = LOWER(?)" + topicSql)
          .bind(...myParams)
          .first();
        const { results } = await env.CCv6_DB
          .prepare("SELECT * FROM submissions WHERE LOWER(pupil_name) = LOWER(?) AND LOWER(pupil_class) = LOWER(?)" + topicSql + " ORDER BY " + myOrder + " LIMIT ? OFFSET ?")
          .bind(...myParams, limit, offset)
          .all();
        const submissions = results.map((r) => redactForPupil(rowToSubmission(r)));
        const total = totalRow ? totalRow.c : 0;
        return json({ submissions, total, offset, limit, hasMore: offset + limit < total });
      }

      // POST /api/submissions/:id/remark { roundIndex } - re-run AI marking
      // for ONE question that fell back to offline scoring. Available to
      // the pupil who owns the submission, and to any teacher (respecting
      // the usual super-admin-vs-class-scoped split), but never to a pupil
      // re-marking someone else's work - the "AI re-mark" button only ever
      // appears on a submission's owner's own view or a teacher's view, and
      // this check is what actually enforces that, not just the UI hiding
      // the button.
      if (pathname.startsWith("/api/submissions/") && pathname.endsWith("/remark") && request.method === "POST") {
        const session = await getSession(request, env);
        if (!session) return json({ error: "Please log in first." }, 401);
        const id = pathname.split("/")[3];
        const row = await env.CCv6_DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first();
        if (!row) return json({ error: "Submission not found." }, 404);

        const isOwner = session.role === "pupil" && normalizeClassKey(row.pupil_class) === normalizeClassKey(session.pupilClass) && row.pupil_name === session.name;
        const isAuthorizedTeacher = session.role === "teacher" && (session.isSuperAdmin || (session.assignedClasses || []).map(normalizeClassKey).includes(normalizeClassKey(row.pupil_class)));
        if (!isOwner && !isAuthorizedTeacher) return json({ error: "Not authorised." }, 403);

        const body = await request.json().catch(() => ({}));
        const roundIndex = Number.isInteger(body.roundIndex) ? body.roundIndex : -1;
        if (roundIndex < 0 || roundIndex > 2) return badRequest("roundIndex must be 0, 1, or 2.");

        const result = await remarkSubmissionRound(env, row, roundIndex); // a v7.5 submission has rounds 0 and 1 only; a missing round is reported as "doesn't exist"
        if (!result.ok) return badRequest(result.error);
        // A pupil (whether re-marking their own work, or - defensively -
        // ever reached this far on someone else's) never sees coachUsed or
        // the per-unit score breakdown - see redactForPupil.
        const submission = session.role === "pupil" ? redactForPupil(result.submission) : result.submission;
        return json({ ok: true, alreadyMarked: !!result.alreadyMarked, success: !!result.success, addedToLeaderboard: !!result.addedToLeaderboard, message: result.message || null, submission });
      }

      // =========== TEACHER-ONLY ROUTES BELOW ===========
      const session = await getSession(request, env);


      if (pathname === "/api/teacher/submissions" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const limitParam = parseInt(url.searchParams.get("limit"), 10);
        const offsetParam = parseInt(url.searchParams.get("offset"), 10);
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
        const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

        const total = await countFilteredSubmissions(env, session, url);
        const page = await queryFilteredSubmissions(env, session, url, { limit, offset });
        return json({ submissions: page, total, offset, limit, hasMore: offset + limit < total });
      }

      if (pathname === "/api/teacher/submissions/export" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        // Exports whatever's currently in scope/filtered (class/topic/archived
        // query params, same as the Submissions tab) so a teacher-admin's CSV
        // only ever contains their own classes, and "Export CSV" while a
        // filter is active exports just that filtered view.
        const filteredSubs = await queryFilteredSubmissions(env, session, url);
        const rows = [];
        rows.push(
          [
            "id",
            "pupilName",
            "pupilClass",
            "topicTitle",
            "mode",
            "practice",
            "finalScore",
            "maxScore",
            "flagged",
            "gradingDegraded",
            "repeatedIdeasPenalty",
            "archived",
            "retryOf",
            "createdAt",
            "Q1_question",
            "Q1_answer",
            "Q1_score",
            "Q1_coachUsed",
            "Q2_question",
            "Q2_answer",
            "Q2_score",
            "Q2_coachUsed",
            "Q3_question",
            "Q3_answer",
            "Q3_score",
            "Q3_coachUsed",
            // v7.5 - Q2 and Q3 are marked together as one unit, so for a
            // v7.5 submission Q2_score/Q3_score are left blank and the
            // unit scores live here. Pre-v7.5 rows leave these blank.
            "markingScheme",
            "unit1_score",
            "unit2_score",
            "unit1_breakdown",
            "unit2_breakdown",
          ]
            .map(csvEscape)
            .join(",")
        );
        const csvAnswerText = (mode, answer) =>
          mode === "single"
            ? (answer && answer.text) || ""
            : ["T", "R", "E1", "E2", "S"].map((k) => (answer && answer.parts && answer.parts[k]) || "").join(" | ");
        const csvBreakdown = (rd) => (rd && Array.isArray(rd.breakdown) ? rd.breakdown.map((b) => `${b.part} ${b.points}/${b.max}`).join("; ") : "");
        for (const s of filteredSubs) {
          const rounds = s.rounds || [];
          const isTwoUnit = rounds.length === 2 && roundUnit(rounds[1]) === UNIT_Q2Q3;
          const roundCols = [];
          for (let i = 0; i < 3; i++) {
            if (isTwoUnit) {
              if (i === 0) {
                const r = rounds[0];
                roundCols.push(r.question || "", csvAnswerText(r.mode, r.answer), r.score, r.coachUsed ? "yes" : "no");
              } else {
                const r = rounds[1];
                const qi = i - 1;
                roundCols.push(
                  (r.questions && r.questions[qi]) || "",
                  csvAnswerText(r.mode, r.answers && r.answers[qi]),
                  "", // scored as one unit with the other of Q2/Q3 - see unit2_score
                  r.coachUsedQuestions ? (r.coachUsedQuestions[qi] ? "yes" : "no") : r.coachUsed ? "yes" : "no"
                );
              }
              continue;
            }
            const r = rounds[i];
            if (!r) {
              roundCols.push("", "", "", "");
              continue;
            }
            roundCols.push(r.question || "", csvAnswerText(r.mode, r.answer), r.score, r.coachUsed ? "yes" : "no");
          }
          const schemeCols = isTwoUnit
            ? ["v7.5 two-unit (Q1 | Q2+Q3)", rounds[0].score, rounds[1].score, csvBreakdown(rounds[0]), csvBreakdown(rounds[1])]
            : ["legacy three-question", "", "", "", ""];
          rows.push(
            [
              s.id,
              s.pupilName,
              s.pupilClass || "unassigned",
              s.topicTitle,
              s.mode,
              s.practice ? "yes" : "no",
              s.finalScore,
              s.maxScore,
              s.flagged ? "yes" : "no",
              s.gradingDegraded ? "yes" : "no",
              s.repeatedIdeasPenalty ? "yes" : "no",
              s.archived ? "yes" : "no",
              s.retryOf || "",
              new Date(s.createdAt).toISOString(),
              ...roundCols,
              ...schemeCols,
            ]
              .map(csvEscape)
              .join(",")
          );
        }
        const csv = rows.join("\r\n");
        return new Response(csv, {
          status: 200,
          headers: {
            "content-type": "text/csv;charset=UTF-8",
            "content-disposition": 'attachment; filename="just-a-chit-chat-submissions.csv"',
            "access-control-allow-origin": "*",
          },
        });
      }

      // ---------- "Try Again" policy (all teacher roles) ----------
      // A super admin sets the global default and may override any class; a
      // class-scoped teacher-admin sees the global default read-only and may
      // only override their own assigned classes.
      // Sanitized snapshot of the AI reliability layer's in-memory health
      // state (see aiHealth / recordAiFailure above) - lets a teacher see
      // "Groq key 2 has been rate-limited for the last 20 minutes" instead
      // of guessing why marking suddenly got slower or fell back to
      // offline scoring. Never includes API keys, only the keyId label
      // (key1/key2/binding) and failure category/timestamps. This reflects
      // only THIS Worker isolate's memory (see the comment on aiHealth) -
      // after a deploy or a period of low traffic, it may show everything
      // as healthy even if a key was failing hours ago.
      if (pathname === "/api/teacher/ai-health" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const storedGroqModel = await getConfig(env, "model_groq");
        const groqModel = (storedGroqModel && storedGroqModel.trim()) || DEFAULT_GROQ_MODEL;
        const storedOpenRouterModel = await getConfig(env, "model_openrouter");
        const candidateOpenRouterModel = (storedOpenRouterModel && storedOpenRouterModel.trim()) || DEFAULT_OPENROUTER_MODEL;
        const openRouterModel = isFreeOpenRouterModel(candidateOpenRouterModel) ? candidateOpenRouterModel : DEFAULT_OPENROUTER_MODEL;
        const candidates = buildAiCandidates(env, groqModel, openRouterModel, null);
        const now = Date.now();
        return json({
          generatedAt: now,
          candidates: candidates.map((c) => {
            const h = getAiHealth(c.healthKey);
            return {
              provider: c.providerId,
              model: c.modelId,
              key: c.keyId,
              status: h.cooldownUntil > now ? "cooling_down" : "available",
              cooldownSecondsRemaining: h.cooldownUntil > now ? Math.ceil((h.cooldownUntil - now) / 1000) : 0,
              consecutiveFailures: h.consecutiveFailures,
              lastFailureCategory: h.lastFailureCategory,
              lastFailureAt: h.lastFailureAt || null,
              lastSuccessAt: h.lastSuccessAt || null,
              lastLatencyMs: h.lastLatencyMs,
            };
          }),
        });
      }

      if (pathname === "/api/teacher/retry-policy" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const policy = await getRetryPolicy(env);
        const { results } = await env.CCv6_DB.prepare("SELECT DISTINCT pupil_class FROM pupils").all();
        let classes = results.map((r) => r.pupil_class).filter(Boolean);
        if (!session.isSuperAdmin) {
          const scoped = (session.assignedClasses || []).map(normalizeClassKey);
          classes = classes.filter((c) => scoped.includes(normalizeClassKey(c)));
          // Show an assigned class even if no pupil has logged in from it yet.
          for (const c of session.assignedClasses || []) {
            if (!classes.some((x) => normalizeClassKey(x) === normalizeClassKey(c))) classes.push(c);
          }
        }
        classes.sort((a, b) => a.localeCompare(b));
        return json({
          global: policy.global,
          canEditGlobal: !!session.isSuperAdmin,
          classes: classes.map((c) => ({
            pupilClass: c,
            override: Object.prototype.hasOwnProperty.call(policy.classes, normalizeClassKey(c)) ? !!policy.classes[normalizeClassKey(c)] : null,
            effective: isRetryEnabledForClass(policy, c),
          })),
        });
      }

      if (pathname === "/api/teacher/retry-policy" && request.method === "POST") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const policy = await getRetryPolicy(env);

        if (typeof body.global === "boolean") {
          if (!requireSuperAdmin(session)) return json({ error: "Only the main teacher account can change the global setting." }, 403);
          policy.global = body.global;
        }
        if (typeof body.pupilClass === "string" && body.pupilClass.trim()) {
          const key = normalizeClassKey(body.pupilClass);
          if (!session.isSuperAdmin) {
            const scoped = (session.assignedClasses || []).map(normalizeClassKey);
            if (!scoped.includes(key)) return json({ error: "That class isn't one of yours." }, 403);
          }
          // null/"inherit" clears the override so the class follows the global
          // default again, rather than being pinned to whatever it is today.
          if (body.override === null || body.override === "inherit") delete policy.classes[key];
          else policy.classes[key] = !!body.override;
        }

        await setConfig(env, RETRY_POLICY_KEY, JSON.stringify({ global: policy.global, classes: policy.classes }));
        return json({ ok: true, global: policy.global });
      }

      if (pathname === "/api/teacher/rubric" && request.method === "GET") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const stored = await getConfig(env, "rubric");
        return json({ rubric: stored || DEFAULT_RUBRIC, isDefault: !stored, defaultRubric: DEFAULT_RUBRIC });
      }

      if (pathname === "/api/teacher/rubric" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const rubric = (body.rubric || "").trim();
        if (!rubric) {
          await deleteConfig(env, "rubric"); // reset to default
          return json({ ok: true, rubric: DEFAULT_RUBRIC, isDefault: true });
        }
        await setConfig(env, "rubric", rubric);
        return json({ ok: true, rubric, isDefault: false });
      }

      // v7.6 - "Test this rubric": run the REAL marking chain on a sample
      // answer using the rubric text currently typed in Settings (saved or not),
      // and return the result WITHOUT saving anything anywhere - no submission,
      // no leaderboard/pupil history, no config write. Super admin only (same as
      // editing the rubric). Uses one AI call, so it spends a little of the
      // provider quota exactly like a real submission would.
      if (pathname === "/api/teacher/rubric-test" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const unit = body.unit === "q2q3" ? "q2q3" : "q1";
        const rubric = String(body.rubric || "").slice(0, 12000);
        const clip = (v) => String(v || "").trim().slice(0, 2500);
        let topic = null;
        if (body.topicId) {
          const trow = await env.CCv6_DB.prepare("SELECT * FROM topics WHERE id = ?").bind(String(body.topicId)).first();
          if (trow) topic = rowToTopic(trow);
        }
        let result;
        if (unit === "q2q3") {
          const answers = [clip(body.answers && body.answers[0]), clip(body.answers && body.answers[1])];
          if (!answers[0] && !answers[1]) return badRequest("Type a sample answer for Question 2 and/or Question 3 first.");
          const questions = [clip(body.questions && body.questions[0]) || "Tell me about a time you helped someone.", clip(body.questions && body.questions[1]) || "What did you learn from it?"];
          result = await aiScoreUnit2(env, topic, questions, "single", answers.map((text) => ({ text })), { rubricOverride: rubric });
        } else {
          const answer = clip(body.answers && body.answers[0]);
          if (!answer) return badRequest("Type a sample answer for Question 1 first.");
          const question = clip(body.questions && body.questions[0]) || "What do you think is happening in the picture?";
          result = await aiScore(env, topic, question, "single", { text: answer }, { rubricOverride: rubric });
        }
        const offline = result.markedBy === "fallback";
        return json({
          ok: true,
          unit,
          offline,
          markedBy: result.markedBy,
          total: result.total,
          max: result.max,
          breakdown: result.breakdown,
          feedback: result.feedback,
          suggestion: result.suggestion,
          strengths: result.strengths || "",
          nextStep: result.nextStep || "",
          modelAnswer: result.modelAnswer || "",
          note: offline ? "No AI provider answered, so this is the offline keyword estimate - it does NOT use your rubric text. Try again in a moment." : "",
        });
      }

      // v7.6 - class insights: average score per criterion, per marking unit,
      // across the (non-practice, fully AI-marked) submissions in scope. Scoped
      // teacher-admins only ever see their own classes (same filter as the
      // Submissions tab). Pure arithmetic on stored rounds - no AI call.
      if (pathname === "/api/teacher/analytics" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const { whereSql, params } = buildSubmissionsFilter(session, url);
        const w = (whereSql ? whereSql + " AND " : "WHERE ") + "practice = 0 AND grading_degraded = 0";
        const { results } = await env.CCv6_DB
          .prepare(`SELECT pupil_class, topic_title, rounds, final_score FROM submissions ${w} ORDER BY created_at DESC LIMIT 500`)
          .bind(...params)
          .all();
        return json(computeAnalytics(results || []));
      }

      // v7.5 - separate rubric for Unit 2 (Questions 2 + 3 marked together).
      // Stored under config key "rubric_q2q3"; the existing "rubric" key keeps
      // driving Question 1 exactly as before.
      if (pathname === "/api/teacher/rubric-q2q3" && request.method === "GET") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const stored = await getConfig(env, "rubric_q2q3");
        return json({ rubric: stored || DEFAULT_RUBRIC_Q2Q3, isDefault: !stored, defaultRubric: DEFAULT_RUBRIC_Q2Q3 });
      }

      if (pathname === "/api/teacher/rubric-q2q3" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const rubric = (body.rubric || "").trim();
        if (!rubric) {
          await deleteConfig(env, "rubric_q2q3"); // reset to default
          return json({ ok: true, rubric: DEFAULT_RUBRIC_Q2Q3, isDefault: true });
        }
        await setConfig(env, "rubric_q2q3", rubric);
        return json({ ok: true, rubric, isDefault: false });
      }

      if (pathname === "/api/teacher/model-groq" && request.method === "GET") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const stored = await getConfig(env, "model_groq");
        return json({ model: stored || DEFAULT_GROQ_MODEL, isDefault: !stored, options: GROQ_MODEL_OPTIONS });
      }

      if (pathname === "/api/teacher/model-groq" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const model = (body.model || "").trim();
        if (!model) {
          await deleteConfig(env, "model_groq"); // reset to default
          return json({ ok: true, model: DEFAULT_GROQ_MODEL, isDefault: true });
        }
        await setConfig(env, "model_groq", model);
        return json({ ok: true, model, isDefault: false });
      }

      if (pathname === "/api/teacher/model-openrouter" && request.method === "GET") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const stored = await getConfig(env, "model_openrouter");
        return json({ model: stored || DEFAULT_OPENROUTER_MODEL, isDefault: !stored, options: OPENROUTER_MODEL_OPTIONS });
      }

      if (pathname === "/api/teacher/model-openrouter" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const model = (body.model || "").trim();
        if (!model) {
          await deleteConfig(env, "model_openrouter"); // reset to default
          return json({ ok: true, model: DEFAULT_OPENROUTER_MODEL, isDefault: true });
        }
        // OpenRouter is a shared fallback tier for every question - only
        // free models (":free" suffix, or the "openrouter/free" auto-router)
        // are ever allowed here, so this can't silently start running up a
        // bill. See isFreeOpenRouterModel.
        if (!isFreeOpenRouterModel(model)) {
          return badRequest('Only free OpenRouter models are allowed here - the model ID must end in ":free" (e.g. meta-llama/llama-3.3-70b-instruct:free), or be "openrouter/free" (OpenRouter\'s free-model auto-router). See openrouter.ai/models?max_price=0 for the current free-tier list.');
        }
        await setConfig(env, "model_openrouter", model);
        return json({ ok: true, model, isDefault: false });
      }

      if (pathname === "/api/teacher/submissions/archive" && request.method === "POST") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
        const archived = !!body.archived;
        let updated = 0;
        for (const id of ids) {
          const row = await env.CCv6_DB.prepare("SELECT pupil_class FROM submissions WHERE id = ?").bind(id).first();
          if (!row) continue;
          if (!classAllowed(session, row.pupil_class)) continue; // silently skip out-of-scope ids rather than 403ing a whole bulk request
          await env.CCv6_DB.prepare("UPDATE submissions SET archived = ? WHERE id = ?").bind(archived ? 1 : 0, id).run();
          updated++;
        }
        return json({ ok: true, updated, archived });
      }

      if (pathname.startsWith("/api/teacher/submissions/") && request.method === "DELETE") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const id = pathname.split("/").pop();
        const row = await env.CCv6_DB.prepare("SELECT pupil_class FROM submissions WHERE id = ?").bind(id).first();
        if (row && !classAllowed(session, row.pupil_class)) return json({ error: "Not authorised for this pupil's class." }, 403);
        await env.CCv6_DB.prepare("DELETE FROM submissions WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (pathname.startsWith("/api/teacher/submissions/") && request.method === "PUT") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const id = pathname.split("/").pop();
        const existingRow = await env.CCv6_DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first();
        if (!existingRow) return json({ error: "Not found." }, 404);
        if (!classAllowed(session, existingRow.pupil_class)) return json({ error: "Not authorised for this pupil's class." }, 403);
        const body = await request.json();
        const existing = rowToSubmission(existingRow);
        const updated = { ...existing, ...body, id };
        await env.CCv6_DB
          .prepare(
            `UPDATE submissions SET pupil_name=?, pupil_class=?, topic_id=?, topic_title=?, mode=?, rounds=?, final_score=?, max_score=?, practice=?, grading_degraded=?, repeated_ideas_penalty=?, archived=?, flagged=? WHERE id=?`
          )
          .bind(
            updated.pupilName,
            updated.pupilClass,
            updated.topicId,
            updated.topicTitle,
            updated.mode,
            JSON.stringify(updated.rounds),
            updated.finalScore,
            updated.maxScore,
            updated.practice ? 1 : 0,
            updated.gradingDegraded ? 1 : 0,
            updated.repeatedIdeasPenalty ? 1 : 0,
            updated.archived ? 1 : 0,
            updated.flagged ? 1 : 0,
            id
          )
          .run();
        return json({ record: updated });
      }

      // POST /api/teacher/submissions/:id/override-score { roundIndex, score, feedback? }
      // Teacher-only, scope-checked the same way as the DELETE/PUT routes
      // above. See overrideSubmissionRoundScore for why this never flips
      // markedBy/gradingDegraded/leaderboard_counted on its own.
      if (pathname.startsWith("/api/teacher/submissions/") && pathname.endsWith("/override-score") && request.method === "POST") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const id = pathname.split("/")[4];
        const row = await env.CCv6_DB.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first();
        if (!row) return json({ error: "Not found." }, 404);
        if (!classAllowed(session, row.pupil_class)) return json({ error: "Not authorised for this pupil's class." }, 403);

        const body = await request.json().catch(() => ({}));
        const roundIndex = Number.isInteger(body.roundIndex) ? body.roundIndex : -1;
        if (roundIndex < 0 || roundIndex > 2) return badRequest("roundIndex must be 0, 1, or 2.");
        const score = typeof body.score === "number" ? body.score : Number(body.score);

        const result = await overrideSubmissionRoundScore(env, row, roundIndex, score, body.feedback, session.name);
        if (!result.ok) return badRequest(result.error);
        return json({ ok: true, pupilAggregateUpdated: result.pupilAggregateUpdated, submission: result.submission });
      }

      if (pathname === "/api/teacher/leaderboard/reset" && request.method === "POST") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json().catch(() => ({}));
        if (body.name) {
          const cls = body.pupilClass || "unassigned";
          if (!classAllowed(session, cls)) return json({ error: "Not authorised for this pupil's class." }, 403);
          const pupilRow = await env.CCv6_DB.prepare("SELECT id FROM pupils WHERE name = ? AND pupil_class = ?").bind(body.name, cls).first();
          if (pupilRow) {
            await env.CCv6_DB.prepare("DELETE FROM pupil_history WHERE pupil_id = ?").bind(pupilRow.id).run();
            await env.CCv6_DB.prepare("DELETE FROM pupils WHERE id = ?").bind(pupilRow.id).run();
          }
        } else {
          // "Reset all" only resets pupils within this session's scope - a
          // scoped teacher-admin can never wipe another class's leaderboard.
          let where = "";
          const params = [];
          if (!session.isSuperAdmin) {
            const classes = (session.assignedClasses || []).map((c) => String(c).toLowerCase());
            if (!classes.length) return json({ ok: true });
            where = `WHERE LOWER(pupil_class) IN (${classes.map(() => "?").join(",")})`;
            params.push(...classes);
          }
          const { results: pupilRows } = await env.CCv6_DB.prepare(`SELECT id FROM pupils ${where}`).bind(...params).all();
          for (const p of pupilRows) {
            await env.CCv6_DB.prepare("DELETE FROM pupil_history WHERE pupil_id = ?").bind(p.id).run();
          }
          await env.CCv6_DB.prepare(`DELETE FROM pupils ${where}`).bind(...params).run();
        }
        return json({ ok: true });
      }

      // ---------- PUPIL TRACKING ----------
      if (pathname === "/api/teacher/pupils" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const where = [];
        const params = [];
        if (!session.isSuperAdmin) {
          const classes = (session.assignedClasses || []).map((c) => String(c).toLowerCase());
          if (!classes.length) return json({ pupils: [] });
          where.push(`LOWER(pupil_class) IN (${classes.map(() => "?").join(",")})`);
          params.push(...classes);
        }
        const classParam = (url.searchParams.get("class") || "").trim();
        if (classParam) {
          where.push("LOWER(pupil_class) = LOWER(?)");
          params.push(classParam);
        }
        const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
        const { results } = await env.CCv6_DB.prepare(`SELECT * FROM pupils ${whereSql} ORDER BY pupil_class, name`).bind(...params).all();
        return json({ pupils: results.map(rowToPupil) });
      }

      // Distinct class names this session may see - powers the Class filter
      // dropdowns on Leaderboard/Submissions/Pupils.
      if (pathname === "/api/teacher/classes" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        if (session.isSuperAdmin) {
          return json({ classes: await getAllKnownClasses(env) });
        }
        return json({ classes: (session.assignedClasses || []).slice().sort((a, b) => a.localeCompare(b)) });
      }

      if (pathname === "/api/teacher/pupil" && request.method === "GET") {
        if (!requireTeacher(session)) return json({ error: "Not authorised." }, 403);
        const name = (url.searchParams.get("name") || "").trim();
        const pupilClass = (url.searchParams.get("class") || "unassigned").trim();
        if (!name) return badRequest("Missing pupil name.");
        if (!classAllowed(session, pupilClass)) return json({ error: "Not authorised for this pupil's class." }, 403);
        const pupilRow = await env.CCv6_DB.prepare("SELECT * FROM pupils WHERE name = ? AND pupil_class = ?").bind(name, pupilClass).first();
        const pupil = pupilRow ? rowToPupil(pupilRow) : { name, pupilClass, bestScore: 0, totalScore: 0, attempts: 0 };
        const history = pupilRow ? await loadPupilHistory(env, pupilRow.id) : [];
        const { strengths, concerns, rows } = computeStrengthsConcerns(history);
        return json({ pupil, history, strengths, concerns, rows });
      }

      if (pathname === "/api/teacher/topics" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const id = body.id || uid();
        const imageUrl = (body.imageUrl || "").trim();
        // Uploaded pictures (Teacher Tools -> Topics -> "Upload a picture")
        // arrive here as a data: URL - the browser already compresses/
        // resizes them client-side, but re-validate the size server-side
        // too: D1 caps a single row at 2 MB total (see
        // developers.cloudflare.com/d1/platform/limits), and this row also
        // has to fit the title/questions/tags/coach JSON alongside the
        // image, so this leaves comfortable headroom under that cap.
        if (imageUrl.startsWith("data:") && imageUrl.length > MAX_TOPIC_IMAGE_DATA_URL_LENGTH) {
          return badRequest(
            `That picture is too large to store (~${Math.round(imageUrl.length / 1024)} KB) - Cloudflare D1 limits a topic's total stored size to 2 MB. Please try uploading again (the app compresses automatically at a few quality levels), or choose a smaller/lower-resolution picture.`
          );
        }
        const topic = {
          id,
          title: (body.title || "Untitled topic").trim(),
          imageUrl,
          imageDescription: (body.imageDescription || "").trim().slice(0, 600),
          questions: Array.isArray(body.questions) ? body.questions.filter(Boolean) : [],
          tags: Array.isArray(body.tags) ? body.tags : [],
          coach: sanitizeCoach(body.coach),
        };
        const existing = await env.CCv6_DB.prepare("SELECT created_at FROM topics WHERE id = ?").bind(id).first();
        await env.CCv6_DB
          .prepare(
            `INSERT INTO topics (id, title, image_url, image_description, questions, tags, coach, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title, image_url = excluded.image_url, image_description = excluded.image_description,
               questions = excluded.questions, tags = excluded.tags, coach = excluded.coach`
          )
          .bind(id, topic.title, topic.imageUrl, topic.imageDescription, JSON.stringify(topic.questions), JSON.stringify(topic.tags), JSON.stringify(topic.coach), existing ? existing.created_at : Date.now())
          .run();
        return json({ topic });
      }

      if (pathname.startsWith("/api/teacher/topics/") && request.method === "DELETE") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const id = pathname.split("/").pop();
        await env.CCv6_DB.prepare("DELETE FROM topics WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      if (pathname === "/api/teacher/password" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const newPassword = (body.newPassword || "").trim();
        if (newPassword.length < 6) return badRequest("Password should be at least 6 characters.");
        await setTeacherPassword(env, newPassword);
        return json({ ok: true });
      }

      // ---------- TEACHER-ADMIN ACCOUNTS (palpatine only) ----------
      if (pathname === "/api/admin/teachers" && request.method === "GET") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        return json({ teachers: await listTeacherAdmins(env) });
      }

      if (pathname === "/api/admin/teachers" && request.method === "POST") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const body = await request.json();
        const username = (body.username || "").trim().toLowerCase();
        const password = body.password || "";
        const classes = Array.isArray(body.classes) ? body.classes.map((c) => String(c || "").trim()).filter(Boolean).slice(0, 30) : [];
        if (!/^[a-z0-9_-]{3,30}$/.test(username)) return badRequest("Username should be 3-30 characters: letters, numbers, - or _ only.");
        if (username === TEACHER_USERNAME) return badRequest("That username is reserved.");
        if (password.length < 6) return badRequest("Password should be at least 6 characters.");
        if (!classes.length) return badRequest("Assign at least one class.");
        if (await getTeacherAdmin(env, username)) return badRequest("That username is already taken.");
        const salt = uid();
        const hash = await hashPassword(password, salt);
        const createdAt = Date.now();
        await env.CCv6_DB
          .prepare("INSERT INTO teacher_admins (username, salt, hash, classes, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(username, salt, hash, JSON.stringify(classes), createdAt)
          .run();
        return json({ teacher: { username, classes, createdAt } });
      }

      if (pathname.startsWith("/api/admin/teachers/") && request.method === "PUT") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const username = decodeURIComponent(pathname.split("/").pop()).trim().toLowerCase();
        const record = await getTeacherAdmin(env, username);
        if (!record) return json({ error: "Not found." }, 404);
        const body = await request.json();
        let classes = record.classes;
        if (Array.isArray(body.classes)) {
          classes = body.classes.map((c) => String(c || "").trim()).filter(Boolean).slice(0, 30);
          if (!classes.length) return badRequest("Assign at least one class.");
        }
        let salt = record.salt;
        let hash = record.hash;
        if (typeof body.newPassword === "string" && body.newPassword) {
          if (body.newPassword.length < 6) return badRequest("Password should be at least 6 characters.");
          salt = uid();
          hash = await hashPassword(body.newPassword, salt);
        }
        await env.CCv6_DB.prepare("UPDATE teacher_admins SET classes = ?, salt = ?, hash = ? WHERE username = ?").bind(JSON.stringify(classes), salt, hash, username).run();
        return json({ teacher: { username: record.username, classes, createdAt: record.createdAt } });
      }

      if (pathname.startsWith("/api/admin/teachers/") && request.method === "DELETE") {
        if (!requireSuperAdmin(session)) return json({ error: "Not authorised." }, 403);
        const username = decodeURIComponent(pathname.split("/").pop()).trim().toLowerCase();
        await env.CCv6_DB.prepare("DELETE FROM teacher_admins WHERE username = ?").bind(username).run();
        return json({ ok: true });
      }

      return json({ error: "Not found." }, 404);
    } catch (err) {
      // A pupil-facing message thrown from deeper inside a handler (e.g. the
      // retry_of UNIQUE race) - report it as a normal 400, not a server error.
      if (err instanceof HandledSubmitError) return badRequest(err.message);
      return json({ error: "Server error: " + (err && err.message ? err.message : String(err)) }, 500);
    }
  },
};
