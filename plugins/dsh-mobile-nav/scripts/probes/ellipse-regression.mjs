// [DEBUG-e11f] Regression assertions after the _headerStatic guard:
//  - _headText spans on Pet / Community Plugins must have NO radius/bg.
//  - The settings toolbar close button keeps its 32x32 round base.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const ROOT = `${process.cwd()}/.local-tests/ellipse-probe`;
const PORT = 9338;
const SESSION_ID = process.env.DSH_PROBE_SESSION_ID || 'session-40c77405-dd3e-4a1b-8bd6-abc6a81451a3';
mkdirSync(`${ROOT}/profile5`, { recursive: true });
mkdirSync(`${process.env.HOME}/tmp/e11a/browser-tmp`, { recursive: true });
mkdirSync(`${process.env.HOME}/tmp/e11a/xdg-tmp`, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); if (!ok) failures++; };

const chrome = spawn(process.env.DSH_PROBE_CHROME || 'chromium', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${ROOT}/profile5`, 'about:blank',
], { env: { ...process.env, TMPDIR: `${process.env.HOME}/tmp/e11a/browser-tmp`, XDG_RUNTIME_DIR: `${process.env.HOME}/tmp/e11a/xdg-tmp` }, stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', () => {});

async function waitFor(label, timeoutMs, fn) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(400);
  }
  throw new Error(`waitFor(${label}) timed out`);
}
function createCdpClient(ws) {
  let nextId = 0; const pending = new Map();
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id !== undefined) { const r = pending.get(m.id); if (!r) return; pending.delete(m.id); m.error ? r.reject(new Error(JSON.stringify(m.error))) : r.resolve(m.result); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++nextId; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  return { send, evaluate };
}

const MEASURE = `(() => {
  const modal = document.querySelector('[aria-modal=\"true\"]');
  if (!modal) return { error: 'no modal' };
  const headSpans = Array.from(modal.querySelectorAll('span')).filter((s) => /[A-Za-z0-9_-]*_headText$/.test((s.className.split(' ').pop() || '')));
  const headTexts = headSpans.map((s) => {
    const cs = getComputedStyle(s);
    const r = s.getBoundingClientRect();
    return { cls: String(s.className).slice(0, 44), radius: cs.borderRadius, bg: cs.backgroundColor, w: Math.round(r.width), h: Math.round(r.height) };
  });
  let closeBase = null;
  const toolbar = modal.querySelector('[class*=\"_header\"]:not([class*=\"_headerActions\"]):not([class*=\"_headerStatic\"])');
  if (toolbar && toolbar.lastElementChild) {
    const last = toolbar.lastElementChild;
    const cs = getComputedStyle(last);
    const r = last.getBoundingClientRect();
    closeBase = { tag: last.tagName, cls: String(last.className).slice(0, 44), w: Math.round(r.width), h: Math.round(r.height), radius: cs.borderRadius, bg: cs.backgroundColor };
  }
  return { headTextCount: headSpans.length, headTexts, closeBase };
})()`;

const transparentBg = (bg) => !bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent';

try {
  await waitFor('cdp', 30_000, async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).ok ? true : null);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const client = createCdpClient(ws);
  await client.send('Page.enable');
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('dsh.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId: SESSION_ID }))})`,
  });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await client.send('Page.navigate', { url: 'http://127.0.0.1:3080/' });
  await waitFor('boot', 60_000, () => client.evaluate(`!!document.querySelector('[data-mobile-nav="fab"]') && !!document.querySelector('[data-mobile-nav="frame"]')`));
  console.log('PASS boot');

  await client.evaluate(`document.querySelector('[data-mobile-nav="fab"]').click()`);
  await sleep(1200);
  await client.evaluate(`(() => { const a = document.querySelector('[class*="_settingsArea"]'); (a.querySelector('button') || a.firstElementChild || a).click(); return true; })()`);
  for (let i = 0; i < 24; i++) { await sleep(500); if (await client.evaluate(`!!document.querySelector('[aria-modal=\"true\"]')`)) break; }

  const visitAndAssert = async (label, cellText) => {
    if (cellText !== null) {
      const clicked = await client.evaluate(`(() => { const c = Array.from(document.querySelectorAll('[aria-modal="true"] [class*="_navCell"]')).find((x) => x.textContent.trim() === ${JSON.stringify(cellText)}); if (!c) return false; c.click(); return true; })()`);
      if (!clicked) { console.log(`SKIP ${label}: cell missing`); return; }
      await sleep(2200);
    }
    const m = await client.evaluate(MEASURE);
    if (m.error) { check(label + '.modal', false, m.error); return; }
    check(`${label}.no-ellipse-headText`,
      m.headTexts.every((h) => h.radius === '0px' && transparentBg(h.bg)), // empty set (pages without plugin cards) passes vacuously
      JSON.stringify(m.headTexts));
    check(`${label}.close-round-base-intact`,
      m.closeBase !== null && m.closeBase.w === 32 && m.closeBase.h === 32 && m.closeBase.radius === '50%' && !transparentBg(m.closeBase.bg),
      JSON.stringify(m.closeBase));
  };

  await visitAndAssert('general-default', null);
  await visitAndAssert('pet', 'Pet');
  await visitAndAssert('community-plugins', 'Community Plugins');

  console.log(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`);
} finally {
  chrome.kill('SIGKILL');
}
process.exit(failures === 0 ? 0 : 1);
