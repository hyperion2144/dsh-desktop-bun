// #237 统一后台运行模型（监督进程 runtime/shell-supervisor.mjs）：
// 配置解析 / 监督主循环（意图消费、尾巴收割、拉新接班、双监督收尾）/ 尾巴命令构造 / 真跑。
//
// 守的是什么：
//   1. 桌面退出且**没有给本代的有效重启意图** = 真退出：收尾只清自己 bootId 的租约（不互踩），
//      且只在桌面确实退净后才收割尾巴（超时硬闯时绝不能碰它还在用的 helper）。
//   2. 有效意图 ⇒ 清意图 → 等 CEF 锁 → 收割 → 拉 launcher（env 带接班 pid）→ 等新桌面接位 → 继续守。
//   3. 意图 pid 与守着的不一致 = 上一代残留 ⇒ 当无意图处理（不许拿陈旧意图乱拉新）。
// 注入式为主（isAlive / sleep / spawnSync / spawnLauncher / readPid / log）；最后一个测试真跑
// bun 子进程，验证「无意图 + 桌面已死 ⇒ 退 0、租约清掉、relay 日志留痕」的端到端行为。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    awaitNextDesktop,
    buildTailKillArgv,
    buildTailProbeArgv,
    buildTailTarget,
    cefLockReleased,
    parseSupervisorConfig,
    readInstancePid,
        runSupervisor,
        reapRendererTails,
    SUPERVISOR_CONFIG_ENV,
    tailStillAlive,
} from '../runtime/shell-supervisor.mjs'
import {
    clearRestartIntent,
    intentFilePath,
    readRestartIntent,
    readSupervisorLease,
    supervisorLeasePath,
    writeRestartIntent,
    writeSupervisorLease,
} from '../src/bun/platform/restart/intent.ts'

const LAUNCHER = '/Apps/X.app/Contents/MacOS/launcher'

function tmpAppSupport(): string {
    return mkdtempSync(join(tmpdir(), 'dsh-supervisor-'))
}

function cleanup(dir: string): void {
    rmSync(dir, { recursive: true, force: true })
}

function config(appSupport: string, overrides: Record<string, unknown> = {}) {
    return {
        launcherExe: LAUNCHER,
        desktopPid: 100,
        appSupport,
        logFile: '',
        bootId: 'sup-test',
        ...overrides,
    }
}

const noopLog = () => { }

describe('parseSupervisorConfig（配置解析，宁拒不带病启动）', () => {
    test('缺 env / 坏 JSON / 字段非法 ⇒ null', () => {
        expect(parseSupervisorConfig({})).toBeNull()
        expect(parseSupervisorConfig({ [SUPERVISOR_CONFIG_ENV]: 'not-json' })).toBeNull()
        for (const bad of [
            { launcherExe: '', desktopPid: 100, appSupport: '/x' },
            { launcherExe: LAUNCHER, desktopPid: 1, appSupport: '/x' },
            { launcherExe: LAUNCHER, desktopPid: 3.5, appSupport: '/x' },
            { launcherExe: LAUNCHER, desktopPid: 100, appSupport: '' },
            null,
        ]) {
            expect(parseSupervisorConfig({ [SUPERVISOR_CONFIG_ENV]: JSON.stringify(bad) })).toBeNull()
        }
    })

    test('合法配置 ⇒ 字段齐全，bootId 自动生成，可选等待参数透传', () => {
        const got = parseSupervisorConfig({
            [SUPERVISOR_CONFIG_ENV]: JSON.stringify({
                launcherExe: LAUNCHER,
                desktopPid: 4242,
                appSupport: '/support',
                logFile: '/logs/relay.log',
                nextWaitMs: 5,
                pollMs: 10,
            }),
        })
        expect(got).toMatchObject({
            launcherExe: LAUNCHER,
            desktopPid: 4242,
            appSupport: '/support',
            logFile: '/logs/relay.log',
            nextWaitMs: 5,
            pollMs: 10,
        })
        expect(got?.bootId).toMatch(/^sup-\d+-/)
    })
})

describe('runSupervisor（监督主循环，注入式）', () => {
    test('无意图 + 桌面已死 ⇒ 收割尾巴 + 清自己 bootId 的租约', async () => {
        const appSupport = tmpAppSupport()
        try {
            writeSupervisorLease(
                supervisorLeasePath(appSupport),
                    { supervisorPid: 990, desktopPid: 100, bootId: 'sup-test', startedAt: '' },
            )
            const events: string[] = []
            await runSupervisor(config(appSupport), {
                isAlive: () => false,
                waitPidExit: async () => true,
                reapTails: async () => {
                    events.push('reap')
                },
                log: noopLog,
            })
            expect(events).toEqual(['reap'])
            expect(readSupervisorLease(supervisorLeasePath(appSupport))).toBeNull()
        } finally {
            cleanup(appSupport)
        }
    })

        test('超时（桌面仍活）⇒ 续守不弃守；桌面真退后才收尾（不清别人 bootId 的租约）', async () => {
                const appSupport = tmpAppSupport()
                try {
                        writeSupervisorLease(
                                supervisorLeasePath(appSupport),
                                { supervisorPid: 990, desktopPid: 100, bootId: 'other-boot', startedAt: '' },
                        )
                        const events: string[] = []
                        let calls = 0
                        await runSupervisor(config(appSupport), {
                                isAlive: () => false,
                                waitPidExit: async () => {
                                        calls += 1
                                        return calls >= 2 // 第一轮等待窗口内没退（超时），第二轮真退
                                },
                                reapTails: async () => {
                                        events.push('reap')
                                },
                                log: (message: string) => events.push(message),
                        })
                        // 第一轮超时只续守；第二轮桌面真退 + 无有效意图 ⇒ 收尾（含收割）
                        expect(events.some((m) => m.includes('继续守'))).toBe(true)
                        expect(events).toContain('reap')
                        const lease = readSupervisorLease(supervisorLeasePath(appSupport))
                        expect(lease?.bootId).toBe('other-boot') // bootId 守卫：别人的不清
                } finally {
                        cleanup(appSupport)
                }
        })

        test('win32 收割：msedgewebview2 只等不杀（#209）⇒ 跳过外部命令探测（#237 实机带崩嫌疑）', async () => {
                let spawnCalls = 0
                const events: string[] = []
                await reapRendererTails(
                        { launcherExe: 'D:\\App\\bin\\launcher.exe', appSupport: '', desktopPid: 1, logFile: '', bootId: 'x' },
                        {
                                sleep: async () => { },
                                log: (message: string) => events.push(message),
                                spawnSync: () => {
                                        spawnCalls += 1
                                        return { exitCode: 1 }
                                },
                                platform: 'win32',
                        },
                )
                expect(spawnCalls).toBe(0)
                expect(events.some((m) => m.includes('win32') && m.includes('跳过'))).toBe(true)
        })

    test('有效意图 ⇒ 清意图 → 等锁 → 收割 → 拉 launcher（旧 pid）→ 等新桌面接位 → 继续守', async () => {
        const appSupport = tmpAppSupport()
        try {
            writeRestartIntent(intentFilePath(appSupport), { pid: 100, at: 'now' })
            const events: string[] = []
            const spawnedWith: number[] = []
            let polls = 0
            await runSupervisor(config(appSupport), {
                    isAlive: () => true, // awaitNextDesktop 用：接位的下一代活着
                waitPidExit: async () => true,
                waitCefLock: async () => {
                    events.push('lock')
                },
                reapTails: async () => {
                    events.push('reap')
                },
                spawnLauncher: (previousPid) => {
                    spawnedWith.push(previousPid)
                    return 555
                },
                readPid: () => (polls++ === 0 ? 200 : null),
                log: noopLog,
            })
                // 第一代：等锁 + 收割；接班桌面接位后继续守；它退了没意图 ⇒ 收尾（含收割）
                expect(events).toEqual(['lock', 'reap', 'reap'])
                // 新语义：走到收尾必是桌面真退（超时改续守，isAlive 守卫已不需要）⇒ 收尾也收割
            expect(spawnedWith).toEqual([100])
            expect(readRestartIntent(intentFilePath(appSupport))).toBeNull()
                // 收尾：bootId 守卫下清的是自己（sup-test）的租约 ⇒ 文件应该被清掉
                expect(readSupervisorLease(supervisorLeasePath(appSupport))).toBeNull()
        } finally {
            cleanup(appSupport)
        }
    })

    test('意图 pid 不匹配（上一代残留）⇒ 当无意图收尾，不拉新', async () => {
        const appSupport = tmpAppSupport()
        try {
            writeRestartIntent(intentFilePath(appSupport), { pid: 999, at: 'now' })
            let spawned = 0
            await runSupervisor(config(appSupport), {
                isAlive: () => false,
                waitPidExit: async () => true,
                reapTails: async () => { },
                spawnLauncher: () => {
                    spawned += 1
                    return 1
                },
                log: noopLog,
            })
            expect(spawned).toBe(0)
            // 陈旧意图没被消费（那不是本代的），文件原样留着
            expect(readRestartIntent(intentFilePath(appSupport))?.pid).toBe(999)
        } finally {
            cleanup(appSupport)
        }
    })

    test('拉 launcher 失败 ⇒ 诚实收尾（不假装接上了班）', async () => {
        const appSupport = tmpAppSupport()
        try {
            let nextWaitCount = 0
            await runSupervisor(config(appSupport), {
                isAlive: () => false,
                waitPidExit: async () => true,
                reapTails: async () => { },
                waitCefLock: async () => { },
                spawnLauncher: () => null,
                readPid: () => {
                    nextWaitCount += 1
                    return null
                },
                log: noopLog,
            })
            expect(nextWaitCount).toBe(0) // 没拉起来就不等接位
            expect(readSupervisorLease(supervisorLeasePath(appSupport))).toBeNull()
        } finally {
            cleanup(appSupport)
        }
    })

        test('主循环异常 ⇒ 记日志续守不退（防无声死亡，#237）', async () => {
                const appSupport = tmpAppSupport()
                try {
                        writeSupervisorLease(supervisorLeasePath(appSupport), { supervisorPid: 990, desktopPid: 100, bootId: 'sup-test', startedAt: '' })
                        const events: string[] = []
                        let calls = 0
                        await runSupervisor(config(appSupport), {
                                isAlive: () => false,
                                waitPidExit: () => {
                                        calls += 1
                                        if (calls === 1) throw new Error('boom')
                                        return Promise.resolve(true)
                                },
                                reapTails: async () => { },
                                log: (message: string) => events.push(message),
                        })
                        // 第一轮异常被捕获记 relay，第二轮正常走完收尾（租约清掉）
                        expect(events.some((m) => m.includes('本轮守候异常') && m.includes('boom'))).toBe(true)
                        expect(existsSync(supervisorLeasePath(appSupport))).toBe(false)
                } finally {
                        cleanup(appSupport)
                }
        })
})

describe('尾巴目标与命令构造（只点自家名，不殃及池鱼）', () => {
    test('darwin：按 CEF 目录精确点名（--user-data-dir）', () => {
        const target = buildTailTarget({ platform: 'darwin', launcherExe: LAUNCHER })
        expect(target).toEqual({ kind: 'pattern', pattern: `--user-data-dir=/Apps/CEF` })
        expect(buildTailProbeArgv(target)).toEqual(['pgrep', '-f', '--user-data-dir=/Apps/CEF'])
        expect(buildTailKillArgv(target, 'TERM')).toEqual(['pkill', '-TERM', '-f', '--user-data-dir=/Apps/CEF'])
        expect(buildTailKillArgv(target, 'KILL')).toEqual(['pkill', '-KILL', '-f', '--user-data-dir=/Apps/CEF'])
        expect(tailStillAlive({ exitCode: 0 }, target)).toBe(true)
        expect(tailStillAlive({ exitCode: 1 }, target)).toBe(false)
    })

    test('win32：msedgewebview2 是公共镜像名，只探不杀（#209 口径）', () => {
        const target = buildTailTarget({ platform: 'win32', launcherExe: '' })
        expect(target).toEqual({ kind: 'webview2' })
        expect(buildTailProbeArgv(target)).toEqual(['tasklist', '/FI', 'IMAGENAME eq msedgewebview2.exe', '/NH'])
        expect(buildTailKillArgv(target, 'TERM')).toBeNull()
        expect(tailStillAlive({ stdout: 'msedgewebview2.exe    1234 Console' }, target)).toBe(true)
        expect(tailStillAlive({ stdout: 'INFO: No tasks...' }, target)).toBe(false)
    })

    test('linux（无 CEF 目录可推）⇒ 没有尾巴问题，不构造任何命令', () => {
        expect(buildTailTarget({ platform: 'linux', launcherExe: '/usr/bin/dsh' })).toBeNull()
        expect(buildTailProbeArgv(null)).toBeNull()
        expect(buildTailKillArgv(null)).toBeNull()
    })
})

describe('readInstancePid / awaitNextDesktop（等新桌面接位）', () => {
    test('readInstancePid：合法 / 缺文件 / 坏 JSON / pid 非法', () => {
        const dir = tmpAppSupport()
        try {
            const file = join(dir, 'shell-instance.json')
            expect(readInstancePid(file)).toBeNull()
            writeFileSync(file, JSON.stringify({ pid: 7 }))
            expect(readInstancePid(file)).toBe(7)
            writeFileSync(file, '{bad')
            expect(readInstancePid(file)).toBeNull()
            writeFileSync(file, JSON.stringify({ pid: 1 }))
            expect(readInstancePid(file)).toBeNull()
        } finally {
            cleanup(dir)
        }
    })

    test('awaitNextDesktop：pid 换人且活着才算；一直没换 ⇒ null', async () => {
        let calls = 0
        const next = await awaitNextDesktop({
            file: '/unused',
            previousPid: 100,
            isAlive: (pid) => pid === 200,
            readPid: () => (calls++ === 0 ? null : 200),
            sleep: async () => { },
            deadlineMs: 10_000,
            pollMs: 1,
        })
        expect(next).toBe(200)

        const timedOut = await awaitNextDesktop({
            file: '/unused',
            previousPid: 100,
            isAlive: () => true,
            readPid: () => 100, // 一直是旧 pid ⇒ 不算接位
            sleep: async () => { },
            deadlineMs: 5,
            pollMs: 1,
        })
        expect(timedOut).toBeNull()
    })
})

describe('cefLockReleased（CEF 锁是否已释放）', () => {
    test('无锁文件 ⇒ true；指向死 pid 的 symlink ⇒ true（stale）；活 pid ⇒ false', () => {
        const dir = tmpAppSupport()
        try {
            expect(cefLockReleased(dir, (pid) => pid === 4242, 'darwin')).toBe(true)
            mkdirSync(dir, { recursive: true })
            symlinkSync('stubhost-999999', join(dir, 'SingletonLock'))
            expect(cefLockReleased(dir, (pid) => pid === 4242, 'darwin')).toBe(true)
            // SingletonLock stale，但 SingletonCookie 指向活 pid ⇒ 仍在持有
            symlinkSync('stubhost-4242', join(dir, 'SingletonCookie'))
            expect(cefLockReleased(dir, (pid) => pid === 4242, 'darwin')).toBe(false)
        } finally {
            cleanup(dir)
        }
    })
})

describe('真跑监督进程（bun 子进程，端到端）', () => {
    test('无意图 + 桌面已死 ⇒ 退 0、租约清掉、relay 日志留痕', async () => {
        const appSupport = tmpAppSupport()
        try {
            const logFile = join(appSupport, 'supervisor.log')
            const bootstrap = {
                launcherExe: '/nonexistent/launcher',
                desktopPid: 999998,
                appSupport,
                logFile,
                pidWaitMs: 300,
                tailWaitMs: 200,
                nextWaitMs: 200,
                pollMs: 25,
            }
            const proc = Bun.spawnSync({
                cmd: [process.execPath, join(import.meta.dir, '..', 'runtime', 'shell-supervisor.mjs')],
                env: { ...process.env, [SUPERVISOR_CONFIG_ENV]: JSON.stringify(bootstrap) },
                stdout: 'pipe',
                stderr: 'pipe',
            })
            expect(proc.exitCode).toBe(0)
            // 收尾：租约清掉
            expect(existsSync(supervisorLeasePath(appSupport))).toBe(false)
            // relay 日志留痕：启动与退出都有行
            const log = readFileSync(logFile, 'utf8')
            expect(log).toContain('[supervisor]')
            expect(log).toContain('监督进程退出')
        } finally {
            cleanup(appSupport)
        }
    })

    test('缺配置 env ⇒ 拒绝启动（退 1），不带病乱守', () => {
        const proc = Bun.spawnSync({
            cmd: [process.execPath, join(import.meta.dir, '..', 'runtime', 'shell-supervisor.mjs')],
            env: { ...process.env, [SUPERVISOR_CONFIG_ENV]: '' },
            stdout: 'pipe',
            stderr: 'pipe',
        })
        expect(proc.exitCode).toBe(1)
    })

        test('配置 JSON 合法但缺必填 ⇒ 退 1 且把死因写进 config 指定的 relay 文件（#237 排障）', () => {
                const appSupport = tmpAppSupport()
                try {
                        const logFile = join(appSupport, 'supervisor.log')
                        const proc = Bun.spawnSync({
                                cmd: [process.execPath, join(import.meta.dir, '..', 'runtime', 'shell-supervisor.mjs')],
                                env: { ...process.env, [SUPERVISOR_CONFIG_ENV]: JSON.stringify({ logFile }) },
                                stdout: 'pipe',
                                stderr: 'pipe',
                        })
                        expect(proc.exitCode).toBe(1)
                        expect(readFileSync(logFile, 'utf8')).toContain('监督进程启动失败')
                } finally {
                        cleanup(appSupport)
                }
        })
})

describe('意图与租约文件（宽容读 / bootId 守卫）', () => {
    test('clearSupervisorLease 只清自己 bootId 的那份', async () => {
        const { clearSupervisorLease } = await import('../src/bun/platform/restart/intent.ts')
        const appSupport = tmpAppSupport()
        try {
            const file = supervisorLeasePath(appSupport)
                writeSupervisorLease(file, { supervisorPid: 990, desktopPid: 980, bootId: 'mine', startedAt: '' })
            clearSupervisorLease(file, 'theirs') // 别人的 bootId ⇒ 不动
            expect(readSupervisorLease(file)?.bootId).toBe('mine')
            clearSupervisorLease(file, 'mine') // 自己的 ⇒ 清
            expect(readSupervisorLease(file)).toBeNull()
            clearRestartIntent(intentFilePath(appSupport)) // 不存在的文件也不算错
            expect(readRestartIntent(intentFilePath(appSupport))).toBeNull()
        } finally {
            cleanup(appSupport)
        }
    })
})
