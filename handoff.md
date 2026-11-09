# Just a Chit-Chat — hand-off after v8.0

Written when v8.0 was delivered. Part 1 says what v8.0 is and how to work on it. Part 2 scopes
**v8.1** (the one-page skill passport). Part 3 scopes **v8.2** (GUI improvements and graphics).
Part 4 is a QA checklist for real devices, and Part 5 lists known issues.

Estimates are rough working days for one developer who knows the codebase, to be used for ordering
rather than promising dates.

---

## 1. Where things stand (v8.0)

### 1.1 What v8.0 changed

| # | Change | Where it lives |
|---|---|---|
| 1 | Skill names on the radar are real buttons (tap, Enter, Space). Details panel moved directly under the chart. | `skillWebSvg(layers, {interactive, focusKey})`, `skillWebCardHtml`, click handler `skill-focus` |
| 2 | Result and retry panels lead with a plain-words sentence; chips are behind "See every skill". | `skillMovesHtml(now, ref, lead)`, `resultSkillWebHtml`, `retrySkillWebHtml` |
| 3 | Two-tone keyboard focus ring; chart labels draw their own ring; topic cards are keyboard buttons. | CSS block "v8.0", `topicGridHtml` |
| 5 | One-time hint with "Got it", remembered per pupil + class on the device. | `swHintHtml`, localStorage key `chitchat:swhint:v1:<name>\|<class>` |
| 7 | Built-in Skill Coach per skill, plus a "quest" (banner on the topic list, chip on the questions where the skill counts, "Quest check" on the result). | `SKILL_COACH`, `skillCoachPanelHtml`, `questBannerHtml`, `questChipHtml`, `questResultHtml` |
| 9 | Small skill shape beside every pupil in the teacher's Pupils list. | `GET /api/teacher/pupil-skills`, `computePupilSkillMinis`, `skillMiniSvg`, `pupilMiniHtml` |
| – | Fixed a defect from v7.10: the dotted gold "class average" line was 2.96:1 (under the 3:1 minimum for chart lines); now `#b5760f` at 3.69:1. A test now guards every chart line colour. | `skillWebSvg` |

### 1.2 Decisions worth knowing about

- **Focus ring.** The page already had a global `:focus-visible` ring. v8.0 adds a white halo (so the blue
  ring shows on green buttons: blue on forest green is only 1.14:1 on its own) and a drawn ring for SVG
  labels, since SVG ignores `box-shadow`. It also fixed a real gap: topic cards were `div`s with no
  keyboard access.
- **The Skill Coach is not the topic Coach.** The topic Coach is set by the teacher per question and
  quietly flags "Coach used" on attempts. The Skill Coach is generic, opened from My Progress, and does
  **not** touch `state.coachUsed` / `state.coachOpen` (a test guards this). Pupil-facing text never
  mentions the flag, to match the existing "pupils are not told" rule.
- **The quest is session-only** (`state.questSkill`). It clears on logout and is never stored or sent to
  the server. Skills marked only in Question 1 (Thought, Reason, Evidence) show their chip on Question 1
  only; the others show on all three.
- **The interactive chart is `role="group"`, not `role="img"`**, because an image role hides the buttons
  inside it. Non-interactive charts (result, report, Insights) keep `role="img"` plus a hidden table.
- **SVG elements have no `.click()`.** The global keydown handler now dispatches a click event for them.
- **Mini shapes** use the same rules as the full web (non-practice; parts marked by AI or a teacher; last
  5 usable attempts). The endpoint reads up to 3,000 recent submissions and sets `capped` if there were
  more; the UI does not yet show a "capped" notice.
- **Insights default view**: the Skill web, but the Heatmap when the server returns no skill-web data.

### 1.3 How the skill web works (read this before touching it)

Nothing about the web is stored. Every number is derived from each submission's stored `rounds` JSON on
every read, so an AI re-mark or a teacher override is reflected the next time it is requested.

```
rounds[].breakdown ──► skillsOfRounds()        one attempt: points / max per skill (+ Experience sub-skills)
                          │  skips rounds still marked only "fallback" (offline) unless overridden
                          │  scales criteria to the teacher's number when a round is overridden
                          ├─► computeProgressSeries()   entries[].skills, summary.skillWeb / skillWebAll
                          ├─► rowToSubmission()         submission.skills (owner + teacher only; see redactForPupil)
                          ├─► buildSkillReport()        teacher pupil report: latest / first / class average
                          ├─► computeSkillInsights()    class Insights: overall + byClass + byTopic
                          └─► computePupilSkillMinis()  Pupils list: one 8-number shape per pupil
```

Eight skills: Thought, Reason, Evidence, Experience, Suggestion, Grammar, Vocabulary, Fluency.
Thought / Reason / Evidence are marked in Question 1 only. The others are pooled across both units as
points / max. Window: last 5 usable attempts ("now") and the 5 before ("earlier").

**Privacy rule (keep it):** skill marks are marks. `redactForPupil` strips `skills` from any submission
that is not the pupil's own. The pupil progress JSON must not contain the words *teacher*, *coachUsed*,
*overriddenBy*, *originalScore* or *comment* (a v7.8 test checks this, which is why the counter is named
`staffMarked`).

### 1.4 Working on the front end (important)

`frontend.js` is a JavaScript module that builds the whole page as **arrays of JSON-escaped strings**.
There is no build step. Editing those strings by hand is error-prone, so the skill-web code was edited
as plain JavaScript and re-embedded. To repeat that:

1. Extract the block between `var SKILLWEB_JS = [` and the closing `];`, `JSON.parse` each line, and
   write the lines to a plain `.js` file.
2. Edit the plain file; run `node --check` on it.
3. Re-embed it with `JSON.stringify` per line, joined with `,\n`.
4. Run `node --check frontend.js`, then extract the page `<script>` from `PAGE_HTML` and `node --check`
   that too (a missing comma in the array only shows up there).

All pupil/teacher functions are global in one script, so order does not matter. CSS lives in the `HEAD`
string as `'...\n' +` lines; add new rules before the `@media print` block.

Tests: plain Node scripts in `tests/`, run one at a time (`node tests/v80-frontend.test.mjs`). Front-end
tests use jsdom (`npm install jsdom --no-save`); `tests/_fake.mjs` is the in-memory D1 used by the newer
backend tests. A full run is `for f in tests/*.test.mjs; do node $f || echo FAIL $f; done`.
All 20 test files pass at hand-off.

### 1.5 v8.0.1 — login artwork (added after the first v8.0 hand-off)

The two supplied sheets (10 portrait cards, 10 landscape banners) were cropped and shipped as WebP.

- **Files:** `login-art.js` (base64 pictures + their pixel sizes; generated) and a route in `index.js`
  (`loginArtResponse`, `/login-art/v1/<portrait|landscape>-<0..9>.webp`, one-year immutable cache, no database).
  `login-art.js` must be deployed next to `index.js`.
- **Page:** `loginArtIndex()` / `loginArtHtml()` in the `LOGINART_JS` block of `frontend.js`; a `<picture>`
  with an upright-orientation `<source>`. Sequence: random start, then +1 per page open and per logout,
  stored in `chitchat:loginart:v1`.
- **Alignment:** index n is the same animal in both sets (0 penguin, 1 cat, 2 squirrel, 3 robot, 4 turtle,
  5 crab, 6 panda, 7 winter penguin, 8 bunny); 9 is a cloud (portrait) or a fox (landscape).
- **Changing the pictures later:** replace the images, regenerate `login-art.js`, and bump
  `LOGIN_ART_VERSION` (it is in the URL, so browsers fetch the new set).
- **Quality limit:** the source sheets are small (each card was about 300 px wide), so the portrait art is
  stored at 288x480 and can look soft on high-density phone screens. Higher-resolution originals would fix
  this; no code change is needed, only new files.
- **Weight:** 550 KB for all 20 pictures inside the Worker bundle (about 730 KB as base64 text); a visit
  downloads one picture.

### 1.6 Not verified

Everything was tested in jsdom and by rendering the SVG to an image. **No real browser, phone or
Chromebook was used.** Part 4 is the checklist for that.

---

## 2. v8.1 scope — the one-page "Skill Passport"

### 2.1 Goal

A single printable (or save-as-PDF) page per pupil that turns the skill web into something a pupil can
keep, take home, or stick in a book: **who I am as a speaker, what is going well, what I am working on
next**.

### 2.2 Users and moments

- **Pupil**: prints or saves their own passport from My Progress (end of unit, before a parents' meeting).
- **Teacher**: prints one for a pupil from the pupil report, or **a whole class in one go** (one pupil per
  page, sorted by name).

### 2.3 Page content (A4 portrait, black-and-white safe)

1. Header: "My Skill Passport", pupil name, class, date printed.
2. **Character**: title from the strongest skill ("Storyteller"), overall level and level name.
3. **The skill web** (print variant: dash patterns, numbers on the chart) with its values table.
4. **Skills at a glance**: eight rows with level name and a bar (not colour alone).
5. **What is going well**: the two highest skills, one line each.
6. **My next quest**: the lowest skill, the tip, and the three Skill Coach sentence starters (reuse
   `SKILL_COACH`).
7. **My goal**: two ruled lines to write on by hand.
8. Footer: "Based on the last N counted attempts. Parts marked only offline are not included." plus
   "Teacher-marked parts included" when `staffMarked > 0`.

Pupils with no usable marks get a short "Not enough marks yet" page (single sentence and the quest tip),
or are skipped in the class batch. **Decision needed** (see 2.7).

### 2.4 Slices

| Slice | What | Backend | Est. |
|---|---|---|---|
| 8.1a | Pupil passport from My Progress | None: uses the existing `summary.skillWeb` + `summary.skillWebAll`. Pure front end. | 1–1.5 d |
| 8.1b | Teacher: passport from the pupil report; **class batch** | New `GET /api/teacher/passports?class=…` returning, per pupil: name, class, `skillWeb` (axes with `prevPct`, `sub`, `n`, `excludedRounds`, `staffMarked`). Build from `computePupilSkillMinis` extended; same class-scoping as `/api/teacher/pupil-skills`; cap ~60 pupils per request. | 1–1.5 d |
| 8.1c | *Optional*: a short teacher note for the pupil | New nullable column (migration) plus an edit box. **Do not reuse `teacherComment`** — see 2.6. | 1 d |

Suggested order: 8.1a, then 8.1b. Do 8.1c only if wanted.

### 2.5 Technical notes

- **Print mechanism.** Current print CSS hides everything with `visibility:hidden` and shows only
  `#pupilReport`, positioned `absolute`. Absolutely positioned content can be cut off after the first
  page in some browsers, so a multi-page class batch needs a different approach: in a `@media print`
  rule, `display:none` the app shell and render the passports in normal flow, each with
  `break-after: page`. Test by printing a 3-pupil class to PDF in Chrome and Firefox.
- **Window.** The app has no term-date setting that I found. Start with "last 5 counted attempts"
  (the web's own window). A "this term" option needs a stored term start date; if wanted, treat it as a
  separate small decision (a setting plus a date filter on the same queries).
- **Reuse.** `skillWebSvg`, `skillTableHtml`, `skillTopTitle`, `skillNextQuest`, `SKILL_COACH`,
  `skillLevel`. A passport should add layout, not new maths.
- **Fonts when printing.** Fonts come from Google Fonts with `display=swap`; if they have not loaded the
  passport prints in the fallback font. Consider waiting on `document.fonts.ready` before `window.print()`.

### 2.6 Privacy and safeguarding

- A pupil can only generate their own passport (their own session data).
- Teacher batch respects class assignment exactly like the other teacher endpoints.
- **Never print `teacherComment`, coach-use flags, flagged/integrity markers or override details.**
  Those are teacher-only. If a teacher note is wanted (8.1c), it must be a separate field that the
  teacher knowingly writes *for the pupil*.
- Language must stay positive: "next quest", not "weakness"; no ranking against classmates.
  The class-average layer is **not** shown on the pupil passport.

### 2.7 Decisions needed before building

1. Pupils with no usable marks in a class batch: print a "not enough marks yet" page, or skip them?
2. Should the pupil be able to type their own goal on screen before printing, or just ruled lines?
3. Is "last 5 attempts" enough, or is a "this term" window needed for 8.1?
4. Is 8.1c (teacher note) wanted, and who may write it (class teacher only, or any teacher)?

### 2.8 Acceptance criteria

- Pupil can open and print a one-page passport from My Progress; it fits one A4 page at default margins.
- Black-and-white print is fully readable (dash patterns, numbers on the chart, table of values).
- Class batch of 30 pupils renders and prints one page each with no cut-off or blank pages.
- A pupil whose only marks are offline-estimated gets the "not enough marks" treatment, never invented
  numbers. After a teacher override or AI re-mark the passport includes those parts the next time it is
  opened.
- No teacher-only data appears (test with a submission that has coach use, a comment and an override).
- Tests: backend (scoping, shape, cap, privacy) and front end (content, print container, no
  `undefined`/`NaN`), following `tests/v80-*.test.mjs`.

### 2.9 Risks

Print behaviour differs between browsers and Chromebooks (test on the real devices pupils use). Long
names or many characters can overflow the header. Pupils with very few marks give a misleading shape,
so show "based on N attempts" prominently.

---

## 3. v8.2 scope — GUI improvements and graphics

### 3.1 What the code shows today

Measured from the v8.0 code (not from looking at screens in a browser):

- **Palette**: 13 CSS variables (forest greens, gold, bark brown, sky). Fonts: Baloo 2 + Nunito from
  Google Fonts, so an offline or blocked device falls back to system fonts.
- **Icons are emoji.** About 77 emoji entities are used as icons. They look different on Apple, Windows,
  Android and Chromebook, and some skill icons render as tiny or monochrome on older devices.
- **Graphics**: only 7 inline SVGs and 6 `<img>` tags; no illustrations, empty-state art, or level
  graphics. Topic cards use teacher-supplied images or a flat sky-blue block.
- **Motion**: no `@keyframes` at all, and one `prefers-reduced-motion` rule.
- **Theme**: one light theme. No dark mode and no `forced-colors` / high-contrast handling. The skill web
  uses hard-coded hex colours inside the SVG, so it cannot follow a theme until those become CSS variables.
- **Responsive**: breakpoints at 640px and 480px only. Screens: login, pupil (Play / My Progress /
  Leaderboard / Submissions), teacher (many tabs).
- **Contrast** (computed): body text 12.4:1 and buttons 7.8:1 are fine. Muted text is 5.1:1 on white but
  **4.39:1 on the sky-blue panels** (under 4.5:1 for small text). Gold-dark text/lines on white is 3.03:1.
  The chart gridlines are decorative and faint on purpose (1.3–1.6:1).
- **Weight**: `frontend.js` is about 294 KB and `index.js` about 279 KB, with no build step.

### 3.2 Workstreams

**A. Design tokens and consistency sweep** (M, ~2 d)
Add tokens for spacing, type scale, radii and elevation next to the existing colour variables; give
buttons a clear hierarchy (primary, secondary, quiet, danger) and unify form fields, cards, pills and
empty states. Replace hard-coded values in the most used components first. Move the skill-web colours
into CSS variables (`--sw-now`, `--sw-before`, `--sw-class`) so later theming works.

**B. A real graphics set** (L, ~3–4 d, depends on a style decision)
- Replace emoji icons with one consistent inline-SVG icon set delivered as a single hidden `<symbol>`
  sprite (no network request): 8 skill icons, tab icons, status icons.
- **Five illustrated level graphics** for Seedling → Sprout → Sapling → Tree → Grand Oak, used on the
  character card, the skill list, the result "level up" line and the passport.
- **Empty-state illustrations**: no attempts yet, no web yet, no pupils, nothing to review.
- A friendlier topic placeholder. (The login hero now exists as the v8.0.1 artwork; if the style set in B differs from it, decide whether to restyle or keep it.)
- Style rules: rounded 2px strokes, the existing forest/gold palette, each icon under ~1.5 KB,
  decorative graphics `aria-hidden`, meaningful ones labelled.
- **Decision needed:** growing tree only (recommended: simple, consistent with the level names), or a
  character/mascot (needs a commissioned illustration set and agreement on tone for P3–P6 and up).

**C. Motion that helps** (S, ~1–1.5 d)
CSS-only: the web "grows" in when it first appears (~400 ms), a short leaf-burst when a level goes up
(shown once per result), pressed/hover states on buttons and rows, smoother panel open/close. Everything
respects `prefers-reduced-motion`. No sound, no libraries, nothing that blocks reading or typing.

**D. Layout and responsive pass** (M, ~2 d)
Phone at 360 px (the web's labels, the skill rows that wrap, quest banner), small tablets, Chromebooks,
landscape. Sticky tab bar on phones. Teacher tables: horizontal scroll containers and sensible column
priority. Long names and many-class teachers. Make the three screens feel like one family.

**E. Teacher dashboard polish** (M, ~2 d)
Insights: KPI tiles and small trend sparklines above the web/heatmap; Pupils: denser rows with the new
mini shapes, optional sort by a chosen skill; Needs-attention queue: clearer grouping. Consistent
loading skeletons and error states instead of bare text.

**F. Accessibility and theming** (S–M, ~1.5–2 d)
- Fix contrast: muted text on sky panels; gold lines/text to ≥3:1 (chart) and ≥4.5:1 (text).
- Add `forced-colors` support and a high-contrast option (recommended first); **dark mode is optional**
  and probably low value for classroom use, so treat it as a decision.
- Screen-reader pass (NVDA + VoiceOver) on the pupil flow; `aria-live` on results; 200 % zoom check.
- Language attribute and sensible heading order on every screen.

**G. Performance and delivery** (S, ~0.5–1 d)
Self-host or subset the fonts (or keep the CDN with a good fallback stack); lazy-load heavy teacher
screens; confirm total weight stays within a budget (suggest +40 KB over v8.0). No build step is introduced.

### 3.3 Suggested phasing

| Phase | Contents | Est. |
|---|---|---|
| 8.2a | A (tokens) + B (icons and level graphics) + skill-web colours to variables | ~5–6 d |
| 8.2b | C (motion) + empty states | ~1.5–2 d |
| 8.2c | D (responsive) + E (teacher polish) | ~4 d |
| 8.2d | F (accessibility, high contrast) + G (performance) | ~2–3 d |

Roughly 12–15 working days in total. 8.2a unlocks the rest, and the **style decision in B should be made
first**: it changes the amount of illustration work more than anything else.

### 3.4 Acceptance criteria (whole of v8.2)

- No emoji used as functional icons; the sprite icons render identically on a school Chromebook, an
  iPad and Windows.
- Every text colour meets 4.5:1 and every chart line / icon meets 3:1 against its background (add a
  contrast test like the one in `tests/v80-frontend.test.mjs`).
- All motion stops under `prefers-reduced-motion: reduce`; nothing animates on the typing screens.
- No horizontal page scroll at 360 px on any pupil screen; teacher tables scroll inside their own box.
- The skill web, passport and printed report remain readable in black and white.
- Existing behaviour and tests are unchanged apart from intended visual markup (a few tests match emoji
  text and will need updating).

### 3.5 Test approach

jsdom tests for structure, labels and tokens; contrast computed in tests; **rendered SVG snapshots**
(render with `cairosvg`, as was done to check the radar) for the level graphics and icons; and a manual
device matrix (Part 4). There is no real-browser CI, so budget a manual pass per phase.

### 3.6 Risks

- Replacing emoji touches roughly 77 sites and some tests that match emoji text.
- Illustration scope can balloon: fix the number of graphics and the style up front.
- Font loading differs on school networks: confirm what is reachable on the school's network before
  deciding between the CDN and self-hosting.
- The page is string-array based and large; keep new CSS and SVG compact and run the embedded-script
  syntax check after every change.

### 3.7 Decisions needed before starting

1. Tree-only or a mascot/character?
2. Who produces or approves the illustrations?
3. Dark mode: yes or no? High contrast: yes (recommended).
4. The device list to support (school Chromebooks, iPads, phones, projector).
5. Any school branding (colours, logo) to respect.

---

## 4. QA checklist for v8.0 on real devices

Do this on a phone, an iPad/tablet and a Chromebook, with at least one pupil that has a mix of marked and
offline-marked attempts.

- [ ] My Progress: web shows, labels are readable, none are cut off at 360 px width.
- [ ] Tap each label on the chart: opens the right skill; tap again: closes. The list row matches.
- [ ] With a keyboard only: Tab reaches each label, Enter/Space opens it, the blue ring is visible,
      and focus stays on the same label afterwards.
- [ ] First-use hint appears once; "Got it" hides it and it stays hidden after a reload; a second pupil on
      the same device still sees it.
- [ ] "Ask the Coach about …" shows three starters; "Practise this skill" sets the quest; banner on the
      topic list; chip on the right questions; "Quest check" on the result.
- [ ] Topic cards can be chosen with the keyboard.
- [ ] A result with a level-up reads sensibly; the chips open under "See every skill".
- [ ] Teacher Pupils: small shapes load, a pupil with no marks shows a dash, class filter works, and after
      an AI re-mark or override the shape updates on the next visit.
- [ ] Re-mark an offline part (pupil) and override a score (teacher): the web changes on the next view.
- [ ] Print the pupil report in black and white: the web is readable and the table is present.
- [ ] Login page: upright phone/tablet shows the portrait card, laptop shows the banner; the login box is
      reachable without much scrolling; reload ten times (or clear the saved value) to confirm the order.

---

## 5. Known issues and parking lot

- **Re-mark keeps the override tag.** An AI re-mark of a round a teacher had overridden replaces the
  teacher's score but leaves `overridden: true`, so the "Score adjusted" tag can still show. The skill web
  correctly follows the AI's number. A small fix, deliberately left alone as it predates this work.
- **Override spreading.** A teacher override sets one number for a whole unit; the skills inside are
  the marker's own shape scaled to it (`scaleBreakdownToScore`). The report and Insights say when this is
  included. If teachers want per-skill overrides, that is a bigger feature.
- **Few marks per skill.** Thought, Reason, Evidence and Suggestion are marked out of 1 or 2 per attempt,
  so a skill backed by one or two marks can swing. Suggested for v8.2: a small "few marks so far" cue.
- **Minis cap.** The Pupils list reads at most 3,000 recent submissions; the response sets `capped` but
  the UI does not show a notice yet.
- **Strongest / worth practising** on My Progress now ignore offline-estimated parts (changed in v7.10)
  so they agree with the web.
- **Existing figures unchanged:** the Insights heatmap, weekly trend and other analytics still use only
  fully AI-marked, non-practice submissions.
- **Test helper** `tests/_fake.mjs` gained pupil-aggregate support in v7.10 so the real AI re-mark path can
  be tested; keep it if you add similar tests.

---

## 6. File map

| File | What it is |
|---|---|
| `index.js` | Worker: API, marking, skill helpers (`SKILL_AXES`, `skillsOfRounds`, `buildSkillWeb`, `buildSkillReport`, `computeSkillInsights`, `computePupilSkillMinis`, `scaleBreakdownToScore`) |
| `frontend.js` | The whole UI as string arrays; the skill web lives in `SKILLWEB_JS` |
| `tests/v710-*.test.mjs` | Skill web: server rules, UI, re-mark and override updates |
| `login-art.js` | Generated: the 20 login pictures (base64 WebP) and their sizes |
| `tests/v801-login-art.test.mjs` | v8.0.1: picture route, login-page markup, random start and in-order sequence |
| `tests/v80-*.test.mjs` | v8.0: mini shapes endpoint; tappable chart, words-first summary, hint, Skill Coach and quest, minis UI, contrast |
| `README.md` | Release notes (v7.10 and v8.0 at the top) |
| `BROWSER_DEPLOY_GUIDE.md` | Deployment steps (no database step for v7.10 or v8.0) |
