/**
 * The upload page. Served by the Cloudflare Worker in production (which
 * writes parts straight to R2) and by the owl server when running locally.
 * Both implement the same three calls under the page's own path:
 *   POST ./start     {name, size, type}              -> {id, key, uploadId, partSize}
 *   PUT  ./part?...  raw bytes of one part           -> {etag}
 *   POST ./complete  {id, key, uploadId, name, parts} -> {id, name}
 * Files are sent in parts from one shared pool, so several files and parts go
 * out together and failed parts are retried on their own. Progress is kept in
 * localStorage, so after a reload picking the same file resumes the upload.
 */
export const uploadPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>owl upload</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f5f2; --card: #ffffff; --text: #1d1d1b; --muted: #6b6a66; --accent: #3a5bd9; --ok: #2f8a4c; --bad: #c2412d; --line: #e4e2dc; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151514; --card: #1f1f1d; --text: #ecebe7; --muted: #9a9892; --accent: #7d97ff; --ok: #5cc27d; --bad: #ff7a63; --line: #2e2e2b; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--text); }
  main { max-width: 560px; margin: 0 auto; padding: 28px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p { margin: 0 0 20px; color: var(--muted); }
  label.pick { display: block; border: 2px dashed var(--line); border-radius: 14px; padding: 28px 16px; text-align: center; background: var(--card); cursor: pointer; font-weight: 600; }
  label.pick span { display: block; font-weight: 400; color: var(--muted); font-size: 14px; margin-top: 4px; }
  input[type=file] { display: none; }
  ul { list-style: none; padding: 0; margin: 20px 0 0; display: grid; gap: 10px; }
  li { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
  .row { display: flex; justify-content: space-between; gap: 12px; font-size: 15px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { color: var(--muted); white-space: nowrap; }
  .done .state { color: var(--ok); }
  .failed .state { color: var(--bad); }
  .bar { height: 6px; border-radius: 3px; background: var(--line); margin-top: 8px; overflow: hidden; }
  .bar i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .2s; }
  .id { font: 13px ui-monospace, Menlo, monospace; color: var(--muted); margin-top: 6px; }
</style>
</head>
<body>
<main>
  <h1>Upload to owl</h1>
  <p>Add videos, music or images. Keep this page open with the screen on until every file says done, then go back to Claude. If the page reloads, pick the same file again and it continues where it stopped.</p>
  <label class="pick">Choose files<span>Video, audio or images, any size</span><input id="files" type="file" multiple></label>
  <ul id="list"></ul>
</main>
<script>
const base = location.pathname.replace(/\\/$/, "");
const list = document.getElementById("list");
const PARALLEL = 4;
const STORE = "owl-uploads:" + base;
const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; } })();
const persist = () => { try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch {} };
const fileKey = (f) => f.name + "|" + f.size + "|" + f.lastModified;
const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
let active = 0;
let wakeLock = null;
async function awake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && active > 0) { wakeLock = null; awake(true); } });
window.addEventListener("beforeunload", (e) => { if (active > 0) { e.preventDefault(); e.returnValue = ""; } });

async function call(path, init, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(base + path, init);
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      return await res.json();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}
// XHR reports bytes as they leave, so progress moves smoothly instead of jumping per part.
function sendPart(url, blob, onBytes) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", base + url);
    let last = 0;
    xhr.upload.onprogress = (e) => { onBytes(e.loaded - last); last = e.loaded; };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onBytes(blob.size - last); resolve(JSON.parse(xhr.responseText)); }
      else { onBytes(-last); reject(new Error(xhr.responseText || ("HTTP " + xhr.status))); }
    };
    xhr.onerror = () => { onBytes(-last); reject(new Error("Network error")); };
    xhr.send(blob);
  });
}
async function sendPartRetry(url, blob, onBytes) {
  for (let i = 0; ; i++) {
    try { return await sendPart(url, blob, onBytes); }
    catch (e) { if (i >= 4) throw e; await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); }
  }
}
function row(name) {
  const li = document.createElement("li");
  li.innerHTML = '<div class="row"><span class="name"></span><span class="state">waiting</span></div><div class="bar"><i></i></div><div class="id"></div>';
  li.querySelector(".name").textContent = name;
  list.prepend(li);
  return {
    state: (s) => (li.querySelector(".state").textContent = s),
    progress: (p) => (li.querySelector(".bar i").style.width = Math.round(p * 100) + "%"),
    note: (t) => (li.querySelector(".id").textContent = t),
    done: (id) => { li.className = "done"; li.querySelector(".bar i").style.width = "100%"; li.querySelector(".id").textContent = "media id " + id; },
    failed: (msg) => { li.className = "failed"; li.querySelector(".id").textContent = msg; },
    reset: () => { li.className = ""; }
  };
}
const rows = {};
for (const [k, u] of Object.entries(saved)) {
  const ui = rows[k] = row(u.name);
  if (u.mediaId) { ui.state("done"); ui.done(u.mediaId); }
  else {
    const have = Object.keys(u.parts || {}).length;
    ui.state("paused");
    ui.progress(have / Math.max(1, u.count));
    ui.note("Pick this file again to continue (" + have + " of " + u.count + " parts sent).");
  }
}

// One shared pool of part uploads, so several files and parts go out together.
const queue = [];
let workers = 0;
function pump() {
  while (workers < PARALLEL && queue.length > 0) {
    const job = queue.shift();
    workers++;
    job().finally(() => { workers--; pump(); });
  }
}
const enqueue = (fn) => new Promise((resolve, reject) => { queue.push(() => fn().then(resolve, reject)); pump(); });

async function upload(file, ui) {
  const k = fileKey(file);
  let u = saved[k];
  if (u && u.mediaId) { ui.state("done"); ui.done(u.mediaId); return; }
  if (!u) {
    ui.state("starting");
    const start = await call("/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: file.name, size: file.size, type: file.type }) });
    u = saved[k] = { name: file.name, id: start.id, key: start.key, uploadId: start.uploadId, partSize: start.partSize, count: Math.max(1, Math.ceil(file.size / start.partSize)), parts: {} };
    persist();
  }
  let sent = 0;
  for (const n of Object.keys(u.parts)) sent += Math.min(u.partSize, file.size - (Number(n) - 1) * u.partSize);
  const t0 = performance.now();
  const sent0 = sent;
  const show = () => {
    ui.progress(sent / file.size);
    const secs = (performance.now() - t0) / 1000;
    const rate = secs > 1 ? (sent - sent0) / secs : 0;
    const left = rate > 0 ? Math.round((file.size - sent) / rate) : 0;
    ui.state(Math.floor((sent / file.size) * 100) + "%");
    ui.note(mb(sent) + " of " + mb(file.size) + (rate > 0 ? " · " + mb(rate) + "/s" + (left > 0 ? " · about " + (left >= 90 ? Math.round(left / 60) + " min" : left + " s") + " left" : "") : ""));
  };
  show();
  const todo = [];
  for (let n = 1; n <= u.count; n++) if (!u.parts[n]) todo.push(n);
  await Promise.all(todo.map((n) => enqueue(async () => {
    const blob = file.slice((n - 1) * u.partSize, Math.min(file.size, n * u.partSize));
    const q = "?key=" + encodeURIComponent(u.key) + "&uploadId=" + encodeURIComponent(u.uploadId) + "&part=" + n;
    const res = await sendPartRetry("/part" + q, blob, (d) => { sent += d; show(); });
    u.parts[n] = res.etag;
    persist();
  })));
  ui.state("finishing");
  const parts = Object.keys(u.parts).map(Number).sort((a, b) => a - b).map((n) => ({ partNumber: n, etag: u.parts[n] }));
  const done = await call("/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: u.id, key: u.key, uploadId: u.uploadId, name: file.name, parts }) });
  u.mediaId = done.id;
  persist();
  ui.state("done");
  ui.done(done.id);
}
async function run(file) {
  const k = fileKey(file);
  const ui = rows[k] || (rows[k] = row(file.name));
  ui.reset();
  active++;
  awake(true);
  try { await upload(file, ui); }
  catch (e) {
    const msg = String(e.message || e);
    // The server forgot this upload (it restarted): start the file over.
    if (/Unknown upload|NoSuchUpload|does not exist/i.test(msg) && saved[k]) {
      delete saved[k]; persist();
      try { await upload(file, ui); } catch (e2) { ui.state("failed"); ui.failed(String(e2.message || e2)); }
    } else { ui.state("failed"); ui.failed(msg + " Pick the file again to retry."); }
  } finally {
    active--;
    if (active === 0) awake(false);
  }
}
document.getElementById("files").addEventListener("change", (event) => {
  const files = [...event.target.files];
  event.target.value = "";
  files.forEach(run);
});
</script>
</body>
</html>
`
