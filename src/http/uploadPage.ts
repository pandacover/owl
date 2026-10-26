/**
 * The upload page. Served by the Cloudflare Worker in production (which
 * writes parts straight to R2) and by the owl server when running locally.
 * Both implement the same three calls under the page's own path:
 *   POST ./start     {name, size, type}              -> {id, key, uploadId, partSize}
 *   PUT  ./part?...  raw bytes of one part           -> {etag}
 *   POST ./complete  {id, key, uploadId, name, parts} -> {id, name}
 * Files are sent in parts, several at a time, so large phone videos upload
 * reliably and failed parts are retried on their own.
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
  <p>Add videos, music or images. Keep this page open until every file says done, then go back to Claude.</p>
  <label class="pick">Choose files<span>Video, audio or images, any size</span><input id="files" type="file" multiple></label>
  <ul id="list"></ul>
</main>
<script>
const base = location.pathname.replace(/\\/$/, "");
const list = document.getElementById("list");
const PARALLEL = 3;

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

function row(file) {
  const li = document.createElement("li");
  li.innerHTML = '<div class="row"><span class="name"></span><span class="state">waiting</span></div><div class="bar"><i></i></div><div class="id"></div>';
  li.querySelector(".name").textContent = file.name;
  list.appendChild(li);
  return {
    state: (s) => (li.querySelector(".state").textContent = s),
    progress: (p) => (li.querySelector(".bar i").style.width = Math.round(p * 100) + "%"),
    done: (id) => { li.className = "done"; li.querySelector(".id").textContent = "media id " + id; },
    failed: (msg) => { li.className = "failed"; li.querySelector(".id").textContent = msg; }
  };
}

async function upload(file, ui) {
  ui.state("starting");
  const start = await call("/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: file.name, size: file.size, type: file.type }) });
  const count = Math.max(1, Math.ceil(file.size / start.partSize));
  const parts = new Array(count);
  let sent = 0, next = 0;
  async function worker() {
    while (next < count) {
      const n = next++;
      const blob = file.slice(n * start.partSize, Math.min(file.size, (n + 1) * start.partSize));
      const q = "?key=" + encodeURIComponent(start.key) + "&uploadId=" + encodeURIComponent(start.uploadId) + "&part=" + (n + 1);
      const res = await call("/part" + q, { method: "PUT", body: blob });
      parts[n] = { partNumber: n + 1, etag: res.etag };
      sent += blob.size;
      ui.progress(sent / file.size);
      ui.state(Math.round((sent / file.size) * 100) + "%");
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, count) }, worker));
  ui.state("finishing");
  const done = await call("/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: start.id, key: start.key, uploadId: start.uploadId, name: file.name, parts }) });
  ui.state("done");
  ui.done(done.id);
}

document.getElementById("files").addEventListener("change", async (event) => {
  const files = [...event.target.files];
  event.target.value = "";
  for (const file of files) {
    const ui = row(file);
    try { await upload(file, ui); } catch (e) { ui.state("failed"); ui.failed(String(e.message || e)); }
  }
});
</script>
</body>
</html>
`
