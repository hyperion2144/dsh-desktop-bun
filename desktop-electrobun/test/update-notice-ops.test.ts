import { describe, expect, test } from 'bun:test'
import { createUpdateNoticeOpRunner, type UpdateNoticeOpDeps } from '../src/bun/commands/update-notice-ops.ts'

interface Call {
  name: string
  args: unknown[]
}

function harness(overrides: Partial<UpdateNoticeOpDeps> = {}) {
  const calls: Call[] = []
  const record =
    (name: string) =>
    async (...args: unknown[]): Promise<unknown> => {
      calls.push({ name, args })
      return { ok: true }
    }
  const deps: UpdateNoticeOpDeps = {
    downloadShell: record('downloadShell'),
    downloadRuntime: async (version, source) => {
      calls.push({ name: 'downloadRuntime', args: [version, source] })
      return { ok: true }
    },
    switchRuntime: (version) => {
      calls.push({ name: 'switchRuntime', args: [version] })
    },
    restartService: record('restartService'),
    ignoreVersions: (versions) => {
      calls.push({ name: 'ignoreVersions', args: [versions] })
    },
    ...overrides,
  }
  return { deps, calls, run: createUpdateNoticeOpRunner(deps) }
}

const names = (calls: Call[]): string[] => calls.map((call) => call.name)

describe('提醒卡动作执行器', () => {
  test('运行时「切换到此版本」：只落设置 + 重启，不下载', async () => {
    const { calls, run } = harness()
    const result = await run({ op: 'runtime', version: '0.2.1-alpha.6', action: 'switch', source: 'github' })
    expect(result.ok).toBe(true)
    expect(names(calls)).toEqual(['switchRuntime', 'restartService'])
    expect(calls[0]!.args).toEqual(['0.2.1-alpha.6'])
  })

  test('运行时「下载并切换」：下载 → 切设置 → 重启，顺序不能乱', async () => {
    const { calls, run } = harness()
    const result = await run({ op: 'runtime', version: '0.2.2-alpha.1', action: 'download-and-switch', source: 'npm' })
    expect(result.ok).toBe(true)
    expect(names(calls)).toEqual(['downloadRuntime', 'switchRuntime', 'restartService'])
    expect(calls[0]!.args).toEqual(['0.2.2-alpha.1', 'npm'])
  })

  test('下载失败：停在那一步，不切设置也不重启（绝不带半成品切版本）', async () => {
    const { calls, run } = harness({
      downloadRuntime: async () => {
        throw new Error('已有运行时下载任务')
      },
    })
    const result = await run({ op: 'runtime', version: '0.2.2-alpha.1', action: 'download-and-switch', source: 'github' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('已有运行时下载任务')
    expect(names(calls)).toEqual([])
  })

  test('落设置失败 / 重启失败：各自说各自的，不吞', async () => {
    const switchFail = harness({
      switchRuntime: () => {
        throw new Error('设置写入失败')
      },
    })
    const first = await switchFail.run({ op: 'runtime', version: '0.2.1-alpha.6', action: 'switch', source: 'github' })
    expect(first.ok).toBe(false)
    expect(first.message).toContain('设置写入失败')

    const restartFail = harness({
      restartService: async () => {
        throw new Error('端口被占')
      },
    })
    const second = await restartFail.run({ op: 'runtime', version: '0.2.1-alpha.6', action: 'switch', source: 'github' })
    expect(second.ok).toBe(false)
    expect(second.message).toContain('端口被占')
    expect(second.message).toContain('已选中 0.2.1-alpha.6')
  })

  test('壳「下载更新」：只下载，绝不碰 apply', async () => {
    const { calls, run } = harness()
    const result = await run({ op: 'download-shell' })
    expect(result.ok).toBe(true)
    expect(names(calls)).toEqual(['downloadShell'])
    expect(result.message).toContain('重启应用')
  })

  test('全部更新：两段都跑，消息汇总', async () => {
    const { calls, run } = harness()
    const result = await run({
      op: 'update-all',
      shell: true,
      runtime: { version: '0.2.2-alpha.1', action: 'download-and-switch', source: 'github' },
    })
    expect(result.ok).toBe(true)
    expect(names(calls)).toEqual(['downloadShell', 'downloadRuntime', 'switchRuntime', 'restartService'])
    expect(result.message).toContain('桌面壳开始下载')
  })

  test('全部更新：壳那段失败不连坐运行时那段', async () => {
    const { calls, run } = harness({
      downloadShell: async () => {
        calls.push({ name: 'downloadShell', args: [] })
        throw new Error('网络不通')
      },
    })
    const result = await run({
      op: 'update-all',
      shell: true,
      runtime: { version: '0.2.1-alpha.6', action: 'switch', source: 'github' },
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('网络不通')
    expect(names(calls)).toEqual(['downloadShell', 'switchRuntime', 'restartService'])
  })

  test('全部更新：没壳没运行时时不硬造事情', async () => {
    const { calls, run } = harness()
    const result = await run({ op: 'update-all', shell: false })
    expect(result).toEqual({ ok: true, message: '没有需要更新的内容' })
    expect(calls).toHaveLength(0)
  })

  test('稍后：什么都不做', async () => {
    const { calls, run } = harness()
    expect((await run({ op: 'later' })).ok).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test('不再提示：带路的版本目标原样交给忽略名单（壳与运行时分开）', async () => {
    const { calls, run } = harness()
    const result = await run({
      op: 'ignore',
      targets: [
        { kind: 'shell', version: '0.3.0' },
        { kind: 'runtime', version: '0.2.2-alpha.1' },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('0.3.0')
    expect(calls[0]!.args).toEqual([
      [
        { kind: 'shell', version: '0.3.0' },
        { kind: 'runtime', version: '0.2.2-alpha.1' },
      ],
    ])
  })

  test('忽略名单没接上时如实报失败，不假装记住了', async () => {
    const { run } = harness({
      ignoreVersions: () => {
        throw new Error('update-notice.json 不可用')
      },
    })
    const result = await run({ op: 'ignore', targets: [{ kind: 'shell', version: '0.3.0' }] })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('update-notice.json 不可用')
  })

    describe('#235：安装壳更新（apply-shell）', () => {
        test('没接上 applyShell：如实报不可用，不假装装了', async () => {
            const { run } = harness()
            const result = await run({ op: 'apply-shell' })
            expect(result.ok).toBe(false)
            expect(result.message).toContain('还不支持在应用内安装更新')
        })

        test('接上了：调 applyShell，报「安装器已启动」', () => {
            const calls: string[] = []
            const { run } = harness({
                applyShell: async () => {
                    calls.push('applyShell')
                },
            })
            return run({ op: 'apply-shell' }).then((result) => {
                expect(result.ok).toBe(true)
                expect(result.message).toContain('安装器已启动')
                expect(calls).toEqual(['applyShell'])
            })
        }),

        test('applyShell 抛错：失败原因原样回给页面', async () => {
            const { run } = harness({
                applyShell: async () => {
                    throw new Error('安装包不存在')
                },
            })
            const result = await run({ op: 'apply-shell' })
            expect(result.ok).toBe(false)
            expect(result.message).toContain('安装包不存在')
        })
    })
})
