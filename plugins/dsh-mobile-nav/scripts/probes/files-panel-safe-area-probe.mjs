// Files panel (host right sidebar) vs the phone status bar.
//
// The host pins its right sidebar as a fixed full-bleed sheet
// ([data-sidebar-right-panel=fullscreen] -> position:fixed; inset:0) and ships
// no safe-area handling at all, so its top row - the tab strip with the tab
// label, the + button and the Split / Exit-fullscreen pair on the right edge -
// sat UNDER the status bar. A fixed element's containing block is the viewport,
// so the frame's own safe-area padding cannot reach it; layout.css takes the
// inset as padding on the panel instead.
//
// Headless has no safe-area inset (env() resolves to 0), so scenes 3-4 simulate
// the status bar with an inline padding-top of the same value and assert the
// geometry the real inset produces: the panel keeps covering the whole viewport
// (no seam behind the status bar, the panel paints its own bg-base) while every
// top-row control drops below the bar with the right-hand buttons still on the
// right edge. Scene 1-2 pin the contract the fix depends on, so a host upgrade
// that renames the attribute or stops using the fullscreen form fails loudly.
// Scene 5 covers the host's other panel form: above phone widths the right
// sidebar docks (form=push, position:absolute inside the frame), and an
// absolutely-positioned panel already lives in the frame's padding box - i.e.
// below the status bar - so the rule must NOT reach it (a second inset would
// push its row down twice).
//
// Env: DSH_PROBE_URL (default http://127.0.0.1:3080/), DSH_PROBE_SESSION_ID,
// DSH_PROBE_COOKIE (name=value, for an authenticated instance), DSH_PROBE_INSET
// (default 47 = a typical Android status bar), DSH_PROBE_CHROME.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.env.DSH_PROBE_URL || 'http://127.0.0.1:3080/'
const SESSION_ID = process.env.DSH_PROBE_SESSION_ID || ''
const COOKIE = process.env.DSH_PROBE_COOKIE || ''
const INSET = Number(process.env.DSH_PROBE_INSET || 47)
const CHROME = process.env.DSH_PROBE_CHROME || 'chromium'
const PORT = 9356

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

async function main() {
  const dir = await mkdtemp(join(homedir(), 'tmp', 'cdp-files-panel-'))
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
    const json = async (expression) => JSON.parse(await evaluate(expression))

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    if (COOKIE) {
      const eq = COOKIE.indexOf('=')
      await send('Network.setCookie', { name: COOKIE.slice(0, eq), value: COOKIE.slice(eq + 1), url: URL_ })
    }
    if (SESSION_ID) {
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `localStorage['dsh.sessions.current'] = JSON.stringify({sessionId:${JSON.stringify(SESSION_ID)}})`,
      })
    }
    await send('Page.navigate', { url: URL_ })
    // Readiness is a DOM contract, not a phase marker: `body.dataset.dshPhase`
    // does not exist in this host at all (the real marker is the element
    // attribute [data-phase="active"], ~3.3s after boot; waiting on dshPhase
    // only ever timed out). The plugin's frame marker comes earlier (~0.7s) and
    // proves the mobile branch armed, which is what the panel rule needs.
    await waitFor(async () => await evaluate(`document.querySelector('[data-mobile-nav="frame"]') !== null`), 'mobile frame', 30000)
    await waitFor(async () => await evaluate(`document.querySelector('[data-sidebar-right-expand]') !== null`), 'files opener', 15000)

    // ---- 1. the rule is injected, inside the mobile branch ----
    const rules = await json(`(() => {
      const hits = []
      const walk = (list, media) => {
        for (const r of list) {
          try {
            if (r.selectorText) {
              if (r.selectorText.includes('data-sidebar-right-panel')) hits.push({ sel: r.selectorText, css: r.style.cssText, media })
              continue
            }
            if (r.cssRules) walk(r.cssRules, r.conditionText || media)
          } catch {}
        }
      }
      for (const sheet of document.styleSheets) {
        const owner = sheet.ownerNode
        if (!owner || owner.dataset?.plugin !== 'dsh-web-mobile') continue
        try { walk(sheet.cssRules, '') } catch {}
      }
      return JSON.stringify(hits)
    })()`)
    const rule = rules.find((r) => r.sel === '[data-sidebar-right-panel="fullscreen"]')
    record(Boolean(rule), '1.rule-injected', JSON.stringify(rules.map((r) => r.sel)))
    record(Boolean(rule) && /padding-top:\s*env\(safe-area-inset-top/.test(rule.css), '1.rule-declaration', rule ? rule.css : 'absent')
    record(Boolean(rule) && /max-width:\s*1023px/.test(rule.media) && /pointer:\s*coarse/.test(rule.media), '1.rule-in-mobile-branch', rule ? rule.media : 'absent')

    // ---- 2. the host contract the fix rides on ----
    await evaluate(`(() => { const el = document.querySelector('[data-sidebar-right-expand]'); el.click(); return true })()`)
    await waitFor(async () => await evaluate(`document.querySelector('[data-sidebar-right-panel="fullscreen"]') !== null`), 'panel open', 15000)
    await sleep(1000)
    const measure = `(() => {
      const p = document.querySelector('[data-sidebar-right-panel="fullscreen"]')
      if (!p) return null
      const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] }
      const cs = getComputedStyle(p)
      return JSON.stringify({
        panel: box(p), pos: cs.position, inset: [cs.top, cs.right, cs.bottom, cs.left].join(','),
        padTop: cs.paddingTop, bg: cs.backgroundColor,
        form: p.getAttribute('data-sidebar-right-panel'),
        strip: box(p.querySelector('[class*="_tabStrip"]')),
        label: box(p.querySelector('[class*="_tabTitle"]')),
        addTab: box(p.querySelector('button[aria-label="New tab"]')),
        split: box(p.querySelector('button[aria-label="Split"]')),
        fullscreen: box(p.querySelector('button[aria-label="Exit fullscreen"]'))
      })
    })()`
    const base = JSON.parse(await evaluate(measure))
    record(base !== null, '2.panel-present')
    record(base.pos === 'fixed' && base.inset === '0px,0px,0px,0px', '2.panel-is-fixed-fullbleed',
      `position=${base.pos} inset=${base.inset}`)
    record(base.bg !== 'rgba(0, 0, 0, 0)', '2.panel-paints-its-own-background', `bg=${base.bg} (keeps the status-bar band filled)`)
    record(base.label !== null && base.addTab !== null && base.split !== null && base.fullscreen !== null,
      '2.top-row-controls-present', 'tab label / + / Split / Exit fullscreen')
    record(base.form === 'fullscreen', '2.host-form-is-fullscreen', `data-sidebar-right-panel=${base.form}`)
    record(base.padTop === '0px', '2.headless-baseline', `padding-top=${base.padTop} (env() is 0 without a real inset)`)
    // The load-bearing link: the injected rule's selector must MATCH this live
    // panel. Section 3 pushes an inline padding and watches the row move, which
    // only re-proves the box model — if the selector stopped matching the real
    // markup, 2/3 would still be green while the fix did nothing on device.
    const match = await json(`(() => {
      const p = document.querySelector('[data-sidebar-right-panel="fullscreen"]')
      return JSON.stringify({ matches: p !== null && p.matches('[data-sidebar-right-panel="fullscreen"]'), tag: p ? p.tagName.toLowerCase() : null })
    })()`)
    record(match.matches === true, '2.rule-selector-matches-live-panel', `matches=${match.matches} tag=${match.tag}`)

    // ---- 3. with the inset in place the whole row clears the status bar ----
    await evaluate(`(() => { const p = document.querySelector('[data-sidebar-right-panel="fullscreen"]'); p.style.setProperty('padding-top', '${INSET}px', 'important'); return true })()`)
    await sleep(300)
    const sim = JSON.parse(await evaluate(measure))
    record(JSON.stringify(sim.panel) === '[0,0,390,844]', '3.panel-still-covers-viewport', JSON.stringify(sim.panel))
    for (const key of ['strip', 'label', 'addTab', 'split', 'fullscreen']) {
      record(sim[key] !== null && sim[key][1] >= INSET, `3.${key}-below-status-bar`, `${key} top=${sim[key] ? sim[key][1] : 'absent'} inset=${INSET}`)
    }
    record(sim.strip[1] - base.strip[1] === INSET, '3.row-shifts-by-exactly-the-inset', `${base.strip[1]} -> ${sim.strip[1]}`)
    record(Math.round(sim.fullscreen[0] + sim.fullscreen[2]) === 384 && Math.round(sim.split[0] + sim.split[2]) === 348,
      '3.right-buttons-stay-pinned-right',
      `exit-fullscreen right=${sim.fullscreen[0] + sim.fullscreen[2]} split right=${sim.split[0] + sim.split[2]}`)
    record(sim.strip[1] - sim.fullscreen[1] === base.strip[1] - base.fullscreen[1], '3.row-keeps-its-internal-alignment',
      `offset ${base.strip[1] - base.fullscreen[1]} -> ${sim.strip[1] - sim.fullscreen[1]}`)

    // ---- 4. the panel body follows the padded top instead of overflowing ----
    const body = await json(`(() => {
      const p = document.querySelector('[data-sidebar-right-panel="fullscreen"]')
      const el = p.querySelector('[class*="_paneBody"]')
      const b = el.getBoundingClientRect()
      return JSON.stringify({ top: Math.round(b.top), bottom: Math.round(b.bottom), h: innerHeight })
    })()`)
    record(body.bottom <= body.h && body.top >= INSET, '4.pane-body-stays-inside', JSON.stringify(body))
    await evaluate(`(() => { const p = document.querySelector('[data-sidebar-right-panel="fullscreen"]'); p.style.removeProperty('padding-top'); return true })()`)

    // ---- 5. the docked form (tablet widths) is out of the rule's scope ----
    await send('Emulation.setDeviceMetricsOverride', { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true })
    await send('Page.navigate', { url: URL_ })
    await waitFor(async () => await evaluate(`document.querySelector('[data-mobile-nav="frame"]') !== null`), 'tablet frame', 30000)
    await waitFor(async () => await evaluate(`document.querySelector('[data-sidebar-right-expand]') !== null`), 'tablet files opener', 15000)
    record(await evaluate(`matchMedia('(max-width: 1023px) and (pointer: coarse)').matches`), '5.tablet-still-in-mobile-branch', '820px + coarse pointer')
    await evaluate(`(() => { document.querySelector('[data-sidebar-right-expand]').click(); return true })()`)
    await waitFor(async () => await evaluate(`document.querySelector('[data-sidebar-right-panel]') !== null`), 'tablet panel open', 15000)
    await sleep(1000)
    const docked = await json(`(() => {
      const p = document.querySelector('[data-sidebar-right-panel]')
      const frame = document.querySelector('[data-mobile-nav="frame"]')
      const cs = getComputedStyle(p)
      const b = p.getBoundingClientRect()
      const fb = frame.getBoundingClientRect()
      return JSON.stringify({
        form: p.getAttribute('data-sidebar-right-panel'), pos: cs.position, padTop: cs.paddingTop,
        top: Math.round(b.top), frameTop: Math.round(fb.top), framePad: getComputedStyle(frame).paddingTop,
        insideFrame: frame.contains(p), scopedMatch: p.matches('[data-sidebar-right-panel="fullscreen"]')
      })
    })()`)
    record(docked.form === 'push' && docked.pos === 'absolute', '5.host-form-is-docked',
      `data-sidebar-right-panel=${docked.form} position=${docked.pos}`)
    record(docked.scopedMatch === false, '5.docked-panel-outside-rule-scope', 'rule selector must not match the docked form')
    record(docked.padTop === '0px', '5.docked-panel-not-double-padded', `padding-top=${docked.padTop}`)
    record(docked.insideFrame === true && docked.top >= docked.frameTop, '5.docked-panel-inside-frame',
      `containing block = frame padding box (top ${docked.top} >= frame ${docked.frameTop}) -> already below the status bar`)
  } finally {
    chrome.kill()
    await sleep(300)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  if (failures.length > 0) { console.log(`FAILED: ${failures.join(', ')}`); process.exitCode = 1 } else { console.log('ALL PASS') }
}
main().catch((e) => { console.error('ERR', e); process.exitCode = 1 })
