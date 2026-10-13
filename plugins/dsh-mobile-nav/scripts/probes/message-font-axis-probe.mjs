// Regression anchor: on mobile the message text must follow the host's own
// font-size axis (Settings -> 字号大小), not a hardcoded 15px.
//
// Why this file exists (2026-09-15, #52):
//   The mobile block pinned the message container AND its p / li / _text_
//   descendants to `font-size: 15px !important`. That cut the host's axis out of
//   the chain: moving the setting 12 -> 17 changed every host-drawn markdown
//   block (they read --dsw-font-markdown-base-font-size, derived on <body> from
//   --dsh-content-font-size) while message paragraphs stayed at 15px, so a
//   single message mixed two sizes. Fix: the container reads the token and the
//   descendants inherit it.
//
// The axis is driven exactly like the host's own ThemePresenter does:
//   document.body.style.setProperty('--dsh-content-font-size', '12px')
// The token block is declared on `body, body *`, so the derived longhand token
// resolves against the inline value on body and on every descendant.
//
// Assertions: the derived token follows the axis, message paragraphs follow it
// too, container / paragraph / host-markdown agree (no mixed size), and
// removing the inline override restores the host default (14px).
//
// Env: DSH_PROBE_URL (default http://127.0.0.1:3080/), DSH_PROBE_SESSION_ID
//      (required - a session with message content), DSH_PROBE_COOKIE,
//      DSH_PROBE_CHROME, DSH_PROBE_TIMEOUT_MS.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.DSH_PROBE_CHROME || '/data/data/com.termux/files/usr/lib/chromium/chrome'
const PORT = 9345
const URL_BASE = process.env.DSH_PROBE_URL || 'http://127.0.0.1:3080/'
const TIMEOUT_MS = Number(process.env.DSH_PROBE_TIMEOUT_MS || 30000)
const CONTAINER = '[data-phase] [class*="_scroll"]:not([class*="_scrollBody"]):not(:has([data-composer-input])):has(p)'
const HOST_TOKEN = '--dsw-font-markdown-base-font-size'
const HOST_AXIS = '--dsh-content-font-size'
const SIZES = ['12px', '17px']
const DEFAULT_AXIS = '14px'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const record = (ok, name, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`); if (!ok) failures.push(name) }

const MEASURE = `(() => {
  const cs = (el) => el ? getComputedStyle(el) : null
  const container = document.querySelector(${JSON.stringify(CONTAINER)})
  const paragraph = document.querySelector('[data-phase] p')
  const markdown = document.querySelector('[data-phase] [class*="_markdown"]')
  const body = document.body
  return {
    axis: cs(body).getPropertyValue(${JSON.stringify(HOST_AXIS)}).trim(),
    token: cs(body).getPropertyValue(${JSON.stringify(HOST_TOKEN)}).trim(),
    container: cs(container)?.fontSize ?? null,
    paragraph: cs(paragraph)?.fontSize ?? null,
    markdown: cs(markdown)?.fontSize ?? null,
    pluginStyle: !!document.querySelector('style[data-plugin="dsh-web-mobile"]'),
    paragraphs: document.querySelectorAll('[data-phase] p').length,
  }
})()`

async function waitFor(fn, label, timeoutMs = TIMEOUT_MS) {
  const started = Date.now()
  for (;;) {
    const value = await fn().catch(() => null)
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`${label} timeout`)
    await sleep(250)
  }
}

async function main() {
  const sessionId = process.env.DSH_PROBE_SESSION_ID
  if (!sessionId) throw new Error('DSH_PROBE_SESSION_ID is required (a session with message content)')
  const dir = await mkdtemp(join(homedir(), 'tmp', 'cdp-fontaxis-'))
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, 'about:blank'], { env: { ...process.env, TMPDIR: dir, XDG_RUNTIME_DIR: dir }, stdio: 'ignore' })
  try {
    let wsUrl
    await waitFor(async () => {
      try { const res = await fetch(`http://127.0.0.1:${PORT}/json`); const list = await res.json(); wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl; return wsUrl } catch { return null }
    }, 'chrome boot')
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    let id = 0
    const pending = new Map()
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id === undefined || !pending.has(message.id)) return
      const entry = pending.get(message.id)
      pending.delete(message.id)
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result)
    }
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
    const evaluate = async (expression) => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (response.exceptionDetails) throw new Error(String(response.exceptionDetails.exception?.description || response.exceptionDetails.text))
      return response.result.value
    }

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    if (process.env.DSH_PROBE_COOKIE) {
      const raw = process.env.DSH_PROBE_COOKIE
      const eq = raw.indexOf('=')
      await send('Network.setCookie', { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: URL_BASE })
    }
    // Seed the current session before the app boots: a fresh profile has none.
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('dsh.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId }))})`,
    })
    await send('Page.navigate', { url: URL_BASE })
    await waitFor(() => evaluate(`document.readyState === 'complete'`), 'load')
    const active = await waitFor(() => evaluate(`document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'active'`), 'active-phase', 20000).catch(() => false)
    if (active !== true) {
      const diag = await evaluate(`({
        url: location.href,
        title: document.title,
        phase: document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? null,
        phases: [...document.querySelectorAll('[data-phase]')].map((el) => el.getAttribute('data-phase')),
        hasFrame: !!document.querySelector('[data-mobile-nav="frame"]'),
        hasPluginStyle: !!document.querySelector('style[data-plugin="dsh-web-mobile"]'),
        seeded: localStorage.getItem('dsh.sessions.current'),
        bodyText: (document.body.innerText || '').slice(0, 300),
      })`)
      console.log('DIAG ' + JSON.stringify(diag))
      throw new Error('conversation never reached the active phase')
    }
    await sleep(1200)
    // A fresh profile raises the host's Internal Testing Notice over the page.
    await evaluate(`for (const m of document.querySelectorAll('[aria-modal="true"]')) m.remove()`)

    const initial = await evaluate(MEASURE)
    record(initial.paragraphs > 0, '1.conversation-active', `paragraphs=${initial.paragraphs} axis=${initial.axis} token=${initial.token}`)
    record(initial.pluginStyle === true, '2.plugin-stylesheet-present')

    for (const size of SIZES) {
      await evaluate(`document.body.style.setProperty(${JSON.stringify(HOST_AXIS)}, ${JSON.stringify(size)}); true`)
      await sleep(250)
      const measured = await evaluate(MEASURE)
      record(measured.token === size, `3.${size}.token-follows-axis`, `token=${measured.token}`)
      record(measured.paragraph === size, `3.${size}.message-text-follows-axis`, `paragraph=${measured.paragraph} container=${measured.container} markdown=${measured.markdown}`)
      record(measured.container === measured.markdown && measured.paragraph === measured.markdown, `3.${size}.no-mixed-size`, `paragraph=${measured.paragraph} container=${measured.container} markdown=${measured.markdown}`)
    }

    await evaluate(`document.body.style.removeProperty(${JSON.stringify(HOST_AXIS)}); true`)
    await sleep(250)
    const restored = await evaluate(MEASURE)
    record(restored.token === DEFAULT_AXIS, '4.axis-restored', `token=${restored.token} axis=${restored.axis}`)
  } finally {
    chrome.kill()
    await sleep(300)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  if (failures.length > 0) { console.log(`FAILED: ${failures.join(', ')}`); process.exitCode = 1 } else { console.log('ALL PASS') }
}

main().catch((error) => { console.error('ERR', error.message); process.exitCode = 1 })
