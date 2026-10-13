// The context meter in the composer's trailing lane: the ring keeps its place, and the invisible
// hit box around it stays as large as geometry allows.
//
// The meter (official ContextMeter, JObwrW_ hash family) is the last control before the primary
// key, and that key flips from send to STOP while a turn runs. Two phone reports on 2026-09-17
// fixed the contract:
//   * the ring read as too small to hit, so the INVISIBLE trigger box grew 24x24 -> 28x34 (hit area
//     576 -> 952 square px, +65%);
//   * the first attempt at that growth also separated the meter from the primary key (margin-right
//     +8px, 14px of dead space) and was rejected: the ring must keep hugging the key. A later
//     symmetric 34px box was rejected too, because a box pinned on its right edge grows leftward and
//     drags the centred ink along with it. The owner then picked a 6px leftward shift by eye.
//
// Invariants guarded here: the ring ink stays 14x14 (enlarging it is rejected as attention-seeking),
// it never reaches the primary key, the hit box reaches the key's boundary without crossing it, the
// box spans the whole corridor without overlapping the model pill, the row height does not move, and
// a slip just right of the visible ring still lands on the meter. Width 28 is the geometric ceiling:
// the box is centred on the ink and the key's hit box starts 14px right of that centre.
//
// Three traps this probe walked into, all worth knowing before asserting on this cluster:
//   * `[class*="_card"]` is NOT composer-specific. On a 390px phone it matched 14 elements, 13 of
//     them conversation message cards (CY-8Ka_card). The host's own `[data-composer-card]` marker is
//     unique (count 1) and is what this probe anchors on — with NO fallback: a census of all 23
//     published versions of dsh-client-ui-conversation (2026-09-17, npm tarballs + jsdelivr) found
//     the marker in every one of them, starting with the oldest, 0.0.1-rc.1. A host without it does
//     not exist, so an absent marker must fail loudly here instead of falling back to message cards.
//     (`[data-composer-input]` is the generation-gated marker: 0.1.2-alpha.2 onward, Lexical era.)
//   * `[class*="_root"]:has(> [class*="_trigger"][aria-haspopup="dialog"])` is not unique either: a
//     message action bar renders `Q51KRG_root > Q51KRG_trigger[aria-haspopup="dialog"]` as well, at
//     y=-3906 (scrolled far above the viewport, so it still counts as laid out while nothing can
//     reach it). Always scope the meter lookup into the composer card's trailing lane.
//   * computed sizes lie about reachability: a composer card that is not laid out still reports the
//     rule's 28x34 while every getBoundingClientRect() reads 0, which silently turns geometry
//     assertions into false greens. Hence the visibility filter and the elementFromPoint hit tests.
//     The state was reproduced and pinned down (2026-09-18, .local-tests/hidden-copy-signature.mjs):
//     it is a card under an ancestor computing display:none, and in this app that ancestor is the
//     HOST's own chain overlay — dsh-client-ui-renderer renderChainResult() wraps the composer in
//     `[data-chain-overlay-fallback="conversation.composer"]` and writes an inline display:none on it
//     whenever an overlay is elected for that slot (observed live: a pending user-question card,
//     `Mbwy4a_frame[data-question-key]` from dsh-client-ui-user-questions). Two other shapes read
//     differently and must not be confused with it: a DETACHED node returns empty computed strings
//     (not 28x34), and content-visibility:hidden keeps rect AND computed intact (356x98 measured,
//     unmoved) — that one is invisible-but-laid-out, caught only by the hit tests, never by the rect
//     filter. An earlier reading blamed the mobile frame's inline display:none ("fence-only"): it
//     reproduced the shape but named the wrong mechanism.
//     Because the overlay state is legitimate, the probe reports it as a SKIP naming the elected node
//     instead of failing 0.composer-present; any other zero-card state still fails loudly.
//
// Scenes: phone 390x844 with touch, then desktop 1280x720 with a fine pointer (the plugin's mobile
// rules must not touch the meter there at all).
//
// Env: DSH_PROBE_URL (default http://127.0.0.1:3080/), DSH_PROBE_SESSION_ID (opens a real session,
// which is what renders the meter), DSH_PROBE_COOKIE (name=value, for an authenticated instance),
// DSH_PROBE_CHROME (Termux: the real chromium ELF).
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.env.DSH_PROBE_URL || 'http://127.0.0.1:3080/'
const COOKIE = process.env.DSH_PROBE_COOKIE || ''
const CHROME = process.env.DSH_PROBE_CHROME || 'chromium'
const SESSION_ID = process.env.DSH_PROBE_SESSION_ID || ''
const PORT = 9362
const MOBILE_QUERY = '(max-width: 1023px) and (pointer: coarse)'

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

// Measures the REAL meter on the REAL composer. The card is picked by the host's own marker and by
// being laid out; the meter is scoped to that card so the message-action dialog trigger cannot be
// mistaken for it. No synthetic fixture: an injected copy doubles the cluster and skews every gap.
const MEASURE = `(() => {
  const mobileQuery = matchMedia(${JSON.stringify(MOBILE_QUERY)}).matches
  // The host can replace the entire composer with a chain overlay (dsh-client-ui-renderer
  // renderChainResult): the fallback tree -- this card included -- then carries an inline
  // display:none while the elected overlay renders as its next sibling. Naming that state here is
  // what separates "the composer is off screen on purpose" from "the composer is broken".
  const fallback = document.querySelector('[data-chain-overlay-fallback="conversation.composer"]')
  const replacedBy = (() => {
    if (fallback === null || getComputedStyle(fallback).display !== 'none') return null
    const elected = fallback.nextElementSibling
    return {
      slot: fallback.getAttribute('data-chain-overlay-fallback'),
      elected: elected === null ? null : (elected.getAttribute('class') || elected.tagName).slice(0, 40),
      key: elected === null ? null : elected.getAttribute('data-question-key'),
    }
  })()
  // Marker only, no fallback (see trap 1): every published host carries it, and the fallback would
  // have silently measured the first message card holding an input.
  const marked = [...document.querySelectorAll('[data-composer-card]')]
  const cards = marked.filter((c) => c.getBoundingClientRect().width > 0)
  if (cards.length === 0) return JSON.stringify({ card: false, mobileQuery: mobileQuery, overlay: replacedBy })
  const card = cards[0]
  const trailing = card.querySelector('[class*="_trailing"]')
  if (trailing === null) return JSON.stringify({ card: true, meter: false, mobileQuery: mobileQuery })
  const meters = [...trailing.querySelectorAll('[class*="_root"]:has(> [class*="_trigger"][aria-haspopup="dialog"])')]
  const trigger = meters.length === 0 ? null : meters[0].querySelector(':scope > [class*="_trigger"]')
  const svg = trigger === null ? null : trigger.querySelector('svg')
  const primary = trailing.querySelector('[class*="_primary"]')
  const pill = trailing.querySelector('[class*="_trigger"][aria-haspopup="menu"]')
  if (trigger === null || svg === null || primary === null) {
    return JSON.stringify({ card: true, meter: false, mobileQuery: mobileQuery })
  }
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2), right: +b.right.toFixed(2) } }
  const box = r(trigger), ink = r(svg), key = r(primary)
  const cs = getComputedStyle(trigger)
  const cy = ink.y + ink.h / 2
  const hit = (x) => {
    const el = document.elementFromPoint(x, cy)
    if (el === null) return 'none'
    if (trigger.contains(el)) return 'meter'
    return primary.contains(el) ? 'primary' : 'other'
  }
  return JSON.stringify({
    card: true, meter: true, mobileQuery: mobileQuery,
    cardCount: cards.length,
    cardRect: r(card), lane: r(trailing),
    box: box, ink: ink, key: key,
    pill: pill === null ? null : r(pill),
    meterCount: meters.length,
    usedMarker: marked.length > 0,
    cs: { w: cs.width, h: cs.height, pad: cs.padding, marginRight: getComputedStyle(meters[0]).marginRight },
    inkToKey: +(key.x - ink.right).toFixed(2),
    boxToKey: +(key.x - box.right).toFixed(2),
    boxToPill: pill === null ? null : +(box.x - r(pill).right).toFixed(2),
    hits: {
      ringCentre: hit(ink.x + ink.w / 2),
      boxLeftEdge: hit(box.x + 1),
      boxRightEdge: hit(box.x + box.w - 1),
      slip6RightOfInk: hit(ink.x + ink.w + 6),
      primaryCentre: hit(key.x + key.w / 2)
    }
  })
})()`

async function main() {
  const dir = await mkdtemp(join(homedir(), 'tmp', 'cdp-meter-hitbox-'))
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
    const evaluate = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value

    await send('Page.enable')
    await send('Runtime.enable')
    if (COOKIE) {
      const eq = COOKIE.indexOf('=')
      await send('Network.setCookie', { name: COOKIE.slice(0, eq), value: COOKIE.slice(eq + 1), url: URL_ })
    }
    if (SESSION_ID) {
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `localStorage.setItem('dsh.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId: SESSION_ID }))})`,
      })
    }

    const boot = async (label, mobile) => {
      // Touch emulation is load-bearing: headless chromium has no pointer device, so without it
      // (pointer: coarse) is false, MOBILE_QUERY never matches and the mobile branch stays inert.
      await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
      await send('Emulation.setDeviceMetricsOverride', mobile
        ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
        : { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
      await send('Page.navigate', { url: URL_ })
      await waitFor(async () => await evaluate(`document.querySelector('[class*="_trailing"], [data-composer-card]') !== null`), label + ' composer shell', 60000)
      // A fresh profile can raise the host "Internal Testing Notice" modal; drop its whole root.
      await evaluate(`(() => {
        const root = document.querySelector('[class*="_root_15u5s"]')
        if (root !== null && root.parentElement === document.body) root.remove()
        for (const m of document.querySelectorAll('[aria-modal="true"]')) m.remove()
      })()`)
      const readOnce = async () => {
        const value = await evaluate(MEASURE)
        return value === undefined ? null : JSON.parse(value)
      }
      // The meter renders only once the host's context-pressure projection arrives, and the session
      // view is laid out a beat after boot, so poll until the card is both present and laid out.
      try {
        return JSON.parse(await waitFor(async () => {
          const parsed = await readOnce()
          return parsed !== null && parsed.meter === true ? JSON.stringify(parsed) : null
        }, label + ' laid-out composer with meter', 40000))
      } catch {
        // No meter: that projection is provider-dependent. Report it and let the caller SKIP.
        return (await readOnce()) ?? { card: false, meter: false, mobileQuery: false }
      }
    }

    // ---- phone scene ----
    const p = await boot('phone', true)
    // An overlay elected for the composer slot (a pending user question or an approval card) hides
    // the whole fallback tree, meter included: there is nothing to measure, and a red here would be
    // about the host's overlay, not about the plugin. Say so -- never silently -- and skip the scene.
    const replaced = p.card !== true && p.overlay !== null && p.overlay !== undefined
    if (replaced) {
      console.log('SKIP phone scene: composer replaced by chain overlay "' + p.overlay.slot + '"' +
        ' (elected ' + p.overlay.elected + (p.overlay.key === null ? '' : ' ' + p.overlay.key) + ')' +
        ' -- the host hides the fallback with an inline display:none, so the meter is off screen by design')
    } else {
      record(p.card === true, '0.composer-present', '')
      record(p.mobileQuery === true, '0.mobile-branch-active', `mobileQuery=${p.mobileQuery}`)
      if (p.meter !== true) {
        console.log('SKIP meter not rendered (no context-pressure projection in this profile)')
      } else {
        record(p.cardCount === 1, '0.one-visible-composer-card', `laid-out cards=${p.cardCount}`)
        record(p.meterCount === 1, '0.single-meter-in-lane', `meters=${p.meterCount}`)
        record(p.box.w > 0 && p.ink.w > 0, '0.laid-out-not-a-hidden-copy',
          `box=${p.box.w}x${p.box.h} ink=${p.ink.w}x${p.ink.h}`)
        record(p.cs.w === '28px' && p.cs.h === '34px', '1.hitbox-28x34', `${p.cs.w}x${p.cs.h} pad=${p.cs.pad}`)
        record(p.ink.w === 14 && p.ink.h === 14, '1.ring-ink-still-official-14', `${p.ink.w}x${p.ink.h}`)
        // The ring stays clear of the key; the knob below trades 0px (pinned) to 8px of shift.
        record(p.inkToKey >= 7 && p.inkToKey <= 15, '2.ring-ink-clear-of-the-key',
          `ink.right=${p.ink.right} key.left=${p.key.x} gap=${p.inkToKey} (7 official + 0..8 knob)`)
        record(p.boxToKey >= -0.5 && p.boxToKey <= 8.5, '3.box-reaches-key-without-overlap',
          `box.right=${p.box.right} key.left=${p.key.x} gap=${p.boxToKey} (knob 6px + margin-right)`)
        if (p.pill !== null) {
          record(p.boxToPill >= -0.5, '3.box-never-overlaps-model-pill',
            `box.left=${p.box.x} pill.right=${p.pill.right} gap=${p.boxToPill}`)
        } else {
          record(true, '3.box-never-overlaps-model-pill', 'SKIP: no model pill in this session')
        }
        record(p.lane.h <= p.key.h + 1, '4.row-height-unchanged', `lane=${p.lane.h} primary=${p.key.h}`)
        // Hit tests: DOM presence is not enough, the tap must land on the meter.
        record(p.hits.ringCentre === 'meter', '5.hit-ring-centre-is-meter', p.hits.ringCentre)
        record(p.hits.boxLeftEdge === 'meter', '5.hit-box-left-edge-is-meter', p.hits.boxLeftEdge)
        record(p.hits.boxRightEdge === 'meter', '5.hit-box-right-edge-is-meter', p.hits.boxRightEdge)
        record(p.hits.slip6RightOfInk === 'meter', '5.hit-slip-6px-right-of-ring-is-meter',
          `${p.hits.slip6RightOfInk} (was the primary key with the 24px box)`)
        record(p.hits.primaryCentre === 'primary', '5.hit-primary-centre-is-primary', p.hits.primaryCentre)
      }

    }

    // ---- desktop scene: the plugin must not touch the meter at all ----
    const d = await boot('desktop', false)
    record(d.mobileQuery === false, '6.desktop-keeps-mobile-branch-off', `mobileQuery=${d.mobileQuery}`)
    if (d.meter !== true) {
      console.log('SKIP desktop meter not rendered' + (d.overlay ? ' (composer replaced by chain overlay "' + d.overlay.slot + '", elected ' + d.overlay.elected + ')' : ''))
    } else {
      record(d.cs.w === '28px' && d.cs.h === '28px', '6.desktop-meter-keeps-official-box', `${d.cs.w}x${d.cs.h}`)
      record(d.cs.marginRight === '0px', '6.desktop-meter-keeps-official-margin', `margin-right=${d.cs.marginRight}`)
    }
  } finally {
    chrome.kill()
    await sleep(300)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  if (failures.length > 0) { console.log(`FAILED: ${failures.join(', ')}`); process.exitCode = 1 } else { console.log('ALL PASS') }
}
main().catch((e) => { console.error('ERR', e); process.exitCode = 1 })
