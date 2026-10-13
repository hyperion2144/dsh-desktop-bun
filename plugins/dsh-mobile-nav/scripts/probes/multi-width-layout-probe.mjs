// Multi-width layout regression probe for dsh-web-mobile.
//
// 为什么需要它：本插件的每一个数值都是在**某一台真机**（360×754 CSS @dpr4）上量的，
// 而它要服务的是窄手机（320）、常见手机（360/390/430）、平板（768–1023）和桌面（≥1024）。
// 手上只有一台 360px 的真机，所以这里用 CDP 逐档开 viewport 把「各档都成立」变成断言。
//
// 三档断言：
//   A. 手机档（≤767px + coarse）：手机魔数生效（页签 min-height 26px、下划线 5px、
//      页签条 margin-top -4px、标题行回到内容高度），头部不超 90px，页面不横向溢出，
//      四个宿主图标都真的渲染出 svg（图标命名跨代问题由这条守着）。
//   B. 平板档（768–1023px + coarse）：移动 UI 生效，但**手机魔数必须不生效**
//      （页签 min-height 32px、页签条 margin-top 不是 -4px）—— 这批值一漏过来，
//      平板就被套上了 360px 的排布。
//   C. 桌面档（≥1024px 或精细指针）：移动分支完全不激活。
//
// Env: DSH_PROBE_URL（默认 http://127.0.0.1:3080/）、DSH_PROBE_SESSION_ID（可选，
//      开一个真实会话）、DSH_PROBE_COOKIE（name=value，鉴权实例）、
//      DSH_PROBE_CHROME（默认 chromium）、DSH_PROBE_TIMEOUT_MS（默认 60000）。
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.env.DSH_PROBE_URL || 'http://127.0.0.1:3080/'
const COOKIE = process.env.DSH_PROBE_COOKIE || ''
const CHROME = process.env.DSH_PROBE_CHROME || 'chromium'
const SESSION_ID = process.env.DSH_PROBE_SESSION_ID || ''
const BOOT_TIMEOUT_MS = Number(process.env.DSH_PROBE_TIMEOUT_MS || 60000)
const PORT = 9363
const MOBILE_QUERY = '(max-width: 1023px) and (pointer: coarse)'

/** 逐档场景：手机（含极窄）→ 平板 → 桌面。 */
const SCENES = [
  { label: 'phone-320', width: 320, height: 640, dsf: 2, mobile: true, tier: 'phone' },
  { label: 'phone-360', width: 360, height: 754, dsf: 4, mobile: true, tier: 'phone' },
  { label: 'phone-390', width: 390, height: 844, dsf: 3, mobile: true, tier: 'phone' },
  { label: 'phone-430', width: 430, height: 932, dsf: 3, mobile: true, tier: 'phone' },
  { label: 'tablet-768', width: 768, height: 1024, dsf: 2, mobile: true, tier: 'tablet' },
  { label: 'tablet-1023', width: 1023, height: 768, dsf: 2, mobile: true, tier: 'tablet' },
  { label: 'desktop-1280', width: 1280, height: 800, dsf: 1, mobile: false, tier: 'desktop' },
]

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

const MEASURE = `(() => {
  const round = (n) => Math.round(n * 100) / 100
  const rect = (el) => { if (el === null) return null; const b = el.getBoundingClientRect(); return { w: round(b.width), h: round(b.height) } }
  const textRect = (el) => {
    if (el === null) return null
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      if ((node.textContent || '').trim() !== '') { const r = document.createRange(); r.selectNodeContents(node); const b = r.getBoundingClientRect(); return { top: round(b.top), bottom: round(b.bottom) } }
    }
    return null
  }
  const frame = document.querySelector('[data-mobile-nav="frame"]')
  const header = frame === null ? null : frame.querySelector('header')
  const titleRow = header === null ? null : header.querySelector('[class*="_titleRow"]')
  const tabs = header === null ? null : header.querySelector('[role="tablist"]')
  const tab = tabs === null ? null : tabs.querySelector('[role="tab"], button')
  const titleText = textRect(titleRow)
  const tabText = textRect(tab)
  const cs = (el) => el === null ? null : getComputedStyle(el)
  return JSON.stringify({
    mobileQuery: matchMedia(${JSON.stringify(MOBILE_QUERY)}).matches,
    frame: frame !== null,
    headerH: header === null ? null : round(header.getBoundingClientRect().height),
    titleRowH: titleRow === null ? null : round(titleRow.getBoundingClientRect().height),
    tabsMarginTop: tabs === null ? null : cs(tabs).marginTop,
    tabMinHeight: tab === null ? null : cs(tab).minHeight,
    tabPaddingBottom: tab === null ? null : cs(tab).paddingBottom,
    tabH: tab === null ? null : round(tab.getBoundingClientRect().height),
    glyphGap: (titleText !== null && tabText !== null) ? round(tabText.top - titleText.bottom) : null,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    icons: {
      paperclip: document.querySelector('[data-mobile-nav="file-upload"] svg') !== null,
      sessionLog: document.querySelector('[data-mobile-nav="session-log"] svg') !== null,
      drawerToggle: document.querySelector('[data-mobile-nav="toggle"] svg') !== null,
      filesOpener: document.querySelector('[data-mobile-nav="files"] svg') !== null,
    },
    iconHosts: {
      paperclip: document.querySelector('[data-mobile-nav="file-upload"]') !== null,
      sessionLog: document.querySelector('[data-mobile-nav="session-log"]') !== null,
      drawerToggle: document.querySelector('[data-mobile-nav="toggle"]') !== null,
      filesOpener: document.querySelector('[data-mobile-nav="files"]') !== null,
    },
  })
})()`

async function main() {
  const dir = await mkdtemp(join(homedir(), 'tmp', 'cdp-multi-width-'))
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

    for (const scene of SCENES) {
      const tag = scene.label
      try {
        await send('Emulation.setTouchEmulationEnabled', scene.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
        await send('Emulation.setDeviceMetricsOverride', { width: scene.width, height: scene.height, deviceScaleFactor: scene.dsf, mobile: scene.mobile })
        await send('Page.navigate', { url: URL_ })
        await waitFor(async () => await evaluate(`document.querySelector('[data-composer-card], [class*="_trailing"]') !== null`), tag + ' shell', BOOT_TIMEOUT_MS)
        // 新 profile 可能弹宿主的内测提示；整块移除，避免它盖住 header 影响测量。
        await evaluate(`(() => {
          for (const m of document.querySelectorAll('[aria-modal="true"]')) m.remove()
        })()`)
        await sleep(700)
        const raw = await waitFor(async () => {
          const v = await evaluate(MEASURE)
          return v ?? null
        }, tag + ' measure', 30000)
        const m = JSON.parse(raw)

        console.log(`-- ${tag} (${scene.width}x${scene.height} dsf${scene.dsf} ${scene.tier}) mobileQuery=${m.mobileQuery} header=${m.headerH} tabMin=${m.tabMinHeight} tabsMt=${m.tabsMarginTop} gap=${m.glyphGap} overflowX=${m.overflowX}`)

        if (scene.tier === 'desktop') {
          record(m.mobileQuery === false, `${tag}.mobile-branch-off`, `mobileQuery=${m.mobileQuery}`)
          record(m.frame === false, `${tag}.no-mobile-frame`)
          continue
        }

        // 移动档（手机 + 平板）共同要求
        record(m.mobileQuery === true, `${tag}.mobile-branch-on`, `mobileQuery=${m.mobileQuery}`)
        record(m.frame === true, `${tag}.mobile-frame-present`)
        record(m.overflowX <= 1, `${tag}.no-page-horizontal-overflow`, `overflowX=${m.overflowX}`)
        for (const [name, present] of Object.entries(m.iconHosts)) {
          if (!present) continue
          record(m.icons[name] === true, `${tag}.icon-rendered:${name}`, '宿主图标命名跨代兼容是否生效')
        }

        if (scene.tier === 'phone') {
          record(m.tabMinHeight === '26px', `${tag}.phone-tab-floor-26`, `tabMinHeight=${m.tabMinHeight}`)
          record(m.tabsMarginTop === '-4px', `${tag}.phone-tabs-margin-4`, `margin-top=${m.tabsMarginTop}`)
          record(m.tabPaddingBottom === '5px', `${tag}.phone-tab-underline-5`, `padding-bottom=${m.tabPaddingBottom}`)
          record(m.headerH !== null && m.headerH <= 90, `${tag}.compact-header`, `headerH=${m.headerH}`)
          if (m.glyphGap !== null) record(m.glyphGap <= 20, `${tag}.title-tabs-gap-tight`, `gap=${m.glyphGap}`)
        } else {
          // 平板档：上一条的镜像 —— 手机魔数一个都不许生效
          record(m.tabMinHeight === '32px', `${tag}.tablet-keeps-32px-tab-floor`, `tabMinHeight=${m.tabMinHeight}`)
          record(m.tabsMarginTop !== '-4px', `${tag}.tablet-keeps-host-tabs-margin`, `margin-top=${m.tabsMarginTop}`)
        }
      } catch (error) {
        record(false, `${tag}.scene`, error instanceof Error ? error.message : String(error))
      }
    }
  } finally {
    chrome.kill()
    await sleep(300)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  if (failures.length > 0) { console.log(`FAILED: ${failures.join(', ')}`); process.exitCode = 1 } else { console.log('ALL PASS') }
}

await main()
