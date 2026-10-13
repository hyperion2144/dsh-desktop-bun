// The hero (new-conversation) composer must render its input unclipped.
//
// The host sizes the hero input with a floor of its own:
//   .<hash>_hero .<hash>_input { min-height: 52px }
// (verified in @deepseek-ai/dsh-client-ui-conversation 0.1.2-rc.1 and 0.1.5-rc.2) because the hero
// placeholder hint wraps to two lines. The plugin's hero tightening used to force the EMPTY state to
// one line with `height: 28px !important` on the scroll/grow wrappers plus the input; a min-height
// floor beats an outer height, so the wrappers only shrank the *viewport*: measured 2026-09-14 at
// 390px - `_scroll` clientHeight 28 against scrollHeight 52 with overflow-y:auto (scrollbar), the
// autofocused editor scrolled itself to scrollTop 24 and the first input line plus the first line of
// the hint rendered outside the visible band. The collapse was authored 2026-09-05 against a synthetic
// Lexical fixture (no host floor) and went live for real when the host reached 0.1.5.
//
// Invariant guarded here: in the hero the input renders at or above the host's own floor, the scroll
// container is not scrolled and has nothing to scroll, the input and the placeholder hint sit fully
// inside that container, and no plugin rule pins the height of the scroll/grow/input chain.
//
// Scenes: phone 390x844 with touch (hero empty state), then desktop 1280x720 with a fine pointer
// (same chain, plugin must not inject anything there).
//
// Env: DSH_PROBE_URL (default http://127.0.0.1:3080/), DSH_PROBE_COOKIE (name=value, for an
// authenticated instance - see .local-tests/grab-cookie.mjs), DSH_PROBE_CHROME.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.env.DSH_PROBE_URL || 'http://127.0.0.1:3080/'
const COOKIE = process.env.DSH_PROBE_COOKIE || ''
const CHROME = process.env.DSH_PROBE_CHROME || 'chromium'
const PORT = 9361

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const record = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`)
  if (!ok) failures.push(name)
}
async function waitFor(fn, label, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) { const v = await fn(); if (v) return v; await sleep(300) }
  throw new Error(label + ' timeout')
}

// Reads the hero composer chain plus every plugin rule that matches it.
const MEASURE = `(() => {
  const card = document.querySelector('[data-phase="hero"] [class*="_card"]:has(textarea, [data-composer-input])')
  if (card === null) return JSON.stringify({ card: false })
  const scroll = card.querySelector('[class*="_scroll"]')
  const grow = card.querySelector('[class*="_grow"]')
  const input = card.querySelector('textarea, [data-composer-input]')
  const ph = card.querySelector('[data-composer-placeholder]')
  const box = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height } }
  const rules = []
  const walk = (list, media) => {
    for (const r of list) {
      try {
        if (r.selectorText) {
          for (const [label, el] of [['scroll', scroll], ['grow', grow], ['input', input]]) {
            if (el !== null && r.selectorText !== undefined && el.matches(r.selectorText)) {
              rules.push({ label, sel: r.selectorText, css: r.style.cssText, media: media || '' })
            }
          }
          continue
        }
        if (r.cssRules) walk(r.cssRules, r.conditionText || media)
      } catch {}
    }
  }
  for (const sheet of document.styleSheets) {
    const owner = sheet.ownerNode
    if (!owner || owner.dataset === undefined || owner.dataset.plugin !== 'dsh-web-mobile') continue
    try { walk(sheet.cssRules, '') } catch {}
  }
  const sb = box(scroll), ib = box(input)
  return JSON.stringify({
    card: true,
    mobileQuery: matchMedia('(max-width: 1023px) and (pointer: coarse)').matches,
    scroll: { ...sb, clientH: scroll.clientHeight, scrollH: scroll.scrollHeight, scrollTop: scroll.scrollTop, overflowY: getComputedStyle(scroll).overflowY },
    input: { ...ib, minH: getComputedStyle(input).minHeight, inlineH: input.style.height || null },
    placeholder: ph === null ? null : box(ph),
    pluginRules: rules
  })
})()`

async function main() {
  const dir = await mkdtemp(join(homedir(), 'tmp', 'cdp-hero-clip-'))
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, 'about:blank',
  ], { env: { ...process.env, TMPDIR: dir, XDG_RUNTIME_DIR: dir }, stdio: 'ignore' })

  try {
    let wsUrl
    await waitFor(async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
        wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
        return wsUrl
      } catch { return null }
    }, 'chrome boot', 30000)

    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let id = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id)
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
      }
    }
    const send = (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id; pending.set(mid, { res, rej })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    if (COOKIE) {
      const eq = COOKIE.indexOf('=')
      await send('Network.setCookie', { name: COOKIE.slice(0, eq), value: COOKIE.slice(eq + 1), url: URL_ })
    }

    const boot = async (label, readySelector) => {
      await send('Page.navigate', { url: URL_ })
      await waitFor(async () => await evaluate(`document.querySelector(${JSON.stringify(readySelector)}) !== null`), label + ' ready', 60000)
      // A fresh profile can raise the host "Internal Testing Notice" modal; drop its whole root.
      await evaluate(`(() => {
        const root = document.querySelector('[class*="_root_15u5s"]')
        if (root !== null && root.parentElement === document.body) root.remove()
        for (const m of document.querySelectorAll('[aria-modal="true"]')) m.remove()
      })()`)
      await waitFor(async () => await evaluate(`document.querySelector('[data-phase="hero"] [class*="_card"]:has([data-composer-input])') !== null`), label + ' hero card', 60000)
      await sleep(800)
    }

    // ---- phone scene: the hero empty state ----
    await boot('phone', '[data-mobile-nav="frame"]')
    const phone = JSON.parse(await evaluate(MEASURE))
    record(phone.card === true, '1.hero-composer-present', '')
    record(phone.mobileQuery === true, '1.mobile-branch-active', `mobileQuery=${phone.mobileQuery}`)
    const p = phone
    record(p.scroll.scrollH <= p.scroll.clientH, '2.scroll-container-not-overflowing',
      `clientH=${p.scroll.clientH} scrollH=${p.scroll.scrollH} overflowY=${p.scroll.overflowY}`)
    record(p.scroll.scrollTop === 0, '2.scroll-container-not-scrolled', `scrollTop=${p.scroll.scrollTop}`)
    record(p.input.top >= p.scroll.top - 0.5 && p.input.bottom <= p.scroll.bottom + 0.5, '3.input-fully-visible',
      `input ${p.input.top.toFixed(1)}..${p.input.bottom.toFixed(1)} in scroll ${p.scroll.top.toFixed(1)}..${p.scroll.bottom.toFixed(1)}`)
    const minH = Number.parseFloat(p.input.minH) || 0
    record(p.input.h >= minH - 0.5, '3.input-respects-host-floor',
      `inputH=${p.input.h.toFixed(1)} minHeight=${p.input.minH}`)
    if (p.placeholder !== null) {
      record(p.placeholder.bottom <= p.scroll.bottom + 0.5, '4.hint-fully-visible',
        `hint ${p.placeholder.top.toFixed(1)}..${p.placeholder.bottom.toFixed(1)} in scroll ..${p.scroll.bottom.toFixed(1)}`)
    } else {
      record(true, '4.hint-fully-visible', 'SKIP: no [data-composer-placeholder] node')
    }
    const pinned = p.pluginRules.filter((r) => /(^|;)\s*height\s*:/.test(r.css))
    record(pinned.length === 0, '5.no-plugin-rule-pins-the-chain',
      pinned.length === 0 ? `${p.pluginRules.length} plugin rule(s) match, none declare height` : pinned.map((r) => `${r.label}<-${r.sel}{${r.css}}`).join(' | '))
    // 5b — the hero phase's empty header (headerHidden) must never paint. The
    // host's own session-controller grid rule (<=768px) used to beat the host
    // hide and left a stray 1px border-bottom under the status bar (the owner's
    // "gray line at the top of the hero screen"). The plugin re-hides it in the
    // mobile branch. Some hosts never mount the header at all (older engines
    // take a different branch), which satisfies the contract a fortiori: the
    // assertion is "absent or display:none", not "present".
    const phoneHeader = JSON.parse(await evaluate(`(() => {
      const h = document.querySelector('header')
      return JSON.stringify({ cls: h ? h.className : null, display: h ? getComputedStyle(h).display : null })
    })()`))
    const phoneHeaderInvisible = phoneHeader.cls === null || ((phoneHeader.cls.includes('headerHidden') || phoneHeader.cls.includes('headerBlank')) && phoneHeader.display === 'none')
    record(phoneHeaderInvisible,
      '5b.hero-hidden-header-stays-invisible', phoneHeader.cls === null ? 'header not mounted' : `display=${phoneHeader.display} hidden=${(phoneHeader.cls.includes('headerHidden') || phoneHeader.cls.includes('headerBlank'))}`)

    // ---- desktop scene: the same chain must stay untouched ----
    await send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
    await boot('desktop', '[data-phase]')
    const desk = JSON.parse(await evaluate(MEASURE))
    record(desk.card === true, '6.desktop-hero-composer-present', '')
    record(desk.mobileQuery === false, '6.desktop-keeps-mobile-branch-off', `mobileQuery=${desk.mobileQuery}`)
    record(desk.pluginRules.length === 0, '6.desktop-composer-untouched',
      desk.pluginRules.map((r) => `${r.label}<-${r.sel}`).join(' | ') || 'no plugin rule matches the chain')
    record(desk.scroll.scrollH <= desk.scroll.clientH, '6.desktop-no-overflow',
      `clientH=${desk.scroll.clientH} scrollH=${desk.scroll.scrollH}`)
    // 6b — desktop keeps the host's own hide (our mobile rule must not be what
    // the desktop relies on, nor contradict it). Same "absent or display:none"
    // contract as 5b.
    const deskHeader = JSON.parse(await evaluate(`(() => {
      const h = document.querySelector('header')
      return JSON.stringify({ cls: h ? h.className : null, display: h ? getComputedStyle(h).display : null })
    })()`))
    const deskHeaderInvisible = deskHeader.cls === null || ((deskHeader.cls.includes('headerHidden') || deskHeader.cls.includes('headerBlank')) && deskHeader.display === 'none')
    record(deskHeaderInvisible,
      '6b.desktop-hidden-header-stays-invisible', deskHeader.cls === null ? 'header not mounted' : `display=${deskHeader.display}`)
  } finally {
    chrome.kill()
    await sleep(300)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  if (failures.length > 0) { console.log(`FAILED: ${failures.join(', ')}`); process.exitCode = 1 } else { console.log('ALL PASS') }
}
main().catch((e) => { console.error('ERR', e); process.exitCode = 1 })
