// #243 主进程编排（daemon/run.ts）行为面：让位带 origin、boot 拉壳、
// exit+restart 立即重拉、watchdog 崩溃重拉 / 正常退不重拉、activate 幂等激活。
//
// 守的是什么（#243 拍板的进程模型）：
//   1. 重启应用 = 壳自杀 + exitIntent=restart → 主进程重拉（三平台一致，#237 分叉消失）。
//   2. watchdog 只兜「意外死」：正常退（exit 事件已落 stopped）绝不重拉——macOS 后台语义。
//   3. activate（再点图标）：壳活着 = 幂等不动；壳没了才拉。
//   4. 让位时把已有主进程的 origin 带出去（第二实例转发激活意图的依据）。
//
// 全注入式：spawnShellImpl 假 spawn、sleepImpl 计数门（防 watchdog 空转）、isAlive 查表。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_ACTIVATE_PATH, DAEMON_SHELL_EVENT_PATH, SHELL_RESTORE_PROFILES_ENV } from '../src/bun/daemon/control.ts'
import { DAEMON_ROLE } from '../src/bun/daemon/roles.ts'
import { runDaemon, type DaemonLogger, type RunDaemonOptions } from '../src/bun/daemon/run.ts'
import type { SpawnShellOptions, SpawnShellResult } from '../src/bun/daemon/spawn.ts'
import { daemonInstanceFile } from '../src/bun/daemon/roles.ts'
import { VIEW_TOKEN_HEADER } from '../src/shared/net/view-grant.ts'

const TOKEN = 'run-test-token'

function quietLog(): DaemonLogger {
        return { info() { }, warn() { }, error() { } }
}

/** 计数睡眠：前 max 次立即 resolve，之后永远挂起（watchdog 停在第 max+1 轮门口）。 */
function countedSleep(max: number): { sleep: (ms: number) => Promise<void>; settled: () => boolean } {
        let count = 0
        return {
                sleep: () => {
                        count += 1
                        return count > max ? new Promise(() => { }) : Promise.resolve()
                },
                settled: () => count >= max,
        }
}

/** 假 spawn：记下每次调用，按序返回预设结果（缺省成功 + 自增 pid）。 */
function fakeSpawn(results: Array<number | null> = []): {
        spawn: (options: SpawnShellOptions) => SpawnShellResult
        calls: SpawnShellOptions[]
} {
        const calls: SpawnShellOptions[] = []
        return {
                calls,
                spawn: (options) => {
                        calls.push(options)
                        const pid = results.shift()
                        if (pid === null) return { ok: false, pid: null, error: 'injected spawn failure' }
                        return { ok: true, pid: pid ?? 4000 + calls.length, error: null }
                },
        }
}

async function settleUntil(done: () => boolean): Promise<void> {
        for (let i = 0; i < 200 && !done(); i++) {
                await new Promise<void>((resolve) => setTimeout(resolve, 1))
        }
}

function baseOptions(dir: string, overrides: Partial<RunDaemonOptions> = {}): RunDaemonOptions {
        return {
                appSupport: dir,
                launcherExe: '/fake/launcher',
                controlToken: TOKEN,
                spawnShellOnBoot: true,
                watchdogIntervalMs: 1,
                onLog: quietLog(),
                ...overrides,
        }
}

async function postEvent(origin: string, body: unknown): Promise<Response> {
        return fetch(`${origin}${DAEMON_SHELL_EVENT_PATH}`, {
                method: 'POST',
                headers: { [VIEW_TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' },
                body: JSON.stringify(body),
        })
}

describe('runDaemon：让位与拉壳', () => {
        test('让位时把已有主进程的 origin 带出去（previousOrigin）', async () => {
                const dir = mkdtempSync(join(tmpdir(), 'daemon-run-'))
                try {
                        writeFileSync(
                                daemonInstanceFile(dir),
                                JSON.stringify({ pid: 990, profile: DAEMON_ROLE, bootId: '', origin: 'http://127.0.0.1:9' }),
                        )
                        const handle = await runDaemon(baseOptions(dir, { isAlive: (pid) => pid === 990, isOurProcess: () => true }))
                        try {
                                expect(handle.role).toBe('yielded')
                                expect(handle.previousOrigin).toBe('http://127.0.0.1:9')
                        } finally {
                                await handle.stop()
                        }
                } finally {
                        rmSync(dir, { recursive: true, force: true })
                }
        })

        test('boot 拉壳：env 带 ROLE=shell / SUPERVISED_BY，注册表标 starting', async () => {
                const dir = mkdtempSync(join(tmpdir(), 'daemon-run-'))
                const fake = fakeSpawn([555])
                try {
                        const handle = await runDaemon(
                                baseOptions(dir, { isAlive: () => true, sleepImpl: () => new Promise(() => { }), spawnShellImpl: fake.spawn }),
                        )
                        try {
                                expect(handle.role).toBe('acquired')
                                expect(handle.shellPid).toBe(555)
                                expect(fake.calls).toHaveLength(1)
                                expect(fake.calls[0]!.argv).toEqual(['/fake/launcher'])
                                expect(fake.calls[0]!.env?.DSH_SHELL_ROLE).toBe('shell')
                                expect(fake.calls[0]!.env?.DSH_SHELL_SUPERVISED_BY).toBe(String(process.pid))
                                expect(handle.registry?.get('desktop')).toMatchObject({ status: 'starting', pid: 555 })
                        } finally {
                                await handle.stop()
                        }
                } finally {
                        rmSync(dir, { recursive: true, force: true })
                }
        })
})

describe('runDaemon：重启与 watchdog', () => {
        test('exit + exitIntent=restart ⇒ 立即重拉，env 带恢复窗口清单', async () => {
                const dir = mkdtempSync(join(tmpdir(), 'daemon-run-'))
                const fake = fakeSpawn([111, 4242])
                const gate = countedSleep(1)
                try {
                        // 重拉收割走注入桩（默认 killShell 会真 ps 探测 pid=111——系统常驻低 pid——阻塞 grace 期），
                        // 并记录被收割的旧壳 pid，验证「重拉前先收割」防御。
                        const fakeKillCalls: number[] = []
                        const fakeKill = async (options: { pid: number }) => {
                                fakeKillCalls.push(options.pid)
                                return { dead: true, via: 'SIGTERM' as const }
                        }

                        const handle = await runDaemon(
                                baseOptions(dir, { isAlive: () => true, sleepImpl: gate.sleep, spawnShellImpl: fake.spawn, killShellImpl: fakeKill }),
                        )

                        try {
                                expect(handle.shellPid).toBe(111)
                                const response = await postEvent(handle.control!.origin, {
                                        type: 'exit',
                                        profile: 'desktop',
                                        pid: 111,
                                        exitIntent: 'restart',
                                        openProfiles: ['p1', 'p2'],
                                })
                                expect(response.ok).toBe(true)

                                await settleUntil(() => fake.calls.length >= 2)
                                expect(fake.calls).toHaveLength(2)
                                expect(fakeKillCalls).toEqual([111])
                                expect(fake.calls[1]!.env?.[SHELL_RESTORE_PROFILES_ENV]).toBe('p1,p2')
                                expect(handle.shellPid).toBe(4242)
                        } finally {
                                await handle.stop()
                        }
                } finally {
                        rmSync(dir, { recursive: true, force: true })
                }
        })

        test('watchdog：壳意外消失（非 stopped）⇒ 重拉并带恢复清单', async () => {
                const dir = mkdtempSync(join(tmpdir(), 'daemon-run-'))
                const fake = fakeSpawn([111, 4242])
                const gate = countedSleep(2)
                try {
                        const handle = await runDaemon(
                                baseOptions(dir, { isAlive: (pid) => pid === 4242, sleepImpl: gate.sleep, spawnShellImpl: fake.spawn }),
                        )
                        try {
                                // 第 1 轮：111 活（isAlive(111) === true 要成立才能拖到第 2 轮）——此处 isAlive
                                // 只认 4242，所以第 1 轮就判 111 死。先等 boot 后的第 1 轮轮询完成重拉。
                                await settleUntil(() => fake.calls.length >= 2)
                                expect(fake.calls.length).toBe(2)
                                expect(fake.calls[1]!.env?.[SHELL_RESTORE_PROFILES_ENV]).toBeUndefined()
                                expect(handle.shellPid).toBe(4242)
                        } finally {
                                await handle.stop()
                        }
                } finally {
                        rmSync(dir, { recursive: true, force: true })
                }
        })

        test('watchdog：正常退（exit 无意图 → stopped）绝不重拉', async () => {
                const dir = mkdtempSync(join(tmpdir(), 'daemon-run-'))
                const fake = fakeSpawn([111])
                const gate = countedSleep(3)
                try {
                        const handle = await runDaemon(
                                baseOptions(dir, { isAlive: () => true, sleepImpl: gate.sleep, spawnShellImpl: fake.spawn }),
                        )
                        try {
                                const response = await postEvent(handle.control!.origin, { type: 'exit', profile: 'desktop', pid: 111 })
                                expect(response.ok).toBe(true)
                                expect(handle.registry?.get('desktop')).toMatchObject({ status: 'stopped' })
                                await settleUntil(gate.settled)
                                expect(fake.calls).toHaveLength(1)
                        } finally {
                                await handle.stop()
                        }
                } finally {
                        rmSync(dir, { recursive: true, force: true })
                }
        })
})

describe('runDaemon：activate（再点图标）', () => {
        test('壳活着 = 幂等不动；壳没了 = 拉起', async () => {
                const dir = mkdtempSync(join(tmpdir(), 'daemon-run-'))
                const fake = fakeSpawn([111, 4242])
                let alivePid = 111
                try {
                        const handle = await runDaemon(
                                baseOptions(dir, { isAlive: (pid) => pid === alivePid, sleepImpl: () => new Promise(() => { }), spawnShellImpl: fake.spawn }),
                        )
                        try {
                                expect(handle.shellPid).toBe(111)
                                // 壳活着：activate 幂等，不拉第二份。
                                const first = await fetch(`${handle.control!.origin}${DAEMON_ACTIVATE_PATH}`, { method: 'POST' })
                                expect(first.ok).toBe(true)
                                expect(fake.calls).toHaveLength(1)
                                // 壳没了（模拟正常退后用户再点图标）：activate 拉起新壳。
                                alivePid = 4242
                                const second = await fetch(`${handle.control!.origin}${DAEMON_ACTIVATE_PATH}`, { method: 'POST' })
                                expect(second.ok).toBe(true)
                                expect(fake.calls).toHaveLength(2)
                                expect(handle.shellPid).toBe(4242)
                        } finally {
                                await handle.stop()
                        }
                } finally {
                        rmSync(dir, { recursive: true, force: true })
                }
        })
})
