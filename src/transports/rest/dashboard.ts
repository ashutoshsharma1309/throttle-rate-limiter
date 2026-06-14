/**
 * Self-contained live dashboard (no build step, no external JS deps). Served at
 * GET /. It provisions a demo tenant via the admin API, runs an in-browser load
 * generator against /v1/check, and visualises every decision in real time from
 * the /v1/events SSE stream.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Throttle — live rate limiter</title>
<style>
  :root { --bg:#0b0e14; --panel:#141925; --line:#222b3d; --txt:#c9d4e5; --mut:#7c8aa5;
          --ok:#27c08a; --no:#ef5a6f; --acc:#4c7dff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt);
         font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  header { padding:18px 24px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; }
  header h1 { font-size:18px; margin:0; letter-spacing:.5px; }
  header .tag { color:var(--mut); font-size:12px; }
  .wrap { max-width:1100px; margin:0 auto; padding:20px 24px; display:grid; gap:18px; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .card h2 { font-size:12px; text-transform:uppercase; letter-spacing:1px; color:var(--mut); margin:0 0 12px; }
  label { display:block; font-size:12px; color:var(--mut); margin:10px 0 4px; }
  input, select { width:100%; background:#0d1320; color:var(--txt); border:1px solid var(--line);
                  border-radius:6px; padding:8px 10px; font:inherit; }
  button { background:var(--acc); color:#fff; border:0; border-radius:6px; padding:9px 14px;
           font:inherit; cursor:pointer; margin-top:12px; }
  button.stop { background:var(--no); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .hint { color:var(--mut); font-size:12px; margin-top:8px; }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
  .stat { background:#0d1320; border:1px solid var(--line); border-radius:8px; padding:12px; text-align:center; }
  .stat b { display:block; font-size:24px; }
  .stat span { color:var(--mut); font-size:11px; text-transform:uppercase; letter-spacing:1px; }
  .stat.ok b { color:var(--ok); } .stat.no b { color:var(--no); }
  canvas { width:100%; height:160px; display:block; }
  .feed { height:230px; overflow:auto; font-size:12px; }
  .feed div { display:flex; gap:10px; padding:3px 0; border-bottom:1px solid #1a2233; white-space:nowrap; }
  .pill { padding:0 7px; border-radius:4px; font-weight:700; }
  .pill.ok { background:rgba(39,192,138,.15); color:var(--ok); }
  .pill.no { background:rgba(239,90,111,.15); color:var(--no); }
  .mut { color:var(--mut); }
  .ok-t { color:var(--ok); } .no-t { color:var(--no); }
  a { color:var(--acc); }
</style>
</head>
<body>
<header>
  <h1>⊟ Throttle</h1>
  <span class="tag">live rate limiter · atomic Redis Lua · token bucket + sliding window</span>
</header>
<div class="wrap">
  <div class="row">
    <div class="card">
      <h2>1 · Provision a demo tenant</h2>
      <label>Admin API key (the server's ADMIN_API_KEY)</label>
      <input id="admin" placeholder="paste ADMIN_API_KEY" />
      <button id="provision">Provision demo tenant + rules</button>
      <div class="hint" id="provStatus">Creates a tenant and two rules: <b>burst_api</b>
        (token bucket · cap 10 @ 5/s) and <b>free_tier</b> (sliding window · 100/min).</div>
    </div>
    <div class="card">
      <h2>2 · Generate load</h2>
      <label>Rule</label>
      <select id="rule" disabled>
        <option value="burst_api">burst_api — token bucket (cap 10 @ 5/s)</option>
        <option value="free_tier">free_tier — sliding window (100 / min)</option>
      </select>
      <label>Identifier (the bucket being limited)</label>
      <input id="ident" value="demo-user" disabled />
      <label>Target rate — <span id="rpsLabel">20</span> req/s</label>
      <input id="rps" type="range" min="1" max="50" value="20" disabled />
      <button id="toggle" disabled>Start load</button>
    </div>
  </div>

  <div class="card">
    <h2>Decisions / second (green = allowed, red = throttled)</h2>
    <canvas id="chart"></canvas>
  </div>

  <div class="row">
    <div class="card">
      <h2>Totals</h2>
      <div class="stats">
        <div class="stat"><b id="sTotal">0</b><span>total</span></div>
        <div class="stat ok"><b id="sOk">0</b><span>allowed</span></div>
        <div class="stat no"><b id="sNo">0</b><span>throttled</span></div>
        <div class="stat"><b id="sRps">0</b><span>req/s now</span></div>
      </div>
      <div class="hint">Every decision below streams live from <code>/v1/events</code> —
        including traffic from <code>curl</code> or gRPC, not just this page.</div>
    </div>
    <div class="card">
      <h2>Live feed</h2>
      <div class="feed" id="feed"></div>
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let apiKey = null, tenantId = null, running = false, timer = null;
let total = 0, ok = 0, no = 0;

// ── rolling per-second buckets for the chart (last 40s) ──
const SECONDS = 40;
const buckets = Array.from({length: SECONDS}, () => ({ ok: 0, no: 0 }));
let curSec = Math.floor(Date.now() / 1000);
function bucketFor(ts) {
  const sec = Math.floor(ts / 1000);
  const shift = sec - curSec;
  if (shift > 0) {
    for (let i = 0; i < Math.min(shift, SECONDS); i++) buckets.push({ ok: 0, no: 0 }), buckets.shift();
    curSec = sec;
  }
  return buckets[buckets.length - 1];
}

// ── stats / feed / chart from SSE ──
let lastSecCount = 0, rpsWindow = [];
function record(ev) {
  total++; ev.allowed ? ok++ : no++;
  $('sTotal').textContent = total; $('sOk').textContent = ok; $('sNo').textContent = no;
  const b = bucketFor(ev.ts); ev.allowed ? b.ok++ : b.no++;
  rpsWindow.push(ev.ts);
  addFeed(ev);
}
function addFeed(ev) {
  const f = $('feed');
  const t = new Date(ev.ts).toLocaleTimeString();
  const row = document.createElement('div');
  row.innerHTML =
    '<span class="mut">' + t + '</span>' +
    '<span class="pill ' + (ev.allowed ? 'ok' : 'no') + '">' + (ev.allowed ? 'ALLOW' : ' 429 ') + '</span>' +
    '<span>' + ev.rule + '</span>' +
    '<span class="mut">' + ev.identifier + '</span>' +
    '<span class="' + (ev.allowed ? 'ok-t' : 'no-t') + '">rem ' + ev.remaining + '/' + ev.limit + '</span>' +
    (ev.degraded ? '<span class="no-t">[degraded]</span>' : '');
  f.prepend(row);
  while (f.childElementCount > 60) f.removeChild(f.lastChild);
}

// ── canvas chart ──
const cv = $('chart'), ctx = cv.getContext('2d');
function resize() { cv.width = cv.clientWidth * devicePixelRatio; cv.height = 160 * devicePixelRatio; }
addEventListener('resize', resize); resize();
function draw() {
  const W = cv.width, H = cv.height, n = buckets.length;
  ctx.clearRect(0, 0, W, H);
  const bw = W / n, pad = bw * 0.15;
  let max = 1;
  for (const b of buckets) max = Math.max(max, b.ok + b.no);
  for (let i = 0; i < n; i++) {
    const b = buckets[i], x = i * bw + pad, w = bw - pad * 2;
    const okH = (b.ok / max) * (H - 4), noH = (b.no / max) * (H - 4);
    ctx.fillStyle = '#27c08a'; ctx.fillRect(x, H - okH, w, okH);
    ctx.fillStyle = '#ef5a6f'; ctx.fillRect(x, H - okH - noH, w, noH);
  }
  // current req/s = events in the last 1000ms
  const now = Date.now(); rpsWindow = rpsWindow.filter(t => now - t < 1000);
  $('sRps').textContent = rpsWindow.length;
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// ── SSE ──
const es = new EventSource('/v1/events');
es.onmessage = (m) => { try { record(JSON.parse(m.data)); } catch (e) {} };

// ── provisioning ──
$('provision').onclick = async () => {
  const admin = $('admin').value.trim();
  if (!admin) return setProv('Enter the admin key first.', true);
  setProv('Provisioning…');
  try {
    const tRes = await fetch('/v1/admin/tenants', { method: 'POST', headers: { 'x-api-key': admin } });
    if (!tRes.ok) throw new Error('admin key rejected (' + tRes.status + ')');
    const t = await tRes.json(); apiKey = t.apiKey; tenantId = t.tenantId;
    const rules = [
      { id: 'burst_api', body: { algorithm: 'token_bucket', capacity: 10, refillRate: 5 } },
      { id: 'free_tier', body: { algorithm: 'sliding_window', limit: 100, windowMs: 60000 } },
    ];
    for (const r of rules) {
      await fetch('/v1/admin/tenants/' + tenantId + '/rules/' + r.id,
        { method: 'PUT', headers: { 'x-api-key': admin, 'content-type': 'application/json' },
          body: JSON.stringify(r.body) });
    }
    setProv('✓ Tenant ready. Now start the load generator →');
    ['rule', 'ident', 'rps', 'toggle'].forEach(id => $(id).disabled = false);
  } catch (e) { setProv('✗ ' + e.message, true); }
};
function setProv(msg, err) { const el = $('provStatus'); el.innerHTML = msg; el.style.color = err ? '#ef5a6f' : ''; }

// ── load generator (fires from the browser; results come back via SSE) ──
$('rps').oninput = () => { $('rpsLabel').textContent = $('rps').value; if (running) restart(); };
$('toggle').onclick = () => running ? stop() : start();
function start() {
  running = true; $('toggle').textContent = 'Stop load'; $('toggle').classList.add('stop'); restart();
}
function stop() { running = false; clearInterval(timer); $('toggle').textContent = 'Start load'; $('toggle').classList.remove('stop'); }
function restart() {
  clearInterval(timer);
  const delay = 1000 / Number($('rps').value);
  timer = setInterval(fire, delay);
}
function fire() {
  if (!apiKey) return;
  fetch('/v1/check', { method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ rule: $('rule').value, identifier: $('ident').value }) }).catch(() => {});
}
</script>
</body>
</html>`;
