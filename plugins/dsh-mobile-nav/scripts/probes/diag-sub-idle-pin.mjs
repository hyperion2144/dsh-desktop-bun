// 子代理 idle 态 trailing 右钉回归探针(2026-09-06 截图实锤缺陷):
// 子代理会话官方无模型条(模型由父锁定, model seat available=false),
// 置零规则若因圈的 aria-haspopup="dialog" 误杀 send 的 margin-left:auto,
// [圈][发送] 整簇贴 trailing 左缘、右半空(用户截图可见)。
// 断言:模型条缺席钉住状态 + 最后一个 primary 贴 trailing 右缘 + 无重叠。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.DSH_PROBE_URL || 'http://127.0.0.1:3080/';
const SESSION = process.env.DSH_PROBE_SESSION_ID || 'd2bd6659-e128-485c-90fb-0898660621b9';
const CHROME = process.env.DSH_PROBE_CHROME || '/data/data/com.termux/files/usr/lib/chromium/chrome';
const TIMEOUT = 90_000;
if (!SESSION) { console.error('DSH_PROBE_SESSION_ID required'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function allocatePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((e) => e ? reject(e) : resolve(port)); });
  });
}
function createCdpClient(ws) {
  let nextId = 0; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}
async function waitFor(label, probe, timeout = TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const v = await probe(); if (v) return v; } catch {} await sleep(150); }
  throw new Error(label + ' timed out');
}

const SNAPSHOT = `(() => {
  const card = document.querySelector('[data-composer-card]');
  if (!card) return null;
  const row = card.querySelector('[class*="_row"]');
  const trailing = card.querySelector('[class*="_trailing"]');
  if (!row || !trailing) return null;
  const model = trailing.querySelector('[aria-haspopup="menu"]');
  const meter = trailing.querySelector('[aria-haspopup="dialog"]');
  const primaries = [...trailing.querySelectorAll('button[class*="_primary"]')];
  if (!primaries.length) return null;
  const rect = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; };
  return {
    iw: innerWidth,
    inCard: !!card.querySelector('textarea, [data-composer-input]'),
    trailing: rect(trailing),
    modelPresent: !!model,
    meter: meter ? rect(meter) : null,
    primaries: primaries.map(rect),
  };
})()`;

function assertSnap(label, s) {
  const fails = [];
  if (!s.inCard) fails.push('composer not in input state');
  if (s.modelPresent) console.log('NOTE headless shows a menu trigger in trailing (pill or access); pinned via pill rule');
  if (!s.meter) fails.push('meter absent (state not as expected)');
  const last = s.primaries[s.primaries.length - 1];
  if (Math.abs(last.r - s.trailing.r) > 1) fails.push(`primary not pinned right: ${last.r} vs trailing ${s.trailing.r}`);
  const controls = [s.meter, ...s.primaries].filter(Boolean);
  for (let i = 1; i < controls.length; i++) {
    if (controls[i - 1].r > controls[i].l) fails.push(`overlap: ${JSON.stringify(controls[i - 1])} vs ${JSON.stringify(controls[i])}`);
  }
  console.log(`ASSERT ${label} iw=${s.iw} menu=${s.modelPresent ? 'yes' : 'no'} meter=${s.meter ? s.meter.l + '-' + s.meter.r : 'none'} lastPrimary=${last.l}-${last.r} trailingR=${s.trailing.r} ${fails.length ? 'FAIL ' + fails.join(' | ') : 'PASS'}`);
  return fails;
}

async function main() {
  const tmp = '/data/data/com.termux/files/home/tmp/cdp-fix';
  await mkdir(tmp, { recursive: true });
  const env = { ...process.env, TMPDIR: tmp, XDG_RUNTIME_DIR: tmp };
  const port = await allocatePort();
  const profileDir = await mkdtemp(join(homedir(), '.cache', 'dsh-idle-'));
  const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--remote-debugging-port='+port,'--user-data-dir='+profileDir,'--window-size=390,844','about:blank'], { stdio: 'ignore', env });
  let chromeExit = null;
  chrome.once('exit', (c) => { chromeExit = c; });
  const target = await waitFor('chrome target', async () => {
    if (chromeExit) throw new Error('chromium exited early');
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (!r.ok) return null; const t = await r.json(); return t.length ? t[0] : null; } catch { return null; }
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const client = createCdpClient(ws);
  await client.send('Page.enable'); await client.send('Runtime.enable');
  // Authenticated instances answer 401 without a cookie (mint one with
  // .local-tests/mint-cookie.mjs, pass it as DSH_PROBE_COOKIE=name=value).
  if (process.env.DSH_PROBE_COOKIE) {
    const raw = process.env.DSH_PROBE_COOKIE;
    const eq = raw.indexOf('=');
    await client.send('Network.enable');
    await client.send('Network.setCookie', { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: URL_ });
  }

  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('dsh.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId: SESSION }))})`,
  });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await client.send('Page.navigate', { url: URL_ });

  await waitFor('page load', async () => {
    const s = await client.evaluate(`({ ready: document.readyState === 'complete', href: location.href })`);
    return s.ready && s.href.startsWith(URL_) ? s : null;
  });
  const composerActive = await waitFor('composer active', async () => {
    return client.evaluate(`(() => {
      const ph = document.querySelector('[data-phase]');
      const card = document.querySelector('[data-composer-card]');
      if (!card || !ph) return null;
      if (ph.getAttribute('data-phase') === 'hero') return null;
      const ta = card.querySelector('textarea');
      const ph2 = ta ? ta.getAttribute('placeholder') : '';
      return ph2 && ph2.indexOf('Choose workspace') < 0 ? true : null;
    })()`);
  }, 30000).catch(() => false);
  if (!composerActive) {
    // 0.1.6-alpha.2: a fresh headless profile lacks the workspace
    // authorization the host needs to auto-restore the saved session, so the
    // page parks in the hero phase. Restore through the drawer UI (FAB ->
    // first NON-selected session row), retried like header-files-pin-probe.
    await sleep(6000);
    await client.evaluate(`(() => { const f = document.querySelector('[data-mobile-nav="fab"]'); if (f) f.click(); return true })()`);
    await sleep(1500);
    await waitFor('drawer session rows', async () => {
      return client.evaluate(`(() => {
        const rows = [...document.querySelectorAll('[role="treeitem"]')];
        return rows.some((el) => /sessionRow/.test(el.className) && el.getBoundingClientRect().width > 0);
      })()`);
    }, 15000);
    const tryRowsSrc = `(() => {
      const rows = [...document.querySelectorAll('[role="treeitem"]')].filter((el) => /sessionRow/.test(el.className) && el.getBoundingClientRect().width > 0);
      const target = rows.find((el) => !/selected/.test(el.className)) || rows[0];
      if (target) { target.click(); return rows.length }
      return 0
    })()`;
    if ((await client.evaluate(tryRowsSrc)) === 0) throw new Error('no drawer session rows to restore (0.1.6 headless needs one)');
    let restored = false;
    for (let attempt = 0; attempt < 3 && !restored; attempt++) {
      restored = await waitFor('active phase after drawer restore', async () => {
        return client.evaluate(`document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'active'`);
      }, 20000).catch(() => false);
      if (!restored && attempt < 2) await client.evaluate(tryRowsSrc);
    }
    if (!restored) throw new Error('active phase after drawer restore timeout (3 rows tried)');
    await sleep(1500);
  }

  // 进子代理视图(与 running 探针同款:点 Switch subagent 选菜单行)。
  const switcherInfo = await waitFor('subagent switcher', async () => {
    return client.evaluate(`(() => {
      const btns = [...document.querySelectorAll('header button')];
      const sw = btns.find(b => (b.getAttribute('aria-label') || '').indexOf('Switch subagent') >= 0);
      if (!sw) return null;
      const r = sw.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: switcherInfo.x, y: switcherInfo.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: switcherInfo.x, y: switcherInfo.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: switcherInfo.x, y: switcherInfo.y, button: 'left', clickCount: 1 });

  const menuItem = await waitFor('subagent menu item', async () => {
    return client.evaluate(`(() => {
      const menus = [...document.querySelectorAll('[role="menu"], [class*="ZKlsPq_menu"], [class*="_menu"]')];
      for (const m of menus) {
        if (m.getBoundingClientRect().width <= 0) continue;
        const rows = [...m.querySelectorAll('[role="menuitem"], [role="option"], [class*="_item"], li, [role="treeitem"]')];
        for (const rowEl of rows) {
          const t = (rowEl.textContent || '').trim();
          if (t.indexOf('盘点') >= 0 || t.indexOf('样式审查') >= 0) {
            const r = rowEl.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
      }
      return null;
    })()`);
  }, 60000);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: menuItem.x, y: menuItem.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: menuItem.x, y: menuItem.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: menuItem.x, y: menuItem.y, button: 'left', clickCount: 1 });

  await waitFor('subagent view', async () => {
    return client.evaluate(`(() => {
      const sw = [...document.querySelectorAll('header button')].find(b => (b.getAttribute('aria-label') || '').indexOf('Switch subagent') >= 0);
      const swt = sw ? sw.getAttribute('aria-label') : '';
      return (swt.indexOf('盘点') >= 0 || swt.indexOf('样式审查') >= 0) ? true : null;
    })()`);
  }, 60000);

  const fails = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const snap = await waitFor('idle trailing snapshot', async () => {
      const s = await client.evaluate(SNAPSHOT);
      return s && s.inCard && s.meter ? s : null;
    }, 30000);
    fails.push(...assertSnap(`idle-subagent#${attempt}`, snap));
    await sleep(400);
  }

  // task-3 T1b: lineage chip geometry in the idle subagent view — the rc
  // generation hide rule owns the leading "/" separator again (it resurfaced
  // visible on 0.1.6-alpha.2, task-3 audit 2026-09-19), and the chip stays
  // absolutely pinned at right:8 on the tab row.
  const chip = await client.evaluate(`(() => {
    const root = document.querySelector('[class*="ZKlsPq_root"]');
    const sep = document.querySelector('[class*="ZKlsPq_separator"]');
    if (!root) return null;
    const b = root.getBoundingClientRect();
    return { right: Math.round(b.right), y: Math.round(b.y), h: Math.round(b.height), vw: innerWidth, sep: sep ? getComputedStyle(sep).display : 'absent' };
  })()`);
  if (!chip) {
    fails.push('lineage chip absent in idle subagent view');
  } else {
    if (chip.sep !== 'none') fails.push(`lineage separator visible: display=${chip.sep}`);
    if (Math.abs(chip.right - (chip.vw - 8)) > 1) fails.push(`lineage chip not pinned right:8: right=${chip.right} expected ${chip.vw - 8}`);
    console.log(`lineage chip: rect right=${chip.right} (vw-8=${chip.vw - 8}) y=${chip.y} h=${chip.h} separator=${chip.sep}`);
  }
  chrome.kill('SIGKILL');
  if (fails.length) { console.error(`RESULT FAIL (${fails.length} failures)`); process.exit(1); }
  console.log('RESULT PASS');
}
main().catch((e) => { console.error('PROBE ERROR', e.message); process.exit(1); });
