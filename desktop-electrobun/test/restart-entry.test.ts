// #237 统一后台运行模型（桌面侧）：重启路径判定 / 意图写入 / 监督进程自举 / 保底直拉。
//
// 守的是什么：
//   1. 有监督进程 ⇒ 只写意图，本进程零 spawn——等退净 / 收割尾巴 / 拉新是监督进程的事。
//   2. 没监督进程 ⇒ 先自举一份（bun 跑 runtime/shell-supervisor.mjs，配置走 env JSON）再写意图；
//      自举失败回退 #119 直拉 launcher（env 接班口径不变），重启不能断。
//   3. 表不了态（dev / 探测不到 launcher / 写意图失败）诚实报 spawn-failed，不假报成功。
// 全部注入式（io / spawn / isAlive / supervisorScript），不碰真进程。

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RELAUNCH_PID_ENV } from '../src/bun/platform/app-restart.ts'
import {
    buildSupervisorSpawn,
    ensureSupervisorAtBoot,
    isSupervised,
    planRestartPath,
    requestDesktopRestart,
    SUPERVISED_BY_ENV,
    SUPERVISOR_CONFIG_ENV,
    supervisedByPid,
        supervisorScriptFromBundle,
        waitForSupervisorLease,
} from '../src/bun/platform/restart/entry.ts'
import {
    intentFilePath,
    readRestartIntent,
    supervisorLeasePath,
    writeSupervisorLease,
    type RestartFileIo,
} from '../src/bun/platform/restart/intent.ts'

const LAUNCHER = '/Applications/X.app/Contents/MacOS/launcher'

function tmpAppSupport(): string {
    return mkdtempSync(join(tmpdir(), 'dsh-restart-entry-'))
}

/** 让指定 pid 活着的 isAlive 注入。 */
function aliveOf(pids: number[]): (pid: number) => boolean {
    const set = new Set(pids)
    return (pid) => set.has(pid)
}

function baseInput(appSupport: string, overrides: Record<string, unknown> = {}) {
    return {
        isPackaged: true,
        launcherExe: LAUNCHER,
        pid: 4242,
        appSupport,
        logFile: '',
        bundleDir: '/pkg/app/bun',
        env: {},
        spawn: (_plan: { argv: string[]; env: Record<string, string> }) => { },
        ...overrides,
    }
}

describe('planRestartPath（重启走哪条路）', () => {
    test('dev / 探测不到 launcher：直接复用 #119 降级口径（不挑路径）', () => {
        expect(planRestartPath({ isPackaged: false, launcherExe: LAUNCHER, supervised: true, supervisorScript: '/x.mjs' })).toMatchObject({
            ok: false,
            reason: 'dev-build',
        })
        expect(planRestartPath({ isPackaged: true, launcherExe: null, supervised: true, supervisorScript: '/x.mjs' })).toMatchObject({
            ok: false,
            reason: 'launcher-unknown',
        })
    })

    test('有监督 ⇒ intent；无监督有脚本 ⇒ bootstrap；连脚本都没有 ⇒ legacy', () => {
        expect(planRestartPath({ isPackaged: true, launcherExe: LAUNCHER, supervised: true, supervisorScript: null })).toEqual({
            ok: true,
            kind: 'intent',
            exe: LAUNCHER,
        })
        expect(planRestartPath({ isPackaged: true, launcherExe: LAUNCHER, supervised: false, supervisorScript: '/x.mjs' })).toEqual({
            ok: true,
            kind: 'bootstrap',
            exe: LAUNCHER,
        })
        expect(planRestartPath({ isPackaged: true, launcherExe: LAUNCHER, supervised: false, supervisorScript: null })).toEqual({
            ok: true,
            kind: 'legacy',
            exe: LAUNCHER,
        })
    })
})

describe('supervisorScriptFromBundle / supervisedByPid / isSupervised', () => {
    test('脚本探测：<bundleDir>/../runtime/shell-supervisor.mjs，不存在 ⇒ null', () => {
        const bundleDir = join(tmpAppSupport(), 'app', 'bun')
        expect(supervisorScriptFromBundle(bundleDir, () => false)).toBeNull()
        const expected = join(bundleDir, '..', 'runtime', 'shell-supervisor.mjs')
        expect(supervisorScriptFromBundle(bundleDir, (p) => p === expected)).toBe(expected)
    })

    test('supervisedByPid：合法 pid / 空缺 / 非法值', () => {
        expect(supervisedByPid({ [SUPERVISED_BY_ENV]: '777' })).toBe(777)
        expect(supervisedByPid({})).toBeNull()
        for (const raw of ['', 'abc', '0', '1', '-3']) {
            expect(supervisedByPid({ [SUPERVISED_BY_ENV]: raw })).toBeNull()
        }
    })

    test('isSupervised：env 指认的监督者活着 ⇒ true；env 死了看租约双方；全无 ⇒ false', () => {
        const appSupport = tmpAppSupport()
        try {
            expect(isSupervised({ env: { [SUPERVISED_BY_ENV]: '10' }, appSupport, isAlive: aliveOf([10]) })).toBe(true)
            // env 指认的监督者已死 ⇒ 看 env 不算数，落到租约判定
            expect(isSupervised({ env: { [SUPERVISED_BY_ENV]: '10' }, appSupport, isAlive: aliveOf([]) })).toBe(false)
            // 租约双方都活 ⇒ true
            writeSupervisorLease(
                supervisorLeasePath(appSupport),
                { supervisorPid: 10, desktopPid: 20, bootId: 'b1', startedAt: '' },
            )
            expect(isSupervised({ env: {}, appSupport, isAlive: aliveOf([10, 20]) })).toBe(true)
            // 监督者死了（桌面还在）⇒ 它守不住重启了 ⇒ false
            expect(isSupervised({ env: {}, appSupport, isAlive: aliveOf([20]) })).toBe(false)
            expect(isSupervised({ env: {}, appSupport, isAlive: aliveOf([]) })).toBe(false)
        } finally {
            rmSync(appSupport, { recursive: true, force: true })
        }
    })
})

describe('requestDesktopRestart（托盘重启入口）', () => {
    test('有监督 ⇒ 只写意图，零 spawn；意图里带本进程 pid', async () => {
        const appSupport = tmpAppSupport()
        try {
            let spawns = 0
            const plan = await requestDesktopRestart(
                baseInput(appSupport, {
                    supervised: true,
                    spawn: () => {
                        spawns += 1
                    },
                }),
            )
            expect(plan).toEqual({ ok: true, exe: LAUNCHER })
            expect(spawns).toBe(0)
            expect(readRestartIntent(intentFilePath(appSupport))?.pid).toBe(4242)
        } finally {
            rmSync(appSupport, { recursive: true, force: true })
        }
    })

    test('无监督 ⇒ 自举监督进程（argv = [bun, 脚本]，env 带配置 JSON，不带 RELAUNCH_PID）+ 写意图', async () => {
        const appSupport = tmpAppSupport()
        try {
            let seen: { argv: string[]; env: Record<string, string> } | null = null
            const plan = await requestDesktopRestart(
                baseInput(appSupport, {
                        supervisorScript: '/pkg/runtime/shell-supervisor.mjs',
                        leaseWait: async () => true,
                        spawn: (p: { argv: string[]; env: Record<string, string> }) => {
                        seen = p
                    },
                }),
            )
            expect(plan).toEqual({ ok: true, exe: LAUNCHER })
            const got = seen as unknown as { argv: string[]; env: Record<string, string> }
            expect(got.argv).toEqual([process.execPath, '/pkg/runtime/shell-supervisor.mjs'])
                expect(JSON.parse(got.env[SUPERVISOR_CONFIG_ENV] ?? '')).toMatchObject({ launcherExe: LAUNCHER, desktopPid: 4242, appSupport })
            // 意图机制取代了直拉的 env 接班：监督 spawn 不带 RELAUNCH_PID（新桌面由监督进程拉起时才有）
            expect(got.env[RELAUNCH_PID_ENV]).toBeUndefined()
            expect(readRestartIntent(intentFilePath(appSupport))?.pid).toBe(4242)
        } finally {
            rmSync(appSupport, { recursive: true, force: true })
        }
    })


        test('自举后租约没落地（监督进程启动即退）⇒ 不写意图，回退 legacy 直拉（#237 自证）', async () => {
                const appSupport = tmpAppSupport()
                try {
                        const calls: { argv: string[]; env: Record<string, string> }[] = []
                        const plan = await requestDesktopRestart(
                                baseInput(appSupport, {
                                        supervisorScript: '/pkg/runtime/shell-supervisor.mjs',
                                        leaseWait: async () => false,
                                        spawn: (p: { argv: string[]; env: Record<string, string> }) => {
                                                calls.push(p)
                                        },
                                }),
                        )
                        expect(plan).toEqual({ ok: true, exe: LAUNCHER })
                        expect(calls).toHaveLength(2)
                        expect(calls[1]?.argv).toEqual([LAUNCHER])
                        expect(calls[1]?.env[RELAUNCH_PID_ENV]).toBe('4242')
                        // 自证不过绝不能写意图：不然旧壳退了没人拉新桌面
                        expect(readRestartIntent(intentFilePath(appSupport))).toBeNull()
                } finally {
                        rmSync(appSupport, { recursive: true, force: true })
                }
        })
    test('自举 spawn 抛错 ⇒ 回退 legacy 直拉 [launcher]，env 带 RELAUNCH_PID，仍 ok', async () => {
        const appSupport = tmpAppSupport()
        try {
            const calls: { argv: string[]; env: Record<string, string> }[] = []
            const plan = await requestDesktopRestart(
                baseInput(appSupport, {
                    supervisorScript: '/pkg/runtime/shell-supervisor.mjs',
                        spawn: (p: { argv: string[]; env: Record<string, string> }) => {
                        calls.push(p)
                        if (calls.length === 1) throw new Error('boom')
                    },
                }),
            )
            expect(plan).toEqual({ ok: true, exe: LAUNCHER })
            expect(calls).toHaveLength(2)
            expect(calls[0]?.argv[0]).toBe(process.execPath) // 第一次：试自举监督进程
            expect(calls[1]?.argv).toEqual([LAUNCHER]) // 第二次：保底直拉
            expect(calls[1]?.env[RELAUNCH_PID_ENV]).toBe('4242')
        } finally {
            rmSync(appSupport, { recursive: true, force: true })
        }
    })

    test('写意图失败（IO 抛错）⇒ spawn-failed 诚实报错，不假报成功', async () => {
        const appSupport = tmpAppSupport()
        try {
            const failingIo: RestartFileIo = {
                writeAtomic: () => {
                    throw new Error('EROFS')
                },
            }
            let spawns = 0
            const plan = await requestDesktopRestart(
                baseInput(appSupport, {
                    supervised: true,
                    io: failingIo,
                    spawn: () => {
                        spawns += 1
                    },
                }),
            )
            expect(plan.ok).toBe(false)
            if (plan.ok) throw new Error('不该 ok')
            expect(plan.reason).toBe('spawn-failed')
            expect(plan.message).toContain('EROFS')
            expect(spawns).toBe(0)
        } finally {
            rmSync(appSupport, { recursive: true, force: true })
        }
    })

    test('dev / 探测不到 launcher：一个字节都不 spawn，原因原样透出', async () => {
        for (const overrides of [{ isPackaged: false }, { launcherExe: null }]) {
            let spawns = 0
            const plan = await requestDesktopRestart(
                baseInput(tmpAppSupport(), {
                    ...overrides,
                    spawn: () => {
                        spawns += 1
                    },
                }),
            )
            expect(plan.ok).toBe(false)
            expect(spawns).toBe(0)
        }
    })
})

describe('ensureSupervisorAtBoot（冷启动自举）', () => {
    function bootInput(appSupport: string, overrides: Record<string, unknown> = {}) {
        return {
            isPackaged: true,
            launcherExe: LAUNCHER,
            pid: 4242,
            appSupport,
            logFile: '',
            bundleDir: '/pkg/app/bun',
            env: {},
            isAlive: aliveOf([4242]),
            supervisorScript: undefined,
            spawn: (_plan: { argv: string[]; env: Record<string, string> }) => { },
            ...overrides,
        }
    }

        test('dev / 探测不到 launcher / 已有监督在位 / 包里无脚本 ⇒ false 且零 spawn', async () => {
                // 真 bundle 目录但不放脚本：测 supervisorScriptFromBundle 探不到的分支（不是靠传 null 参数）
                const bundleRoot = tmpAppSupport()
                try {
                        const bundleDir = join(bundleRoot, 'app', 'bun')
                        mkdirSync(bundleDir, { recursive: true })
                        for (const overrides of [
                                { isPackaged: false },
                                { launcherExe: null },
                                { env: { [SUPERVISED_BY_ENV]: '99' }, isAlive: aliveOf([99, 4242]) },
                                { bundleDir },
                        ]) {
                                let spawns = 0
                                const result = await ensureSupervisorAtBoot(bootInput(bundleRoot, { ...overrides, spawn: () => (spawns += 1) }))
                                expect(result).toBe(false)
                                expect(spawns).toBe(0)
                        }
                } finally {
                        rmSync(bundleRoot, { recursive: true, force: true })
                }
        })

        test('happy path：包里有 runtime/shell-supervisor.mjs ⇒ spawn [bun, 脚本]，配置指向本进程，返回 true', async () => {
                        const bundleRoot = tmpAppSupport()
                        try {
                                const bundleDir = join(bundleRoot, 'app', 'bun')
                                const scriptPath = join(bundleRoot, 'app', 'runtime', 'shell-supervisor.mjs')
                                mkdirSync(join(bundleRoot, 'app', 'runtime'), { recursive: true })
                                writeFileSync(scriptPath, 'export {}')
                                let seen: { argv: string[]; env: Record<string, string> } | null = null
                                const result = await ensureSupervisorAtBoot(
                                        bootInput(bundleRoot, {
                                                bundleDir,
                                                leaseWait: async () => true,
                                                spawn: (p: { argv: string[]; env: Record<string, string> }) => {
                                                        seen = p
                                                },
                                        }),
                                )
                                expect(result).toBe(true)
                                const got = seen as unknown as { argv: string[]; env: Record<string, string> }
                                expect(got.argv).toEqual([process.execPath, scriptPath])
                                expect(JSON.parse(got.env[SUPERVISOR_CONFIG_ENV] ?? '')).toMatchObject({ launcherExe: LAUNCHER, desktopPid: 4242 })
                        } finally {
                                rmSync(bundleRoot, { recursive: true, force: true })
                        }
                })

        test('自举 spawn 抛错 ⇒ false（不挡启动，重启时还有保底路径）', async () => {
                const result = await ensureSupervisorAtBoot(
            bootInput(tmpAppSupport(), {
                supervisorScript: '/pkg/runtime/shell-supervisor.mjs',
                spawn: () => {
                    throw new Error('EACCES')
                },
            }),
        )
        expect(result).toBe(false)
    })
})


describe('waitForSupervisorLease（自举自证）', () => {
        test('租约出现且监督 pid 活 ⇒ true；监督 pid 死 / 干脆没租约 ⇒ false', async () => {
                const appSupport = tmpAppSupport()
                try {
                        writeSupervisorLease(supervisorLeasePath(appSupport), { supervisorPid: 10, desktopPid: 20, bootId: 'b1', startedAt: '' })
                        expect(
                                await waitForSupervisorLease({ appSupport, isAlive: aliveOf([10]), deadlineMs: 40, pollMs: 10 }),
                        ).toBe(true)
                        // 监督 pid 死 ⇒ 不算自证过
                        expect(
                                await waitForSupervisorLease({ appSupport, isAlive: aliveOf([]), deadlineMs: 40, pollMs: 10 }),
                        ).toBe(false)
                        // 干脆没租约 ⇒ false
                        expect(
                                await waitForSupervisorLease({ appSupport: tmpAppSupport(), isAlive: aliveOf([10]), deadlineMs: 40, pollMs: 10 }),
                        ).toBe(false)
                } finally {
                        rmSync(appSupport, { recursive: true, force: true })
                }
        })
})
describe('buildSupervisorSpawn（监督进程 spawn 组装）', () => {
    test('argv = [bunExe, scriptPath]，配置 JSON 落 env，其余 env 透传', () => {
        const plan = buildSupervisorSpawn({
            bunExe: '/toolchains/bun',
            scriptPath: '/pkg/runtime/shell-supervisor.mjs',
            config: {
                launcherExe: LAUNCHER,
                desktopPid: 4242,
                appSupport: '/support',
                logFile: '/logs/relay.log',
                nextWaitMs: 5,
            },
            env: { PATH: '/usr/bin' },
        })
        expect(plan.argv).toEqual(['/toolchains/bun', '/pkg/runtime/shell-supervisor.mjs'])
        expect(plan.env.PATH).toBe('/usr/bin')
            const config = JSON.parse(plan.env[SUPERVISOR_CONFIG_ENV] ?? '')
        expect(config).toEqual({
            launcherExe: LAUNCHER,
            desktopPid: 4242,
            appSupport: '/support',
            logFile: '/logs/relay.log',
            nextWaitMs: 5,
        })
    })
})
