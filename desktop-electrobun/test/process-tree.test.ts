// 进程树枚举与树级停止的测试（#60）。
// 纯逻辑（解析/BFS/等待策略）直接断言；编排器用注入的假实现验证信号顺序，
// 另配真进程用例守「树级停止真的不留孤儿」这条契约。

import { describe, expect, test } from 'bun:test'
import {
  collectDescendants,
  createPlatformProbe,
  isProcessAlive,
  parseProcessTable,
  startTreeSampler,
  stopProcessTree,
  sweepProcessRemnants,
  waitAllDead,
} from '../src/bun/host/process-tree.ts'

describe('进程表解析', () => {
  test('ps 两列输出：坏行/表头/非法 pid 跳过', () => {
    expect(parseProcessTable('  123     1\n  456   123\n\n bad line\n 0 1\n 789 abc\n x\n')).toEqual([
      { pid: 123, ppid: 1 },
      { pid: 456, ppid: 123 },
    ])
  })

  test('Windows PowerShell 两列输出同构（CRLF 也能吃）', () => {
    expect(parseProcessTable('1000 999\r\n1001 1000\r\n')).toEqual([
      { pid: 1000, ppid: 999 },
      { pid: 1001, ppid: 1000 },
    ])
  })
})

describe('后代收集（BFS）', () => {
  const table = [
    { pid: 1, ppid: 0 },
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 10 },
    { pid: 20, ppid: 1 },
    { pid: 30, ppid: 99 },
  ]

  test('只收宿主子树（多层），不含宿主自己', () => {
    expect(collectDescendants(table, 1).sort((a, b) => a - b)).toEqual([10, 11, 12, 20])
  })

  test('叶子作根：只收它下面的', () => {
    expect(collectDescendants(table, 10)).toEqual([11, 12])
  })

  test('环不炸（visited 兜底）', () => {
    const cyclic = [
      { pid: 2, ppid: 3 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 2 },
    ]
    expect(collectDescendants(cyclic, 2).sort((a, b) => a - b)).toEqual([3, 4])
  })
})

describe('有界等待', () => {
  test('全灭即刻返回空', async () => {
    const alive = new Set<number>()
    expect(await waitAllDead([1, 2], (pid) => alive.has(pid), 500, 20)).toEqual([])
  })

  test('到点返回幸存者', async () => {
    const alive = new Set([7])
    expect(await waitAllDead([7], (pid) => alive.has(pid), 150, 30)).toEqual([7])
  })
})

describe('树级停止（注入假实现，验证编排顺序）', () => {
  test('TERM 后幸存者走 KILL 升级并确认树灭', async () => {
    const signals: string[] = []
    const alive = new Set([5])
    const result = await stopProcessTree({
      rootPid: 1,
      rootExited: Promise.resolve(0),
      probe: {
        list: async () => [
          { pid: 1, ppid: 0 },
          { pid: 5, ppid: 1 },
        ],
      },
      graceMs: 100,
      killWaitMs: 100,
      confirmTimeoutMs: 400,
      signalFn: (pid, signal) => {
        signals.push(`${pid}:${String(signal)}`)
        if (signal === 'SIGKILL') alive.delete(pid)
      },
      aliveFn: (pid) => alive.has(pid),
    })
    expect(result.descendants).toEqual([5])
    expect(result.survivors).toEqual([])
    expect(signals).toContain('1:SIGTERM')
    expect(signals).toContain('5:SIGTERM')
    expect(signals.some((entry) => entry.endsWith('SIGKILL'))).toBe(true)
  })
})

describe('树级停止（真进程）', () => {
  const itPosix = test.skipIf(process.platform === 'win32')

  itPosix('宿主+伴生整树退场，不留孤儿', async () => {
    const probe = createPlatformProbe()
    // 两层伴生：测试进程 → root（报出 leaf 的 pid）→ leaf
    const script = `
      const leaf = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(60_000)'], { stdout: 'ignore', stderr: 'ignore' })
      console.log(JSON.stringify({ leaf: leaf.pid }))
      await Bun.sleep(60_000)
    `
    const root = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'ignore' })
    try {
      const reader = (root.stdout as ReadableStream<Uint8Array>).getReader()
      const { value } = await reader.read()
      const { leaf } = JSON.parse(new TextDecoder().decode(value)) as { leaf: number }

      const entries = await probe.list()
      const descendants = collectDescendants(entries, root.pid).sort((a, b) => a - b)
      expect(descendants).toContain(leaf) // 枚举真的找到了伴生

      const result = await stopProcessTree({
        rootPid: root.pid,
        rootExited: root.exited,
        probe,
        graceMs: 500,
        killWaitMs: 500,
        confirmTimeoutMs: 2_000,
      })
      expect(result.survivors).toEqual([])
      await Bun.sleep(200) // 给收尸一点时间
      for (const pid of [root.pid, ...descendants]) {
        expect(isProcessAlive(pid)).toBe(false)
      }
    } finally {
      try {
        root.kill('SIGKILL')
      } catch {}
    }
  }, 20_000)

  itPosix('忽略 SIGTERM 的宿主被升级 SIGKILL（不留孤儿）', async () => {
    const stubborn = Bun.spawn(['sh', '-c', 'trap "" TERM; exec sleep 60'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      const result = await stopProcessTree({
        rootPid: stubborn.pid,
        rootExited: stubborn.exited,
        probe: createPlatformProbe(),
        graceMs: 300,
        killWaitMs: 300,
        confirmTimeoutMs: 2_000,
      })
      expect(result.survivors).toEqual([])
      expect(isProcessAlive(stubborn.pid)).toBe(false)
    } finally {
      try {
        stubborn.kill('SIGKILL')
      } catch {}
    }
  }, 15_000)

  test('枚举失败退化为停单进程（不炸、不阻塞）', async () => {
    const victim = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(60_000)'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      const result = await stopProcessTree({
        rootPid: victim.pid,
        rootExited: victim.exited,
        probe: {
          list: async () => {
            throw new Error('ps 不可用')
          },
        },
        graceMs: 300,
        killWaitMs: 300,
        confirmTimeoutMs: 500,
      })
      expect(result.descendants).toEqual([])
      expect(result.survivors).toEqual([])
      expect(isProcessAlive(victim.pid)).toBe(false)
    } finally {
      try {
        victim.kill('SIGKILL')
      } catch {}
    }
  }, 10_000)
})

describe('崩溃残留清扫', () => {
  test('空快照零开销', async () => {
    expect(await sweepProcessRemnants({ pids: [] })).toEqual([])
  })

  test('孤儿被清掉（真进程）', async () => {
    const orphan = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(60_000)'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      expect(isProcessAlive(orphan.pid)).toBe(true)
      const survivors = await sweepProcessRemnants({ pids: [orphan.pid], graceMs: 500, confirmTimeoutMs: 1_000 })
      expect(survivors).toEqual([])
      expect(isProcessAlive(orphan.pid)).toBe(false)
    } finally {
      try {
        orphan.kill('SIGKILL')
      } catch {}
    }
  }, 10_000)
})

describe('宿主生前树采样', () => {
  test('宿主死后冻结最后一份快照（不被空表冲掉）', async () => {
    let table = [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
    ]
    let rootAlive = true
    const sampler = startTreeSampler(
      { list: async () => table },
      1,
      20,
      undefined,
      () => rootAlive,
    )
    try {
      await Bun.sleep(80)
      expect(sampler.latest()).toEqual([2])
      rootAlive = false
      table = [] // 宿主死后表里再也找不到它的子树
      await Bun.sleep(80)
      expect(sampler.latest()).toEqual([2]) // 冻结，不被空表冲掉
    } finally {
      sampler.stop()
    }
  })
})
