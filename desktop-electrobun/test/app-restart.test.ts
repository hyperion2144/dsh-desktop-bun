// #119 接班三元组测试：接班 pid 解析 / 等旧壳退干净 / 接班接管锁。
//
// #245 后：#237 的监督进程与中继（planRelaunch / restart-entry / restart-supervisor / CEF 锁）
// 已随主进程模型移除，它们的测试一并删除；本文件只留新壳的接班等待与单实例锁。
// 纯逻辑 + 注入式 sleep / isAlive，无需真实进程。

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { awaitParentExit, relaunchParentPid, RELAUNCH_PID_ENV, RELAUNCH_WAIT_DEADLINE_MS } from '../src/bun/platform/app-restart.ts'
import { acquireInstance, type InstanceRecord } from '../src/bun/platform/single-instance.ts'


describe('relaunchParentPid（我是不是接班人）', () => {
  test('正常 pid ⇒ 那个数', () => {
    expect(relaunchParentPid({ [RELAUNCH_PID_ENV]: '4242' })).toBe(4242)
    expect(relaunchParentPid({ [RELAUNCH_PID_ENV]: '  4242 ' })).toBe(4242)
  })

  test('没这个变量 ⇒ null（正常冷启动走老路）', () => {
    expect(relaunchParentPid({})).toBeNull()
  })

  test('非数字 / 0 / 1 ⇒ null（0/1 在 posix 上是 init/kthread，等不了也不该等）', () => {
    for (const raw of ['', 'abc', '42a', '-1', '1.5', '0', '1']) {
      expect(relaunchParentPid({ [RELAUNCH_PID_ENV]: raw })).toBeNull()
    }
  })
})

describe('awaitParentExit（等旧壳退干净）', () => {
  test('旧壳已经不在 ⇒ 立刻 true，一次都不 sleep', async () => {
    let slept = 0
    const gone = await awaitParentExit({
      pid: 4242,
      isAlive: () => false,
      sleep: async () => {
        slept += 1
      },
    })
    expect(gone).toBe(true)
    expect(slept).toBe(0)
  })

  test('第二次轮询时旧壳退了 ⇒ true', async () => {
    let alive = true
    const gone = await awaitParentExit({
      pid: 4242,
      isAlive: () => alive,
      sleep: async () => {
        alive = false
      },
    })
    expect(gone).toBe(true)
  })

  test('一直活着 ⇒ 超时返回 false 而不是死等/抛错（抢锁那边另有 succeedsPid 兜底）', async () => {
    const gone = await awaitParentExit({
      pid: 4242,
      isAlive: () => true,
      sleep: async () => {},
      deadlineMs: 500,
    })
    expect(gone).toBe(false)
  })

  test('默认 deadline 就是 RELAUNCH_WAIT_DEADLINE_MS', () => {
    expect(RELAUNCH_WAIT_DEADLINE_MS).toBe(15_000)
  })
})

describe('接班与单实例锁（succeedsPid 兜底）', () => {
  const dirs: string[] = []
  function lockFile(pid: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-relaunch-'))
    dirs.push(dir)
    const file = join(dir, 'shell-instance.json')
    writeFileSync(
      file,
      JSON.stringify({
        pid,
        origin: 'http://127.0.0.1:6390',
        pageUrl: 'http://127.0.0.1:6390/tok/',
        profile: 'desktop',
        startedAt: '2026-10-16T00:00:00.000Z',
        bootId: '',
        exePath: '',
      } satisfies InstanceRecord),
    )
    return file
  }
  /** 旧 pid 仍活着且仍被认成壳进程——整应用重启的常态。 */
  const stillOurs = { identity: { pid: 5555, startedAt: 'now' }, isAlive: () => true, isOurProcess: () => true }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('锁文件里那个 pid 就是我被指定的接班目标 ⇒ 接管，不当「已有实例」', () => {
    const result = acquireInstance(lockFile(4242), 'desktop', { ...stillOurs, succeedsPid: 4242 })
    expect(result.acquired).toBe(true)
    expect(result.previous?.pid).toBe(4242)
  })

  test('不指定 succeedsPid 时行为不变：还活着的旧 pid 仍判「已有实例」', () => {
    const result = acquireInstance(lockFile(4242), 'desktop', stillOurs)
    expect(result.acquired).toBe(false)
    expect(result.previous?.pid).toBe(4242)
  })

  test('指定的接班目标不是锁里那个 pid ⇒ 照常判「已有实例」（别把无关进程当成接班对象）', () => {
    const result = acquireInstance(lockFile(4242), 'desktop', { ...stillOurs, succeedsPid: 9999 })
    expect(result.acquired).toBe(false)
  })
})
