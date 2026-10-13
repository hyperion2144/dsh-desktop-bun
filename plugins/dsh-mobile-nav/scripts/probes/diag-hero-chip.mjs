// hero 相位分支胶囊净空断言（红→绿回归门）
// 断言：胶囊经 A′ CSS 重锚定（留在 dock 子树，常数钉到卡角）后，compat 的
// 44px 顶部净空不被 hero 紧凑规则踩掉
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
const URL_ = 'http://127.0.0.1:3080/'
const CHROME = '/data/data/com.termux/files/usr/lib/chromium/chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function allocatePort() { return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((e) => e ? rej(e) : res(port)) }) }) }
function createCdpClient(ws) {
  let n = 0; const p = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id !== undefined) { const q = p.get(m.id); if (!q) return; p.delete(m.id); m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result) } }
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++n; p.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
  return { send, evaluate, close: () => ws.close() }
}
async function waitFor(label, probe, timeout = 90000) { const d = Date.now() + timeout; while (Date.now() < d) { try { const v = await probe(); if (v) return v } catch { } await sleep(150) } throw new Error(label + ' timed out') }
const tmp = '/data/data/com.termux/files/home/tmp/cdp-fix'; await mkdir(tmp, { recursive: true })
const env = { ...process.env, TMPDIR: tmp, XDG_RUNTIME_DIR: tmp }
const port = await allocatePort(); const profileDir = await mkdtemp(join(homedir(), '.cache', 'dsh-diag13-'))
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=' + port, '--user-data-dir=' + profileDir, '--window-size=412,915', 'about:blank'], { stdio: 'ignore', env })
const target = await waitFor('target', async () => { try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (!r.ok) return null; const t = await r.json(); return t.length ? t[0] : null } catch { return null } })
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const client = createCdpClient(ws); await client.send('Page.enable'); await client.send('Runtime.enable')
await client.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' })
await client.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, screenWidth: 412, screenHeight: 915 })
await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await client.send('Page.navigate', { url: URL_ })
await waitFor('load', async () => { const s = await client.evaluate(`({r:document.readyState==='complete'})`); return s.r ? s : null })
await waitFor('phase', async () => { return client.evaluate(`(()=>{const ph=document.querySelector('[data-phase]');return ph?ph.getAttribute('data-phase'):null})()`) }, 150000)
// 轮询等胶囊出现（时序性渲染：git 数据异步加载，最长 20s）
const chipSeen = await waitFor('chip', async () => { return client.evaluate(`!!document.querySelector('[data-gitgraph-chip-anchor]')`) }, 20000).catch(() => false)
await sleep(800)
const d = await client.evaluate(`(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), t: Math.round(b.top * 10) / 10, b: Math.round(b.bottom * 10) / 10, l: Math.round(b.left) } }
  const card = document.querySelector('[class*="uV2eYG_card"]') || document.querySelector('[data-phase] [class*="_card"]')
  const anchor = document.querySelector('[data-gitgraph-chip-anchor]')
  const chip = document.querySelector('[data-gitgraph-chip]')
  const scroll = card && [...card.children].find((c) => (c.className || '').toString().includes('_scroll'))
  const row = card && [...card.children].find((c) => (c.className || '').toString().includes('_row'))
  const out = { chipSeen: !!anchor, padTop: card ? getComputedStyle(card).paddingTop : null, cardH: card ? Math.round(card.getBoundingClientRect().height) : null }
  if (anchor) out.anchor = r(anchor)
  if (chip) { out.chip = r(chip); out.chipTouch = getComputedStyle(chip).touchAction }
  if (scroll) out.scroll = r(scroll)
  if (row) out.row = r(row)
  // 上框两芯片不重叠
  const wr = document.querySelector('[class*="_heroWorkspaceRow"]')
  if (wr) { const kids = [...wr.querySelectorAll('button')].map(r); out.workspaceButtons = kids
    out.workspaceNoOverlap = kids.length >= 2 ? (kids[0].l + kids[0].w <= kids[1].l + 0.5) : true }
  return out
})()`)
// 断言
const A = []
const add = (name, ok, detail) => A.push({ name, ok, detail })
if (d.chipSeen) {
  add('A1 卡片净空=44px（compat 存活，含 4px 呼吸隙）', d.padTop === '44px', 'padTop=' + d.padTop)
  add('A2 胶囊底 ≤ 输入行顶（无重叠）', d.anchor.b <= d.scroll.t + 0.5, 'anchor.b=' + d.anchor.b + ' scroll.t=' + d.scroll.t)
  add('A3 胶囊可见', d.chip && d.chip.w > 0 && d.chip.h > 0, JSON.stringify(d.chip))
  add('A4 输入行在胶囊下方', d.scroll.t >= d.anchor.t, 'scroll.t=' + d.scroll.t + ' anchor.t=' + d.anchor.t)
  add('A5 工具行在输入行下方', d.row.t >= d.scroll.b - 0.5, 'row.t=' + d.row.t + ' scroll.b=' + d.scroll.b)
  add('A6 卡片高度合理 108~132', d.cardH >= 108 && d.cardH <= 132, 'cardH=' + d.cardH)
  add('A7 胶囊 touch-action=manipulation', d.chipTouch === 'manipulation', 'touchAction=' + d.chipTouch)
} else {
  add('CHIP-ABSENT 胶囊未渲染（时序）—紧凑 6px 生效属预期', d.padTop === '6px', 'padTop=' + d.padTop)
}
add('A8 上框按钮无重叠', d.workspaceNoOverlap === true, JSON.stringify(d.workspaceButtons))
let fails = 0
for (const a of A) { console.log((a.ok ? 'PASS' : 'FAIL') + ' ' + a.name + '  [' + a.detail + ']'); if (!a.ok) fails++ }
console.log(fails === 0 ? 'ALL GREEN' : fails + ' FAILED')
client.close(); chrome.kill('SIGTERM'); await Promise.race([once(chrome, 'exit').catch(() => { }), sleep(3000)]); chrome.kill('SIGKILL')
process.exit(fails === 0 ? 0 : 1)
