// Issue #104 red→green gate: offline ≥15s → reconnect must NOT blank the
// composer. The old stats-line moved React-owned nodes; React's unmount
// removeChild then threw NotFoundError and the SlotErrorBoundary emptied the
// composer bar slot until a reload. Repro recipe = Network.emulateNetworkConditions
// offline on a loaded mobile session (reporter-verified).
// #105 adds the git-chip A′ section (G1-G4): chip stays in the dock subtree
// and is CSS-pinned to the card corner; asserted only when the chip renders.
// Env: DSH_PROBE_SESSION_ID (required, full session-<uuid>),
//      DSH_PROBE_TOKEN (required, the ?token= value of the running web),
//      DSH_PROBE_URL (default http://127.0.0.1:3080/),
//      DSH_PROBE_CHROME, DSH_PROBE_OFFLINE_MS (default 16000).
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const URL_ = (process.env.DSH_PROBE_URL || 'http://127.0.0.1:3080/').replace(/\/?$/, '/')
const TOKEN = process.env.DSH_PROBE_TOKEN
const SESSION = process.env.DSH_PROBE_SESSION_ID
const OFFLINE_MS = Number(process.env.DSH_PROBE_OFFLINE_MS || 16000)
const CHROME = process.env.DSH_PROBE_CHROME || '/data/data/com.termux/files/usr/lib/chromium/chrome'
if (!TOKEN) throw new Error('DSH_PROBE_TOKEN is required')
if (!SESSION) throw new Error('DSH_PROBE_SESSION_ID is required (full session-<uuid>)')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const allocatePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((e) => (e ? rej(e) : res(port))) }) })
function createCdpClient(ws) {
  let n = 0; const p = new Map(); const errors = []
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id !== undefined) { const q = p.get(m.id); if (!q) return; p.delete(m.id); m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result) } }
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++n; p.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
  const onException = ({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description || exceptionDetails.text)
  const onLog = ({ entry }) => { if (entry.level === 'error') errors.push(entry.text) }
  return { send, evaluate, errors, attach: () => { ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') onException(m.params); if (m.method === 'Log.entryAdded') onLog(m.params) }) }, close: () => ws.close() }
}
const waitFor = async (label, probe, timeout = 90000) => { const d = Date.now() + timeout; while (Date.now() < d) { try { const v = await probe(); if (v) return v } catch {} await sleep(200) } throw new Error(label + ' timed out') }

const tmp = join(homedir(), 'tmp', 'cdp-fix'); await mkdir(tmp, { recursive: true })
const env = { ...process.env, TMPDIR: tmp, XDG_RUNTIME_DIR: tmp }
const port = await allocatePort(); const profileDir = await mkdtemp(join(homedir(), '.cache', 'dsh-104-'))
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=' + port, '--user-data-dir=' + profileDir, '--window-size=393,852', 'about:blank'], { stdio: 'ignore', env })
const target = await waitFor('target', async () => { try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (!r.ok) return null; const t = await r.json(); return t.length ? t[0] : null } catch { return null } })
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const client = createCdpClient(ws); client.attach()
await client.send('Page.enable'); await client.send('Runtime.enable'); await client.send('Log.enable'); await client.send('Network.enable')
await client.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' })
await client.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2.75, mobile: true, screenWidth: 393, screenHeight: 852 })
await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
const currentSession = JSON.stringify({ sessionId: SESSION })
await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('dsh.sessions.current', ${JSON.stringify(currentSession)})` })
// The removeChild throw is swallowed by React's SlotErrorBoundary and never
// reaches the uncaught-error channel; count pre-throw misses on the prototype
// instead (the reporter's runtime-evidence method).
await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const orig = Node.prototype.removeChild; Node.prototype.removeChild = function (child) { if (child && child.parentNode !== this) { window.__mnRemoveChildMiss = (window.__mnRemoveChildMiss || 0) + 1 } ; return orig.call(this, child) } })()` })
await client.send('Page.navigate', { url: URL_ + '?token=' + TOKEN })
await waitFor('load', async () => (await client.evaluate('({r: document.readyState === "complete"})')).r)
await waitFor('phase', () => client.evaluate('!!document.querySelector("[data-phase]")'), 150000)
await waitFor('plugin armed', () => client.evaluate('!!document.querySelector("[data-mobile-nav=\\"frame\\"]")'), 60000)
await waitFor('stats strip marked', () => client.evaluate('!!document.querySelector(\'[data-mobile-nav="stats"]\')'), 60000)
await sleep(1200)

const snap = `(() => {
  const strip = document.querySelector('[data-mobile-nav="stats"]')
  const composer = document.querySelector('[data-composer-card] textarea, [data-composer-card] [data-composer-input]')
  const out = {
    strip: !!strip,
    composerAlive: !!composer,
    slotErrors: document.querySelectorAll('[data-slot-error]').length,
    removeChildMiss: window.__mnRemoveChildMiss || 0,
  }
  // git-chip 段（#105 A′）：chip 留在 dock 子树 + CSS 钉角 ≈ 卡角+(12,12)±2px
  const gAnchor = document.querySelector('[data-gitgraph-chip-anchor]')
  const gDock = document.querySelector('[data-slot="conversation.input.dock"]')
  const gCard = document.querySelector('[data-composer-input], textarea')?.closest('[class*="_card"]')
  out.chipPresent = !!gAnchor
  out.chipInDock = !!(gAnchor && gDock && gDock.contains(gAnchor))
  if (gAnchor && gCard) {
    const ab = gAnchor.getBoundingClientRect(), cb = gCard.getBoundingClientRect()
    out.chipAlignDx = Math.round((ab.left - (cb.left + 12)) * 10) / 10
    out.chipAlignDy = Math.round((ab.top - (cb.top + 12)) * 10) / 10
  }
  if (!strip) return out
  const holder = strip.parentElement
  const dock = holder && holder.parentElement
  const ring = dock ? [...dock.children].find((c) => !c.contains(strip) && /\\d\\s*%/.test(c.textContent || '')) : null
  const row = document.querySelector('[data-composer-card] [class*="_row"] [class*="_trailing"]')
  const reserve = row && row.querySelector(':scope > [data-mobile-nav="stats-ring-reserve"]')
  const tpsReserve = strip.querySelector(':scope > [data-mobile-nav="stats-tps-reserve"]')
  const tps = document.querySelector('[data-mobile-nav="stats-tps"]')
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: Math.round(b.left * 10) / 10, t: Math.round(b.top * 10) / 10, w: Math.round(b.width * 10) / 10 } }
  out.ringParentIsDock = !!ring && !!dock && ring.parentElement === dock
  out.ringPosition = ring ? getComputedStyle(ring).position : null
  out.ring = rect(ring); out.reserve = rect(reserve)
  out.ringOnReserve = !!ring && !!reserve && Math.abs(ring.getBoundingClientRect().left - reserve.getBoundingClientRect().left) <= 1 && Math.abs(ring.getBoundingClientRect().top - reserve.getBoundingClientRect().top) <= 1
  out.tpsMoved = !!tpsReserve; out.tps = rect(tps); out.tpsReserveBox = rect(tpsReserve)
  return out
})()`
const pre = await client.evaluate(snap)
const A = []
const add = (name, ok, detail) => A.push({ name, ok, detail })

add('P1 统计条已标记', pre.strip, 'strip=' + pre.strip)
add('P2 环仍在 React 父节点 dock 内（#104 不变量）', pre.ringParentIsDock === true, 'ringParentIsDock=' + pre.ringParentIsDock)
add('P3 环 overlay 对准自建占位', pre.ringOnReserve === true, 'ring=' + JSON.stringify(pre.ring) + ' reserve=' + JSON.stringify(pre.reserve))
add('P4 环为绝对定位', pre.ringPosition === 'absolute', 'position=' + pre.ringPosition)
add('P5 复现前 composer 在场', pre.composerAlive, 'composerAlive=' + pre.composerAlive)
add('P6 复现前槽位零错误', pre.slotErrors === 0, 'slotErrors=' + pre.slotErrors)
// #105 A′ git-chip 段：chip 在场才断言（headless 无 git 数据时缺席与主探针 gitgraph
// SKIP 基线同源，整段记 SKIP，不影响退出码）；在场则全部为必过断言（绊线）。
const chipAligned = (s) => s.chipPresent && Math.abs(s.chipAlignDx ?? 99) <= 2 && Math.abs(s.chipAlignDy ?? 99) <= 2
if (pre.chipPresent) {
  add('G1 chip 留在 dock 子树（A′ 不搬家不变量）', pre.chipInDock === true, 'chipInDock=' + pre.chipInDock)
  add('G2 chip 左上角 ≈ 卡角+(12,12) ±2px', chipAligned(pre), 'dx=' + pre.chipAlignDx + ' dy=' + pre.chipAlignDy)
} else {
  console.log('SKIP git-chip 断言段（G1-G4）：chip 未渲染（headless 无 git 数据，与主探针 gitgraph SKIP 基线同源）')
}

// 断网 ≥15s → 恢复（报障者配方）
await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
await sleep(OFFLINE_MS)
await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
// 等 React 重建/重连尘埃落定（重试风暴 + commit，60s 覆盖慢环境）
await sleep(20000)
const post = await client.evaluate(snap)

add('X1 断网重连后 composer 存活', post.composerAlive, 'composerAlive=' + post.composerAlive)
add('X2 零 removeChild 未命中（钩子计数，含被边界吞掉的）', post.removeChildMiss === 0, 'miss=' + post.removeChildMiss)
add('X3 composer 槽位零 data-slot-error', post.slotErrors === 0, 'slotErrors=' + post.slotErrors)
add('X4 环未被搬动（不变量保持）', post.ringParentIsDock === true, 'ringParentIsDock=' + post.ringParentIsDock)
add('X5 环 overlay 仍对准占位', post.ringOnReserve === true, 'ring=' + JSON.stringify(post.ring) + ' reserve=' + JSON.stringify(post.reserve))
if (pre.chipPresent) {
  add('G3 断网重连后 chip 仍在 dock 子树', post.chipInDock === true, 'chipInDock=' + post.chipInDock)
  add('G4 断网重连后 chip 钉角不变（≈卡角+(12,12)±2px）', chipAligned(post), 'dx=' + post.chipAlignDx + ' dy=' + post.chipAlignDy)
}

let fail = 0
for (const a of A) { console.log((a.ok ? 'PASS' : 'FAIL') + '  ' + a.name + (a.ok ? '' : '  [' + a.detail + ']')); if (!a.ok) fail++ }
console.log('tpsMoved=' + pre.tpsMoved + ' tps=' + JSON.stringify(pre.tps) + ' reserveBox=' + JSON.stringify(pre.tpsReserveBox))
console.log('SUMMARY pass=' + (A.length - fail) + ' fail=' + fail)
client.close(); chrome.kill()
process.exit(fail === 0 ? 0 : 1)
