# Just a Chit-Chat

A Singapore-oral-conversation practice game (TREES framework, 25-mark rubric)
built as a single Cloudflare Worker: one file serves the pupil-facing game,
the leaderboard, and hidden teacher tools, backed by D1 (Cloudflare's SQLite
database) with Workers KV used only for session tokens.

## What's new in v7.6 — nudges, coach tips, strengths/next step, insights

**v7.6.1 — Thought / Reason / Evidence are optional on Questions 2 and 3.** In
TREES-branch mode a pupil may leave those three boxes blank on Q2 and Q3 (they
earn no marks there). The boxes are tagged *optional*, the branch tree dims
them, and the "Please complete" check no longer lists them; **Experience and
Suggestion are still required** on Q2 and Q3, and all five boxes are still
required on Q1. The Unit 2 marker is told blank Thought/Reason/Evidence is
expected and must never lower a mark. The single-box Q2/Q3 hint no longer
mentions the picture. The server never required these boxes, so this is a
page and prompt change only.

No schema change and no migration: deploy the new `index.js` + `frontend.js`.

**For pupils**

- **Live nudges.** While a pupil types, a checklist ticks off as the matching
  words appear. Questions 2 + 3 share one **story checklist** (who else was
  there, what happened, when, where, why, how it ended, what I learnt/felt, a
  suggestion) because they are marked together as one story; Question 1 gets a
  short checklist (reason, something from the picture, a personal experience,
  a suggestion) in single-box mode (TREES-branch mode already has its branch
  progress). Everything runs in the browser from simple cue words: hints only,
  never a mark, nothing is sent to the server.
- **Strengths and next step.** Every marked part now returns *What went well*
  (specific to what the pupil actually said) and *Your next step* (one concrete
  thing to do next time). Pupils still never see per-part scores, so this is
  how they know what to work on. They appear on the result screen, in My
  Submissions / On the Leaderboard, and above the new answer box on Try Again.
  If the AI leaves them out, or the part was marked offline, they are derived
  from the breakdown (strongest and weakest criterion, in plain words), so
  they are never blank on a new submission. Older submissions simply don't show them.
- **Coach tips for Q2/Q3.** In Teacher Tools → Topics, Questions 2 and 3 each
  have two new boxes: *telling a personal story* and *adding a lesson or
  suggestion* (one tip per line, up to 5 per box, 240 characters each). They
  show under **Ask the Coach** with the sentence starters and links. Question 1
  does not have them. Opening the coach is still quietly flagged to teachers only.
- **All your entries, and your peers'.** My Submissions has always held every
  attempt (practice, retries, offline-marked, even teacher-archived). It now
  has a topic filter, sort (newest / oldest / highest / lowest), "Showing N of
  total" and Load more. On the Leaderboard adds a *find a pupil or class*
  search. Unchanged rules: a peer's entry appears only if it counted toward the
  leaderboard (non-practice, fully AI-marked) and the teacher hasn't archived
  it; peers' entries show answers and feedback but never per-part scores.

**For teachers**

- **Submission detail.** A summary strip (Unit 1, Unit 2, average, and the
  criteria that lost the most marks), Q2 and Q3 answers side by side, the
  score breakdown collapsed by default, strengths/next step shown, and a
  *Legacy 3-question marking* tag on pre-v7.5 submissions (also in the list).
- **Settings → rubrics.** A live **mark check** under each rubric box compares
  the "0-N" ranges you wrote with the maxes the app enforces (the app always
  totals 25 per unit and caps each part, whatever the text says); a **View the
  built-in default** viewer with *copy into the box*; and a **Test a rubric**
  panel that runs the real AI marker once on a sample answer using the rubric
  text currently in the box (saved or not) and shows the full result without
  saving anything (`POST /api/teacher/rubric-test`, super admin only, one AI
  call per test).
- **Insights tab** (all teachers; class-scoped admins see only their classes).
  Average per criterion for each unit, overall average, "where to focus next"
  (the three weakest criteria) and a by-class table, from non-practice, fully
  AI-marked, non-archived submissions (latest 500 in view)
  (`GET /api/teacher/analytics?class=&topic=`). Pre-v7.5 submissions count in the
  overall average but are kept out of the per-unit tables.

**API additions:** `strengths` / `nextStep` on every round; `storyTips` /
`lessonTips` on `coach[1]` and `coach[2]`; `q` on `/api/submissions/leaderboard`;
`topic` and `sort` on `/api/submissions/mine`; `defaultRubric` in both rubric
GETs; the two new teacher endpoints above.

## What's new in v7.5 — two marking units instead of three

Each topic still has 3 questions, but they are now **marked as 2 units**:

| Unit | Covers | AI calls | Rubric | Max |
|---|---|---|---|---:|
| **Unit 1** | Question 1 alone | its own call | full TREES against the picture (T/R/E1/E2/S) + Language Use (5), exactly as before | 25 |
| **Unit 2** | Questions 2 + 3 together | **one** call that sees both questions and both answers | Experience **16** + Suggestion **2** + Language Use **7** | 25 |

*Why:* Question 1's prompt always refers to the picture, but Questions 2 and
3 move away from it toward broader themes and often ask directly for a
personal experience, so Thought/Reason/Evidence-from-the-picture marks were
unfair there. Q2 + Q3 read as one extended personal-narrative task split
across two prompts, so they are read, and marked, as one piece of work.

**Unit 2 rubric** (Thought, Reason and Evidence are dropped; their 6 marks
are redistributed):

- **Experience (16, up from 12)** — six sub-criteria: Relevance (2),
  5W1H Specificity (6), Authenticity/Personal Voice (2), Clarity & Sequence
  across both answers (2), Reflection/Lesson Learnt (2), and *Depth &
  Development Across Both Answers* (2). A detail in Q2 and its payoff in Q3
  are read as one story, not graded in isolation, and the same detail is
  not credited twice just for being repeated.
- **Suggestion (2)** — need only appear in *either* answer, not both.
- **Language Use (7, up from 5)** — one holistic judgement over the
  combined text: Grammar (3) + Vocabulary (3) + Fluency (1).

**Scoring:** `finalScore` = the average of the two unit scores (each out of
25) — same formula as before, two inputs instead of three. The
repeated-ideas penalty is unchanged (it compares the pupil's three
*answers*, so it only fires if Q1 reuses the Q2/Q3 story as well).

**What pupils see:** only the overall average, plus the written feedback,
tip and "stronger version" for each part. Per-unit scores, the per-criterion
breakdown and "who adjusted what" are stripped **server-side** from every
pupil-facing response (submit, My Submissions, On the Leaderboard, re-mark),
not just hidden in the page. **Teachers** still see the full per-unit
breakdown, the Q2/Q3 answers side by side, and a CSV with new
`markingScheme`, `unit1_score`, `unit2_score`, `unit1_breakdown`,
`unit2_breakdown` columns.

**Unchanged for Question 1:** its own independent AI call, its own
`rounds[0]` record, its own AI re-mark button and its own teacher-override
form. Unit 2 gets the same controls independently (`rounds[1]`): re-marking
Unit 2 re-runs the single combined call, and overriding it sets that unit's
score (0–25). The submission only joins the leaderboard once **both** units
are AI-marked.

**Settings:** Teacher Tools → Settings now has two rubric boxes — *Question 1*
(config key `rubric`, unchanged) and *Questions 2 + 3* (new config key
`rubric_q2q3`, built-in default `DEFAULT_RUBRIC_Q2Q3`). Blank + Save resets
either one to its default. If you write your own Q2+Q3 rubric, keep its total
at 25 so the two units average fairly.

**Existing data / upgrading:** no schema change and no migration. Old
3-round submissions keep their stored scores and render as three questions;
re-marking or overriding them still divides by 3. New submissions store 2
rounds (`rounds[0].unit = "q1"`, `rounds[1].unit = "q2q3"` with `questions[]`
and `answers[]`). Pupil progress history now averages each criterion over the
units that contain it, with its own average max (e.g. Experience is out of 12
on Unit 1 and 16 on Unit 2, so it is stored as 14 for a v7.5 attempt;
Thought/Reason/Evidence come from Unit 1 only). If you had saved a custom
Question 1 rubric it keeps working exactly as before. Just deploy the new
`index.js` + `frontend.js`.

## What's new in v7-d1

Same features as v7 (below) - this is a storage migration, not a feature
change. The Submissions tab's class/topic/sort/archive filters used to work
by pulling every submission out of KV and filtering in JavaScript; they now
run as real, indexed SQL queries, so filtering/sorting/pagination is faster
and Teacher Tools reads far less data on each page load as your submission
history grows across terms. Frontend and API contract are unchanged - if
you're upgrading from a v7 (KV-only) deployment, see "Upgrading from
KV-only v7" below for the one-time migration.

## What's new since v7-d1

Six additions, all described in full in their own sections below:

- **Teacher score override** (section 4f) - a teacher can now directly set
  a question's score (and optionally its feedback), on any submission in
  their scope, whether AI marked it or not. Deliberately kept independent
  of AI-assessment status: overriding a question a teacher disagrees with
  never changes whether it counts as "assessed by AI" for the leaderboard-
  visibility rule below. No migration needed.
- **A pupil-facing Submissions view, and "AI re-mark" for offline-scored
  questions** (section 4e) - pupils can now browse their own full
  submission history and every submission currently on the leaderboard
  (from any pupil), and can re-run AI marking on any question that fell
  back to offline scoring - as can a teacher, from the existing submission
  detail view. A submission joins the leaderboard automatically the moment
  its last offline-scored question is successfully re-marked, and a pupil
  can never see another pupil's work until that's happened - a teacher
  override alone is never enough to make a submission visible to
  classmates. **This one needs a one-line database migration before you
  deploy** - see the bottom of `schema.sql`.
- **A provider-aware AI reliability layer** (section 4) - AI marking no
  longer treats every failure the same way or every key as interchangeable.
  Rate limits, provider overload, timeouts, bad keys, wrong/deprecated
  model ids, context-length errors, content-policy rejections, and
  malformed responses are each classified and handled differently, with
  per-key health tracking, cooldowns, and a new Teacher Tools → AI Health
  panel. No migration needed.
- **"Try Again" resubmissions** (section 4d) - a pupil can take one second
  try at the same 3 questions, in the same session, with their previous
  answers and feedback shown beside each blank box. Teacher-controlled,
  globally and per class. **This one needs a one-line database migration
  before you deploy** - see the bottom of `schema.sql`.
- **A model answer that can't be weaker than the pupil's own** (section 4b) -
  the "stronger version" panel now has a length target derived from what the
  pupil actually wrote, checked server-side, with the panel suppressed
  outright rather than ever showing a thinner rewrite. No migration needed.

## What's new in v7

- **Class-scoped teacher admins**: palpatine can now create additional
  teacher login accounts from **Teacher Tools → Admins**, each restricted to
  a set of assigned classes. A scoped teacher-admin only ever sees pupils,
  submissions and the leaderboard for their own classes; Topics and Settings
  stay palpatine-only. See "Roles: palpatine vs teacher admins" below.
- **Bulk archive** on the Submissions tab: select any number of rows (or
  "select all") and archive/unarchive them in one click, to tidy up the
  Submissions view at the end of a term without deleting the data. A
  "Show: Active / Archived only / All" filter controls what's visible.
- **Sort & filter Submissions** by class, topic, newest/oldest, or score,
  and the same filters carry through to CSV export.
- **Class filters** on Leaderboard and Pupils, and the Pupils tab now
  groups pupils under a heading per class.
- `name@class` login (e.g. `Ashraf@5IG`) already divided pupils into
  classes under the hood in v6.1 — v7 makes that grouping visible
  throughout Teacher Tools via the new class filters above.

## What's included

```
just-a-chit-chat/
  wrangler.toml          Worker + D1 + KV + AI config
  schema.sql              D1 table definitions - apply once when setting up
  migrate-kv-to-d1.js     One-off script to move data from an old KV-only v7 deployment into D1
  src/index.js            API routes, auth, vulgarity filter, AI marking, D1/KV data layer
  src/frontend.js         The entire pupil + teacher web app (HTML/CSS/JS), served at "/"
  src/seed-topics.js      12 starter topic/picture cards (each with 3 questions)
  src/vulgarity-list.js   Starter profanity word list used to mask pupil text
  tests/                  Node test scripts (see below)
  README.md               You are here
```

The five test scripts are optional and are not deployed with the Worker.
They need Node 18+ and one dev dependency (`npm install jsdom`), then:

```
node tests/retry-backend.test.mjs        # retry rules against a fake D1/KV + fake AI provider
node tests/retry-frontend.test.mjs       # renders the real page in jsdom and drives the retry flow
node tests/ai-reliability.test.mjs       # the AI reliability layer: every failure category, cooldowns, failover
node tests/submissions-remark.test.mjs   # pupil Submissions view + AI re-mark, including the leaderboard hand-off
node tests/teacher-override.test.mjs     # teacher score override, pupil-aggregate recompute, visibility lock-in
node tests/two-unit-marking.test.mjs     # v7.5: 2 marking units, combined Q2+Q3 call, redaction, re-mark/override, legacy rows, CSV
node tests/two-unit-frontend.test.mjs    # v7.5: jsdom - pupil sees overall score only, teacher sees breakdown, second rubric box
node tests/v76-backend.test.mjs          # v7.6: coach tips, strengths/next step, history filters, rubric test, insights
node tests/v76-frontend.test.mjs         # v7.6: jsdom - nudges, coach tips, history filters, teacher summary, rubric tools, insights
```

`teacher-override.test.mjs` drives the real
`/api/teacher/submissions/:id/override-score` handler, and checks: overriding
a question on an already-AI-marked, leaderboard-counted submission updates
its score/feedback and recomputes the pupil's aggregate immediately, without
touching `markedBy`/`gradingDegraded`/`leaderboardCounted`; the pupil
aggregate's `bestScore` correctly drops back down (not just up) when the
overridden submission was that pupil's highest, computed fresh from their
submissions rather than nudged incrementally; the very first pre-override
score survives as `originalScore` across any number of further overrides;
overriding a still-`"fallback"` question changes its score but leaves the
submission exactly as un-AI-assessed as before - explicitly re-verified to
still be invisible on the shared leaderboard-submissions list even after the
override; a practice submission never reaches the leaderboard via override
either; score/roundIndex validation rejects out-of-range and non-numeric
input without changing anything; authorization matches the other submission-
detail actions (class-scoped vs. super-admin teacher, never a pupil); and a
standalone set of checks locks in the visibility rule itself - a pupil can
never see another pupil's submission, in any form, until every question on
it has actually been assessed by AI.

`submissions-remark.test.mjs` drives the real `/api/submissions/leaderboard`,
`/api/submissions/mine`, and `/api/submissions/:id/remark` handlers against
an in-memory D1 stand-in, and checks: a fully AI-down submission is created
but stays off the public leaderboard-submissions list while still showing up
in the pupil's own history; re-marking one question at a time updates its
score without joining the leaderboard until the *last* offline-scored
question clears, at which point the pupil aggregate/history update exactly
once; re-marking an already-AI-marked question is a safe no-op with no
wasted API call; a still-down remark attempt changes nothing and reports
`success:false`; a practice submission never joins the leaderboard even once
fully re-marked; authorization is enforced for both the submission's own
pupil and a class-scoped vs. super-admin teacher; `coachUsed` is stripped
from every pupil-facing response; and the class filter and pagination on
the leaderboard-submissions list behave correctly.

`ai-reliability.test.mjs` drives the real `/api/submit` handler with a
scripted fake `fetch` that returns specific HTTP statuses/bodies per
provider, and checks: a 429 fails over within the same provider (different
key) rather than jumping providers; a 401/404 is never retried against the
same key and cools it down; a timeout and a raw network failure both fail
over cleanly; a Gemini safety block (HTTP 200, no error, just a
`finishReason`) is detected and not retried; malformed JSON fails over
instead of crashing; a context-length error re-prioritizes remaining
candidates by context window; a provider's `Retry-After` is honored as a
cooldown floor; a cooldown from one request is still in effect on the very
next request in the same process; total provider failure still returns a
result via the offline scorer; and the new `/api/teacher/ai-health`
endpoint reports cooldown state without ever leaking a key.

The backend script stands up an in-memory stand-in for D1 and KV and a fake
Workers AI binding, then exercises the real `/api/submit` and retry-policy
handlers: one-retry-per-attempt, retry-of-a-retry, same-session, ownership,
the global/per-class toggle and its permissions, practice inheritance, and the
UNIQUE-index race. The frontend script loads the actual served HTML into jsdom
and clicks through result screen → Try Again → copy previous → edit → resubmit
→ before/after panel, in both TREES and single mode.

## Deploying without a terminal

Everything below assumes the Wrangler CLI. If you'd rather deploy entirely
from your browser — no command prompt, no local installs — see
**[BROWSER_DEPLOY_GUIDE.md](./BROWSER_DEPLOY_GUIDE.md)** instead, which
covers the same setup (D1 database, KV namespace, secrets, teacher password)
using only the Cloudflare and GitHub web dashboards. Cloudflare's dashboard
can create a D1 database and run schema.sql through its built-in SQL
console, so this doesn't require the CLI either.

## Deploying on Firebase instead

If you'd rather run this on Firebase (Firestore + Cloud Functions) instead
of Cloudflare — e.g. to keep it consistent with other Firebase-hosted
projects — see **[firebase-backend/FIREBASE_DEPLOY_GUIDE.md](./firebase-backend/FIREBASE_DEPLOY_GUIDE.md)**.
It's a full port exposing the identical REST API, so `frontend.js` is
shared unchanged between both deployment targets.

## 1. Prerequisites

- A Cloudflare account (free tier works)
- Node.js installed locally
- `npm install -g wrangler` (Cloudflare's CLI), then `wrangler login`
- A free Google Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
  (used as the main AI marker — see step 4)
- Optionally, a free Groq API key from [console.groq.com](https://console.groq.com)
  as a second-line marker

## 2. Create the D1 database and KV namespace

D1 holds everything except session tokens (topics, submissions, pupils,
teacher-admins, settings). KV holds only `session:*` entries now, since KV's
free automatic expiry (`expirationTtl`) is a better fit for those than D1.

```bash
cd just-a-chit-chat
wrangler d1 create chitchat-v7
```

Copy the `database_id` it prints into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`. Then apply the schema:

```bash
wrangler d1 execute chitchat-v7 --remote --file=schema.sql
```

Now the KV namespace, for sessions:

```bash
wrangler kv:namespace create CCv6_DATA
```

Copy the `id` it prints into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

## 3. Set the teacher password (stored in D1, never in code)

```bash
wrangler d1 execute chitchat-v7 --remote --command="INSERT INTO config (key,value) VALUES ('teacher_password','choose-a-strong-password') ON CONFLICT(key) DO UPDATE SET value=excluded.value"
```

The app hashes this the first time someone logs in with it (salted SHA-256)
and overwrites the plaintext row - same behaviour as the old KV version, just
in a D1 table instead of a KV key.

Only the login name **palpatine** unlocks the password prompt for full
Teacher Tools admin — any pupil typing that name (or any other name) never
sees a hint that it's special unless they already know it. Teachers can
change palpatine's password later from inside **Teacher Tools → Settings**
without redeploying.

## Upgrading from KV-only v7

If you already have a v7 deployment running on the old KV-only layout (i.e.
you deployed the previous `chitchat_v7.zip` before this D1 version existed),
don't skip straight to a fresh install - your existing topics, submissions,
pupil scores, and any teacher-admin accounts you created are sitting in that
old KV namespace and won't just appear in the new D1 database on their own.

1. Deploy this v7-d1 code and run `schema.sql` against your D1 database
   (steps 2-3 above) - but don't wipe or recreate your old KV namespace yet.
2. Run the migration script (needs Node.js and the Wrangler CLI, logged in):
   ```bash
   node migrate-kv-to-d1.js
   ```
   This reads every `topic:*`, `submission:*`, `pupil:*`, `teacheradmin:*`,
   and `config:*` entry out of your old KV namespace (binding `CCv6_DATA`,
   same name as before - open the script if you renamed it) and writes a
   `migration.sql` file. It doesn't change anything remotely by itself.
3. Look over `migration.sql` if you want, then apply it:
   ```bash
   wrangler d1 execute chitchat-v7 --remote --file=migration.sql
   ```
4. Spot-check Teacher Tools (Submissions, Pupils, Leaderboard, Admins) to
   confirm everything landed, then redeploy so the Worker is running this
   D1-backed `index.js` for real traffic.
5. Your old KV namespace's `topic:*`/`submission:*`/`pupil:*`/`teacheradmin:*`/
   `config:*` keys are now unused (only `session:*` keys in that same
   namespace are still read) - safe to leave alone or clean up later, no
   rush either way.

## Roles: palpatine vs teacher admins (v7)

There are now two kinds of teacher login:

- **palpatine** — the one super-admin account, set up above. Full access
  to every class, plus the only account that can open Topics, Settings, and
  the new Admins tab.
- **Teacher admins** — created from **Teacher Tools → Admins** (palpatine
  only). Each has their own username/password and a list of assigned
  classes (e.g. `5IG, 5HP`). They log in the same way — type their username
  as their "name" on the main login screen, then enter their password —
  and land in Teacher Tools scoped to just those classes: Leaderboard,
  Submissions and Pupils only show pupils in their assigned classes, and
  "Reset Entire Leaderboard" only resets pupils in their own classes.
  Topics and Settings are hidden for them, since those are global and
  affect every class.

Nothing else about pupil login changes: pupils still just type
`Name@Class` (e.g. `Jovan@5IG`) or just `Name` if class isn't needed.

## 4. AI marking: a provider-aware reliability layer (v7.2)

Every question in a submission is marked by the same **reliability layer** —
not a fixed "try key 1, then key 2, then key 3" list. It understands
providers, models and keys as separate things with their own capabilities
and failure modes, classifies every failure into one of a fixed set of
categories, and reacts differently depending on which one it hit:

| What happened | What the layer does |
|---|---|
| Rate limited (429) | Cools that key down (honoring `Retry-After` if the provider sent one) and moves to the next candidate. One short in-place retry with backoff+jitter first, in case it clears immediately. |
| Provider overloaded (5xx/503) | Same as rate-limited — brief in-place retry, then cooldown and fail over. |
| Timeout / network failure | Every HTTP call is wrapped in a 20-second timeout (`AI_REQUEST_TIMEOUT_MS`); a hang or a dropped connection fails over exactly like any other transient error, one retry then cooldown. |
| Auth failure (401/403) | **No retry** — a bad key won't fix itself by asking again. Cools that key down for 30 minutes (growing on repeat failures, capped at 6 hours) and moves on. |
| Model not found (404) | Same as auth — that model id is wrong or deprecated, so it's cooled down for an hour (up to 24h), not retried every request. |
| Invalid request (400, generic) | Logged and cooled down for a while (likely a misconfigured model id a teacher typed into Settings) rather than retried forever. |
| Context/token limit exceeded | Classified distinctly from a generic 400. The *remaining* candidates for this question are re-sorted by descending context window, so a bigger-context model gets tried next regardless of its normal provider-priority position. |
| Content/policy rejection | Detected even when the provider returns HTTP 200 (Gemini reports a safety block as a normal response with `finishReason: SAFETY` and no text) — not retried against the same key, since asking again won't change a policy decision. |
| Malformed/unusable response | Invalid JSON, or valid JSON missing the expected `breakdown` array, is treated as its own failure category and fails over — never silently accepted or allowed to crash marking. |

**Providers, models, and keys are modelled as separate things.** A second
Gemini key is a second *account* for the *same* Gemini model — never
treated as equivalent to switching providers, and never used to route
around Gemini's own rate limits in a way that isn't just "our own second
free-tier account was also available." The provider list, in priority
order:

1. **Google Gemini** (up to 2 keys) — the only vision-capable provider here.
   When a Gemini attempt runs, it's sent the actual topic picture (fetched
   and base64-encoded server-side) so it can verify the Evidence (E1) part
   against what's really in the picture, not just judge plausibility.
2. **Groq** (up to 2 keys) — fast, free-tier Llama marking. Text-only — see
   "Picture Description" below for how it still marks Evidence sensibly.
3. **OpenRouter** (up to 2 keys) — text-only. **Only free models are ever
   allowed here** — see "Free models only" below.
4. **Cloudflare Workers AI** — free, built into this Worker via the `[ai]`
   binding in `wrangler.toml`, no signup needed, no key to configure. Also
   text-only. This is the final AI tier — if it fails too, the question
   falls back to the offline scorer (step 5).
5. If every candidate above fails on a first full pass — most likely a sign
   of transient rate-limiting across providers — the *entire candidate list
   is tried again* once more, after a short pause, before finally falling
   back to a simple offline rule-based keyword/relevance/language score for
   that one question. A candidate that was cooling down at the start of the
   first pass may well have cleared its cooldown by the second. A **45-
   second wall-clock budget** (`AI_MAX_TOTAL_MS`) covers the whole
   question, across both passes — if it's exhausted, marking drops straight
   to the offline scorer rather than risking a pupil's submission hanging
   indefinitely on one slow provider. This offline scorer is intentionally
   strict (it checks for on-topic content and specific keyword/grammar
   patterns, not just answer length), so it under-scores rather than
   over-scores while it's active — see the in-app AI status badge below.

Any tier with no key/binding configured is simply skipped, and questions are
marked **one at a time, not concurrently** — marking all 3 questions in
parallel would mean up to 3x the simultaneous requests hitting the same
provider/key, which is exactly what tends to trigger rate limits in the
first place. A short pause between questions spaces the load out further
still.

**Health tracking** (which key just failed, how many times in a row, and
until when it's cooling down) lives in memory for the life of the Worker
isolate — cheap and effective at not hammering a key that just failed
within a burst of traffic, but it does **not** persist across a cold start
and is **not** shared across every simultaneously-running edge isolate. A
durable, cross-isolate view of provider health would need a Durable Object
or KV-backed counters; this layer intentionally doesn't do that, since its
job is "don't immediately retry the thing that just failed," not "maintain
a long-term uptime dashboard."

**Teacher Tools → AI Health** shows a live, sanitized snapshot of every
configured provider/model/key: available or cooling down, how many seconds
remain, the last failure's category, and when it last succeeded — so a
teacher can see *why* marking got slower or fell back to offline scoring
instead of guessing. It never shows an API key, only which slot (key1/key2/
binding) is affected. Because the health data is isolate-local, it can look
emptier than reality right after a deploy or during a quiet period — that's
expected, not a bug.

A pupil never sees a raw provider error (`429 RESOURCE_EXHAUSTED`, `503`,
etc.) under any circumstance — every failure is absorbed by the layer above
and either recovered from automatically or turned into the plain "AI
unavailable" badge described below.


Pupils and teachers can always see which mode marked a given question: a
green **"AI connected"** badge means one of the AI providers marked it; a
red **"AI unavailable"** badge means it fell all the way through to the
offline scorer, and the score may be less accurate as a result. Non-practice
attempts that hit the offline scorer are also kept off the leaderboard.

### Picture Description (fallback for text-only providers)

Since only Gemini can actually see the picture, whichever provider ends up
marking a question when it isn't Gemini needs another way to judge whether
an Evidence (E1) claim is accurate. Teacher Tools → Topics → each topic has
an optional **"Picture Description"** field — describe what's actually in
the picture (not the topic in general), and Groq/OpenRouter/Workers AI will
use that text instead of guessing. If it's left blank, those providers are
told plainly that they can't see the picture and to mark Evidence on
plausibility/specificity only, without penalising for accuracy they can't
verify. This also matters if Gemini's own image fetch fails (broken link,
non-image response, image blocked by the host) — Gemini falls back to the
same description-based marking for that attempt.

### Uploading a picture directly (instead of pasting a URL)

Teacher Tools → Topics → each topic's editor has an **"Or Upload a
Picture"** file picker alongside the "Picture URL" field — use whichever is
easier; both end up in the same field. Choosing a file:

1. Reads it entirely in your browser (nothing is uploaded to any server yet).
2. Resizes and re-compresses it to JPEG, trying progressively smaller
   dimensions/quality (starting at 1600px/82% quality, stepping down as far
   as 640px/50% if needed) until it fits comfortably under Cloudflare D1's
   2 MB per-row limit as a base64 `data:` URL.
3. Fills the "Picture URL" field with that resulting `data:image/jpeg;base64,...`
   string and shows a preview — from here it behaves exactly like a pasted
   URL: hit "Save Changes"/"Add Topic" to actually store it, or "Remove
   Picture" to clear it and try a different one.

This is genuinely stored *in* the topic row in D1 (not uploaded to any
external image host), so there's no separate service to configure and no
broken-link risk — but it does mean each topic with an uploaded picture
takes up meaningfully more space in your database than one using a linked
URL (a linked URL is just a short string; an uploaded picture is the whole
compressed image, typically some hundreds of KB). At classroom scale (a
few dozen topics) this is a non-issue on D1's free tier (500 MB per
database) — see [D1's limits](https://developers.cloudflare.com/d1/platform/limits/)
if you're curious about the numbers. If an image still comes back "too
large" after the app's automatic compression (a very high-resolution photo,
or a screenshot with unusually poor JPEG compressibility), crop it or
resize it yourself before uploading, or use a hosted image URL instead.

### Set your Gemini key(s)

```bash
wrangler secret put GEMINI_API_KEY
wrangler secret put GEMINI_API_KEY_2
```

Paste keys from [Google AI Studio](https://aistudio.google.com/apikey) when
prompted. These are real credentials, so — unlike the teacher password —
they're stored as encrypted Worker **secrets**, never in D1, `wrangler.toml`,
or any source file. `GEMINI_API_KEY_2` is optional — set it only if you have
a second Gemini account/key you want tried as a backup when the first is
exhausted or rate-limited.

### Set your Groq key(s) (optional but recommended)

```bash
wrangler secret put GROQ_API_KEY
wrangler secret put GROQ_API_KEY_2
```

Paste keys from [console.groq.com](https://console.groq.com) when prompted.
Same rules as the Gemini keys — stored as encrypted secrets, never in source
or `wrangler.toml`. Both are optional; without either, marking just skips
Groq entirely and moves on to OpenRouter.

### Set your OpenRouter key(s) (optional but recommended)

```bash
wrangler secret put OPENROUTER_API_KEY
wrangler secret put OPENROUTER_API_KEY_2
```

Paste keys from [openrouter.ai/keys](https://openrouter.ai/keys) when
prompted. Both are optional — set `OPENROUTER_API_KEY_2` only if you have a
second OpenRouter account/key you want tried as a backup when the first is
exhausted or rate-limited. Without either key, OpenRouter is simply skipped
and marking moves on to Workers AI.

If a key was ever pasted somewhere insecure (a chat, a doc, a screenshot),
regenerate it in the relevant console — old keys can just be revoked with no
other cleanup needed.

### Free models only (OpenRouter)

OpenRouter is a paid platform in general, but it also hosts a number of
`:free`-tagged model variants, and provides
[`openrouter/free`](https://openrouter.ai/openrouter/free) — a special
router model that auto-picks a free model for you on every request
(filtering for whatever features that request needs). Since OpenRouter is
part of the marking chain for every question, the app is built to only ever
call free models on it, enforced twice:

1. **At save time** — Teacher Tools → Settings rejects any OpenRouter model
   ID that isn't `openrouter/free` or doesn't end in `:free`.
2. **At call time** — even if the `config` table's `model_openrouter` value
   were ever changed some other way (e.g. edited directly via D1's console),
   `aiScore()` re-validates it before every call and silently substitutes
   the safe default (`openrouter/free`) if it isn't a free model.

The default, `openrouter/free`, needs no maintenance as OpenRouter's
specific free-model lineup changes over time — it just keeps routing to
whatever's currently free. If you'd rather pin a specific model instead
(for more consistent behaviour, say), pick one from
[openrouter.ai/models?max_price=0](https://openrouter.ai/models?max_price=0)
— anything on that list will already have the `:free` suffix and pass
validation.

### Free tier notes

- **Gemini**: has a free tier (`gemini-2.5-flash` by default). Sending an
  image uses more of that quota per call than text alone. See
  [Google AI Studio's rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
  for current numbers.
- **Groq**: generous free-tier rate limits, no card required. See
  [Groq's docs](https://console.groq.com/docs/rate-limits) for current
  numbers.
- **OpenRouter**: rate limits vary by model, but only free models can be
  configured here at all (see "Free models only" above), so this tier stays
  free by construction. See [OpenRouter's docs](https://openrouter.ai/docs)
  for current free-tier rate limits.
- **Workers AI**: the Workers Free plan includes 10,000 "Neurons" of use per
  day, which comfortably covers normal classroom use. See
  [Cloudflare's Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
  for current numbers.

### Reducing rate-limit failures further

Questions already mark sequentially (not concurrently) with a short pause
between them, and each question retries its entire chain once more before
giving up (see the intro above) — between the two extra keys per provider
and this retry behaviour, AI marking should succeed the vast majority of the
time even on a free-tier setup. If you're still seeing the offline-scorer
badge often, the two constants worth adjusting are in `src/index.js`:
`AI_ATTEMPT_PAUSE_MS` (pause between individual provider attempts, and
between questions) and `AI_PASS_RETRY_PAUSE_MS` (pause before retrying the
whole chain) — both under `AI_MARKING_MAX_PASSES`. Raising either gives
rate limits more time to clear at the cost of slower marking.

### Changing models later

Edit the `model` string in `callGemini()` or `callWorkersAI()` in
`src/index.js` (e.g. to a newer release) and redeploy — these two aren't
teacher-configurable from Settings. The Groq and OpenRouter models **can**
be changed without redeploying — see Teacher Tools → Settings → "Groq
Marking Model" / "OpenRouter Marking Model".

## 4b. Language Use, filler words, and the model answer (v6)

Marking is no longer just content (TREES, 20 marks) — there's now a separate
**Language Use** score (5 marks, 25 total): Grammar Accuracy (0–2),
Vocabulary Range & Appropriateness (0–2), and Fluency & Delivery (0–1). It's
graded from the pupil's actual sentences, independently of how good their
ideas/experience are, so a pupil with a weak story but clean grammar (or
vice versa) is scored fairly on both.

- **Filler words**: the app counts filler words/phrases (um, uh, erm, like,
  you know, etc.) in the transcript and feeds that count into the Fluency
  score — either as evidence given to the AI marker, or as a direct
  deduction in the offline fallback. This is only as reliable as the
  browser's speech-to-text transcript, which is known to smooth over or drop
  disfluencies rather than transcribe them faithfully — treat it as a
  best-effort signal, not a precise measurement.
- **Model answer**: every AI-marked question now also returns a short
  rewritten version of the *pupil's own* answer — same content/experience,
  but with stronger grammar, added missing 5W1H detail, and better flow.
  Shown on the pupil's result screen and in the teacher's submission detail.
  The offline fallback can't generate this (no LLM to draw on), so it's
  simply omitted for those attempts.
- **Model answer length (v7)**: the rewrite is never allowed to be thinner
  than what the pupil actually wrote. The prompt now carries the pupil's own
  word count and demands at least 1.1× that (floor 60 words, ceiling ~220);
  after the response comes back the server re-counts the words, and if the
  rewrite falls short it makes **one** extra call to the same provider/key
  saying exactly how short it was — keeping the original scores, adopting
  only the longer rewrite. If that retry is still short (or fails), the
  "stronger version" panel is suppressed for that round rather than showing
  a pupil something weaker than their own answer. This matters more since
  v7's 7-attempt chain: weaker fallback models (Workers AI, free OpenRouter
  models) under-elaborate compared to Gemini, so without this the quality
  varied by whichever provider happened to answer. Stored rewrites are
  capped at 1,500 characters (was 900), trimmed at a sentence boundary.
- **Repeated-ideas penalty**: a flat 5-point deduction from the final score
  when a pupil's answers to all 3 questions turn out to reuse essentially
  the same story/idea. Detected deterministically (word overlap between all
  three answers), not by asking the AI, since each round is otherwise marked
  independently of the others. The pupil is told plainly in their feedback
  when this fires.
- The default rubric text (Teacher Tools → Settings → AI Marking Rubric) has
  been updated to include the Language Use criteria — if you'd previously
  customised the rubric, you'll want to add a Language Use section yourself,
  since custom rubric text fully replaces the default rather than merging
  with it.

## 4d. "Try Again" resubmissions

When Try Again is switched on, a pupil who has just seen their results gets a
**Try Again** button. It opens a screen showing, for each of the 3 questions,
their previous answer in a muted read-only box (with that question's score,
feedback, suggestion and model answer) and a blank box underneath for the new
attempt. A **Copy my previous answer** button drops the old text into the new
box if they'd rather edit than retype. Layout is stacked rather than
side-by-side columns, because two columns of answer text are unreadable on a
phone.

The rules, all enforced on the server and not just hidden in the UI:

- **One retry per attempt.** Not a retry of a retry, not two retries of the
  same first attempt. Also enforced by a UNIQUE index on `retry_of`, so two
  simultaneous resubmits (double-tap, two tabs) can't both get through.
- **Same session only.** The original must have been created at or after the
  pupil's current login. Nothing is re-fetched - the first attempt's full
  record is already in the browser from the results screen - and it keeps
  Try Again an in-the-moment revision rather than a way to farm old attempts.
- **Own attempt, same topic.** A pupil can only retry their own submission,
  on the topic it was for.
- **A retry is a genuinely new submission.** It's marked by the same AI chain,
  stored as its own row, and updates `attempts` / `totalScore` / `bestScore`
  exactly like a first attempt. It's linked back to the original only through
  the `retry_of` column, and is labelled **retry** in the Submissions tab and
  in the CSV export (`retryOf` column) so you can see which scores were second
  tries.
- **Practice is inherited.** A second try at a practice attempt stays practice
  (and stays off the leaderboard); a second try at a real attempt counts.
- **Mode is locked** to whatever the first attempt used (TREES branches or
  single box), since the previous answers are displayed in that shape.

The retry's own results screen adds a **before/after panel**: overall score
change (`12 → 18`). Since v7.5 this is the overall score only: pupils no
longer see per-question/per-unit scores (teachers still can). If the second
try scored lower, it says so plainly rather than spinning it.

**Teacher control** lives in Teacher Tools → **Try Again**, which is visible
to class-scoped teacher-admins as well as palpatine. There's one global
default (palpatine only) plus a per-class override of *Follow default / On /
Off*; a scoped teacher-admin sees the global setting read-only and can only
override their own assigned classes. An override wins in both directions, so
you can switch Try Again off for one class sitting a real assessment while
leaving it on everywhere else, or the reverse. Selecting "Follow default"
deletes the override rather than pinning today's value. **The default is ON**
- if you'd rather it stayed off until deliberately enabled, change the
`global` fallback in `getRetryPolicy` in `index.js`.

Note that the NPC Coach is deliberately not shown on the Try Again screen:
opening it triggers a re-render, which would wipe a half-written revision.
`coachUsed` is recorded as false for retries.

**Migration:** `submissions` gains a nullable `retry_of` column and a UNIQUE
index on it. A fresh `schema.sql` run creates both; an existing database needs
the two `ALTER TABLE` / `CREATE UNIQUE INDEX` commands at the bottom of
`schema.sql`, run **before** deploying the new Worker.

## 4e. Pupil Submissions view, and "AI re-mark" (v7.3)

A pupil gets a third tab, **Submissions**, alongside Play and Leaderboard,
with two views:

- **My Submissions** - every submission the pupil has ever made: practice,
  real, retries, even ones a teacher has archived from their own Submissions
  tab (archiving is a teacher-side organizational tool, not a way to erase a
  pupil's own record of their own work).
- **On the Leaderboard** - every submission, from any pupil in any class,
  that has actually contributed to the leaderboard - i.e. every non-practice
  attempt where all 3 questions ended up genuinely AI-marked. This is full
  detail: the pupil's real answers, the AI's feedback, and the model
  answer - not just a score. **This deliberately follows the same openness
  the leaderboard itself already has** (any logged-in pupil can already see
  every other pupil's real name, class and score, with no class restriction
  unless a class-scoped teacher-admin is asking). If you'd rather pupils
  only saw scores and not full answer text for other pupils' work, that's a
  straightforward follow-up change - it isn't built in as an option today.

Clicking **View** on either list opens the same read-only detail used
elsewhere in the app: each question's score, feedback, breakdown, and model
answer, plus the pupil's own answer text underneath.

**"AI re-mark"** is the other half of this: any question that fell all the
way back to the offline scorer (`markedBy: "fallback"` - shown with the
existing red "AI unavailable" badge) gets an **AI re-mark 🧠** button,
wherever that question is shown - the pupil's own just-submitted result
screen, either Submissions list, and the teacher's existing submission
detail view. Clicking it does exactly one thing: re-runs *that one question*
through the same AI reliability layer used at submission time (section 4),
using the answer exactly as originally submitted (already vulgarity-masked,
nothing to re-clean).

- If AI marking succeeds this time, that question's score, feedback,
  breakdown and model answer are updated in place, and the submission's
  final score is recalculated from all 3 questions (any repeated-ideas
  penalty that applied before still applies at the same fixed amount - the
  pupil's answer text hasn't changed, so there's nothing new to detect).
- **The moment the LAST offline-scored question is cleared** - all 3
  questions now genuinely AI-marked, and the submission isn't a practice
  attempt - it automatically joins the leaderboard: the pupil aggregate
  (`attempts`/`totalScore`/`bestScore`) and history are updated right then,
  exactly as they would have been at original submission time. A practice
  submission gets its score corrected the same way but never joins the
  leaderboard, matching the rule for a first attempt. This only ever
  happens once per submission - re-marking again later can't double-count it.
- If AI is still unavailable, nothing changes - the question stays exactly
  as it was, and the pupil sees a small message inviting them to try again
  shortly. Marking one question at a time, same as at original submission,
  means a re-mark click never bursts 3 simultaneous requests at a provider
  that may have just recovered from an outage.
- Re-marking is authorised the same way everywhere it appears: the
  submission's own pupil, or a teacher (a class-scoped teacher-admin only
  for their own assigned classes, palpatine for anything) - never a pupil
  re-marking someone else's work, even though they can now *view* it.

**Migration:** `submissions` gains a `leaderboard_counted` column (default
0), set once at submission time and flipped to 1 by whichever re-mark call
clears the last offline-scored question. A fresh `schema.sql` run creates
it; an existing database needs the `ALTER TABLE` / backfill `UPDATE` /
`CREATE INDEX` commands at the bottom of `schema.sql` - the backfill matters
here, since without it every submission made before this upgrade would be
invisible on the new "On the Leaderboard" list even though it's already
counted in the pupils table. Run this **before** deploying the new Worker.

**The visibility rule, stated plainly:** a pupil can never see another
pupil's submission unless `leaderboard_counted` is true for it - which, by
construction, means every one of its 3 questions was actually marked by a
real AI provider (never `"fallback"`), and it wasn't a practice attempt. A
teacher's score override (section 4f) never changes this on its own, even
when it's used on a question AI never got to - see that section for why.

## 4f. Teacher score override (v7.4)

Independent of AI re-marking, a teacher can now directly set a question's
score from the existing submission detail view (Teacher Tools →
Submissions → View): an **Override score ✎** button on any question opens
a small form with the current score and feedback pre-filled, editable, and
saveable. This works on any question - one AI already marked and the
teacher disagrees with, or one that's still sitting on an offline
`"fallback"` score and the teacher would rather just grade themselves right
now than wait for AI providers to recover.

A few deliberate design choices:

- **An override never touches `markedBy`, `gradingDegraded`, or
  `leaderboard_counted`.** Whether a question was actually assessed by AI
  stays a separate, honest fact from whatever score is currently showing.
  Concretely: overriding a still-`"fallback"` question updates its score
  right away, but the submission stays exactly as un-AI-assessed as before,
  which means it still won't appear on a classmate's "On the Leaderboard"
  list and still won't count toward that pupil's leaderboard totals (see
  the visibility rule in section 4e) - only an actual AI re-mark, or AI
  providers coming back up, changes that. If you want an override to
  *also* unlock the leaderboard for a question AI never reached, that's a
  deliberate decision this version doesn't make for you; say so and it's a
  small change.
- **The submission's final score is recomputed immediately** (average of
  the 3 questions, with any repeated-ideas penalty from the original
  submission still applied at the same fixed amount). **If the submission
  was already on the leaderboard** before the override (every question
  already AI-marked, non-practice), the pupil's aggregate
  (`attempts`/`totalScore`/`bestScore`) is recomputed too - not nudged up
  or down, but freshly derived from that pupil's actual leaderboard-counted
  submissions each time, so a correction can never leave a stale total
  sitting around, and `bestScore` correctly drops back down if the
  submission being corrected was the pupil's highest.
- **The original AI/offline score is never lost.** The first pre-override
  value is kept as `originalScore` on the round, preserved across any
  number of further overrides - so "what did AI actually give this" is
  always answerable later.
- Every round that's been touched shows an amber **"Score adjusted"** tag
  next to the usual AI-status badge - visible to the teacher (with who
  adjusted it), the submission's own pupil, and anyone who can see it on
  the shared leaderboard-submissions list, so nobody mistakes an
  overridden score for an untouched AI one.
- Authorised exactly like the other submission-detail actions: a class-
  scoped teacher-admin only for their own assigned classes, palpatine for
  anything. A pupil - even the submission's own owner - cannot call this
  endpoint; overriding is teacher-only.

No migration needed - the override fields (`overridden`, `overriddenBy`,
`overriddenAt`, `originalScore`) live inside the existing `rounds` JSON
column on each submission.

## 4c. Pupil tracking by name & class (v6)

Pupils can log in as just a name ("Ashraf"), or with a class using an `@`
sign ("Ashraf@5IG") so their teacher can track progress by class. This is
optional — a pupil who doesn't include a class is grouped under
"unassigned".

- **Teacher Tools → Pupils** — a new tab listing every pupil who's completed
  a scored attempt, each with a "View Progress" button showing their score
  trend over their last several attempts, and two auto-generated lists:
  **Strengths** and **Areas to grow**, computed by averaging each TREES/
  Language criterion across their history and flagging the highest/lowest.
  This is pure arithmetic on stored scores — no AI call involved.
  Both lists show up empty until a pupil has a few scored attempts to
  average.
- Only non-practice attempts that were fully AI-marked count toward this
  tracking (same rule as the leaderboard) — practice runs and offline-marked
  attempts aren't a reliable signal of the pupil's real ability, so they're
  excluded from both the trend and the strengths/concerns calculation.
- History is a capped rolling log (last 50 scored attempts per pupil, read
  back via `ORDER BY timestamp DESC LIMIT 50` in D1) so a pupil's progress
  view stays fast even after years of attempts pile up in `pupil_history`.
- Pupil identity is (name, class) — a D1 `UNIQUE(name, pupil_class)`
  constraint on the `pupils` table, same idea as the old
  `pupil:<class>:<name>` KV key scheme, just enforced by the database now
  instead of by key-naming convention. The same name can still appear in
  multiple classes as separate pupils.

## 5. The NPC Coach (sentence starters + resources)

Each of the 3 questions on a topic can have its own optional "Coach": a
short list of sentence starters, plus up to 2 teacher-picked links (article
or video). Pupils see a **"Ask the Coach"** button on a question only when
that question actually has starters or resources set — tapping it reveals
them.

- **Manually set by the teacher** — Teacher Tools → Topics → edit a topic →
  each question has its own "Coach sentence starters" box and 2 resource
  slots (title + link + type). There is deliberately no AI-generated link
  suggestion here: an LLM can produce a plausible-looking article or video
  URL that doesn't actually exist, so links are always the teacher's own,
  pasted in directly.
- **Video links are locked** — a YouTube link is embedded with autoplay
  restrictions and no related-video suggestions; when it ends, pupils see a
  "Watch Again" replay rather than YouTube's normal end-screen grid of other
  videos, so they only ever have a path to the one video the teacher chose.
  A non-YouTube video link falls back to a plain "opens in new tab" link
  instead (only YouTube gets the locked embed treatment).
- **Usage is flagged for the teacher, not the pupil** — if a pupil opens the
  Coach on a question, that's recorded against their submission (visible as
  a "Coach used" tag in Teacher Tools → Submissions, and as a
  `Q1/Q2/Q3_coachUsed` column in the CSV export) but pupils are never told
  this is tracked.
- **Pre-seeded examples** — the 12 built-in topics ship with real starter
  content and links pulled from public PSLE-oral-prep blogs (Lil' but
  Mighty, AGrader, illum.education, Learning Journey, Thinking Factory,
  doappliedlearning.com.sg) so you can see the feature working immediately.
  This seed data only loads into a brand-new, empty `topics` table (see
  `ensureSeeded()` in `src/index.js`) — if you're upgrading an existing
  deployment (including via the KV→D1 migration script), your current
  topics won't automatically pick up this coach content; add it via the
  Topics editor.

## 6. Deploy

```bash
wrangler deploy
```

Wrangler prints a `*.workers.dev` URL — that's the whole app. Share it with pupils.

## 7. Using it

**Pupils:** open the URL → type their name → pick a topic card. Each topic
has **3 questions** — pupils answer all 3 in one sitting, and each answer is
marked out of 25 by the AI. Before starting, they choose a response mode:
- **Separated TREES branches** — 5 labelled boxes per question (Thought,
  Reason, Evidence, Experience, Suggestion), with a tree that grows a leaf
  as each branch is filled in.
- **Single response box** — one free-text box per question, just like the
  real spoken exam. The AI still identifies and marks each TREES component
  within the continuous answer, using the same rubric.

After submitting all 3, pupils see their **final score** (the average of
the 3 question scores, out of 25) plus each individual question's score,
breakdown, and feedback — then check the leaderboard.

**Teacher:** open the URL → type `palpatine` (or a teacher-admin username) as
the name → enter the password → tabs appear. palpatine sees six tabs;
a teacher-admin (see "Roles" above) sees the first three, scoped to their
assigned classes:
- **Leaderboard** — view and reset scores (per pupil or all, or filter to one
  class). Scores shown are each pupil's average-of-3 session score, out of 25.
- **Submissions** — read every pupil's full session (all 3 questions, their
  answers, and per-question breakdowns), see anything the vulgarity filter
  caught, see which attempts were practice-only, delete entries, and
  **export everything as a CSV** (one click download — columns: pupil,
  topic, mode, practice yes/no, final score, flagged, archived, timestamp,
  then each of the 3 questions/answers/scores). Filter by class/topic, sort
  by newest/oldest/class/topic/score, and switch between Active/Archived/All.
  Tick rows (or "select all") and use **Archive Selected** to bulk-archive —
  archived submissions stay in the database and count in exports (when "All" or
  "Archived" is selected) but are hidden from the default Active view, so a
  term's worth of old entries can be tidied away without deleting anything.
- **Pupils** — browse pupils grouped by class, with a class filter, and drill
  into each pupil's progress history.
- **Topics** *(palpatine only)* — add new picture/topic cards (title, image
  URL, **3** examiner questions, tags) or edit/delete existing ones. All 3
  question fields are used as the 3 graded rounds, so fill in all of them.
- **Settings** *(palpatine only)* — change palpatine's password, edit the
  **AI marking rubric**, and choose the **Groq** and **OpenRouter marking
  models** (all below)
- **Admins** *(palpatine only)* — create, edit, or remove teacher-admin
  accounts and their assigned classes (see "Roles" above).

### Where to edit the rubric

Teacher Tools → **Settings** → two boxes (v7.5): "AI Marking Rubric —
Question 1" (key `rubric`, default `DEFAULT_RUBRIC`) and "AI Marking Rubric —
Questions 2 + 3 together" (key `rubric_q2q3`, default `DEFAULT_RUBRIC_Q2Q3`).
Whatever you type in the Question 1 box is sent to the AI marker for Question
1 of every submission from that point on; the Q2+Q3 box is sent with the
single combined call for Questions 2 and 3. The rest of this paragraph
applies to both — it's the actual scoring guidance the model follows. It's
stored in D1 (`config` table, key `rubric`), so no redeploy needed, and it applies
immediately to the next submission. Leave it blank and hit Save to fall back
to the built-in default rubric (also visible in `src/index.js` as
`DEFAULT_RUBRIC`). This only affects **AI marking** — if a question's entire
marking chain is unreachable (both passes through Gemini, Groq, OpenRouter,
and Workers AI), that question's scoring uses the offline keyword-based
fallback instead, which doesn't read the rubric.

### Where to change the Groq / OpenRouter models

Teacher Tools → **Settings** → "Groq Marking Model" / "OpenRouter Marking
Model" dropdowns. Pick one of the known models, or choose "Other" to type
any valid model ID directly — for Groq, see
[console.groq.com/docs/models](https://console.groq.com/docs/models) for the
current list; for OpenRouter, any model ID must end in `:free` (or be
`openrouter/free`) — see
[openrouter.ai/models?max_price=0](https://openrouter.ai/models?max_price=0)
for the current free-tier list, and "Free models only" above for why this is
enforced. These only change which model **Groq**/**OpenRouter** use — Gemini
and Workers AI keep their own fixed models, changeable only by editing
`src/index.js`. Stored in D1 (`config` table, keys `model_groq` /
`model_openrouter`), applies immediately, no redeploy needed. Leave it on
the default and hit Save (or hit Reset to Default) to go back to the
built-in defaults (`openai/gpt-oss-120b` for Groq, `openrouter/free` for
OpenRouter).

### Marking scheme (TREES + Language Use — PEEL has been removed)

Since v7.5 there are **two marking units** (see "What's new in v7.5" at the
top): **Unit 1 = Question 1** on the full scheme below, and **Unit 2 =
Questions 2 + 3 together** on Experience 16 + Suggestion 2 + Language Use 7
(Grammar 3, Vocabulary 3, Fluency 1). Both are out of 25. The table below is
Unit 1 (and every question of a pre-v7.5 submission).

Unit 1 is marked out of **25 marks total**: 20 for TREES content, 5
for a separate Language Use score.

| Part | Marks |
|---|---:|
| T — Thought | 2 |
| R — Reason | 2 |
| E — Example/Evidence (picture/topic) | 2 |
| E — Experience | **12** |
| S — Suggestion | 2 |
| **TREES subtotal** | **20** |
| Grammar Accuracy | 2 |
| Vocabulary Range & Appropriateness | 2 |
| Fluency & Delivery | 1 |
| **Language Use subtotal** | **5** |

The Experience part is itself broken into 5 sub-criteria that the AI marker
scores and sums (shown to pupils and teachers as a nested breakdown):
Relevance (2), 5W1H Specificity (6), Authenticity/Personal Voice (2),
Clarity & Sequence (1), Reflection/Lesson Learnt (1). The default rubric
instructs the AI not to reward length alone — a long but generic answer
should score low, while a short but specific, believable one scores well.
If an Experience answer lacks depth, the AI is instructed to name what was
missing (e.g. unclear place/date/people) and suggest 1–2 example experiences
the pupil could have shared instead, rather than just marking it down.

**Repeated-ideas penalty**: if a pupil's answers to all 3 questions reuse
essentially the same story/idea (checked deterministically via word overlap
across all three answers, not by the AI), a flat 5-point penalty is applied
to their final score, and the pupil is told plainly in their feedback that
this happened. This only fires when all three answers actually have enough
content to compare fairly — a blank or very short answer won't trigger it.

A pupil's **final score** for the practice session is the average of their
2 unit scores (each out of 25; 3 question scores on pre-v7.5 submissions),
rounded to 1 decimal place, minus the repeated-ideas penalty (if it applied)
once per attempt.

If a question's entire marking chain is unreachable (both passes through
Gemini, Groq, OpenRouter, and Workers AI), the built-in offline fallback
approximates this with simple keyword checks (pronouns, time/place words,
"because", sequence words like "then"/"in the end", reflection words like
"felt"/"learnt") — it's a rough stand-in, not real understanding, and the
app tells pupils that in the feedback text.

### Response modes: separated TREES vs single response box

Both modes are marked against the exact same 25-mark rubric:
- In **separated** mode, the AI marks each of the 5 labelled boxes directly.
- In **single response box** mode, the pupil writes one continuous answer
  (closer to a real spoken response), and the AI is instructed to read the
  whole thing and identify/mark each TREES component wherever it appears,
  scoring any genuinely missing component as 0.

This is a session-wide choice made once before starting (applies to all 3
questions in that sitting), not a per-question toggle.

### Practice mode

Pupils see a "Practice mode" checkbox above the Submit button. When ticked,
they still get full AI-marked scores and feedback for all 3 questions, and
the teacher can still see the attempt in Submissions (tagged "practice"),
but it is **not** added to their leaderboard total or best score. Useful for
warm-ups or re-tries before a graded attempt.

## Notes & things worth knowing

- **Vulgarity filter**: `src/vulgarity-list.js` is a starter list of common
  swear words (no slurs). Matches get masked with asterisks before being
  scored or stored, and the submission is flagged for the teacher. Extend
  the list by editing that file and redeploying.
- **Pictures**: the Topics tab takes a direct image URL (e.g. an Unsplash
  link, or an image uploaded to Cloudflare Images / Imgur / your school
  drive with a public link). This build doesn't do file uploads — pasting a
  URL keeps the Worker simple and free-tier friendly.
- **Data**: topics, submissions, pupils, pupil history, teacher-admins, and
  settings live in the `chitchat-v7` D1 database (see `schema.sql`); only
  session tokens live in the `CCv6_DATA` KV namespace. To wipe all app data,
  drop and recreate the D1 database (re-run steps 2-3, minus the KV part);
  to force everyone to log in again, delete and recreate the KV namespace.
- **Latency**: each submission now marks its 3 questions one after another
  (not concurrently, to avoid rate-limiting — see "AI marking" above), and
  each question can retry its entire provider chain once more before giving
  up, so expect several seconds of "Marking all 3 answers..." — longer than
  a fully-parallel design would take, but far more resistant to rate-limit
  failures. This is normal.
- **Cost**: with two free-tier keys each for Gemini, Groq, and OpenRouter,
  plus Workers AI as a final backstop, this whole app runs on free tiers for
  a single class — Workers, D1, KV, and all four AI providers have free
  daily allowances (OpenRouter only ever runs a `:free`-tagged model, see
  "Free models only" above). The only way you'd pay anything is if every
  single one of those 7 attempts hits its free-tier limit on both marking
  passes for the same question, which would need a very large or very
  active class to happen at all.
