// Cascade-conflict probe: the "same-specificity cross-module stomp" class.
//
// Why this exists: docs/audits/2026-09-15-css-surface-audit.md §G registers this
// as the one latent-bug class this repo has repeatedly shipped (hero clearance
// stomped from 40px to 6px by an equal-(0,3,0) misc rule; header layout fights),
// and it cannot be settled statically: two rules with equal specificity that can
// never hit the same element look identical to two that always do. Only the
// runtime element-level matched-rules list answers "who actually met whom".
// The audit's static pass produced 63 equal-specificity groups, nearly all false
// positives for exactly that reason.
//
// What it does (audit Task 8, steps 1-7): boot a 390x844 touch-emulated page,
// wait for the plugin frame AND [data-phase="active"], take elements from a
// marker list plus an elementFromPoint grid, ask CDP for each element's
// matchedCSSRules, and report the declarations that lost to a competitor of
// EQUAL specificity (order alone decided it - the fragile class) or to a
// STRONGER-suppressed-vs-!important competitor. Findings are deduped into
// (property, loser rule, winner rule) classes with an element count.
//
// ponytail: sampling is an approximation, not a sweep - the grid is 24px and the
// marker list only covers data-mobile-nav nodes, so a small cold element that no
// grid point lands on (or one with no plugin marker) is never inspected. Ceiling:
// coverage tracks viewport area / 576 grid points. Upgrade path: densify the grid
// or walk the plugin's own subtrees in full when a finding is suspected.
// ponytail: the winner is derived by modelling the cascade myself
// (importance, specificity, then matched-array index). That model is not assumed
// - it is calibrated at runtime by the planted-conflict control at the end of the
// run, which fails the probe if the detector cannot see a conflict it planted.
//
// Env: DSH_PROBE_URL (default http://127.0.0.1:3080/), DSH_PROBE_SESSION_ID
// (required), DSH_PROBE_COOKIE (name=value; the local instance answers 401
// without one - mint with .local-tests/mint-cookie.mjs), DSH_PROBE_CHROME
// (Termux: the real ELF, see docs/maintenance/pitfalls.md §探针运行环境),
// DSH_PROBE_TIMEOUT_MS.
// Exit 0 = every scene ran and every order-tie candidate is whitelisted below.
// Exit 1 = a new candidate, a scene precondition failure, or the control failed.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const URL_ = process.env.DSH_PROBE_URL || 'http://127.0.0.1:3080/'
const SESSION_ID = process.env.DSH_PROBE_SESSION_ID || ''
const COOKIE = process.env.DSH_PROBE_COOKIE || ''
const CHROME = process.env.DSH_PROBE_CHROME || 'chromium'
const TIMEOUT_MS = Number(process.env.DSH_PROBE_TIMEOUT_MS || 45000)
const PORT = 9367
const GRID_STEP = 24
const MODULES = ['base', 'layout', 'compat', 'misc']

// Deliberate, human-reviewed order-tie overrides. An order-tie candidate whose
// (property, loser selector, winner selector) contains every substring listed
// here is reported as KNOWN instead of NEW. Keep the reason with the entry; a
// candidate that stops matching these must resurface as NEW, so keep the
// substrings as tight as the real selectors allow.
// 2026-09-19 终审回炉: the flex-shrink entry registered here earlier the same
// day (layout.css.ts base block vs the @media (min-width: 377px) breakpoint-A
// block on _headerActions) is GONE on purpose - the breakpoint-A media block
// was unconditionally folded into a single declaration later that night, so
// the tie no longer exists and a surviving entry would mislead readers into
// thinking the 377 block is still there. If a same-family tie ever resurfaces,
// re-register it with a fresh reason.
const WHITELIST = [
  // Intentional cross-sheet order dependency (observed 2026-09-19 in the
  // files-open scene when a file list with tables was sampled): the mobile
  // table adaptation at layout.css.ts:375 ([data-phase] th, (0,1,1), plain)
  // must keep overriding the third-party dsh-web-all sheet's
  // ._tableScroll_uddqf_ th/td column caps (same specificity, earlier sheet)
  // — the override IS the feature (narrow-screen tables must not keep the
  // 30vw/100px column boxes).
  {
    property: 'min-width',
    loser: ['_tableScroll_uddqf_192 t'],
    winner: ['[data-phase] t'],
    winnerWhere: 'layout.css.ts',
  },
  {
    property: 'max-width',
    loser: ['_tableScroll_uddqf_192 t'],
    winner: ['[data-phase] t'],
    winnerWhere: 'layout.css.ts',
  },
]
// History: the two entries that lived here before 2026-09-19 were the frame
// grid and the dismiss shadow losing a tie to @linxin666/dsh-web-all, whose
// injected sheet ships the same specificity and !important. Audit D-5 option A
// ended both ties by giving those plugin rules a leading html element selector
// - they now win on specificity and are reported as kind=important, which this
// probe counts but does not fail. Keep the mechanism: a future deliberate order
// dependency belongs here with its reason, not left for a red run to discover.

// Gating policy. The audited class is this repo's OWN cross-module stomp (base
// vs layout vs compat vs misc inside the single concatenated sheet) plus any
// order dependency this plugin creates against someone else's sheet. A tie
// between two OTHER sheets is outside the repo's control - its selectors churn
// with every host release and with third-party plugin upgrades - so it is
// reported and counted but does not fail the run. Flip this to true to gate on
// those too.
//
// Naming caution: "host-only" in the summary means "neither side is this
// plugin's own sheet", which is NOT the same as "the host". Third-party plugin
// stylesheets land in the same bucket, and a foreign sheet is labelled by a
// distinctive selector found in its text (e.g. [data-dsh-frame]) because the
// probe has no owner id for it. When reading a foreign tie, confirm the owner
// before assuming the host wrote it - 2026-09-16 got this wrong twice.
const GATE_HOST_ONLY_TIES = false

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
// Degradations that do not invalidate the run (the detector still answered) but
// must not be missed in the log.
const warn = (name, detail) => console.log(`WARN ${name}${detail ? ' ' + detail : ''}`)
const record = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + detail : ''}`)
  if (!ok) failures.push(name)
}

// ---------------------------------------------------------------- module map
// The plugin injects ONE style tag holding [BASE, LAYOUT, COMPAT, MISC].join('\n')
// (src/client/styles/index.ts). Rebuilding that text here gives both the module
// <-> line mapping and the sheet identity: the live sheet is matched by exact
// text equality, so if src/ and the served bundle ever drift apart the mapping
// turns itself off instead of mislabelling every rule.
async function loadModuleMap() {
  const parts = []
  const map = []
  let line0 = 0
  for (const name of MODULES) {
    const file = join(REPO, 'src/client/styles', `${name}.css.ts`)
    const src = await readFile(file, 'utf8')
    const m = src.match(/=\s*`([\s\S]*)`\s*;?\s*$/)
    if (!m) return null
    const css = m[1]
    const lines = css.split('\n').length
    // 0-based line of the opening backtick: a rule whose 0-based range.startLine
    // is `start + k` sits on file line `fileLine0 + k + 1` (1-based).
    map.push({ name, start: line0, lines, fileLine0: src.slice(0, m.index).split('\n').length - 1 })
    line0 += lines
    parts.push(css)
  }
  return { text: parts.join('\n'), map }
}

function locateModule(modMap, line) {
  if (!modMap) return null
  for (const mod of modMap.map) {
    if (line >= mod.start && line < mod.start + mod.lines) {
      return { module: mod.name, line: mod.fileLine0 + (line - mod.start) + 1 }
    }
  }
  return null
}

// ------------------------------------------------------------- cascade model
const specKey = (s) => (s ? [s.a || 0, s.b || 0, s.c || 0] : [0, 0, 0])
const cmpSpec = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
// Declaration entries carry their rule, not a copy of it: specificity and cascade
// position belong to the rule. Reading them off the entry silently yields
// undefined, and `undefined[0]` inside cmpSpec becomes a swallowed TypeError that
// reports "no conflicts" - never reintroduce that shape.
const cmpDecl = (x, y) => (x.important - y.important) || cmpSpec(x.rule.spec, y.rule.spec) || (x.rule.index - y.rule.index)
const norm = (v) => String(v).trim().replace(/\s+/g, ' ').replace(/\s*!important$/, '')

// Source declarations only: CDP appends derived entries (the resolved shorthand
// expansion) that carry no `text`. Shorthands are expanded through
// `longhandProperties` so `padding` competes with a later `padding-left`.
function sourceDecls(style) {
  const out = []
  for (const p of style.cssProperties || []) {
    if (!p.text || !p.value) continue
    const important = p.important === true
    if (p.longhandProperties && p.longhandProperties.length > 0) {
      for (const l of p.longhandProperties) out.push({ long: l.name, declared: p.name, value: norm(l.value), important })
    } else {
      out.push({ long: p.name, declared: p.name, value: norm(p.value), important })
    }
  }
  return out
}

/**
 * Rules that matched this element, in the order CDP returned them. Only author
 * rules carry a styleSheetId (user-agent rules report origin=user-agent and no
 * sheet), and only those can be attributed to a module or to a host sheet.
 */
function matchedRules(matched, modMap, pluginSheetId, sheetLabels) {
  const rules = []
  let skipped = 0
  matched.matchedCSSRules.forEach((match, index) => {
    const rule = match.rule
    if (rule.origin !== 'regular') return
    const sheetId = rule.style && rule.style.styleSheetId
    if (!sheetId) return
    const selectors = rule.selectorList.selectors || []
    // Chromium returns an empty selector list for a few author rules (selectors
    // it cannot represent, e.g. inside @keyframes-like or parser-recovered
    // blocks). Without a selector there is no specificity, so the rule cannot be
    // scored - count it rather than crash, and never let it silence the scan.
    if (selectors.length === 0 || !selectors[0]) { skipped++; return }
    const indexes = match.matchingSelectors && match.matchingSelectors.length > 0 ? match.matchingSelectors : [0]
    let sel = selectors[0]
    for (const i of indexes) if (selectors[i] && cmpSpec(specKey(selectors[i].specificity), specKey(sel.specificity)) > 0) sel = selectors[i]
    const at = rule.style.range ? locateModule(modMap, rule.style.range.startLine) : null
    const decls = sourceDecls(rule.style)
    const spec = specKey(sel.specificity)
    if (!Array.isArray(spec) || !Number.isInteger(index) || !Array.isArray(decls)) {
      throw new Error(`rule entry missing spec/index/decls for ${rule.selectorList.text}`)
    }
    rules.push({
      index,
      sheetId,
      selector: sel.text,
      spec,
      media: (rule.media || []).map((m) => m.text).join(' and '),
      where: sheetId === pluginSheetId
        ? (at ? `${at.module}.css.ts:${at.line}` : 'dsh-web-mobile')
        : (sheetLabels.get(sheetId) || `sheet#${sheetId.split('-').pop()}`),
      plugin: sheetId === pluginSheetId,
      decls,
    })
  })
  return { rules, skipped }
}

/**
 * Cascade analysis for one element. Returns the conflict classes found.
 * Intra-block pairs never appear: within one rule only the last declaration of a
 * longhand survives, which is also how the vh -> dvh fallback pairs are
 * neutralised structurally instead of by a hardcoded string list.
 */
function conflictsFor(rules) {
  const pool = new Map()
  for (const rule of rules) {
    const perRule = new Map()
    for (const d of rule.decls) perRule.set(d.long, d) // later source declaration wins
    for (const [long, d] of perRule) {
      if (!pool.has(long)) pool.set(long, [])
      pool.get(long).push({ ...d, long, rule })
    }
  }
  const out = []
  const modelErrors = []
  for (const [long, entries] of pool) {
    if (entries.length < 2) continue
    const sorted = [...entries].sort(cmpDecl)
    const winner = sorted[sorted.length - 1]
    // Invariant: CDP hands back matchedCSSRules in ascending cascade priority, so
    // the modelled winner must be the last declaration of that property in the
    // array. A mismatch means the model is wrong, not that a rule is.
    const lastSeen = entries.reduce((a, b) => (b.rule.index >= a.rule.index ? b : a))
    if (lastSeen !== winner) {
      modelErrors.push({ property: long, winner: winner.rule.selector, last: lastSeen.rule.selector })
    }
    for (const loser of sorted) {
      if (loser === winner) continue
      if (loser.value === winner.value) continue
      const specComparator = cmpSpec(loser.rule.spec, winner.rule.spec)
      if (loser.important && !winner.important) { modelErrors.push({ property: long, winner: winner.rule.selector, last: loser.rule.selector }); continue }
      if (loser.important === winner.important && specComparator > 0) { modelErrors.push({ property: long, winner: winner.rule.selector, last: loser.rule.selector }); continue }
      if (loser.important === winner.important && specComparator === 0) {
        out.push({ kind: 'order-tie', property: long, loser, winner })
      } else if (winner.important && specComparator > 0) {
        out.push({ kind: 'important', property: long, loser, winner })
      } else if (winner.important && specComparator === 0) {
        // Same specificity, lost on importance rather than on order: not the
        // fragile class the audit gates on, but counted so the exclusion is
        // visible rather than silent.
        out.push({ kind: 'importance-tie', property: long, loser, winner })
      }
      // specComparator < 0: the loser was simply weaker. Not this class.
    }
  }
  return { findings: out, modelErrors }
}

const specText = (s) => `(${s.join(',')})`
function findingKey(f) {
  return [f.property, f.loser.rule.where, f.loser.rule.selector, f.winner.rule.where, f.winner.rule.selector].join('|')
}
// Matching pins the property, both selectors and (when given) the module the
// winning rule must still come from. It deliberately does NOT pin line numbers
// - those drift on every unrelated edit - but it must NOT be loose enough to
// keep suppressing after the rule it excuses has been moved or replaced: a
// whitelist entry that stops matching resurfaces its candidate as CANDIDATE.
function isWhitelisted(f) {
  return WHITELIST.some((w) => w.property === f.property
    && w.loser.every((s) => f.loser.rule.selector.includes(s))
    && w.winner.every((s) => f.winner.rule.selector.includes(s))
    && (!w.loserWhere || f.loser.rule.where.includes(w.loserWhere))
    && (!w.winnerWhere || f.winner.rule.where.includes(w.winnerWhere)))
}

// ------------------------------------------------------------------- chromium
async function connect() {
  const dir = await mkdtemp(join(homedir(), 'tmp', 'cdp-cascade-'))
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, 'about:blank'],
  { env: { ...process.env, TMPDIR: dir, XDG_RUNTIME_DIR: dir }, stdio: 'ignore' })
  let wsUrl = null
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    if (!wsUrl) await sleep(300)
  }
  if (!wsUrl) throw new Error('chromium never published a CDP page target')
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  const handlers = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id !== undefined) {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
      return
    }
    for (const h of handlers.get(m.method) || []) h(m.params)
  }
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  const on = (method, handler) => {
    if (!handlers.has(method)) handlers.set(method, [])
    handlers.get(method).push(handler)
  }
  const evaluate = async (expression, byValue = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: byValue, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result
  }
  const json = async (expression) => JSON.parse((await evaluate(expression)).value)
  return { dir, chrome, ws, send, on, evaluate, json }
}

/**
 * A sheet's own text names it best: most author sheets here are anonymous
 * JS-injected <style> tags (only 2 of 136 carried a sourceURL in the
 * 2026-09-16 measurement), so a label taken from the first selector is stable
 * across navigations - which is also what lets findings dedupe across scenes
 * instead of resurfacing as sheet#125 / sheet#168 / sheet#297 / sheet#531.
 */
function sheetLabelFromText(text) {
  const brace = text.indexOf('{')
  if (brace < 0) return null
  const selector = text.slice(0, brace).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim()
  if (!selector) return null
  return selector.length > 56 ? `…${selector.slice(-56)}` : selector
}

/**
 * One pass per scene over every sheet in the document, because a navigation
 * rebuilds the document and every styleSheetId with it. It both names the sheets
 * and claims the plugin's: the plugin ships ONE style tag holding the
 * concatenation of its four modules, so exact text equality against the src
 * concatenation is what licenses module:line labels. When src/ has moved ahead
 * of the served bundle the loose marker match keeps host-vs-plugin attribution
 * while module:line stays disabled - a degradation, never a mislabel.
 */
async function resolveSheets(client, ctx) {
  let exact = null
  let loose = null
  for (const [styleSheetId, header] of ctx.sheetHeaders) {
    let text = null
    try { ({ text } = await client.send('CSS.getStyleSheetText', { styleSheetId })) } catch { continue }
    if (ctx.modMap && text === ctx.modMap.text) exact = styleSheetId
    if (loose === null && text.includes('[data-mobile-nav="frame"]')) loose = styleSheetId
    if (!ctx.sheetLabels.has(styleSheetId)) {
      const base = header.sourceURL ? header.sourceURL.split('/').pop() : sheetLabelFromText(text)
      ctx.sheetLabels.set(styleSheetId, base || `sheet#${styleSheetId.split('-').pop()}`)
    }
  }
  ctx.pluginSheetId = exact || loose
  ctx.modMapLive = exact !== null
  if (!ctx.identifiedReported) {
    ctx.identifiedReported = true
    record(ctx.pluginSheetId !== null, 'map.plugin-sheet-identified',
      ctx.pluginSheetId ? `styleSheetId=${ctx.pluginSheetId} exact=${ctx.modMapLive}` : 'no injected sheet carried the plugin markers')
    if (!ctx.modMapLive && ctx.pluginSheetId) {
      warn('map.module-lines-exact', 'live sheet text !== src concatenation (src ahead of lib/, or a styles module changed): module:line labels disabled, sheet attribution kept')
    }
  }
  return ctx.pluginSheetId
}

async function waitFor(client, label, ms, probe) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await probe()) return true
    await sleep(250)
  }
  throw new Error(`${label} timed out after ${ms}ms`)
}

const HEALTHY = `document.querySelector('[data-mobile-nav="frame"]') !== null && document.querySelector('[data-phase="active"]') !== null`

// Elements: the plugin's own marker list (every data-mobile-nav value is a
// contract in AGENTS.md) unioned with a viewport grid. Elements are parked on
// window so each one can be turned into a nodeId one call at a time.
const SAMPLER = (step) => `(() => {
  const seen = new Set()
  const out = []
  const add = (el) => { if (el && el.nodeType === 1 && !seen.has(el)) { seen.add(el); out.push(el) } }
  add(document.documentElement)
  add(document.body)
  for (const el of document.querySelectorAll('[data-mobile-nav], [data-sidebar-right-panel], [data-sidebar-right-expand]')) add(el)
  for (let y = 0; y < innerHeight; y += ${step}) {
    for (let x = 0; x < innerWidth; x += ${step}) add(document.elementFromPoint(x + 0.5, y + 0.5))
  }
  window.__cascadeSamples = out
  return out.length
})()`

const DESCRIBE = (i) => `(() => {
  const el = window.__cascadeSamples[${i}]
  if (!el) return null
  const tag = el.tagName.toLowerCase()
  if (tag === 'html' || tag === 'body') return tag
  const id = el.id ? '#' + el.id : ''
  const marker = el.getAttribute('data-mobile-nav')
  const cls = (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('')
  return tag + id + (marker ? '[data-mobile-nav="' + marker + '"]' : '') + cls
})()`

async function analyzeElements(client, ctx, sampler = SAMPLER(GRID_STEP)) {
  const count = (await client.evaluate(sampler)).value
  const found = []
  const modelErrors = []
  // A sampled-but-uninspected element is indistinguishable from a clean element
  // unless the failure is kept: an entire empty result must not read as "no
  // conflicts". First few messages are printed, the rest only counted.
  const inspectErrors = []
  let inspected = 0
  let skippedRules = 0
  for (let i = 0; i < count; i++) {
    const desc = (await client.evaluate(DESCRIBE(i))).value
    let objectId
    try {
      objectId = (await client.evaluate(`window.__cascadeSamples[${i}]`, false)).objectId
    } catch (error) {
      inspectErrors.push(`resolve:${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!objectId) { inspectErrors.push('resolve:no-object-id'); continue }
    let nodeId
    try {
      nodeId = (await client.send('DOM.requestNode', { objectId })).nodeId
    } catch (error) {
      inspectErrors.push(`requestNode:${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!nodeId) { inspectErrors.push('requestNode:no-node-id'); continue }
    try {
      const matched = await client.send('CSS.getMatchedStylesForNode', { nodeId })
      inspected++
      const { rules, skipped } = matchedRules(matched, ctx.modMap, ctx.pluginSheetId, ctx.sheetLabels)
      skippedRules += skipped
      const { findings, modelErrors: errs } = conflictsFor(rules)
      for (const f of findings) found.push({ ...f, element: desc })
      for (const e of errs) modelErrors.push({ ...e, element: desc })
    } catch (error) {
      // Detached between sampling and inspection is normal (React re-renders).
      inspectErrors.push(`matchedStyles:${error instanceof Error ? `${error.message} @${(error.stack || '').split('\n')[1]?.trim() || '?'}` : String(error)}`)
    }
  }
  return { found, modelErrors, sampled: count, inspected, inspectErrors, skippedRules }
}

async function runScene(client, scene, ctx) {
  await client.send('Page.navigate', { url: URL_ })
  const healthy = await waitFor(client, `${scene.name}: frame+active`, TIMEOUT_MS, async () => (await client.evaluate(HEALTHY)).value === true).catch(() => false)
  if (!healthy) {
    // 0.1.6-alpha.2: a fresh headless profile lacks the workspace authorization
    // the host needs to auto-restore the saved session, so the page parks in
    // the hero phase and HEALTHY never turns true. Restore one through the
    // drawer UI (FAB -> first visible session row -> active phase) before
    // giving up; the scenes measure the session header, so without this every
    // scene would time out on 0.1.6 hosts.
    // Host settle first (workspace switch + saved-selection write-back land
    // ~4s after boot), then FAB -> first NON-selected session row (the
    // selected row is the blank "new session" placeholder), retrying rows.
    await sleep(6000)
    await client.evaluate(`(() => { const f = document.querySelector('[data-mobile-nav="fab"]'); if (f) f.click(); return true })()`)
    await sleep(1500)
    await waitFor(client, `${scene.name}: drawer session rows`, 15000, async () => (await client.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[role="treeitem"]')]
      return rows.some((el) => /sessionRow/.test(el.className) && el.getBoundingClientRect().width > 0)
    })()`)).value === true).catch(() => false)
    const tryRowsSrc = `(() => {
      const rows = [...document.querySelectorAll('[role="treeitem"]')].filter((el) => /sessionRow/.test(el.className) && el.getBoundingClientRect().width > 0)
      const target = rows.find((el) => !/selected/.test(el.className)) || rows[0]
      if (target) { target.click(); return rows.length }
      return 0
    })()`
    if ((await client.evaluate(tryRowsSrc)).value === 0) throw new Error(`${scene.name}: no drawer session rows to restore`)
    let active = false
    for (let attempt = 0; attempt < 3 && !active; attempt++) {
      active = await waitFor(client, `${scene.name}: active after drawer restore`, 20000, async () => (await client.evaluate(`document.querySelector('[data-phase]')?.getAttribute('data-phase') === 'active'`)).value === true).catch(() => false)
      if (!active && attempt < 2) await client.evaluate(tryRowsSrc)
    }
    if (!active) throw new Error(`${scene.name}: active phase after drawer restore timeout (3 rows tried)`)
    await sleep(1500)
  }
  // DOM.requestNode answers "Could not find node with given id" until the DOM
  // agent has a document tree; the tree dies with each navigation, so this is
  // per scene, not once per session.
  await client.send('DOM.getDocument', { depth: 0 })
  await resolveSheets(client, ctx)
  await sleep(800)
  await scene.setup(client)
  const ready = await scene.ready(client)
  record(ready.ok, `scene.${scene.name}`, ready.detail)
  if (!ready.ok) return { found: [], modelErrors: [], sampled: 0, inspected: 0, inspectErrors: [] }
  const result = await analyzeElements(client, ctx)
  record(result.inspected > 0 && result.inspectErrors.length === 0, `scan.${scene.name}`,
    `sampled=${result.sampled} inspected=${result.inspected} findings=${result.found.length} rules-skipped=${result.skippedRules}`
    + (result.inspectErrors.length > 0 ? ` errors=${result.inspectErrors.length} first=${result.inspectErrors[0]}` : ''))
  return result
}

// ------------------------------------------------- web-all coexistence assertions
// task-3 T1b: with the @linxin666/dsh-web-all sheet loaded (its (0,3,0) rules
// stomp equal-specificity declarations by source order), the header terminal
// values must hold unchanged. The five element assertions are
// environment-adaptive: each prints SKIP instead of FAIL when its anchor is
// absent from the current session shape, and the presence of the foreign
// sheet itself is recorded (the local instance ships the web-all rows
// disabled, so absence is the common case and still pins our own values).
const WEBALL_SNAPSHOT = `(() => {
  const cs = (el) => getComputedStyle(el)
  // Same scope as the cluster-button floor rule itself: the QsffPG/ZKlsPq
  // chip buttons keep their own 25px pin (supplied by a dedicated rule), so
  // they are excluded here exactly like the :not() chain excludes them.
  const btns = [...document.querySelectorAll('[class*="_titleCluster"] button')]
    .filter((b) => b.getBoundingClientRect().width > 0 && !b.closest('[class*="QsffPG_root"], [class*="ZKlsPq_root"]'))
  const team = document.querySelector('[data-team-action]')
  const label = [...document.querySelectorAll('[class*="SVAs4q"]')].find((el) => /_label/.test(el.className) && el.getBoundingClientRect().width > 0)
  const sep = document.querySelector('[class*="ZKlsPq_separator"]')
  let webAll = false
  for (const sheet of document.styleSheets) {
    try { if ((sheet.ownerNode?.textContent || '').indexOf('[data-dsh-frame]') >= 0) { webAll = true; break } } catch {}
  }
  return JSON.stringify({
    webAll,
    clusterBtns: btns.map((b) => ({ mw: cs(b).minWidth, mh: cs(b).minHeight })),
    team: team ? { flex: cs(team).flex, order: cs(team).order, minw: cs(team).minWidth, maxw: cs(team).maxWidth } : null,
    label: label ? { w: +label.getBoundingClientRect().width.toFixed(1), sw: label.scrollWidth, cw: label.clientWidth } : null,
    sep: sep ? cs(sep).display : 'absent',
  })
})()`

function webAllAssertions(s) {
  const snap = JSON.parse(s)
  record(true, 'weball.sheet-presence', snap.webAll
    ? 'foreign web-all sheet LOADED (coexistence really exercised)'
    : 'foreign web-all sheet ABSENT (local web-all rows disabled; assertions still pin our own terminal values)')
  if (snap.clusterBtns.length === 0) record(true, 'weball.cluster-buttons-min-zero', 'SKIP no visible cluster buttons in this session shape')
  else {
    const bad = snap.clusterBtns.filter((b) => b.mw !== '0px' || b.mh !== '0px')
    record(bad.length === 0, 'weball.cluster-buttons-min-zero', bad.length ? JSON.stringify(bad) : `${snap.clusterBtns.length} buttons all min-width/height=0px`)
  }
  if (!snap.team) record(true, 'weball.team-root-shrinkable', 'SKIP no [data-team-action] chip in this session shape')
  else {
    record(snap.team.flex === '0 1 auto' && snap.team.minw === '44px' && snap.team.maxw === '156px', 'weball.team-root-shrinkable',
      `flex=${snap.team.flex} min=${snap.team.minw} max=${snap.team.maxw}`)
    record(snap.team.order === '2', 'weball.team-root-order-2', `order=${snap.team.order}`)
  }
  if (!snap.label) record(true, 'weball.mode-label-unclipped', 'SKIP no creative-mode label in this session shape')
  else record(snap.label.sw <= snap.label.cw + 1 && snap.label.w >= 60, 'weball.mode-label-unclipped',
    `width=${snap.label.w} scrollWidth=${snap.label.sw} clientWidth=${snap.label.cw} (font-metric tolerant, no hard px width)`)
  if (snap.sep === 'absent') record(true, 'weball.crumb-separator-hidden', 'SKIP no lineage separator in this session shape')
  else record(snap.sep === 'none', 'weball.crumb-separator-hidden', `display=${snap.sep}`)
}

// ----------------------------------------------------------------------- main
if (!SESSION_ID) {
  console.error('DSH_PROBE_SESSION_ID is required (a real session id in this workspace)')
  process.exitCode = 1
} else {
  const modMap = await loadModuleMap()
  if (!modMap) console.log('WARN module map unavailable: a styles/*.css.ts template literal could not be read')
  await main(modMap)
}

async function main(modMap) {
  const client = await connect()
  // styleSheetAdded gives ids + ownerNode; a human label is resolved per scene
  // because every navigation builds a new document (and new styleSheetIds).
  const sheetHeaders = new Map()
  const sheetLabels = new Map()
  client.on('CSS.styleSheetAdded', ({ header }) => {
    if (!sheetHeaders.has(header.styleSheetId)) sheetHeaders.set(header.styleSheetId, header)
  })
  let pluginSheetId = null
  try {
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('DOM.enable')
    await client.send('CSS.enable')
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    // MOBILE_QUERY needs a coarse pointer; headless has no pointer at all.
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    if (COOKIE) {
      const eq = COOKIE.indexOf('=')
      await client.send('Network.enable')
      await client.send('Network.setCookie', { name: COOKIE.slice(0, eq), value: COOKIE.slice(eq + 1), url: URL_ })
    }
    if (SESSION_ID) {
      await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `localStorage['dsh.sessions.current'] = JSON.stringify({sessionId:${JSON.stringify(SESSION_ID)}})`,
      })
    }
    const scenes = [
      { name: 'default', setup: async () => {}, ready: async (c) => ({
        ok: (await c.evaluate(`document.querySelector('[data-mobile-nav="frame"]').hasAttribute('data-sidebar-collapsed')`)).value === true,
        detail: 'drawer collapsed',
      }) },
      { name: 'drawer-open', setup: async (c) => { await c.evaluate(`(() => { document.querySelector('[data-mobile-nav="toggle"]').click(); return true })()`) }, ready: async (c) => {
        const open = await waitFor(c, 'drawer open', 10000, async () => (await c.evaluate(`document.querySelector('[data-mobile-nav="frame"]').hasAttribute('data-sidebar-collapsed')`)).value === false).catch(() => false)
        return { ok: open === true, detail: 'frame without data-sidebar-collapsed' }
      } },
      { name: 'files-open', setup: async (c) => {
        await waitFor(c, 'files opener', 15000, async () => (await c.evaluate(`document.querySelector('[data-sidebar-right-expand]') !== null`)).value === true)
        await c.evaluate(`(() => { document.querySelector('[data-sidebar-right-expand]').click(); return true })()`)
      }, ready: async (c) => {
        const open = await waitFor(c, 'panel open', 15000, async () => (await c.evaluate(`document.querySelector('[data-sidebar-right-panel]') !== null`)).value === true).catch(() => false)
        return { ok: open === true, detail: '[data-sidebar-right-panel] present' }
      } },
      // The iOS 16px floor is gated on html[data-mobile-nav-ios]. Toggling the
      // attribute exercises the same CSS gate the effect writes; it does NOT
      // reproduce the real UA sniff (detectIosWebKit), which has no headless path.
      { name: 'ios-attr', setup: async (c) => { await c.evaluate(`(() => { document.documentElement.setAttribute('data-mobile-nav-ios', ''); return true })()`); await sleep(400) }, ready: async (c) => ({
        ok: (await c.evaluate(`document.documentElement.hasAttribute('data-mobile-nav-ios')`)).value === true,
        detail: 'html[data-mobile-nav-ios] set by hand',
      }) },
      // web-all coexistence (task-3 T1b): with @linxin666/dsh-web-all sheets in
      // the page (its (0,3,0) rules stomp equal-specificity declarations by
      // order), our header terminal values must hold UNCHANGED. The five
      // assertions run below in webAllAssertions; the scene itself accepts
      // both profiles because the local instance ships web-all rows disabled.
      { name: 'web-all-coexist', setup: async () => {}, ready: async (c) => ({
        ok: (await c.evaluate(`document.querySelector('[data-mobile-nav="frame"]') !== null`)).value === true,
        detail: 'default page shape (web-all sheet presence recorded by the assertion block)',
      }) },
    ]

    // One ctx for the whole run: pluginSheetId and the sheet labels are
    // reassigned per scene by resolveSheets (a navigation rebuilds both).
    const ctx = { modMap, pluginSheetId: null, modMapLive: null, identifiedReported: false, sheetHeaders, sheetLabels }
    const perScene = []
    for (const scene of scenes) {
      const result = await runScene(client, scene, ctx)
      if (scene.name === 'web-all-coexist') webAllAssertions((await client.evaluate(WEBALL_SNAPSHOT)).value)
      perScene.push({ name: scene.name, ...result })
    }
    pluginSheetId = ctx.pluginSheetId
    const modMapLive = ctx.modMapLive

    // ---- positive control: the detector must see a conflict it planted ----
    await client.evaluate(`(() => {
      const host = document.createElement('div')
      host.id = 'cascade-probe-fixture'
      host.innerHTML = '<span class="cp-a" id="cp-target">x</span>'
      document.body.appendChild(host)
      const s1 = document.createElement('style')
      s1.id = 'cascade-probe-sheet-1'
      s1.textContent = '#cascade-probe-fixture .cp-a { color: rgb(4, 4, 4); color: rgb(5, 5, 5); padding: 1px 2px; }'
      document.head.appendChild(s1)
      const s2 = document.createElement('style')
      s2.id = 'cascade-probe-sheet-2'
      s2.textContent = '#cascade-probe-fixture .cp-a { color: rgb(6, 6, 6); padding-left: 9px; }'
      document.head.appendChild(s2)
      return true
    })()`)
    await sleep(400)
    // Deliberately NOT the grid: the fixture is a bare span at the end of body,
    // so a 24px grid would usually miss it and the control would pass by
    // inspecting nothing.
    const controlResult = await analyzeElements(client, ctx,
      `(() => { window.__cascadeSamples = [document.getElementById('cp-target')]; return window.__cascadeSamples.length })()`)
    record(controlResult.inspected === 1 && controlResult.inspectErrors.length === 0, 'control.fixture-inspected',
      `inspected=${controlResult.inspected} errors=${controlResult.inspectErrors.length} ${controlResult.inspectErrors[0] || ''}`)
    const ties = controlResult.found.filter((f) => f.kind === 'order-tie')
    const colorTies = ties.filter((f) => f.property === 'color')
    const paddingTies = ties.filter((f) => f.property === 'padding-left')
    record(colorTies.length === 1, 'control.equal-specificity-conflict-detected',
      `color order-tie classes=${colorTies.length} (1 = the cross-rule one; the in-block rgb(4)->rgb(5) duplicate must not add another)`)
    record(paddingTies.length === 1, 'control.shorthand-vs-longhand-detected',
      `padding-left order-tie classes=${paddingTies.length} (padding:1px 2px vs padding-left:9px)`)
    if (colorTies.length === 1) {
      const t = colorTies[0]
      record(t.winner.value === 'rgb(6, 6, 6)' && t.loser.value === 'rgb(5, 5, 5)', 'control.winner-is-the-later-sheet',
        `winner=${t.winner.value} loser=${t.loser.value}`)
    } else {
      record(false, 'control.winner-is-the-later-sheet', 'no color order-tie to inspect')
    }

    // ------------------------------------------------------------- reporting
    const classes = new Map()
    let knownCount = 0
    let importantCount = 0
    let importanceTies = 0
    const mediaOf = (rule) => (rule.media ? ` media="${rule.media}"` : '')
    for (const scene of perScene) {
      for (const f of scene.found) {
        const key = f.kind + '|' + findingKey(f)
        if (!classes.has(key)) classes.set(key, { ...f, scenes: new Set(), elements: new Set() })
        const entry = classes.get(key)
        entry.scenes.add(scene.name)
        entry.elements.add(f.element)
      }
      for (const e of scene.modelErrors) console.log(`FAIL model-error ${e.element} property=${e.property} modelled=${e.winner} last=${e.last}`)
    }
    // 2026-09-19 ruling (replaces the numeric baseline): model errors are
    // classified by shape, not counted. Detector-debt shapes, each with its
    // own mismatch mechanism, reported as NOTE for observability only:
    //  - :has( chains — the model mispredicts specificity across :has();
    //  - :hover rules — pseudo-class state rules must not compete for the
    //    static winner at all;
    //  - rule pairs where NEITHER selector belongs to this plugin — a tie
    //    between two other sheets is outside the repo's control (the same
    //    principle as the Gating policy comment above).
    // Anything else stays a hard failure; the live geometry probes remain
    // the source of truth.
    const allModelErrors = perScene.flatMap((s) => s.modelErrors)
    const ours = (t) => t.indexOf('[data-mobile-nav') >= 0
    const detectorDebt = allModelErrors.filter((e) => e.winner.includes(':has(') || e.last.includes(':has(')
      || e.winner.includes(':hover') || e.last.includes(':hover')
      || (!ours(e.winner) && !ours(e.last)))
    const actionableModelErrors = allModelErrors.length - detectorDebt.length
    const items = [...classes.values()]
    for (const f of items) {
      if (f.kind === 'importance-tie') { importanceTies++; continue }
      if (f.kind !== 'order-tie') { importantCount++; continue }
      const pluginInvolved = f.loser.rule.plugin || f.winner.rule.plugin
      const gated = pluginInvolved || GATE_HOST_ONLY_TIES
      const whitelisted = isWhitelisted(f)
      if (whitelisted) knownCount++
      const label = whitelisted ? 'NOTE whitelisted-order-tie' : (gated ? 'CANDIDATE' : 'NOTE host-only-tie')
      console.log(`${label} `
        + `plugin=${pluginInvolved} property=${f.property} `
        + `loser=[${f.loser.rule.where} ${specText(f.loser.rule.spec)} imp=${f.loser.important}${mediaOf(f.loser.rule)} ${f.loser.rule.selector}] value=${f.loser.value} `
        + `winner=[${f.winner.rule.where} ${specText(f.winner.rule.spec)} imp=${f.winner.important}${mediaOf(f.winner.rule)} ${f.winner.rule.selector}] value=${f.winner.value} `
        + `elements=${f.elements.size} ${[...f.elements].slice(0, 3).join(' ')}`)
    }
    for (const f of items) {
      if (f.kind !== 'important' || isWhitelisted(f)) continue
      console.log('NOTE important-override '
        + `property=${f.property} loser=[${f.loser.rule.where} ${specText(f.loser.rule.spec)}] winner=[${f.winner.rule.where} ${specText(f.winner.rule.spec)}] elements=${f.elements.size}`)
    }
    const orderTies = items.filter((f) => f.kind === 'order-tie' && !isWhitelisted(f))
    const pluginTies = orderTies.filter((f) => f.loser.rule.plugin || f.winner.rule.plugin).length
    const newCount = GATE_HOST_ONLY_TIES ? orderTies.length : pluginTies
    const perSceneText = perScene.map((s) => `${s.name}:${s.sampled}/${s.inspected}/${s.found.length}`).join(' ')
    console.log(`SUMMARY scenes=[${perSceneText}]`)
    for (const e of detectorDebt) console.log(`NOTE known-detector-debt ${e.element} property=${e.property} modelled=${e.winner} last=${e.last}`)
    console.log(`SUMMARY candidates=${newCount} plugin-involved=${pluginTies} host-only=${orderTies.length - pluginTies} whitelisted=${knownCount} important=${importantCount} importance-ties=${importanceTies} model-errors=${allModelErrors.length} (known-detector-debt=${detectorDebt.length}, actionable=${actionableModelErrors}) module-lines=${modMapLive ? 'exact' : 'DISABLED'} sampled=${perScene.reduce((n, s) => n + s.sampled, 0)}`)
    if (actionableModelErrors > 0) failures.push('model-errors')
    if (newCount > 0) failures.push('new-candidates')
    if (failures.length > 0) console.log(`FAILED: ${failures.join(', ')}`)
    else console.log('ALL PASS')
    process.exitCode = failures.length > 0 ? 1 : 0
  } catch (error) {
    console.error('FATAL', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    try { client.ws.close() } catch { /* already closed */ }
    client.chrome.kill()
    await sleep(300)
    await rm(client.dir, { recursive: true, force: true }).catch(() => {})
  }
}
