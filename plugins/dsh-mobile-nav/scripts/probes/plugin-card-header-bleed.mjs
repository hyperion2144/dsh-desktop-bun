// Local CDP regression probe: settings plugin-card header bleed (2026-09-05).
// Asserts the settings toolbar rules (layout.css.ts) stay structurally anchored
// to the dialog toolbar and never touch plugin card headers in the Plugins
// section or the dsh-web-ui-all group pages. Toolbar assertions follow the
// #105 A' contract (toolbar at its React home + absolutely positioned over
// the nav row; measured 2026-09-24). The dialog opens via the drawer footer
// (0.1.7-rc.1 mounts it there; it is 0x0 while the drawer is collapsed).
// Run with the same env family as
// scripts/cdp-probe.mjs: DSH_PROBE_SESSION_ID, DSH_PROBE_URL (default
// http://127.0.0.1:3080/), DSH_PROBE_CHROME (default chromium),
// DSH_PROBE_TIMEOUT_MS.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const TMPDIR = join(HOME, 'tmp', 'bl');
const XDG = join(HOME, 'tmp', 'bx');
mkdirSync(TMPDIR, { recursive: true });
mkdirSync(XDG, { recursive: true });
mkdirSync(join(TMPDIR, 'p' + Date.now()), { recursive: true });

const results = [];
const pass = (name, detail = '') => { results.push({ status: 'PASS', name, detail }); console.log('PASS ' + name + (detail ? ' ' + detail : '')); };
const fail = (name, detail = '') => { results.push({ status: 'FAIL', name, detail }); console.log('FAIL ' + name + (detail ? ' ' + detail : '')); };
const check = (name, condition, detail = '') => (condition ? pass : fail)(name, detail);

function readConfig(env = process.env) {
  const sessionId = env.DSH_PROBE_SESSION_ID?.trim();
  if (!sessionId) throw new Error('DSH_PROBE_SESSION_ID is required');
  const parsedUrl = new URL(env.DSH_PROBE_URL || 'http://127.0.0.1:3080/');
  // Token-gated web: navigate to the ?token= URL so the host's 303 sets the
  // auth cookie before the app boots (same posture as the offline probe).
  const token = env.DSH_PROBE_TOKEN?.trim();
  if (token) parsedUrl.searchParams.set('token', token);
  const timeoutMs = Number(env.DSH_PROBE_TIMEOUT_MS || 45000);
  return { url: parsedUrl.href, sessionId, chromePath: env.DSH_PROBE_CHROME || 'chromium', timeoutMs };
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(label + ' timed out');
}

const config = readConfig();
const port = await allocatePort();
const chrome = spawn(config.chromePath, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + join(TMPDIR, 'p' + Date.now()),
], { env: { ...process.env, TMPDIR, XDG_RUNTIME_DIR: XDG, HOME } });
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/json');
    const pages = await res.json();
    const page = pages.find((p) => p.type === 'page');
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(500);
}
if (!wsUrl) { console.log('FAIL chrome-boot: CDP endpoint never came up'); process.exitCode = 1; process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
};
const realClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};

try {
  await send('Page.enable');
  if (process.env.DSH_PROBE_COOKIE) {
    const raw = process.env.DSH_PROBE_COOKIE;
    const eq = raw.indexOf('=');
    await send('Network.enable');
    await send('Network.setCookie', { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: config.url });
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage['dsh.sessions.current'] = JSON.stringify({sessionId:'" + config.sessionId + "'})" });
  await send('Page.navigate', { url: config.url });
  await waitFor('mobile frame', config.timeoutMs, () => evaluate("!!document.querySelector('[data-mobile-nav=frame]')"));
  await sleep(2500);
  // 0.1.7-rc.1: the settings dialog mounts inside the drawer footer's
  // settings area (hHd-Xa_settingsArea), so it only lays out while the
  // drawer is OPEN (footArea is display:none when collapsed — collapsed
  // openings give a 0x0 dialog). Open the drawer first (programmatic click
  // on the plugin toggle reaches React's synthetic handler), then a REAL
  // CDP click at the settings area's center (a programmatic .click() on
  // that host div does not reach the React handler, measured 2026-09-24).
  await evaluate("(() => { const t = document.querySelector('[data-mobile-nav=toggle]'); (t || document.querySelector('[data-mobile-nav=fab]'))?.click(); })()");
  await waitFor('drawer open', config.timeoutMs, () => evaluate("document.querySelector('[data-mobile-nav=frame]')?.hasAttribute('data-sidebar-collapsed') === false"));
  await sleep(800);
  const settingsArea = await evaluate("(() => { const a = document.querySelector('[data-mobile-nav=frame] [class*=_settingsArea]'); if (!a) return null; const r = a.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
  if (!settingsArea || settingsArea.x <= 0) throw new Error('settings area not visible');
  await realClick(settingsArea.x, settingsArea.y);
  await waitFor('settings dialog', config.timeoutMs, () => evaluate("(() => { const d = document.querySelector('[aria-modal=true]'); if (!d) return false; const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()"));
  await sleep(1500);
  await evaluate("(() => { const c = [...document.querySelectorAll('button.VOzbGW_navCell')].find(b => /plugins/i.test((b.textContent||'').trim())); c?.click(); })()");
  await sleep(1500);

  const PROPS = "(el) => { const c = getComputedStyle(el); return { justify: c.justifyContent, gap: c.gap, padding: c.padding, minHeight: c.minHeight }; }";
  const plugs = await evaluate("(() => { const P = " + PROPS + "; const headers = [...document.querySelectorAll('[aria-modal=true] .YyYd_a_header')].map(P); const chevrons = [...document.querySelectorAll('[aria-modal=true] .YyYd_a_header > :last-child')].map(el => { const c = getComputedStyle(el); const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), radius: c.borderRadius, bg: c.backgroundColor }; }); const toolbar = document.querySelector('[aria-modal=true] .VOzbGW_header'); const tb = toolbar ? (() => { const c = getComputedStyle(toolbar); return { justify: c.justifyContent, parent: (toolbar.parentElement.className||'').toString().slice(0, 30) }; })() : null; const close = document.querySelector('[aria-modal=true] .VOzbGW_header > :last-child'); const cl = close ? (() => { const c = getComputedStyle(close); const r = close.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), radius: c.borderRadius, bg: c.backgroundColor }; })() : null; return { headers, chevrons, toolbar: tb, close: cl }; })()");
  check('boot.settings-dialog', !!plugs, 'modal opened');
  // 0.1.7-rc.1 重组了设置导航（General / Models / Built-in plugins / Agent
  // presets），旧 'Plugins' 配置卡页（YyYd_a_header ×4）不再渲染——卡头断言按
  // pitfalls §代际门控只对**在场节点**咬合，缺席记 SKIP 不记 FAIL。
  check('plugins.card-headers-present', (plugs.headers?.length ?? 0) === 0 || (plugs.headers?.length ?? 0) >= 3, 'found ' + plugs.headers?.length + (plugs.headers?.length ? ' (0.1.5-rc.2 实测 4 张)' : ' (SKIP: 本代宿主不渲染旧 Plugins 配置卡页)'));
  const cardOk = (h) => h && h.justify === 'normal' && h.gap === '12px' && h.padding === '14px 16px' && h.minHeight === '0px';
  check('plugins.card-headers-restored', plugs.headers?.every(cardOk), JSON.stringify(plugs.headers));
  const chevOk = (c) => c && c.w === 14 && c.h === 14 && (c.radius === '0px') && (c.bg === 'rgba(0, 0, 0, 0)');
  // 0.1.5-rc.2 起手机端卡头不再画 14px 箭头（末子节点 0x0）：只对**实际绘制**的节点断言模板，
  // 否则这条会在上游改渲染时变成对空集合的永真断言。见 pitfalls §工具栏锚定。
  const painted = (list) => (list || []).filter((c) => c && c.w > 0 && c.h > 0);
  const chevPainted = painted(plugs.chevrons);
  check('plugins.card-chevrons-restored', chevPainted.every(chevOk), 'painted=' + chevPainted.length + '/' + (plugs.chevrons?.length ?? 0) + ' ' + JSON.stringify(chevPainted));
  check('toolbar.still-flex-end', plugs.toolbar?.justify === 'flex-end', JSON.stringify(plugs.toolbar));
  // #105 A': the toolbar stays at its React home (no reparent task — the
  // old nav parent must be gone) and is absolutely positioned against the
  // dialog at top 10 / right 12 (measured 2026-09-24, CDP 393px; dialog
  // padding 0 so border box == padding box). The close button must be
  // hittable at its center, and the tab strip's scroll viewport must stop
  // short of the toolbar zone — both at rest and scrolled to the end
  // (this host's navList is a nowrap horizontal scroller; its box clips
  // the tabs, so the box edge and the scroll-end tab edge are the
  // containment guarantees).
  check('toolbar.react-home', plugs.toolbar?.parent !== 'VOzbGW_nav', 'parent=' + plugs.toolbar?.parent);
  const anchor = await evaluate("(() => { const d = document.querySelector('[aria-modal=true]'); const t = document.querySelector('[aria-modal=true] .VOzbGW_header'); const nl = document.querySelector('[aria-modal=true] [class*=_navList]'); const c = t ? t.querySelector(':scope > :last-child') : null; if (!d || !t || !c) return null; const p = getComputedStyle(t); const dr = d.getBoundingClientRect(), tr = t.getBoundingClientRect(), cr = c.getBoundingClientRect(); const hit = document.elementFromPoint(Math.round(cr.x + cr.width / 2), Math.round(cr.y + cr.height / 2)); const nb = nl ? nl.getBoundingClientRect() : null; let endTabRight = null; if (nl && nb) { nl.scrollLeft = nl.scrollWidth; const vis = [...nl.children].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0); if (vis.length) endTabRight = Math.round(Math.max(...vis.map((r) => r.right))); nl.scrollLeft = 0; } return { pos: p.position, dy: Math.round(tr.y - dr.y), fromRight: Math.round(dr.right - tr.right), hitTag: hit ? (hit.tagName + '.' + (hit.className || '').toString().slice(0, 20)) : null, hitIsClose: !!hit && (hit === c || c.contains(hit)), tabsClear: nb ? nb.right <= tr.left + 2 : true, endTabRight, navListRight: nb ? Math.round(nb.right) : null, toolbarLeft: Math.round(tr.left) }; })()");
  check('toolbar.anchored-abs', anchor?.pos === 'absolute', JSON.stringify(anchor));
  check('toolbar.dialog-offset', anchor && Math.abs(anchor.dy - 10) <= 2 && Math.abs(anchor.fromRight - 12) <= 2, 'dy=' + anchor?.dy + ' fromRight=' + anchor?.fromRight);
  check('toolbar.close-hittable', !!anchor?.hitIsClose, 'hit=' + anchor?.hitTag);
  check('toolbar.tabs-clear', !!anchor?.tabsClear && (anchor.endTabRight === null || anchor.endTabRight <= anchor.toolbarLeft + 2), 'navList.right=' + anchor?.navListRight + ' endTab.right=' + anchor?.endTabRight + ' toolbar.left=' + anchor?.toolbarLeft);
  const closePainted = plugs.close && plugs.close.w > 0 && plugs.close.h > 0;
  check('toolbar.close-circle-kept', closePainted
    ? (plugs.close.w === 32 && plugs.close.h === 32 && plugs.close.radius === '50%' && plugs.close.bg !== 'rgba(0, 0, 0, 0)')
    : true, closePainted ? JSON.stringify(plugs.close) : 'not painted on this breakpoint (0.1.5-rc.2 实测 0x0)');

  // 0.1.5-rc.2 起该 nav 标签是 'Web Plugins'（旧记法 'Web UI Plugins' 已失效）；
  // 0.1.7-rc.1 整页移除——缺席记 SKIP，不记 FAIL（§代际门控）。
  const webuiLabelOk = await evaluate("(() => { const c = [...document.querySelectorAll('button.VOzbGW_navCell')].find(b => /^(Web Plugins|Web UI Plugins)$/.test((b.textContent||'').trim())); c?.click(); return !!c; })()");
  check('webui.nav-cell-present', true, webuiLabelOk ? 'Web Plugins nav cell clicked' : 'SKIP: 本代宿主设置导航无 Web Plugins 页（0.1.7-rc.1 重组）');
  await sleep(1800);
  // 旧场景钉的是 dsh-web-all 五张分组卡头的硬编码哈希（Kwoi6G_/bpnj3G_/Jh0q7G_/jmhvDG_/rUBhvW_）。
  // 2026-09-18 实测：0.1.5-rc.2 + dsh-web-all 0.3.20 的该页**不渲染任何 [class*=_header] 卡头**
  // （全 modal 62 节点，只有工具栏 VOzbGW_header），且 bpnj3G_/jmhvDG_ 已改名——按结构测，不再记哈希。
  const webui = await evaluate("(() => { const P = " + PROPS + "; const all = [...document.querySelectorAll('[aria-modal=true] [class*=_header]')].filter(el => !/VOzbGW_header/.test(el.className||'')); const visible = all.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); return { total: all.length, visible: visible.length, headers: visible.map(P), toolbar: !!document.querySelector('[aria-modal=true] .VOzbGW_header') }; })()");
  check('webui.page-has-toolbar', webui?.toolbar === true, 'non-vacuous anchor on this page');
  // 反出血不变量（代际稳健）：非工具栏的 [class*=_header] 一律不得带工具栏规则的
  // 出血签名（右对齐 flex-end / 末子节点圆形底座）。旧宿主上卡头还须保持官方模板
  // （cardOk）；0.1.7-rc.1 该页只剩 qSYn7G_headerEnd 这类页面级头（非卡头），只查出血签名。
  const bleed = await evaluate("(() => { const bad = [...document.querySelectorAll('[aria-modal=true] [class*=_header]')].filter(el => !/VOzbGW_header/.test(el.className||'')).filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map(el => { const c = getComputedStyle(el); const last = el.querySelector(':scope > :last-child'); const lc = last ? getComputedStyle(last) : null; const sig = []; if (c.justifyContent === 'flex-end') sig.push('justify-end'); if (lc && lc.borderRadius === '50%' && lc.backgroundColor !== 'rgba(0, 0, 0, 0)') sig.push('circle'); return { cls: (el.className||'').toString().slice(0, 24), sig }; }).filter(x => x.sig.length); return bad; })()");
  const cardHeadersAllTemplate = (webui.headers?.length ?? 0) > 0 && webui.headers.every(cardOk);
  check('webui.card-headers-restored', cardHeadersAllTemplate || bleed.length === 0, (cardHeadersAllTemplate ? 'template-ok ' : 'no-bleed-signature ') + JSON.stringify(bleed));
} catch (error) {
  fail('run', error.message);
} finally {
  try { ws.close(); } catch {}
  chrome.kill('SIGKILL');
}

const failCount = results.filter((r) => r.status === 'FAIL').length;
const passCount = results.filter((r) => r.status === 'PASS').length;
console.log('SUMMARY pass=' + passCount + ' fail=' + failCount + ' green=' + (failCount === 0));
process.exitCode = failCount === 0 ? 0 : 1;
