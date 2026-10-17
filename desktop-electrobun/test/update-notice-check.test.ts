// #142 启动那次后台检查的编排：不阻塞、分路静默、只弹一次、没得提醒就不记账。
// #141 托盘手动那次：绕过开关与去重，但拉黑仍然认。

import { describe, expect, test } from 'bun:test'
import {
  runUpdateNoticeCheck,
  type UpdateNoticeCheckDeps,
  type UpdateNoticeCheckResult,
  type UpdateNoticeRuntimeProbe,
  type UpdateNoticeShellProbe,
} from '../src/bun/update-notice-check.ts'
import type { UpdateNoticePayload } from '../src/bun/update-notice-dialog.ts'
import { evaluateRuntimeUpdates, type RuntimeUpdateReport } from '../src/shared/runtime-update.ts'
import type { UpdateView } from '../src/shared/update.ts'
import type { UpdateNoticeState } from '../src/bun/update-notice-store.ts'
import type { UpdateNoticeTarget } from '../src/shared/update-notice-policy.ts'

const shellView = (overrides: Partial<UpdateView> = {}): UpdateView =>
  ({
    available: true,
    reason: '',
    phase: 'idle',
    label: '',
    status: '',
    message: '',
    current: '0.2.9',
    latest: '0.3.0',
    channel: 'stable',
    baseUrl: '',
    feedUrl: '',
    updateAvailable: true,
    updateReady: false,
    progress: 0,
    bytesDownloaded: 0,
    totalBytes: 0,
    error: null,
    at: 0,
    ...overrides,
  }) as UpdateView

function runtimeReport(running = '0.2.1-alpha.5'): RuntimeUpdateReport {
  return evaluateRuntimeUpdates({
    running,
    builtin: running,
    catalog: [{ version: '0.2.2-alpha.1', channel: 'alpha' }],
    installed: [],
  })
}

const state = (overrides: Partial<UpdateNoticeState> = {}): UpdateNoticeState => ({
  enabled: true,
  ignored: [],
  lastNotified: { shell: null, runtime: null },
  ...overrides,
})

interface Harness {
  run: (deps?: Partial<UpdateNoticeCheckDeps>) => Promise<UpdateNoticeCheckResult>
  opened: UpdateNoticePayload[]
  marked: UpdateNoticeState[]
}

function harness(readState: UpdateNoticeState = state()): Harness {
  const opened: UpdateNoticePayload[] = []
  const marked: UpdateNoticeState[] = []
  let current = readState
  const base: UpdateNoticeCheckDeps = {
    store: {
      read: () => current,
      // 真 store 会把命中的版本写回 lastNotified；harness 得真的写，否则「下次不再弹」无从验证
      markNotified: (targets: UpdateNoticeTarget[]): UpdateNoticeState => {
        marked.push(current)
        current = {
          ...current,
          lastNotified: {
            ...current.lastNotified,
            ...Object.fromEntries(targets.map((target: UpdateNoticeTarget) => [target.kind, target.version])),
          },
        }
        return current
      },
    } as unknown as UpdateNoticeCheckDeps['store'],
    probeShell: async (): Promise<UpdateNoticeShellProbe> => ({ view: shellView(), fresh: true }),
    probeRuntime: async (): Promise<UpdateNoticeRuntimeProbe> => ({ report: runtimeReport(), fresh: true }),
    context: () => ({ profile: 'desktop', baseline: '0.2.1-alpha.5', preference: '0.2.1-alpha.5' }),
    open: (payload) => {
      opened.push(payload)
      return true
    },
    log: () => {},
  }
  return {
    run: (deps = {}) => runUpdateNoticeCheck({ ...base, ...deps }),
    opened,
    marked,
  }
}

describe('runUpdateNoticeCheck：该弹的弹', () => {
  test('两路都有新版本 ⇒ 开窗一次，且两路都记账', async () => {
    const h = harness()
    const result = await h.run()
    expect(result.notify).toBe(true)
    expect(result.notified.sort()).toEqual(['runtime', 'shell'])
    expect(h.opened).toHaveLength(1)
    expect(h.opened[0]!.shell).not.toBeNull()
    expect(h.opened[0]!.runtime).not.toBeNull()
    expect(h.marked).toHaveLength(1)
  })

  test('只有运行时有更新：payload 里壳那一路是 null（不占一栏）', async () => {
    const h = harness()
    await h.run({ probeShell: async () => ({ view: shellView({ updateAvailable: false, latest: '0.2.9' }), fresh: true }) })
    expect(h.opened[0]!.shell).toBeNull()
    expect(h.opened[0]!.runtime).not.toBeNull()
  })

  test('同一个版本第二次检查 ⇒ 不再弹、不再记账', async () => {
    const h = harness(state({ lastNotified: { shell: '0.3.0', runtime: '0.2.2-alpha.1' } }))
    const result = await h.run()
    expect(result.notify).toBe(false)
    expect(h.opened).toHaveLength(0)
    expect(h.marked).toHaveLength(0)
  })
})

describe('runUpdateNoticeCheck：静默优先', () => {
  test('开关关了 ⇒ 两个探针都不该跑（省掉这次网络）', async () => {
    let probed = 0
    const h = harness(state({ enabled: false }))
    const result = await h.run({
      probeShell: async () => {
        probed += 1
        return { view: shellView(), fresh: true }
      },
      probeRuntime: async () => {
        probed += 1
        return { report: runtimeReport(), fresh: true }
      },
    })
    expect(result.notify).toBe(false)
    expect(probed).toBe(0)
    expect(h.opened).toHaveLength(0)
  })

  test('dev 构建（壳没有更新源）⇒ 壳那一路静默，运行时照弹', async () => {
    const h = harness()
    const result = await h.run({
      // dev 构建：壳压根没有更新源（view 里压根没有新版本），这一路静默，但运行时的更新照弹。
      probeShell: async () => ({ view: shellView({ updateAvailable: false, latest: '', available: false, reason: '未配置更新源' }), fresh: false }),
    })
    expect(result.notify).toBe(true)
    expect(result.notified).toEqual(['runtime'])
    expect(h.opened[0]!.shell).toBeNull()
    // 运行时也没更新时 ⇒ 全静默；探到的失败原因进日志（#141 复用成托盘灰字）。
    const quiet = harness()
    const quietResult = await quiet.run({
      probeShell: async () => ({ view: shellView({ updateAvailable: false, latest: '', available: false }), fresh: false }),
      probeRuntime: async () => ({ report: null, fresh: false }),
    })
    expect(quietResult.notify).toBe(false)
    expect(quietResult.reason).toContain('这次没查成')
    expect(quiet.opened).toHaveLength(0)
  })

  test('运行时目录拉挂（report 为 null）⇒ 壳更新照样弹', async () => {
    const h = harness()
    const result = await h.run({ probeRuntime: async () => ({ report: null, fresh: false }) })
    expect(result.notify).toBe(true)
    expect(result.notified).toEqual(['shell'])
    expect(h.opened[0]!.runtime).toBeNull()
  })

  test('探针抛异常 ⇒ 吞成理由，不炸也不弹', async () => {
    const h = harness()
    const result = await h.run({
      probeShell: async () => {
        throw new Error('offline')
      },
      probeRuntime: async () => {
        throw new Error('offline')
      },
    })
    expect(result.notify).toBe(false)
    expect(h.opened).toHaveLength(0)
  })

  test('窗判定「没什么可提醒」⇒ 不记账，下次还能再弹', async () => {
    const h = harness()
    const result = await h.run({ open: () => false })
    expect(result.notify).toBe(false)
    expect(result.reason).toContain('没什么可提醒')
    expect(h.marked).toHaveLength(0)
  })
})

describe('runUpdateNoticeCheck：超时按「没查成」处理', () => {
  test('一个探针挂住 ⇒ 到点按静默处理，另一路照常', async () => {
    const h = harness()
    const result = await h.run({
      timeoutMs: 20,
      probeShell: () => new Promise<UpdateNoticeShellProbe>(() => {}),
      probeRuntime: async () => ({ report: runtimeReport(), fresh: true }),
    })
    expect(result.notify).toBe(true)
    expect(result.notified).toEqual(['runtime'])
  }, 2000)
})

describe('runUpdateNoticeCheck：manual 触发（#141 托盘手动检查）', () => {
  test('手动那次绕过总开关——用户亲手点的，关掉提醒也不该装没看见', async () => {
    const h = harness(state({ enabled: false }))
    const result = await h.run({ trigger: 'manual' })
    expect(result.notify).toBe(true)
    expect(result.notified).toEqual(['shell', 'runtime'])
  })

  test('手动那次绕过「已提醒过」——同一版本再点一次还得再提醒一次', async () => {
    const h = harness(state({ lastNotified: { shell: '0.3.0', runtime: '0.2.2-alpha.1' } }))
    expect((await h.run()).notify).toBe(false)
    expect((await h.run({ trigger: 'manual' })).notify).toBe(true)
  })

  test('拉黑仍然认：手动点也不能把用户拉黑的版本弹回去', async () => {
    const h = harness(state({ ignored: ['shell:0.3.0'] }))
    const result = await h.run({ trigger: 'manual' })
    expect(result.notify).toBe(true)
    expect(result.notified).toEqual(['runtime'])
  })

  test('手动那次真开了窗也照样记账——否则下次启动会把同一版又当成没提醒过', async () => {
    const h = harness()
    await h.run({ trigger: 'manual' })
    expect(h.opened).toHaveLength(1)
    expect(h.marked).toHaveLength(1)
    expect((await h.run()).notify).toBe(false)
  })
})
