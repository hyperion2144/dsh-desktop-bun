import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TRAY_MENU_ACTIONS,
  TRAY_RUNTIME_FETCH_LIMIT,
  type TrayMenuItem,
  type TrayState,
  orderedProfiles,
  parseTrayAction,
  windowAction,
  runtimeMenuItems,
  trayMenu,
  statusLabel,
  trayTitle,
} from '../src/bun/platform/tray-menu.ts'
import { TRAY_LABEL_MAX, truncateTrayLabel, updateCheckLabel } from '../src/bun/platform/tray-menu.ts'
import { evaluateRuntimeUpdates } from '../src/shared/runtime/runtime-update.ts'
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_VISIBLE_EDGE,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type DisplayBounds,
  type WindowFrame,
  clearWindowFrame,
  isFrameVisible,
  parseWindowFrame,
  readWindowFrame,
  sanitizeFrame,
  writeWindowFrame,
} from '../src/bun/windows/window-state.ts'

const labels = (items: TrayMenuItem[]): string[] =>
  items.map((item) => (item.type === 'divider' ? '---' : `${item.checked === true ? '✓ ' : ''}${item.label}`))

type NormalItem = Extract<TrayMenuItem, { type: 'normal' }>

const isNormal = (item: TrayMenuItem): item is NormalItem => item.type === 'normal'

const findItem = (items: TrayMenuItem[], label: string): NormalItem | undefined =>
  items.find((item): item is NormalItem => isNormal(item) && item.label === label)

const baseState = (
  overrides: Partial<TrayState> & { catalog?: Array<{ version: string; channel: string }> } = {},
): TrayState => {
  const { catalog = [], ...rest } = overrides
  // 候选与内置口径和产线同一来源：判定层从同一组事实算出（#186/#189）
  const report = evaluateRuntimeUpdates({
    running: 'runningVersion' in rest ? (rest.runningVersion ?? null) : '0.2.1-alpha.2',
    builtin: 'builtinVersion' in rest ? (rest.builtinVersion ?? null) : '0.2.1-alpha.2',
    catalog,
    installed: (rest.installed ?? []).map((version) => ({ version, source: '', installed_at: 0 })),
  })
  return {
    windowVisible: true,
    profile: 'desktop',
    profiles: ['desktop'],
    openWindows: [],
    hostRunning: true,
    runtimeLabel: '内置 0.2.1-alpha.2',
    builtinVersion: '0.2.1-alpha.2',
    runningVersion: '0.2.1-alpha.2',
    selected: null,
    installed: [],
    downloading: null,
    registerLabel: null,
    candidates: report.candidates,
    builtinDescriptor: report.builtinDescriptor,
    ...rest,
  }
}

// #117：托盘状态行讲的是「服务面在 / DSH 在不在 / 为什么不在」。
// 服务面先于 DSH 存在，所以 stopped 与 failed 都有对应的菜单文案（以前只有「宿主未运行」一种）。
describe('statusLabel（#117 服务面先于 DSH）', () => {
  test('运行中', () => {
    expect(statusLabel(baseState({ serviceStatus: 'running' }))).toBe('状态：运行中')
  })

  test('正在启动', () => {
    expect(statusLabel(baseState({ serviceStatus: 'starting' }))).toBe('状态：dsh 启动中…')
  })

  test('服务面已就绪但还没拉 DSH', () => {
    expect(statusLabel(baseState({ serviceStatus: 'stopped' }))).toBe('状态：dsh 未运行（托盘已就绪）')
  })

  test('起不来：带原因（这是「能换一个运行时再试」的提示位）', () => {
    const label = statusLabel(
      baseState({ serviceStatus: 'failed', serviceError: '找不到可用的 dsh 运行时（dsh_runtime=9.9.9）' }),
    )
    expect(label).toContain('dsh 未起来')
    expect(label).toContain('找不到可用的 dsh 运行时')
  })

  test('起不来：没给原因也不编一个', () => {
    expect(statusLabel(baseState({ serviceStatus: 'failed', serviceError: null }))).toBe('状态：dsh 未起来')
    expect(statusLabel(baseState({ serviceStatus: 'failed' }))).toBe('状态：dsh 未起来')
  })

  test('阻塞（端口被陌生程序占）与起不来分开说', () => {
    expect(statusLabel(baseState({ serviceStatus: 'blocked', serviceError: '端口 6391 被其他实例或程序占用' }))).toContain(
      '状态：已阻塞',
    )
  })

  test('长原因按菜单宽度截断', () => {
    const label = statusLabel(baseState({ serviceStatus: 'failed', serviceError: '错'.repeat(TRAY_LABEL_MAX + 30) }))
    expect(label.length).toBeLessThanOrEqual(TRAY_LABEL_MAX + '状态：dsh 未起来'.length + 2)
  })

  test('旧调用方（没给 serviceStatus）按 hostRunning 兼容', () => {
    expect(statusLabel(baseState({ hostRunning: true }))).toBe('状态：运行中')
    expect(statusLabel(baseState({ hostRunning: false }))).toBe('状态：宿主未运行')
  })

  test('trayMenu 里用的就是它（菜单里的状态行不是别的文案）', () => {
    const label = statusLabel(baseState({ serviceStatus: 'failed', serviceError: '找不到可用的 dsh 运行时' }))
    expect(labels(trayMenu(baseState({ serviceStatus: 'failed', serviceError: '找不到可用的 dsh 运行时' })))).toContain(label)
  })

  test('DSH 没起来时，运行时版本与退出这两条自救入口仍然在菜单里（#117 的要害）', () => {
    const items = trayMenu(
      baseState({ serviceStatus: 'failed', serviceError: '找不到可用的 dsh 运行时', installed: ['0.2.1-alpha.2'] }),
    )
    expect(labels(items)).toContain('退出')
    const runtime = items.find((item): item is NormalItem & { submenu?: TrayMenuItem[] } => isNormal(item) && item.label.startsWith('运行时版本'))
    expect(runtime?.submenu).toBeDefined()
    expect(labels(runtime?.submenu ?? []).some((line) => line.includes('0.2.1-alpha.2'))).toBe(true)
  })
})

describe('trayMenu', () => {

  test('「注册 dsh 命令」条件项：未注册/冲突时出现，已注册或未探出就不摆', () => {
    expect(labels(trayMenu(baseState()).slice(-4))).toContain('重启应用')
    expect(findItem(trayMenu(baseState()), '注册 dsh 为系统命令')).toBeUndefined()

    const missing = trayMenu(baseState({ registerLabel: '注册 dsh 为系统命令' }))
    expect(findItem(missing, '注册 dsh 为系统命令')?.action).toBe('tray:register-cli')

    const conflict = trayMenu(baseState({ registerLabel: '注册 dsh 为系统命令（检测到冲突：/opt/homebrew/bin/dsh）' }))
    expect(findItem(conflict, '注册 dsh 为系统命令（检测到冲突：/opt/homebrew/bin/dsh）')).toBeDefined()
  })

  test('窗口可见时给「隐藏窗口」，隐藏时给「显示窗口」', () => {
    const shown = labels(trayMenu(baseState({ windowVisible: true })))
    const hidden = labels(trayMenu(baseState({ windowVisible: false })))
    expect(shown[0]).toBe('隐藏窗口')
    expect(hidden[0]).toBe('显示窗口')
  })

    test('profile 管理子菜单：未运行裸名 + 「在新窗口打开」，末尾挂新建/迁移入口', () => {
    const items = trayMenu(baseState({ openWindows: ['desktop'] }))
        const group = findItem(items, 'profile 管理')
    const submenu = group?.submenu ?? []
    expect(submenu[0]?.type).toBe('normal')
    expect((submenu[0] as NormalItem).label).toBe('● desktop（聚焦中）')
    const nested = (submenu[0] as NormalItem).submenu ?? []
    expect((nested[0] as NormalItem).label).toBe('聚焦窗口')
    expect((nested[0] as NormalItem).action).toBe(windowAction('desktop'))
    const tail = submenu.slice(-3)
    expect((tail[0] as { type?: string }).type).toBe('divider')
    expect((tail[1] as NormalItem).label).toBe('新建 Profile…')
    expect(parseTrayAction((tail[1] as NormalItem).action)).toEqual({ kind: 'new-profile' })
    expect((tail[2] as NormalItem).label).toBe('迁移 Profile…')
    expect(parseTrayAction((tail[2] as NormalItem).action)).toEqual({ kind: 'migrate-profile' })
  })

    test('多个 profile：当前项打勾且排第一位，没开窗的不带后缀', () => {
    const items = trayMenu(
      baseState({
        profile: 'web',
        profiles: ['desktop', 'web', 'mobile'],
        openWindows: ['web'],
        profileRows: [
          { profile: 'web', open: true, running: true, port: 6393, focused: true },
          { profile: 'desktop', open: false, running: false, port: null, focused: false },
          { profile: 'mobile', open: false, running: false, port: null, focused: false },
        ],
      })
    )
        const submenu = findItem(items, 'profile 管理')?.submenu
    expect(submenu !== undefined).toBe(true)
    const webHead = (submenu ?? [])[0] as NormalItem
    expect(webHead.label).toBe('● web · 6393（聚焦中）')
    const webSub = webHead.submenu ?? []
    expect((webSub[0] as NormalItem).label).toBe('聚焦窗口')
    expect((webSub[0] as NormalItem).action).toBe(windowAction('web'))
    expect((webSub[webSub.length - 1] as NormalItem).label).toBe('退出（停止实例）')
    expect(parseTrayAction((webSub[webSub.length - 1] as NormalItem).action)).toEqual({
      kind: 'stop-profile',
      profile: 'web',
    })
    expect(((submenu ?? [])[1] as NormalItem).label).toBe('desktop')
    expect(((submenu ?? [])[2] as NormalItem).label).toBe('mobile')
  })

  test('#215 退过的实例不再说「运行中」：裸名 + 「在新窗口打开」，菜单里没有「退出（停止实例）」', () => {
    const items = trayMenu(
      baseState({
        profile: 'web',
        profiles: ['web', 'desktop'],
        profileRows: [
          { profile: 'web', open: true, running: true, port: 6393, focused: true },
          { profile: 'desktop', open: false, running: false, port: null, focused: false },
        ],
      })
    )
    const submenu = findItem(items, 'profile 管理')?.submenu ?? []
    const stopped = submenu[1] as NormalItem | undefined
    expect(stopped?.label).toBe('desktop')
    // 退过的那行不再带「运行中」字样（旧壳 tray.rs 的约定：未运行就是裸名）
    expect(stopped?.label?.includes('运行中')).toBe(false)
    const stoppedSub = stopped?.submenu ?? []
    expect((stoppedSub[0] as NormalItem).label).toBe('在新窗口打开 desktop')
    expect((stoppedSub[0] as NormalItem).action).toBe(windowAction('desktop'))
    // 退过的实例没有「退出」可点：菜单里不能摆一条走不通的路（原来就是它把用户卡死在托盘上）
    expect(stoppedSub.some((item) => isNormal(item) && item.label === '退出（停止实例）')).toBe(false)
  })

  test('运行时与宿主状态是只读行，退出永远在最后', () => {
    const items = trayMenu(baseState({ hostRunning: false }))
    expect(findItem(items, '运行时：内置 0.2.1-alpha.2')?.enabled).toBe(false)
    expect(findItem(items, '状态：宿主未运行')?.enabled).toBe(false)
    const last = [...items].reverse().find(isNormal)
    expect(last?.label).toBe('退出')
    expect(last?.action).toBe(TRAY_MENU_ACTIONS.quit)
  })

  test('标题带当前 profile', () => {
    expect(trayTitle(baseState({ profile: 'web' }))).toBe('DSH · web')
  })

  test('菜单结构稳定：两条分隔线，动作行只有四处（#141 加了「检查更新」）', () => {
    const items = trayMenu(baseState({ profile: 'web', profiles: ['web', 'app'] }))
    expect(items.filter((item) => item.type === 'divider').length).toBe(2)
    const actionable = items.filter((item): item is NormalItem => isNormal(item) && item.action !== undefined)
    // 子菜单父项只挂 submenu、不带 action；真正可点的顶层动作只有四个
    expect(actionable.map((item) => item.label).sort()).toEqual(
      ['退出', '隐藏窗口', '重启应用', '检查更新'].sort(),
    )
  })
})

describe('#126 托盘「重启应用」（口径从 DSH 侧重启改为整应用重来）', () => {
  test('菜单项文案是「重启应用」，动作是 tray:restart-app', () => {
    const item = trayMenu(baseState()).find(
      (menu): menu is NormalItem => isNormal(menu) && menu.label === '重启应用',
    )
    expect(item?.action).toBe(TRAY_MENU_ACTIONS.restartApp)
  })

  test('动作 id 不再是 tray:restart-service——语义已变，名字留着会骗人', () => {
    expect(TRAY_MENU_ACTIONS.restartApp).toBe('tray:restart-app')
    expect(parseTrayAction('tray:restart-service')).toBeNull()
  })

  test('DSH 没起来时这一项照样在——整个应用重来正是那时候最需要的出口', () => {
    const down = baseState({ hostRunning: false, serviceStatus: 'failed', serviceError: '找不到可用的 dsh 运行时' })
    const labels = trayMenu(down)
      .filter((item): item is NormalItem => isNormal(item) && item.action !== undefined)
      .map((item) => item.label)
    expect(labels).toContain('重启应用')
    expect(labels).toContain('退出')
  })

  test('菜单里不再出现「重启 dsh 服务」这个说法（那是面板那一项）', () => {
    expect(labels(trayMenu(baseState()))).not.toContain('重启 dsh 服务')
  })
})

describe('parseTrayAction', () => {
  test('解析动作表', () => {
    expect(parseTrayAction(TRAY_MENU_ACTIONS.toggleWindow)).toEqual({ kind: 'toggle-window' })
    expect(parseTrayAction(TRAY_MENU_ACTIONS.quit)).toEqual({ kind: 'quit' })
    expect(parseTrayAction(TRAY_MENU_ACTIONS.restartApp)).toEqual({ kind: 'restart-app' })
    expect(parseTrayAction(TRAY_MENU_ACTIONS.runtimeBuiltin)).toEqual({ kind: 'switch-runtime' })
    expect(parseTrayAction(`${TRAY_MENU_ACTIONS.runtimeVersionPrefix}0.2.1-alpha.1`)).toEqual({
      kind: 'switch-runtime',
      version: '0.2.1-alpha.1',
    })
    expect(parseTrayAction(`${TRAY_MENU_ACTIONS.runtimeFetchPrefix}0.2.0-rc.2`)).toEqual({
      kind: 'download-runtime',
      version: '0.2.0-rc.2',
    })
      expect(parseTrayAction(windowAction('web'))).toEqual({ kind: 'open-window', profile: 'web' })
      expect(parseTrayAction(`${TRAY_MENU_ACTIONS.restartProfile}web`)).toEqual({ kind: 'restart-profile', profile: 'web' })
      expect(parseTrayAction(`${TRAY_MENU_ACTIONS.toggleProfileWindow}web`)).toEqual({ kind: 'toggle-profile-window', profile: 'web' })
  })

    describe('#241 profile 管理（本地+远程统一条目）', () => {
        test('远程条目渲染：head 带「· 远程」；打开可用、无「退出」（远程 dsh 不归本桌面停）', () => {
            const items = trayMenu(
                baseState({
                    profileRows: [
                        { profile: 'remote:dsh.example.cn', kind: 'remote', open: false, hidden: false, running: false, port: null, focused: false },
                    ],
                }),
            )
            const sub = (findItem(items, 'profile 管理')?.submenu ?? [])[0] as NormalItem
            expect(sub.label).toBe('dsh.example.cn · 远程')
            const labels = (sub.submenu ?? []).filter((item): item is NormalItem => isNormal(item)).map((item) => item.label)
            // #246：通路已接，打开/显隐可用；重启只在窗口开着时出现；退出永远不摆。
            expect(labels[0]).toBe('在新窗口打开 dsh.example.cn')
            expect(labels).not.toContain('退出（停止实例）')
        })

        test('开着窗的本地条目四动作：聚焦/隐藏/重启/退出，restart·toggle 动作可解析', () => {
            const items = trayMenu(
                baseState({
                    profileRows: [
                        { profile: 'desktop', kind: 'local', open: true, hidden: false, running: true, port: 6393, focused: true },
                    ],
                }),
            )
            const sub = ((findItem(items, 'profile 管理')?.submenu ?? [])[0] as NormalItem).submenu ?? []
            const actionLabels = sub.filter((item): item is NormalItem => isNormal(item)).map((item) => item.label)
            expect(actionLabels).toEqual(['聚焦窗口', '隐藏窗口', '重启', '退出（停止实例）'])
            expect(parseTrayAction(`${TRAY_MENU_ACTIONS.restartProfile}desktop`)).toEqual({ kind: 'restart-profile', profile: 'desktop' })
            expect(parseTrayAction(`${TRAY_MENU_ACTIONS.toggleProfileWindow}desktop`)).toEqual({ kind: 'toggle-profile-window', profile: 'desktop' })
        })

        test('隐藏回托盘的条目给「显示窗口」而不是「隐藏窗口」', () => {
            const items = trayMenu(
                baseState({
                    profileRows: [
                        { profile: 'desktop', kind: 'local', open: true, hidden: true, running: true, port: 6393, focused: false },
                    ],
                }),
            )
            const sub = ((findItem(items, 'profile 管理')?.submenu ?? [])[0] as NormalItem).submenu ?? []
            const actionLabels = sub.filter((item): item is NormalItem => isNormal(item)).map((item) => item.label)
            expect(actionLabels).toContain('显示窗口')
            expect(actionLabels).not.toContain('隐藏窗口')
        })
    })

})

describe('parseTrayAction 的前缀边界', () => {
  test('前缀后面什么都没有就回 null，不造出空版本', () => {
    expect(parseTrayAction(TRAY_MENU_ACTIONS.runtimeVersionPrefix)).toBeNull()
    expect(parseTrayAction(TRAY_MENU_ACTIONS.runtimeFetchPrefix)).toBeNull()
  })
})

describe('orderedProfiles', () => {
  test('当前在最前，其余去重排序', () => {
    expect(orderedProfiles({ profile: 'desktop', profiles: ['web', 'desktop', 'web', 'app'] })).toEqual([
      'desktop',
      'app',
      'web',
    ])
  })

  test('当前不在列表里也补上', () => {
    expect(orderedProfiles({ profile: 'desktop', profiles: [] })).toEqual(['desktop'])
  })
})

describe('runtimeMenuItems（托盘里的运行时来源切换）', () => {
  test('默认只用内置树：内置打勾，不列已装版本', () => {
    expect(labels(runtimeMenuItems(baseState()))).toEqual(['✓ 内置 0.2.1-alpha.2（随安装包）'])
  })

  test('内置版本拿不到时，退成「正在跑的版本」（不再显示版本未知）', () => {
    const items = runtimeMenuItems(baseState({ builtinVersion: null }))
    expect(findItem(items, '内置 0.2.1-alpha.2（随安装包）')?.checked).toBe(true)
  })

  test('内置版本与正在跑的版本都拿不到时；才写「版本未知」', () => {
    const items = runtimeMenuItems(baseState({ builtinVersion: null, runningVersion: null }))
    expect(findItem(items, '内置（随安装包，版本未知）')?.checked).toBe(true)
  })

  test('目录里与正在跑同号的版本不再列成「下载并切换」', () => {
    const catalog = [
      { version: '0.2.1-alpha.2', channel: 'alpha' },
      { version: '0.2.1-alpha.1', channel: 'alpha' },
    ]
    const items = runtimeMenuItems(baseState({ builtinVersion: null, catalog }))
    expect(labels(items).filter((label) => label.startsWith('↓ 下载并切换'))).toEqual([
      '↓ 下载并切换 0.2.1-alpha.1（alpha）',
    ])
  })

  test('已装版本与正在跑的不一致时，那一行标「（当前运行）」', () => {
    const items = runtimeMenuItems(
      baseState({ installed: ['0.2.1-alpha.1'], runningVersion: '0.2.1-alpha.1' })
    )
    expect(labels(items)).toContain('0.2.1-alpha.1（当前运行）')
  })


  test('已下载版本按版本号倒序，且跳过与内置同号的', () => {
    const items = runtimeMenuItems(
      baseState({ installed: ['0.2.1-alpha.1', '0.2.0-rc.2', '0.2.1-alpha.2'] })
    )
    expect(labels(items)).toEqual(['✓ 内置 0.2.1-alpha.2（随安装包）', '0.2.1-alpha.1', '0.2.0-rc.2'])
    expect(findItem(items, '0.2.1-alpha.1')?.action).toBe(
      `${TRAY_MENU_ACTIONS.runtimeVersionPrefix}0.2.1-alpha.1`
    )
  })

  test('选中已下载版本：那一行打勾、内置不再打勾', () => {
    const items = runtimeMenuItems(
      baseState({
        installed: ['0.2.1-alpha.1'],
        selected: '0.2.1-alpha.1',
        runningVersion: '0.2.1-alpha.1',
      })
    )
    expect(findItem(items, '0.2.1-alpha.1')?.checked).toBe(true)
    expect(findItem(items, '内置 0.2.1-alpha.2（随安装包）')?.checked).toBe(false)
  })

  test('目录里未装的列成「↓ 下载并切换」，最多 5 条且不与已装重复', () => {
    // 目录是壳按版本倒序给的；这里照同一个顺序摆
    const catalog = [
      { version: '0.2.1-alpha.1', channel: 'alpha' },
      { version: '0.2.0', channel: 'latest' },
      { version: '0.1.9', channel: 'latest' },
      { version: '0.1.8', channel: 'latest' },
      { version: '0.1.7', channel: 'latest' },
      { version: '0.1.6', channel: 'latest' },
      { version: '0.1.5', channel: 'latest' },
    ]
    const items = runtimeMenuItems(baseState({ installed: ['0.2.0'], catalog }))
    const fetchRows = labels(items).filter((label) => label.startsWith('↓ 下载并切换'))
    expect(fetchRows.length).toBe(TRAY_RUNTIME_FETCH_LIMIT)
    expect(fetchRows).not.toContain('↓ 下载并切换 0.2.0（latest）')
    expect(findItem(items, '↓ 下载并切换 0.2.1-alpha.1（alpha）')?.action).toBe(
      `${TRAY_MENU_ACTIONS.runtimeFetchPrefix}0.2.1-alpha.1`
    )
  })

  test('下载中：那一条带「（下载中…）」且不可点，目录项全部禁用', () => {
    const items = runtimeMenuItems(
      baseState({ downloading: '0.2.1-alpha.1', catalog: [{ version: '0.2.0', channel: 'latest' }] })
    )
    const row = findItem(items, '0.2.1-alpha.1（下载中…）')
    expect(row?.enabled).toBe(false)
    expect(findItem(items, '↓ 下载并切换 0.2.0（latest）')?.enabled).toBe(false)
  })
})

describe('window-state', () => {
  const display: DisplayBounds = { x: 0, y: 0, width: 1920, height: 1080 }
  const ok: WindowFrame = { x: 100, y: 60, width: 1280, height: 860 }

  test('parseWindowFrame 拒绝坏 JSON、缺字段与过小的框', () => {
    expect(parseWindowFrame('')).toBeNull()
    expect(parseWindowFrame('{ 坏')).toBeNull()
    expect(parseWindowFrame('null')).toBeNull()
    expect(parseWindowFrame('{"x":0,"y":0}')).toBeNull()
    expect(parseWindowFrame(JSON.stringify({ x: 0, y: 0, width: MIN_WINDOW_WIDTH - 1, height: 860 }))).toBeNull()
    expect(parseWindowFrame(JSON.stringify({ x: 0, y: 0, width: 1280, height: MIN_WINDOW_HEIGHT - 1 }))).toBeNull()
  })

  test('parseWindowFrame 取整并接受合法框', () => {
    expect(parseWindowFrame(JSON.stringify({ x: 10.6, y: 20.2, width: 1280.4, height: 860.9 }))).toEqual({
      x: 11,
      y: 20,
      width: 1280,
      height: 861,
    })
  })

  test('完全在屏外的框判为不可见（含只剩一条边）', () => {
    const offscreen: WindowFrame = { x: display.width, y: 0, width: 1280, height: 860 }
    expect(isFrameVisible(offscreen, [display])).toBe(false)
    expect(sanitizeFrame(offscreen, [display])).toBeNull()
    const sliver: WindowFrame = { x: display.width - MIN_VISIBLE_EDGE + 1, y: 0, width: 1280, height: 860 }
    expect(isFrameVisible(sliver, [display])).toBe(false)
  })

  test('没有屏幕信息时不做还原（宁可居中开）', () => {
    expect(sanitizeFrame(ok, [])).toBeNull()
    expect(isFrameVisible(ok, [])).toBe(false)
  })

  test('尺寸超出主屏时按主屏夹取', () => {
    const tooBig: WindowFrame = { x: 0, y: 0, width: 3000, height: 2000 }
    expect(sanitizeFrame(tooBig, [display])).toEqual({
      x: 0,
      y: 0,
      width: display.width,
      height: display.height,
    })
  })

  test('屏内但比最小尺寸小的框按最小尺寸放大', () => {
    const tiny: WindowFrame = { x: 40, y: 40, width: 100, height: 100 }
    expect(sanitizeFrame(tiny, [display])).toEqual({
      x: 40,
      y: 40,
      width: MIN_WINDOW_WIDTH,
      height: MIN_WINDOW_HEIGHT,
    })
  })

  test('读不到/坏文件都退回 null，写出后可原样读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-window-'))
    const file = join(dir, 'window.json')
    expect(readWindowFrame(file)).toBeNull()
    writeFileSync(file, '{ 坏 json')
    expect(readWindowFrame(file)).toBeNull()
    writeWindowFrame(file, ok)
    expect(readWindowFrame(file)).toEqual(ok)
    clearWindowFrame(file)
    expect(readWindowFrame(file)).toBeNull()
  })

  test('默认尺寸仍然大于最小尺寸', () => {
    expect(DEFAULT_WINDOW_WIDTH).toBeGreaterThan(MIN_WINDOW_WIDTH)
    expect(DEFAULT_WINDOW_HEIGHT).toBeGreaterThan(MIN_WINDOW_HEIGHT)
  })
})

describe('托盘菜单限宽（A6）', () => {
  test('短 label 原样返回', () => {
    expect(truncateTrayLabel('退出')).toBe('退出')
  })
  test('超长 label 截断加省略号，长度不超过 max', () => {
    const long = '/Users/mutou/Library/Application Support/com.arcreel.dsh-desktop-tauriapp/runtimes/0.2.1-alpha.2'
    const out = truncateTrayLabel(long)
    expect(Array.from(out).length).toBeLessThanOrEqual(TRAY_LABEL_MAX)
    expect(out.endsWith('…')).toBe(true)
    expect(out.startsWith('/Users/mutou')).toBe(true)
  })
  test('CJK 按码点计数不劈开代理对', () => {
    const emoji = '🚀'.repeat(60)
    const out = truncateTrayLabel(emoji)
    expect(Array.from(out).length).toBe(TRAY_LABEL_MAX)
  })
  test('自定义上限', () => {
    expect(truncateTrayLabel('abcdef', 3)).toBe('ab…')
  })
  test('菜单树整体限宽：长 label 项被截断且 action 保留', () => {
    const state = baseState({ runtimeLabel: 'x'.repeat(80) })
    const menu = trayMenu(state)
    const runtime = menu.find((item) => item.type === 'normal' && item.label.startsWith('运行时：'))
    expect(runtime).toBeDefined()
    if (runtime?.type !== 'normal') throw new Error('unreachable')
    expect(Array.from(runtime.label).length).toBeLessThanOrEqual(TRAY_LABEL_MAX)
    expect(runtime.enabled).toBe(false)
  })
})

// #141：托盘「检查更新」。状态行讲「上一次查到什么」，菜单项讲「现在去查」，两件事分开。
describe('托盘「检查更新」（#141）', () => {
  test('没查过就不摆这一行（旧调用方不受影响）', () => {
    expect(updateCheckLabel(undefined)).toBeNull()
    expect(trayMenu(baseState()).some((item) => isNormal(item) && item.label.startsWith('更新：'))).toBe(false)
  })

  test('检查中 / 有更新 / 无更新 / 查不成，四种说法各自不同', () => {
    expect(updateCheckLabel({ checking: true, result: null })).toBe('更新：正在检查…')
    expect(updateCheckLabel({ checking: false, result: null })).toBe('更新：未检查')
    expect(
      updateCheckLabel({ checking: false, result: { notify: true, reason: '有可用更新', updates: 2 } }),
    ).toBe('更新：有 2 项可用更新')
    expect(
      updateCheckLabel({ checking: false, result: { notify: false, reason: '没有新的可用更新', updates: 0 } }),
    ).toBe('更新：没有新的可用更新')
  })

  test('查不成就把原因摆上灰字，而不是抿一句「已是最新」', () => {
    const label = updateCheckLabel({
      checking: false,
      result: { notify: false, reason: 'DSH 运行时这次没查成（离线 / 超时 / 未配置更新源），静默', updates: 0 },
    })
    expect(label).toContain('这次没查成')
    // 灰字行也要限宽，否则长原因会把菜单摆得跟窗口一样宽
    expect(Array.from(label ?? '').length).toBeLessThanOrEqual(TRAY_LABEL_MAX + 3)
  })

  test('状态行只读（enabled:false），检查中菜单项置灰防连点', () => {
    const idle = trayMenu(baseState({ updateCheck: { checking: false, result: null } }))
    const status = findItem(idle, '更新：未检查')
    expect(status?.enabled).toBe(false)
    expect(findItem(idle, '检查更新')?.enabled).toBe(true)

    const busy = trayMenu(baseState({ updateCheck: { checking: true, result: null } }))
    expect(findItem(busy, '更新：正在检查…')?.enabled).toBe(false)
    expect(findItem(busy, '检查更新')?.enabled).toBe(false)
  })

  test('位置与「运行时版本」子菜单同区：状态行 → 检查更新，紧跟在它后面', () => {
    const items = trayMenu(baseState({ updateCheck: { checking: false, result: { notify: true, reason: 'x', updates: 1 } } }))
    const at = (label: string): number => items.findIndex((item) => isNormal(item) && item.label === label)
    const runtimeSub = at('运行时版本')
    expect(runtimeSub).toBeGreaterThan(-1)
    expect(at('更新：有 1 项可用更新')).toBe(runtimeSub + 1)
    expect(at('检查更新')).toBe(runtimeSub + 2)
  })

  test('action 一路派发到 check-updates', () => {
    expect(TRAY_MENU_ACTIONS.checkUpdates).toBe('tray:check-updates')
    expect(parseTrayAction(TRAY_MENU_ACTIONS.checkUpdates)).toEqual({ kind: 'check-updates' })
  })
})
