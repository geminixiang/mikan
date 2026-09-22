#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";

const ADMIN_URL = process.argv[2];
const OUT = process.argv[3] ?? "/tmp/admin-audit";
const EXTRA_URLS = process.argv.slice(4);
const CDP_HTTP = "http://127.0.0.1:9222";

const WIDTHS = [
  { name: "mobile-390", width: 390, height: 844, dsf: 3, mobile: true },
  { name: "mobile-430", width: 430, height: 932, dsf: 3, mobile: true },
  { name: "tablet-768", width: 768, height: 1024, dsf: 2, mobile: true },
  { name: "tablet-1024", width: 1024, height: 768, dsf: 2, mobile: false },
  { name: "desktop-1440", width: 1440, height: 900, dsf: 1, mobile: false },
  { name: "desktop-1920", width: 1920, height: 1080, dsf: 1, mobile: false },
];

const PANES = [
  { scope: "conversation", pane: "settings" },
  { scope: "conversation", pane: "workspace" },
  { scope: "conversation", pane: "skills" },
  { scope: "conversation", pane: "mcp" },
  { scope: "conversation", pane: "events" },
  { scope: "global", pane: "g-overview" },
  { scope: "global", pane: "g-usage" },
  { scope: "global", pane: "g-settings" },
  { scope: "global", pane: "g-mcp" },
  { scope: "global", pane: "g-skills" },
  { scope: "global", pane: "g-events" },
];

mkdirSync(OUT, { recursive: true });

const target = await (await fetch(`${CDP_HTTP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", (err) => reject(err), { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) {
      reject(new Error(JSON.stringify(msg.error)));
    } else {
      resolve(msg.result);
    }
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");

const report = {};

for (const vp of WIDTHS) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: vp.dsf,
    mobile: vp.mobile,
    screenWidth: vp.width,
    screenHeight: vp.height,
  });
  await send("Page.navigate", { url: ADMIN_URL });
  await new Promise((r) => setTimeout(r, 1200));

  report[vp.name] = {};
  for (const { scope, pane } of PANES) {
    const ok = await evaluate(`(() => {
      const s = document.querySelector('.rail-scope-btn[data-tab="${scope}"]');
      if (s) s.click();
      const b = document.querySelector('.rail-link[data-pane="${pane}"]');
      if (!b || !b.offsetParent) return false;
      b.click();
      return true;
    })()`);
    if (!ok) {
      report[vp.name][pane] = "hidden";
      continue;
    }
    await new Promise((r) => setTimeout(r, 320));

    const metrics = await evaluate(`(() => {
      const d = document.documentElement;
      const offenders = [];
      document.querySelectorAll('body *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > d.clientWidth + 1) {
          offenders.push({
            tag: el.tagName,
            cls: (el.className||'').toString().slice(0,50),
            right: Math.round(r.right),
            w: Math.round(r.width),
            txt: (el.textContent||'').trim().slice(0,40),
          });
        }
      });
      // de-dup nested offenders: keep the outermost few
      const uniq = [];
      for (const o of offenders) {
        if (!uniq.some(u => u.tag === o.tag && u.cls === o.cls && Math.abs(u.right - o.right) < 3)) uniq.push(o);
      }
      return {
        viewport: d.clientWidth,
        scrollWidth: d.scrollWidth,
        overflowPx: d.scrollWidth - d.clientWidth,
        offenderCount: offenders.length,
        offenders: uniq.slice(0, 6),
      };
    })()`);
    report[vp.name][pane] = metrics;

    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/${vp.name}__${pane}.png`, Buffer.from(shot.data, "base64"));
  }

  for (const [i, url] of EXTRA_URLS.entries()) {
    await send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, 1200));
    const metrics = await evaluate(`(() => {
      const d = document.documentElement;
      const offenders = [];
      document.querySelectorAll('body *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > d.clientWidth + 1) {
          offenders.push({
            tag: el.tagName,
            cls: (el.className||'').toString().slice(0,50),
            right: Math.round(r.right),
            w: Math.round(r.width),
            txt: (el.textContent||'').trim().slice(0,40),
          });
        }
      });
      const uniq = [];
      for (const o of offenders) {
        if (!uniq.some(u => u.tag === o.tag && u.cls === o.cls && Math.abs(u.right - o.right) < 3)) uniq.push(o);
      }
      return {
        viewport: d.clientWidth,
        scrollWidth: d.scrollWidth,
        overflowPx: d.scrollWidth - d.clientWidth,
        offenderCount: offenders.length,
        offenders: uniq.slice(0, 6),
      };
    })()`);
    report[vp.name][`page-${i}`] = metrics;
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/${vp.name}__page-${i}.png`, Buffer.from(shot.data, "base64"));
  }
}

console.log(JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
ws.close();
await fetch(`${CDP_HTTP}/json/close/${target.id}`);
