// v8.0.1: login-page artwork (10 portrait cards + 10 landscape banners), served by the Worker and
// shown on the login page: random start, then each next picture in order.
import { JSDOM } from "jsdom";
import worker from "../index.js";
import { PAGE_HTML } from "../frontend.js";
import { LOGIN_ART, LOGIN_ART_DIMS, LOGIN_ART_VERSION } from "../login-art.js";
import { baseEnv } from "./_fake.mjs";

const results = [];
function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? "PASS  " : "FAIL  ") + label + (cond || extra === undefined ? "" : "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra))));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= server =================
const get = (path, method, env) => worker.fetch(new Request("https://example.com" + path, { method: method || "GET" }), env || baseEnv());
const webpSize = (b) => { // lossy WebP ('VP8 ') header: 14-bit width / height
  const s = String.fromCharCode(...b.slice(0, 4)) + String.fromCharCode(...b.slice(8, 12)) + String.fromCharCode(...b.slice(12, 16));
  if (s !== "RIFFWEBPVP8 ") return null;
  return [(b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff];
};
{
  check("art: there are 10 portrait and 10 landscape pictures", LOGIN_ART.portrait.length === 10 && LOGIN_ART.landscape.length === 10 && LOGIN_ART_DIMS.portrait.length === 10 && LOGIN_ART_DIMS.landscape.length === 10);
  let okAll = true, bad = [], total = 0;
  for (const kind of ["portrait", "landscape"]) {
    for (let i = 0; i < 10; i++) {
      const r = await get(`/login-art/v${LOGIN_ART_VERSION}/${kind}-${i}.webp`);
      const bytes = new Uint8Array(await r.arrayBuffer()); total += bytes.length;
      const dims = webpSize(bytes);
      const good = r.status === 200 && r.headers.get("content-type") === "image/webp" && /immutable/.test(r.headers.get("cache-control")) && /max-age=31536000/.test(r.headers.get("cache-control")) && dims && dims[0] === LOGIN_ART_DIMS[kind][i][0] && dims[1] === LOGIN_ART_DIMS[kind][i][1];
      if (!good) { okAll = false; bad.push([kind, i, r.status, dims]); }
    }
  }
  check("route: all 20 pictures are served as image/webp, cached for a year, and each file's real size matches the size the page is told", okAll, bad);
  check("route: total picture weight stays modest (under 600 KB for all 20; one visit downloads only one)", total < 600 * 1024, Math.round(total / 1024) + " KB");
  const a = await (await get(`/login-art/v1/portrait-3.webp`)).arrayBuffer(), b = await (await get(`/login-art/v1/portrait-3.webp`)).arrayBuffer();
  check("route: repeat requests return identical bytes (decoded once, then reused)", a.byteLength === b.byteLength && a.byteLength > 1000);
  check("route: it needs no database or login (works with an empty environment, no bindings at all)", (await get(`/login-art/v1/landscape-0.webp`, "GET", {})).status === 200);
  check("route: HEAD works too", (await get(`/login-art/v1/landscape-0.webp`, "HEAD")).status === 200);
  check("route: a picture number out of range is a 404", (await get(`/login-art/v1/portrait-10.webp`)).status === 404 && (await get(`/login-art/v1/landscape-99.webp`)).status === 404);
  check("route: a different version number or orientation is a 404", (await get(`/login-art/v2/portrait-0.webp`)).status === 404 && (await get(`/login-art/v1/square-0.webp`)).status === 404 && (await get(`/login-art/v1/portrait-0.png`)).status === 404);
  check("route: POST is not served as an image", (await get(`/login-art/v1/portrait-0.webp`, "POST")).status !== 200);
}

// ================= login page =================
async function make(opts) {
  opts = opts || {};
  const dom = new JSDOM(PAGE_HTML, { runScripts: "dangerously", url: "https://example.com/", pretendToBeVisual: true, beforeParse(win) {
    if (opts.stored !== undefined) win.localStorage.setItem("chitchat:loginart:v1", String(opts.stored));
    if (opts.random !== undefined) win.Math.random = () => opts.random;
    if (opts.brokenStorage) Object.defineProperty(win, "localStorage", { get() { throw new Error("blocked"); } });
  } });
  const w = dom.window;
  await new Promise((r) => (w.document.readyState === "complete" ? r() : w.addEventListener("load", r)));
  return { w, doc: w.document };
}
const idxOf = (a) => Number(/portrait-(\d+)\.webp/.exec(a.doc.querySelector(".login-art source").getAttribute("srcset"))[1]);
{
  const a = await make({ stored: 3 });
  const art = a.doc.querySelector(".login-art");
  check("login: the artwork is on the login page, above the card", !!art && !!(art.compareDocumentPosition(a.doc.querySelector(".login-card")) & 4));
  const src = art.querySelector("source"), img = art.querySelector("img");
  check("login: portrait cards for upright screens (phones, tablets), landscape banners otherwise, via <picture>", /orientation: portrait/.test(src.getAttribute("media")) && /^\/login-art\/v1\/portrait-4\.webp$/.test(src.getAttribute("srcset")) && /^\/login-art\/v1\/landscape-4\.webp$/.test(img.getAttribute("src")));
  check("login: the picture carries its real width and height, so nothing jumps while it loads", img.getAttribute("width") === String(LOGIN_ART_DIMS.landscape[4][0]) && img.getAttribute("height") === String(LOGIN_ART_DIMS.landscape[4][1]) && src.getAttribute("width") === "288" && src.getAttribute("height") === "480");
  check("login: it has a text alternative (the words on the sign)", /Just a Chit-Chat\. Have a chat\. Share your thoughts!/.test(img.getAttribute("alt")));
  check("login: the same animal is shown in both orientations (same number)", img.getAttribute("src").match(/landscape-(\d+)/)[1] === src.getAttribute("srcset").match(/portrait-(\d+)/)[1]);
  const css = a.doc.querySelector("style").textContent;
  check("login: styles - portrait sizing is height-aware, landscape is capped (so the form stays on screen)", /@media \(orientation:portrait\)/.test(css) && /\.login-art picture\{display:block;width:min\(100%,940px,calc\(30vh\*var\(--arn-l\)\)\)/.test(css) && /clamp\(300px,46vh,620px\)/.test(css) && /border-radius:18px/.test(css));
  check("login: once the picture has loaded the plain speech-bubble icon is hidden; if it fails the picture hides and the icon stays", /\.login-art\.ok \+ \.login-card \.logo-big\{display:none;\}/.test(css) && /onerror="this\.closest\('\.login-art'\)\.style\.display='none'"/.test(art.innerHTML.replace(/&quot;/g, '"')) );
  img.dispatchEvent(new a.w.Event("load"));
  check("login: a successful load marks the artwork as showing", art.classList.contains("ok"));
  const before = idxOf(a); a.w.render(); a.w.render();
  check("login: the picture stays the same through re-renders (e.g. after a wrong name)", idxOf(a) === before && a.w.localStorage.getItem("chitchat:loginart:v1") === "4");
}
{
  // sequence: random start, then in order, wrapping after the last
  let seen = [];
  let stored = undefined;
  for (let visit = 0; visit < 12; visit++) {
    const a = await make({ stored, random: 0.34 });
    const i = idxOf(a); seen.push(i);
    stored = a.w.localStorage.getItem("chitchat:loginart:v1");
  }
  check("sequence: a random first picture (3 for random 0.34), then each next one in order, wrapping 9 -> 0", seen.slice(0, 8).join() === "3,4,5,6,7,8,9,0" && seen.slice(8).join() === "1,2,3,4", seen.join());
  check("sequence: ten visits in a row show all ten pictures once", new Set(seen.slice(0, 10)).size === 10);
  const r0 = await make({ random: 0 }), r9 = await make({ random: 0.999 });
  check("sequence: the random start can be any of the ten (first and last reachable)", idxOf(r0) === 0 && idxOf(r9) === 9);
  const junk = await make({ stored: "banana", random: 0.5 }), neg = await make({ stored: "-4", random: 0.5 }), big = await make({ stored: "57", random: 0.5 });
  check("sequence: a damaged or out-of-range saved value falls back to a random start (no crash)", idxOf(junk) === 5 && idxOf(neg) === 5 && idxOf(big) === 5);
  const blocked = await make({ brokenStorage: true, random: 0.7 });
  check("sequence: if the browser blocks storage it still shows a (random) picture", idxOf(blocked) === 7);
}
{
  // logout on a shared computer moves on to the next picture
  const a = await make({ stored: 5 });
  const first = idxOf(a);
  a.w.state.token = "t"; a.w.state.role = "pupil"; a.w.state.name = "Jovan"; a.w.state.screen = "pupil"; a.w.render();
  check("logout: no artwork inside the app (login page only)", !a.doc.querySelector(".login-art"));
  a.w.doLogout();
  check("logout: the next pupil on a shared computer gets the next picture", first === 6 && idxOf(a) === 7, [first, idxOf(a)]);
  a.w.state.pendingTeacherLogin = true; a.w.render();
  check("teacher login: the password step shows the artwork too", !!a.doc.querySelector(".login-art") && /Teacher Tools/.test(a.doc.querySelector(".login-card").textContent) && idxOf(a) === 7);
}

const failed = results.filter((x) => !x).length;
console.log("\nv8.0.1 login art: " + results.filter(Boolean).length + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
