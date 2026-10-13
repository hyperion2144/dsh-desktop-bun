// 子代理 composer 双 primary 回归断言:驱动子代理 running,断言模型条保底宽度
// 与 [圈][停][发] 贴右缘。几何断言即验证(本项目无视觉目检)。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.DSH_PROBE_URL || 'http://127.0.0.1:3080/';
// 实测:注入子代理 ID 会打开父会话视图(header 带 Switch subagent switcher);
// 注入父会话 ID 反而看不到 switcher。
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

// 抓取 trailing 关键几何:模型条 root、meter、两个 primary、tools 车道。
const SNAPSHOT = `(() => {
  const card = document.querySelector('[data-composer-card]');
  if (!card) return null;
  const row = card.querySelector('[class*="_row"]');
  const trailing = card.querySelector('[class*="_trailing"]');
  const model = trailing ? trailing.querySelector('[aria-haspopup="menu"]') : null;
  const modelRoot = model ? model.parentElement : null;
  const meter = card.querySelector('[class*="_trailing"] [aria-haspopup="dialog"]');
  const primaries = [...card.querySelectorAll('button[class*="_primary"]')];
  if (!row || !trailing || !modelRoot || primaries.length < 2) return null;
  const rect = (el) => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), t: Math.round(b.top), b: Math.round(b.bottom) }; };
  const t = rect(trailing);
  return {
    iw: innerWidth,
    trailing: t,
    tools: rect(row.firstElementChild),
    modelRoot: rect(modelRoot),
    modelRootMinW: getComputedStyle(modelRoot).minWidth,
    meter: meter ? rect(meter) : null,
    primaries: primaries.map((b) => ({ aria: b.getAttribute('aria-label'), ...rect(b) })),
  };
})()`;

// 断言一组快照;返回失败列表。核心断言:双 primary 形态下 trailing 换行
// (修复行为)且四件套完整、send 贴 trailing 右缘、控件无重叠。
function assertSnap(label, s) {
  const fails = [];
  const last = s.primaries[s.primaries.length - 1];
  if (!(s.trailing.t > s.tools.t + 5)) fails.push(`trailing not wrapped: trailing.t=${s.trailing.t} tools.t=${s.tools.t}`);
  if (s.modelRoot.w < 48) fails.push(`model pill too narrow: ${s.modelRoot.w}px < 48px (minW=${s.modelRootMinW})`);
  if (Math.abs(last.r - s.trailing.r) > 1) fails.push(`send not pinned right: send.r=${last.r} trailing.r=${s.trailing.r}`);
  const controls = [s.meter, ...s.primaries].filter(Boolean);
  for (let i = 1; i < controls.length; i++) {
    if (controls[i - 1].r > controls[i].l) fails.push(`overlap: ${JSON.stringify(controls[i - 1])} vs ${JSON.stringify(controls[i])}`);
  }
  console.log(`ASSERT ${label} iw=${s.iw} wrap=${s.trailing.t > s.tools.t + 5 ? 'yes' : 'no'} trailing=${s.trailing.w}px@${s.trailing.t} model=${s.modelRoot.w}px send.r=${last.r}/${s.trailing.r} ${fails.length ? 'FAIL ' + fails.join(' | ') : 'PASS'}`);
  return fails;
}

async function main() {
  const tmp = '/data/data/com.termux/files/home/tmp/cdp-fix';
  await mkdir(tmp, { recursive: true });
  const env = { ...process.env, TMPDIR: tmp, XDG_RUNTIME_DIR: tmp };
  const port = await allocatePort();
  const profileDir = await mkdtemp(join(homedir(), '.cache', 'dsh-fix-'));
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

  await waitFor('subagent composer active state', async () => {
    return client.evaluate(`(() => {
      const ph = document.querySelector('[data-phase]');
      const phase = ph ? ph.getAttribute('data-phase') : null;
      const card = document.querySelector('[data-composer-card]');
      if (!card) return null;
      const ta = card.querySelector('textarea');
      const placeholder = ta ? ta.getAttribute('placeholder') : null;
      if (phase === 'hero' || (placeholder && placeholder.indexOf('Choose workspace') >= 0)) return null;
      return { phase };
    })()`);
  }, 150000);

  // 点「Switch subagent」并选任意子代理(菜单行含「盘点」或「样式审查」)。
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
            if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: t.slice(0, 50) };
          }
        }
      }
      return null;
    })()`);
  }, 60000);
  console.log('MENUITEM', JSON.stringify(menuItem));
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: menuItem.x, y: menuItem.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: menuItem.x, y: menuItem.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: menuItem.x, y: menuItem.y, button: 'left', clickCount: 1 });

  await waitFor('subagent view switch', async () => {
    return client.evaluate(`(() => {
      const h = document.querySelector('[data-phase] header');
      const t = h ? (h.textContent || '') : '';
      const sw = [...document.querySelectorAll('header button')].find(b => (b.getAttribute('aria-label') || '').indexOf('Switch subagent') >= 0);
      const swt = sw ? sw.getAttribute('aria-label') : '';
      if ((t.indexOf('盘点') >= 0 || t.indexOf('样式审查') >= 0) && (swt.indexOf('盘点') >= 0 || swt.indexOf('样式审查') >= 0)) return true;
      return null;
    })()`);
  }, 60000);
  await sleep(2500);

  // 驱动 running:聚焦 textarea、输入、点发送(此时只有一个 primary=发送)。
  const inputInfo = await waitFor('composer textarea', async () => {
    return client.evaluate(`(() => {
      const ta = document.querySelector('[data-composer-card] textarea');
      if (!ta) return null;
      const r = ta.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: inputInfo.x, y: inputInfo.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inputInfo.x, y: inputInfo.y, button: 'left', clickCount: 1 });
  await sleep(300);
  await client.send('Input.insertText', { text: '请从 1 数到 300,每行一个数字。' });
  await sleep(300);
  const sendBtn = await waitFor('send button', async () => {
    return client.evaluate(`(() => {
      const primaries = [...document.querySelectorAll('[data-composer-card] button[class*="_primary"]')];
      const send = primaries.find(b => (b.getAttribute('aria-label') || '').indexOf('Send') >= 0);
      if (!send || primaries.length !== 1) return null;
      const r = send.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sendBtn.x, y: sendBtn.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sendBtn.x, y: sendBtn.y, button: 'left', clickCount: 1 });

  // 等双 primary(停止 + 发送)出现 = running 形态。
  await waitFor('dual primary running form', async () => {
    return client.evaluate(`(() => {
      const primaries = [...document.querySelectorAll('[data-composer-card] button[class*="_primary"]')];
      const labels = primaries.map(b => b.getAttribute('aria-label') || '');
      if (labels.some(l => l.indexOf('Stop') >= 0) && labels.some(l => l.indexOf('Send') >= 0)) return labels;
      return null;
    })()`);
  }, 60000);
  await sleep(800);

  // 压力注入:超长 triggerLabel + style 标签锁死 modes 车道(模拟用户设备上
  // tools 更宽且不可缩:旧宿主 modes 芯片多/不可收缩)。inline style 会被
  // running 期 React 重渲染冲掉,style 标签不受影响。未修复(nowrap)时
  // trailing 被压到 <158px,模型条是唯一可缩元素被压到最小内容宽;
  // 修复(wrap)后 trailing 换到第二行整宽,四件套完整。
  const injected = await client.evaluate(`(() => {
    const card = document.querySelector('[data-composer-card]');
    const label = card.querySelector('[class*="_trailing"] [aria-haspopup="menu"] [class*="_triggerLabel"]');
    if (!label) return false;
    label.textContent = 'deepseek-v4-pro-0813-super-long-model-name-pressure-test';
    const st = document.createElement('style');
    st.setAttribute('data-probe-pressure', '1');
    // 锁 tools 容器本身(modes 的 min-width 不参与 row 层分配,必须锁容器)
    st.textContent = '.uV2eYG_tools{flex:none!important;min-width:234px!important}';
    document.head.appendChild(st);
    return true;
  })()`);
  if (!injected) throw new Error('pressure injection failed');
  await sleep(400);

  const allFails = [];
  // 390 视口断言
  const s390 = await client.evaluate(SNAPSHOT);
  allFails.push(...assertSnap('390', s390));
  // 360 视口断言
  await client.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  const s360 = await client.evaluate(SNAPSHOT);
  allFails.push(...assertSnap('360', s360));
  // 320 视口:仅报告,不断言(极小设备边缘场景)。
  await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  const s320 = await client.evaluate(SNAPSHOT);
  console.log(`INFO 320 iw=${s320.iw} trailing=${s320.trailing.w}px model=${s320.modelRoot.w}px send.r=${s320.primaries[s320.primaries.length - 1].r}/${s320.trailing.r}`);

  client.close();
  chrome.kill('SIGTERM');
  await Promise.race([once(chrome, 'exit').catch(() => {}), sleep(4000)]);
  if (!chromeExit) chrome.kill('SIGKILL');
  if (allFails.length) { console.error('FAILURES ' + allFails.join(' | ')); process.exit(1); }
  console.log('ALL PASS');
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
