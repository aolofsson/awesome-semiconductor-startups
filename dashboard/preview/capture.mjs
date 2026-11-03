// Capture the dashboard's panels as PNGs through the Chrome DevTools protocol,
// for compose.py to arrange into dashboard/preview.png (the README image).
//
// Usage: node capture.mjs <dashboard URL> <output dir> <chrome profile dir>
// Needs Node 22+ (built-in WebSocket) and google-chrome. Not run by CI.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [url, outDir, profile] = process.argv.slice(2);
const PORT = 9333;
const chrome = spawn("google-chrome", ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === "page"); }
  catch { await sleep(200); }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await send("Page.enable");
await send("Page.navigate", { url });
await sleep(6000);
const sels = { figures: "#figures", wafer: ".wafer-panel", tech: ".tech-panel", map: ".map-panel",
  founded: ".founded-panel", exityear: "#exit-year-chart", exitvalue: "#exit-value-chart",
  acquirers: "#acquirer-chart", age: "#age-chart" };
const r = await send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
  const out = {}; const s = ${JSON.stringify(sels)};
  for (const [k, q] of Object.entries(s)) { const el = q.startsWith('#') && !['#figures'].includes(q) ? document.querySelector(q).closest('figure') : document.querySelector(q);
    const b = el.getBoundingClientRect(); out[k] = { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height }; }
  return out; })()` });
const rects = r.result.result.value;
for (const [k, clip] of Object.entries(rects)) {
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...clip, scale: 1 } });
  writeFileSync(`${outDir}/${k}.png`, Buffer.from(shot.result.data, "base64"));
}
writeFileSync(`${outDir}/rects.json`, JSON.stringify(rects, null, 1));
ws.close(); chrome.kill();
console.log(Object.keys(rects).join(" "));
