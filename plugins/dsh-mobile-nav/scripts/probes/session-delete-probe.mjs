// Mobile session-delete probe (port of fork wzxmt-zhc v2.7.0, mainline
// adaptation 2026-09-06, decision A "预备式收尾" 2026-09-07).
//
// Host-generation reality (CDP-verified): on 0.1.1-rc.2 the mobile drawer
// renders the workspace section as the icon RAIL (bhn1Oq_rail, empty
// bhn1Oq_listArea) — no session rows and no ⋯ menus at 390px or 768px. The
// hash was qDHVXG_ up to 0.1.3 but the installed rc.2 ships bhn1Oq_ (2026-09-19
// dead-needle fix; the same hash spans rc.2 and 0.1.6-alpha.2). A bare
// `[class*="_rail"]` substring was rejected: it collides with rails in four
// other packages (attachment/cordis/settings-general/sidebar). On a rehash the
// tripwire turns red — re-pin to the new hash.
// fork's injection surface (session rows with menus) only renders in the
// ≥1024px desktop panel on rc.2, and renders inside the drawer on 0.1.3.
// The client effect is touch-gated (TOUCH_QUERY, pointer: coarse at every
// width since 2.4.1), so on rc.2 it is an inert no-op that activates when
// the host upgrade puts session rows into the drawer.
//
// This probe therefore asserts:
//   - the ROUTE end-to-end (405 / 400 / 404 session-not-found) — live today;
//   - the rc.2 drawer reality as an UPGRADE TRIPWIRE: "no session rows in
//     the drawer" must flip to FAIL on 0.1.3, which is the maintainer's
//     signal to re-enable the injected-item/dialog assertion suite (kept
//     below as SKIP with the exact steps);
//   - the mouse/pointer-less desktop panel carries the rows and exactly the
//     4 host menu items (pin / rename / fork / archive — 0.1.7 shape; the
//     pre-0.1.7 hosts rendered 3) with ZERO injected markers
//     — the desktop zero-impact contract (15c/15d);
//   - the WIDE-TOUCH desktop (same ≥1024px viewport WITH touch emulation)
//     DOES get the injected item and its confirm dialog (16a-16d) — the
//     large-tablet landscape contract;
//   - selector forward-compatibility: [class*="_sessionRow"] matches the
//     rc.2 desktop rows (YDXeBa_sessionRow), so the fork logic hits as soon
//     a menu-bearing surface renders.
// No deletion is performed — the destructive path is a manual checklist.
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
const CHROME = '/data/data/com.termux/files/usr/lib/chromium/chrome'
const PORT = 9341
const URL_BASE = process.env.DSH_PROBE_URL ?? 'http://127.0.0.1:3080/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, label, timeoutMs) { const s = Date.now(); while (Date.now() - s < timeoutMs) { const v = await fn(); if (v) return v; await sleep(300) } throw new Error(label + ' timeout') }
const failures = []
const record = (ok, name, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`); if (!ok) failures.push(name) }
const skip = (name, reason) => console.log(`SKIP ${name} — ${reason}`)
async function latestSessionId() {
  const root = join(homedir(), '.dsh', 'sessions', '--data-data-com.termux-files-home--')
  const names = (await readdir(root)).filter((n) => n.startsWith('session-'))
  let best = null
  let bestMs = -1
  for (const n of names) {
    const s = await stat(join(root, n))
    if (s.mtimeMs > bestMs) { bestMs = s.mtimeMs; best = n }
  }
  return best
}
async function boot(c, evaluate, { touch, width, height }) {
  await c.send('Page.enable'); await c.send('Runtime.enable')
  await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: touch })
  if (touch) await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  if (process.env.DSH_PROBE_COOKIE) {
    const raw = process.env.DSH_PROBE_COOKIE
    const eq = raw.indexOf('=')
    await c.send('Network.setCookie', { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: URL_BASE })
  }
  await c.send('Page.navigate', { url: URL_BASE })
  await waitFor(() => evaluate(`document.readyState === 'complete'`), 'load', 30000)
  await sleep(1500)
  // 隔离 profile 的 Internal Testing Notice 模态必须整 root 移除（mask 拦触摸）。
  await evaluate(`for (const m of document.querySelectorAll('[n="true"]')) m.remove()`)
  const sid = process.env.DSH_PROBE_SESSION_ID ?? await latestSessionId()
  if (!sid) throw new Error('no session dir found to seed')
  await evaluate(`localStorage.setItem('dsh.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId: sid }))})`)
  await c.send('Page.navigate', { url: URL_BASE })
  await waitFor(() => evaluate(`document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'active'`), 'active', 30000)
  await sleep(1500)
  await evaluate(`for (const m of document.querySelectorAll('[n="true"]')) m.remove()`)
}
async function touchSwipe(c, x0, y0, x1, y1) {
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, radiusX: 2, radiusY: 2, force: 1, id: 0 }] })
  for (let i = 1; i <= 8; i += 1) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 8, y: y0 + (y1 - y0) * i / 8, radiusX: 2, radiusY: 2, force: 1, id: 0 }] })
    await sleep(16)
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}
async function tapAt(c, x, y, touch) {
  if (touch) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1, id: 0 }] })
    await sleep(40)
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await sleep(40)
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
}
// Desktop rows reveal their action buttons on hover (YDXeBa_rowActions is
// display:none until the row is hovered) — mouse-move over the row first,
// then click the now-visible ⋯ button.
async function desktopOpenMenu(c, evaluate) {
  const row = await evaluate(`(() => {
    const r = [...document.querySelectorAll('[class*="_sessionRow"]')].find((x) => x.getBoundingClientRect().width > 0)
    if (!r) return null
    const rc = r.getBoundingClientRect()
    return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 }
  })()`)
  if (!row) return false
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y })
  await sleep(400)
  const btn = await evaluate(`(() => {
    const r = [...document.querySelectorAll('[class*="_sessionRow"]')].find((x) => x.getBoundingClientRect().width > 0)?.querySelector('button')
    if (!r) return null
    const rc = r.getBoundingClientRect()
    return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2, vis: rc.width > 0 && rc.height > 0 }
  })()`)
  if (!btn || !btn.vis) return false
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
  await sleep(40)
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
  try {
    await waitFor(() => evaluate(`document.querySelector('[role="menu"]') !== null`), 'desktop-menu', 5000)
    return true
  } catch { return false }
}
async function main() {
  const dir = await mkdtemp(join(homedir(), 'tmp', 'cdp-sdel-'))
  const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-dev-shm-usage',`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'about:blank'], { env: { ...process.env, TMPDIR: dir, XDG_RUNTIME_DIR: dir }, stdio: 'ignore' })
  try {
    let wsUrl
    await waitFor(async () => { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const l = await r.json(); wsUrl = l.find(t => t.type === 'page')?.webSocketDebuggerUrl; return wsUrl } catch { return null } }, 'boot', 30000)
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let id = 0; const pending = new Map()
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } }
    const client = {
      ws,
      send(method, params = {}) { return new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })) }) },
    }
    const evaluate = async (expr) => { const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value }

    // ---- mobile boot + drawer ----
    await boot(client, evaluate, { touch: true, width: 390, height: 844 })
    record(true, '1.boot-active')
    record(await evaluate(`document.querySelector('[aria-modal="true"]') === null`), '2.no-modal-residue')
    record(await evaluate(`document.querySelector('[data-mobile-nav="frame"]') !== null`), '3.frame-marker-present')
    await touchSwipe(client, 5, 400, 60, 400)
    const opened = await waitFor(() => evaluate(`document.querySelector('[data-mobile-nav="frame"]')?.hasAttribute('data-sidebar-collapsed') === false`), 'drawer-open', 10000)
    record(opened === true, '4.drawer-opens-on-edge-swipe')
    await sleep(600)

    // ---- 5. UPGRADE TRIPWIRE: rc.2 drawer renders the rail variant, zero session rows ----
    const reality = await evaluate(`(() => {
      const area = document.querySelector('[class*="bhn1Oq_listArea"]')
      const railRoot = document.querySelector('[class*="bhn1Oq_rail"]')
      return { listChildren: area ? area.children.length : -1, railPresent: railRoot !== null, rows: document.querySelectorAll('[class*="_sessionRow"]').length, menus: document.querySelectorAll('[role="menu"]').length }
    })()`)
    record(reality.railPresent === true && reality.listChildren === 0 && reality.rows === 0 && reality.menus === 0,
      '5.tripwire-rc2-drawer-has-no-session-rows (expect FAIL on 0.1.3 → re-enable UI suite)',
      JSON.stringify(reality))
    // 6-13: the injected-item / dialog suite needs a menu-bearing surface.
    skip('6-13.mobile-injection-suite (menu items, dialog open/cancel/Escape)', 'rc.2 drawer renders no session menus; re-enable when 5 flips on 0.1.3 — steps in docs/fork-wzxmt-zhc/backlog.md 会话删除 row')
    await sleep(500)

    // ---- route negative paths through the real server (page fetch, live today) ----
    const neg = await evaluate(`(async () => {
      const base = ${JSON.stringify(URL_BASE)} + 'api/mobile-nav.session.delete'
      const get = await fetch(base, { method: 'GET' })
      const bad = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const unknown = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-does-not-exist-probe' }) })
      const unknownBody = await unknown.json().catch(() => ({}))
      return { get: get.status, bad: bad.status, unknown: unknown.status, code: unknownBody?.error?.code ?? '' }
    })()`)
    record(neg.get === 405, '14a.route-405-on-get', `got=${neg.get}`)
    record(neg.bad === 400, '14b.route-400-on-empty-body', `got=${neg.bad}`)
    record(neg.unknown === 404 && neg.code === 'session-not-found', '14c.route-404-unknown-session', `got=${neg.unknown} code=${neg.code}`)

    // ---- desktop: workspace panel HAS rows; menu = exactly 3 host items; zero injected markers ----
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await client.send('Page.navigate', { url: URL_BASE })
    await waitFor(() => evaluate(`document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'active'`), 'desktop-active', 30000)
    await sleep(1800)
    await evaluate(`for (const m of document.querySelectorAll('[n="true"]')) m.remove()`)
    const desktopRows = await evaluate(`document.querySelectorAll('[class*="_sessionRow"]').length`)
    record(desktopRows >= 1, '15a.desktop-panel-has-session-rows (selector forward-compat)', `rows=${desktopRows}`)
    const desktopMenu = await desktopOpenMenu(client, evaluate)
    record(desktopMenu, '15b.desktop-menu-opens')
    if (desktopMenu) {
      const dItems = await evaluate(`document.querySelectorAll('[role="menu"] [role="menuitem"]').length`)
      const dInjected = await evaluate(`document.querySelectorAll('[data-mobile-nav="session-delete"]').length`)
      record(dItems === 4 && dInjected === 0, '15c.desktop-menu-is-4-host-items-no-injection', `items=${dItems} injected=${dInjected}`)
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(300)
    } else {
      record(false, '15c.desktop-menu-is-4-host-items-no-injection', 'menu did not open')
    }
    const dDialogs = await evaluate(`document.querySelectorAll('[data-mobile-nav="session-delete"], [data-mobile-nav="delete-dialog"], [data-mobile-nav="delete-dialog-backdrop"]').length`)
    record(dDialogs === 0, '15d.desktop-zero-delete-markers', `n=${dDialogs}`)

    // ---- wide touch: same desktop viewport WITH touch emulation — the
    // ---- delete item must come back (large-tablet landscape contract) ----
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: true })
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await client.send('Page.navigate', { url: URL_BASE })
    await waitFor(() => evaluate(`document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'active'`), 'wide-touch-active', 30000)
    await sleep(1800)
    await evaluate(`for (const m of document.querySelectorAll('[n="true"]')) m.remove()`)
    const wtMenu = await desktopOpenMenu(client, evaluate)
    record(wtMenu, '16a.wide-touch-menu-opens')
    if (wtMenu) {
      const wtItems = await evaluate(`document.querySelectorAll('[role="menu"] [role="menuitem"]').length`)
      const wtInjected = await evaluate(`document.querySelectorAll('[data-mobile-nav="session-delete"]').length`)
      // 0.1.7: 4 host items (pin / rename / fork / archive) + 1 injected.
      record(wtItems === 5 && wtInjected === 1, '16b.wide-touch-menu-has-delete-item', `items=${wtItems} injected=${wtInjected}`)
      // Tap the injected item: it closes the host menu and opens the confirm
      // dialog. No deletion happens until the dialog's own "yes" is tapped,
      // which this probe never does.
      const delBtn = await evaluate(`(() => {
        const b = document.querySelector('[data-mobile-nav="session-delete"]')
        if (!b) return null
        const rc = b.getBoundingClientRect()
        return rc.width > 0 ? { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 } : null
      })()`)
      if (delBtn) {
        await tapAt(client, delBtn.x, delBtn.y, true)
        await sleep(600)
        const wtDialog = await evaluate(`document.querySelectorAll('[data-mobile-nav="delete-dialog"]').length`)
        record(wtDialog === 1, '16c.wide-touch-confirm-dialog-opens', `dialogs=${wtDialog}`)
        await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await sleep(300)
        const wtDialogGone = await evaluate(`document.querySelectorAll('[data-mobile-nav="delete-dialog"]').length`)
        record(wtDialogGone === 0, '16d.wide-touch-dialog-closes-on-escape', `dialogs=${wtDialogGone}`)
      } else {
        record(false, '16c.wide-touch-confirm-dialog-opens', 'injected item not visible')
      }
    } else {
      record(false, '16b.wide-touch-menu-has-delete-item', 'menu did not open')
      record(false, '16c.wide-touch-confirm-dialog-opens', 'menu did not open')
      record(false, '16d.wide-touch-dialog-closes-on-escape', 'menu did not open')
    }
  } finally {
    chrome.kill()
    await sleep(300)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  if (failures.length > 0) { console.log(`FAILED: ${failures.join(', ')}`); process.exitCode = 1 } else { console.log('ALL PASS') }
}
main().catch((e) => { console.error('ERR', e); process.exitCode = 1 })
