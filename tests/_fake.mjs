// Shared test helpers for the v7.8 / v7.9 suites: a small in-memory D1 + KV stand-in that understands
// ONLY the SQL these builds issue, plus request helpers. (Older suites keep their own fakes.)
import worker from "../src/index.js";

export const results = [];
export function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra))));
}
export function summary(name) {
  const failed = results.filter((x) => !x).length;
  console.log("\n" + name + ": " + results.filter(Boolean).length + " passed, " + failed + " failed");
  if (failed) process.exit(1);
}

const norm = (s) => s.replace(/\s+/g, " ").trim();
const lc = (x) => String(x == null ? "" : x).toLowerCase();

// opts.v79 = false simulates a database where the v7.9 migration has NOT been run (new columns missing).
export function makeDb(initialConfig, opts) {
  const o = Object.assign({ v79: true }, opts || {});
  const config = new Map(Object.entries(initialConfig || {}));
  const topics = [];
  const submissions = [];
  const pupils = [];
  const teacherAdmins = [];
  const V79_SUB = ["teacher_comment", "comment_by", "comment_at", "reviewed_at", "reviewed_by"];
  const log = [];

  function missingColumn(s) {
    if (o.v79) return false;
    return /teacher_comment|comment_by|comment_at|reviewed_at|reviewed_by|sort_order/.test(s);
  }
  function inScope(row, s, params) {
    // class scope used by v7.8/v7.9 queries: "LOWER(pupil_class) IN (?,?)" bound first
    const m = s.match(/LOWER\(pupil_class\) IN \(([?, ]+)\)/);
    if (!m) return { ok: true, used: 0 };
    const n = m[1].split(",").length;
    const set = params.slice(0, n).map(lc);
    return { ok: set.includes(lc(row.pupil_class)), used: n };
  }

  function run(sql, params) {
    const s = norm(sql);
    log.push(s);
    if (missingColumn(s)) throw new Error("no such column: (v7.9 migration not applied)");

    // ---- config ----
    if (/^SELECT value FROM config WHERE key = \?/.test(s)) return { first: config.has(params[0]) ? { value: config.get(params[0]) } : null };
    if (/^INSERT INTO config/.test(s)) { config.set(params[0], params[1]); return {}; }
    if (/^DELETE FROM config WHERE key = \?/.test(s)) { config.delete(params[0]); return {}; }

    // ---- v7.9 feature probe ----
    if (/^SELECT teacher_comment, reviewed_at FROM submissions LIMIT 1/.test(s)) return { first: null };
    if (/^SELECT sort_order FROM topics LIMIT 1/.test(s)) return { first: null };

    // ---- topics ----
    if (/^SELECT \* FROM topics WHERE id = \?/.test(s)) return { first: topics.find((t) => t.id === params[0]) || null };
    if (/^SELECT created_at FROM topics WHERE id = \?/.test(s)) { const t = topics.find((x) => x.id === params[0]); return { first: t ? { created_at: t.created_at } : null }; }
    if (/^SELECT \* FROM topics ORDER BY sort_order/.test(s)) {
      return { all: topics.slice().sort((a, b) => {
        const sa = a.sort_order == null ? 1e15 : a.sort_order, sb = b.sort_order == null ? 1e15 : b.sort_order;
        return sa - sb || a.created_at - b.created_at;
      }) };
    }
    if (/^SELECT \* FROM topics ORDER BY/.test(s)) return { all: topics.slice().sort((a, b) => a.created_at - b.created_at) };
    if (/^INSERT INTO topics \(id, title, image_url, image_description, questions, tags, coach, created_at, sort_order\)/.test(s)) {
      const [id, title, image_url, image_description, questions, tags, coach, created_at, sort_order] = params;
      const i = topics.findIndex((t) => t.id === id);
      const row = { id, title, image_url, image_description, questions, tags, coach, created_at, sort_order: i >= 0 ? topics[i].sort_order : sort_order };
      if (i >= 0) topics[i] = row; else topics.push(row);
      return {};
    }
    if (/^INSERT INTO topics/.test(s)) {
      const [id, title, image_url, image_description, questions, tags, coach, created_at] = params;
      const i = topics.findIndex((t) => t.id === id);
      const row = { id, title, image_url, image_description, questions, tags, coach, created_at, sort_order: i >= 0 ? topics[i].sort_order : null };
      if (i >= 0) topics[i] = row; else topics.push(row);
      return {};
    }
    if (/^UPDATE topics SET sort_order = \? WHERE id = \?/.test(s)) { const t = topics.find((x) => x.id === params[1]); if (t) t.sort_order = params[0]; return {}; }
    if (/^SELECT MAX\(sort_order\) as m FROM topics/.test(s)) return { first: { m: topics.reduce((m, t) => Math.max(m, t.sort_order == null ? -1 : t.sort_order), -1) } };
    if (/^DELETE FROM topics WHERE id = \?/.test(s)) { const i = topics.findIndex((t) => t.id === params[0]); if (i >= 0) topics.splice(i, 1); return {}; }

    // ---- submissions: single row / own history / linked retry ----
    if (/^SELECT \* FROM submissions WHERE id = \?/.test(s)) return { first: submissions.find((x) => x.id === params[0]) || null };
    if (/^SELECT \* FROM submissions WHERE retry_of = \?/.test(s)) return { first: submissions.find((x) => x.retry_of === params[0]) || null };
    if (/^SELECT \* FROM submissions WHERE LOWER\(pupil_name\) = LOWER\(\?\) AND LOWER\(pupil_class\) = LOWER\(\?\) ORDER BY created_at DESC LIMIT (\d+)/.test(s)) {
      const lim = Number(s.match(/LIMIT (\d+)/)[1]);
      const rows = submissions.filter((r) => lc(r.pupil_name) === lc(params[0]) && lc(r.pupil_class) === lc(params[1])).sort((a, b) => b.created_at - a.created_at);
      return { all: rows.slice(0, lim) };
    }
    // teacher-side pupil report (v7.9): one pupil's rows
    if (/^SELECT \* FROM submissions WHERE pupil_name = \? AND pupil_class = \? ORDER BY created_at DESC LIMIT (\d+)/.test(s)) {
      const lim = Number(s.match(/LIMIT (\d+)/)[1]);
      const rows = submissions.filter((r) => r.pupil_name === params[0] && r.pupil_class === params[1]).sort((a, b) => b.created_at - a.created_at);
      return { all: rows.slice(0, lim) };
    }
    // v7.9 queries built by buildSubmissionsFilter: needs-attention, alerts and analytics
    if (/^SELECT (\*|pupil_class, topic_title, rounds, final_score, max_score, created_at) FROM submissions WHERE /.test(s) && /ORDER BY created_at DESC( LIMIT \d+)?$/.test(s)) {
      const where = s.slice(s.indexOf(" WHERE ") + 7, s.indexOf(" ORDER BY"));
      let rows = submissions.slice();
      let pi = 0;
      const re = /LOWER\(pupil_class\) IN \(([?,]+)\)|LOWER\(pupil_class\) = LOWER\(\?\)|LOWER\(topic_title\) = LOWER\(\?\)|1 = 0|archived = (\d)|practice = 0|grading_degraded = 0|created_at >= \?|created_at <= \?/g;
      let m;
      while ((m = re.exec(where))) {
        const t = m[0];
        if (t.startsWith("LOWER(pupil_class) IN")) { const n = m[1].split(",").length; const set = params.slice(pi, pi + n).map(lc); pi += n; rows = rows.filter((r) => set.includes(lc(r.pupil_class))); }
        else if (t === "LOWER(pupil_class) = LOWER(?)") { const c = params[pi++]; rows = rows.filter((r) => lc(r.pupil_class) === lc(c)); }
        else if (t === "LOWER(topic_title) = LOWER(?)") { const c = params[pi++]; rows = rows.filter((r) => lc(r.topic_title) === lc(c)); }
        else if (t === "1 = 0") rows = [];
        else if (t.startsWith("archived")) rows = rows.filter((r) => r.archived === Number(m[2]));
        else if (t === "practice = 0") rows = rows.filter((r) => r.practice === 0);
        else if (t === "grading_degraded = 0") rows = rows.filter((r) => r.grading_degraded === 0);
        else if (t === "created_at >= ?") { const v = params[pi++]; rows = rows.filter((r) => r.created_at >= v); }
        else if (t === "created_at <= ?") { const v = params[pi++]; rows = rows.filter((r) => r.created_at <= v); }
      }
      const lim = Number((s.match(/LIMIT (\d+)$/) || [0, 1e9])[1]);
      rows.sort((x, y) => y.created_at - x.created_at);
      return { all: rows.slice(0, lim) };
    }
    // ---- v7.9 writes ----
    if (/^UPDATE submissions SET teacher_comment = \?, comment_by = \?, comment_at = \? WHERE id = \?/.test(s)) {
      const r = submissions.find((x) => x.id === params[3]); if (r) { r.teacher_comment = params[0]; r.comment_by = params[1]; r.comment_at = params[2]; } return {};
    }
    if (/^UPDATE submissions SET reviewed_at = \?, reviewed_by = \? WHERE id = \?/.test(s)) {
      const r = submissions.find((x) => x.id === params[2]); if (r) { r.reviewed_at = params[0]; r.reviewed_by = params[1]; } return {};
    }
    if (/^UPDATE submissions SET archived = \? WHERE id = \?/.test(s)) {
      const r = submissions.find((x) => x.id === params[1]); if (r) r.archived = params[0]; return {};
    }
    if (/^UPDATE submissions SET rounds = \?, final_score = \?, grading_degraded = \? WHERE id = \?/.test(s)) {
      const r = submissions.find((x) => x.id === params[3]); if (r) { r.rounds = params[0]; r.final_score = params[1]; r.grading_degraded = params[2]; } return {};
    }
    if (/^UPDATE submissions SET rounds = \?, final_score = \? WHERE id = \?/.test(s)) {
      const r = submissions.find((x) => x.id === params[2]); if (r) { r.rounds = params[0]; r.final_score = params[1]; } return {};
    }
    if (/^UPDATE submissions SET rounds = \? WHERE id = \?/.test(s)) {
      const r = submissions.find((x) => x.id === params[1]); if (r) r.rounds = params[0]; return {};
    }
    if (/^UPDATE submissions SET leaderboard_counted = 1 WHERE id = \?/.test(s)) {
      const r = submissions.find((x) => x.id === params[0]); if (r) r.leaderboard_counted = 1; return {};
    }
    // ---- pupils (teacher pupil view / progress report) ----
    if (/^SELECT \* FROM pupils WHERE name = \? AND pupil_class = \?/.test(s)) return { first: pupils.find((p) => p.name === params[0] && p.pupil_class === params[1]) || null };
    // ---- pupil aggregate (used by the AI re-mark path) ----
    if (/^SELECT id FROM pupils WHERE name = \? AND pupil_class = \?/.test(s)) { const p = pupils.find((x) => x.name === params[0] && x.pupil_class === params[1]); return { first: p ? { id: p.id } : null }; }
    if (/^INSERT INTO pupils \(name, pupil_class, best_score, total_score, attempts\) VALUES .* RETURNING id/.test(s)) { const p = { id: pupils.length + 1, name: params[0], pupil_class: params[1], best_score: 0, total_score: 0, attempts: 0 }; pupils.push(p); return { first: { id: p.id } }; }
    if (/^SELECT COUNT\(\*\) as attempts, COALESCE\(SUM\(final_score\), 0\) as total, COALESCE\(MAX\(final_score\), 0\) as best FROM submissions WHERE pupil_name = \? AND pupil_class = \? AND leaderboard_counted = 1/.test(s)) {
      const rows = submissions.filter((r) => r.pupil_name === params[0] && r.pupil_class === params[1] && r.leaderboard_counted === 1);
      return { first: { attempts: rows.length, total: rows.reduce((a, r) => a + r.final_score, 0), best: rows.reduce((m, r) => Math.max(m, r.final_score), 0) } };
    }
    if (/^UPDATE pupils SET attempts = \?, total_score = \?, best_score = \? WHERE id = \?/.test(s)) { const p = pupils.find((x) => x.id === params[3]); if (p) { p.attempts = params[0]; p.total_score = params[1]; p.best_score = params[2]; } return {}; }
    return { first: null, all: [] };
  }

  return {
    _state: { submissions, topics, pupils, teacherAdmins, config, log },
    prepare(sql) {
      return {
        bind(...p) { this._p = p; return this; },
        async first() { const r = run(sql, this._p || []); return r.first !== undefined ? r.first : null; },
        async all() { const r = run(sql, this._p || []); return { results: r.all || [] }; },
        async run() { return run(sql, this._p || []); },
      };
    },
  };
}

const sessions = new Map();
let counter = 0;
export function baseEnv(overrides, dbOpts) {
  counter++;
  return {
    CCv6_DB: makeDb({ model_groq: "test-groq-" + counter, model_openrouter: "test-or-" + counter + ":free" }, dbOpts),
    CCv6_DATA: { async get(k) { return sessions.get(k) || null; }, async put() {}, async delete() {} },
    ...overrides,
  };
}
export function login(token, session) { sessions.set("session:" + token, JSON.stringify(session)); }
export function loginAll() {
  login("pup1", { name: "Jovan", pupilClass: "5ig", role: "pupil", createdAt: Date.now() - 1000 });
  login("pup2", { name: "Mei", pupilClass: "5ig", role: "pupil", createdAt: Date.now() - 1000 });
  login("pup3", { name: "Jovan", pupilClass: "6ha", role: "pupil", createdAt: Date.now() - 1000 });
  login("admin", { name: "palpatine", role: "teacher", isSuperAdmin: true, createdAt: Date.now() - 1000 });
  login("scoped-in", { name: "mrslim", role: "teacher", isSuperAdmin: false, assignedClasses: ["5ig"], createdAt: Date.now() - 1000 });
  login("scoped-out", { name: "mrslam", role: "teacher", isSuperAdmin: false, assignedClasses: ["6ha"], createdAt: Date.now() - 1000 });
}
export async function call(env, method, path, token, body) {
  const headers = {};
  if (token) headers.authorization = "Bearer " + token;
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request("https://x.dev" + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, {});
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}
export const get = (env, path, token) => call(env, "GET", path, token);
export const post = (env, path, token, body) => call(env, "POST", path, token, body || {});

// ---- row builders ----
export const crit = (part, points, max, extra) => ({ part, points, max, note: "", ...(extra || {}) });
export function q1Round(score, extra) {
  return { unit: "q1", question: "Q1?", mode: "trees", answer: { parts: { T: "I think", R: "because", E1: "I see", E2: "Last week I helped", S: "we should" } }, score, max: 25,
    breakdown: [crit("Thought", 2, 2), crit("Experience", Math.min(12, Math.round(score / 2)), 12), crit("Grammar Accuracy", 2, 3)], feedback: "fb", suggestion: "s", strengths: "a", nextStep: "b",
    modelAnswer: "An improved first answer that is long enough to count here.", markedBy: "groq", coachUsed: true, ...(extra || {}) };
}
export function q23Round(score, extra) {
  return { unit: "q2q3", questions: ["Q2?", "Q3?"], question: "Q2: a | Q3: b", mode: "trees", answers: [{ parts: { E2: "I helped my friend", S: "teachers should help" } }, { parts: { E2: "He thanked me", S: "" } }],
    score, max: 25, breakdown: [crit("Experience", Math.min(16, Math.round(score * 0.6)), 16), crit("Suggestion", 1, 2), crit("Grammar Accuracy", 2, 3)], feedback: "fb2", suggestion: "s2", strengths: "a", nextStep: "b",
    observed: [{ part: "Thought", status: "Present" }], modelAnswer: "x", modelAnswers: ["Improved Q2 text here.", "Improved Q3 text here."], markedBy: "groq", coachUsed: false, coachUsedQuestions: [false, false],
    originalScore: score + 1, overriddenBy: "mrslim", overriddenAt: 123, ...(extra || {}) };
}
let rowN = 0;
export function subRow(o) {
  rowN++;
  const rounds = o.rounds || [q1Round(o.q1 == null ? 15 : o.q1), q23Round(o.q23 == null ? 15 : o.q23)];
  return {
    id: o.id || "sub_" + rowN, pupil_name: o.name || "Jovan", pupil_class: o.cls || "5ig", topic_id: o.topicId || "topic_1", topic_title: o.topic || "Helping Others",
    mode: "trees", rounds: JSON.stringify(rounds), final_score: o.final == null ? 15 : o.final, max_score: 25, practice: o.practice ? 1 : 0, grading_degraded: o.degraded ? 1 : 0,
    repeated_ideas_penalty: 0, archived: o.archived ? 1 : 0, flagged: o.flagged ? 1 : 0, created_at: o.at || Date.now() - rowN * 1000, retry_of: o.retryOf || null,
    leaderboard_counted: o.practice || o.degraded ? 0 : 1, ...(o.extra || {}),
  };
}
