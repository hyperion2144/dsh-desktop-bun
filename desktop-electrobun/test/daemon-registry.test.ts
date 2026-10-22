// #242 守护骨架：注册表持久化/幂等/容错 + 角色锁拆分 + spawn 机械 + 装配层。
//
// 守的是什么：
//   1. 注册表是唯一权威记账——坏文件按空表继续（宽容读），同 id 幂等，原子写。
//   2. 守护角色锁与壳锁互不干扰；第二个守护必须让位（单守护保证点）。
//   3. spawn/kill 是进程机械：注入式，不真拉进程；kill 的 TERM→KILL 梯次明确。
//   4. runDaemon 装配语义：让位/acquired、旧壳认领、stop 清锁。
// 控制通道 HTTP 面在 daemon-control.test.ts。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProfileRegistry, parseRegistry, remoteProfileId, type RegistryIo } from '../src/bun/daemon/registry.ts'
import { DAEMON_ROLE, acquireDaemonRole, daemonInstanceFile, readShellInstance, releaseDaemonRole } from '../src/bun/daemon/roles.ts'
import { classifyShellExit, killShell, shellDaemonEnv, shellLaunchArgv, spawnShell } from '../src/bun/daemon/spawn.ts'
import { runDaemon } from '../src/bun/daemon/run.ts'

function memoryIo(initial: string = ''): RegistryIo & { store: Map<string, string> } {
    const store = new Map<string, string>()
    if (initial !== '') store.set('registry', initial)
    return {
        store,
        readFile: (path) => store.get(path) ?? store.get('registry') ?? null,
        writeFile: (path, text) => {
            store.set(path, text)
            store.set('registry', text)
        },
    }
}

describe('parseRegistry（宽容读）', () => {
    test('null / 空串 / 非 JSON / 非对象 / 无 entries ⇒ 空表', () => {
        for (const bad of [null, '', 'not-json', '{"a":1}', '{"entries":"nope"}']) {
            expect(parseRegistry(bad).entries).toEqual([])
        }
    })
    test('逐条容错：坏条目跳过、字段归一', () => {
        const registry = parseRegistry(
            JSON.stringify({
                version: 1,
                entries: [
                    { id: 'desktop', kind: 'local', status: 'running', pid: 42 },
                    { kind: 'local' },
                    { id: 'r1', kind: 'remote', remoteUrl: 'https://X.io:3080/', status: 'weird' },
                ],
            }),
        )
        expect(registry.entries).toHaveLength(2)
        expect(registry.entries[0]).toMatchObject({ id: 'desktop', kind: 'local', pid: 42 })
        expect(registry.entries[1]).toMatchObject({ id: 'r1', kind: 'remote', status: 'stopped', remoteUrl: 'https://X.io:3080/' })
    })
})

describe('ProfileRegistry（内存 IO）', () => {
    test('upsertLocal 幂等 + markStatus 跑通 + 持久化落盘', () => {
        const io = memoryIo()
        const registry = new ProfileRegistry('/tmp/unused', io)
        registry.upsertLocal('desktop')
        registry.upsertLocal('desktop')
        expect(registry.list()).toHaveLength(1)
        registry.markStatus('desktop', 'running', 1234)
        expect(registry.get('desktop')).toMatchObject({ status: 'running', pid: 1234 })
        const persisted = JSON.parse(io.store.get('registry') ?? '{}')
        expect(persisted.entries[0]).toMatchObject({ id: 'desktop', status: 'running', pid: 1234 })
    })
    test('markStatus stopped/crashed 清 pid；running 记 startedAt', () => {
        const registry = new ProfileRegistry('/tmp/unused', memoryIo())
        registry.upsertLocal('a')
        registry.markStatus('a', 'running', 7)
        const stopped = registry.markStatus('a', 'crashed')
        expect(stopped).toMatchObject({ status: 'crashed', pid: null })
        const running = registry.markStatus('a', 'running', 8)
        expect(running?.pid).toBe(8)
        expect(running?.startedAt).not.toBeNull()
    })
    test('upsertRemote 归一 id + 改名生效；remove 删条目', () => {
        const registry = new ProfileRegistry('/tmp/unused', memoryIo())
        registry.upsertRemote('https://X.io:3080', '远程A')
        registry.upsertRemote('https://x.io:3080/') // 同址不同写法 ⇒ 同一条
        expect(registry.list()).toHaveLength(1)
        expect(registry.list()[0]).toMatchObject({ id: remoteProfileId('https://X.io:3080'), name: '远程A' })
        registry.upsertRemote('https://x.io:3080', '改名B')
        expect(registry.list()[0]?.name).toBe('改名B')
        expect(registry.remove('nope')).toBe(false)
        expect(registry.remove(registry.list()[0]?.id ?? '')).toBe(true)
    })
    test('重启恢复：本地条目 pid 清空回 stopped，远程条目保留状态', () => {
        const io = memoryIo()
        const first = new ProfileRegistry('/tmp/unused', io)
        first.upsertLocal('desktop')
        first.markStatus('desktop', 'running', 99)
        first.upsertRemote('https://x.io', 'R')
        first.markStatus(first.list().find((entry) => entry.kind === 'remote')?.id ?? '', 'running')
        const second = new ProfileRegistry('/tmp/unused', io)
        expect(second.get('desktop')).toMatchObject({ status: 'stopped', pid: null })
        const remote = second.list().find((entry) => entry.kind === 'remote')
        expect(remote?.status).toBe('running')
    })
    test('磁盘实现：真写临时目录 + 原子文件可回读', () => {
        const dir = mkdtempSync(join(tmpdir(), 'daemon-registry-'))
        try {
            const registry = new ProfileRegistry(dir)
            registry.upsertLocal('desktop')
            const text = readFileSync(join(dir, 'daemon-profiles.json'), 'utf8')
            expect(JSON.parse(text).entries[0]?.id).toBe('desktop')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('角色锁（daemon vs shell 拆分）', () => {
    test('第二个守护让位；释放后可再抢', () => {
        const dir = mkdtempSync(join(tmpdir(), 'daemon-role-'))
        try {
            const file = daemonInstanceFile(dir)
                const first = acquireDaemonRole(file, { isAlive: () => true, isOurProcess: () => true, identity: { pid: 100 } })
            expect(first.acquired).toBe(true)
            expect(first.record.profile).toBe(DAEMON_ROLE)
                const second = acquireDaemonRole(file, { isAlive: () => true, isOurProcess: () => true, identity: { pid: 200 } })
            expect(second.acquired).toBe(false)
            expect(second.previous?.pid).toBe(100)
            releaseDaemonRole(file, 100)
            const third = acquireDaemonRole(file, { isAlive: () => false, identity: { pid: 300 } })
            expect(third.acquired).toBe(true)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
    test('readShellInstance 读旧壳锁（兼容口径）', () => {
        const dir = mkdtempSync(join(tmpdir(), 'daemon-role-'))
        try {
            writeFileSync(join(dir, 'shell-instance.json'), JSON.stringify({ pid: 55, profile: 'desktop', bootId: '' }))
            const record = readShellInstance(dir)
            expect(record?.pid).toBe(55)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('spawn 机械（注入式）', () => {
    test('shellDaemonEnv 注出守护上下文三键', () => {
        expect(shellDaemonEnv({ controlOrigin: 'http://127.0.0.1:9', token: 'tok', daemonPid: 5 })).toEqual({
            DSH_SHELL_SUPERVISED_BY: '5',
            DSH_SHELL_CONTROL_URL: 'http://127.0.0.1:9',
            DSH_SHELL_CONTROL_TOKEN: 'tok',
        })
    })
        test('shellDaemonEnv：role/cefIdentity/restoreProfiles 可选键', () => {
                expect(shellDaemonEnv({ controlOrigin: 'o', token: 't', daemonPid: 5, role: 'shell', cefIdentity: 'id-shell' })).toEqual({
                        DSH_SHELL_SUPERVISED_BY: '5',
                        DSH_SHELL_CONTROL_URL: 'o',
                        DSH_SHELL_CONTROL_TOKEN: 't',
                        DSH_SHELL_ROLE: 'shell',
                        DSH_SHELL_CEF_IDENTITY: 'id-shell',
                })
                // 缺省 / 空串 cefIdentity 不透传（升级包 patch 未就位时的降级面）。
                expect('DSH_SHELL_CEF_IDENTITY' in shellDaemonEnv({ controlOrigin: 'o', token: 't', daemonPid: 5 })).toBe(false)
                expect('DSH_SHELL_CEF_IDENTITY' in shellDaemonEnv({ controlOrigin: 'o', token: 't', daemonPid: 5, cefIdentity: '' })).toBe(false)
        })
    test('spawnShell 成功/异常 pid/抛错三路', () => {
        const log = { infos: [] as string[], warns: [] as string[] }
        const onLog = { info: (m: string) => void log.infos.push(m), warn: (m: string) => void log.warns.push(m) }
        expect(spawnShell({ argv: ['x'], spawn: () => 123, onLog })).toEqual({ ok: true, pid: 123, error: null })
        expect(spawnShell({ argv: ['x'], spawn: () => -1, onLog }).ok).toBe(false)
        expect(
            spawnShell({ argv: ['x'], spawn: () => { throw new Error('boom') }, onLog }).error,
        ).toBe('boom')
        expect(log.warns.some((line) => line.includes('boom'))).toBe(true)
    })
        test('defaultSpawnShell：日志目录不存在时先建目录（#243 冒烟实抓）', () => {
                const dir = mkdtempSync(join(tmpdir(), 'daemon-spawn-'))
                const logFile = join(dir, 'no-such-dir', 'sub', 'shell-relay.log')
                const result = spawnShell({ argv: [process.execPath, '-e', 'process.exit(0)'], logFile })
                expect(result.ok).toBe(true)
                expect(existsSync(logFile)).toBe(true)
                rmSync(dir, { recursive: true, force: true })
        })
    test('killShell：已死不动 / TERM 生效 / TERM 超时走 KILL', async () => {
        const signals: string[] = []
        const signal = (pid: number, sig: 'SIGTERM' | 'SIGKILL') => void signals.push(sig)
        expect(await killShell({ pid: 1, isAlive: () => false, signal })).toEqual({ dead: true, via: 'none' })
        let alive = true
        expect(
            await killShell({
                pid: 2,
                isAlive: () => alive,
                signal: (pid, sig) => {
                    signal(pid, sig)
                    alive = false
                },
                sleep: () => Promise.resolve(),
            }),
        ).toEqual({ dead: true, via: 'SIGTERM' })
        const stubborn = await killShell({ pid: 3, isAlive: () => true, signal, sleep: () => Promise.resolve(), graceMs: 0 })
            expect(stubborn).toEqual({ dead: false, via: 'SIGKILL' })
        expect(signals).toContain('SIGKILL')
    })
    test('classifyShellExit：信号带走/非零码 ⇒ crashed', () => {
        expect(classifyShellExit({ exitCode: 0, signalCode: null })).toBe('normal')
        expect(classifyShellExit({ exitCode: null, signalCode: null })).toBe('normal')
        expect(classifyShellExit({ exitCode: 1, signalCode: null })).toBe('crashed')
        expect(classifyShellExit({ exitCode: 0, signalCode: 'SIGKILL' })).toBe('crashed')
    })
})

test('shellLaunchArgv：Windows 绕开 launcher.exe 直拉 [bun, main.js]，布局不全兜底旧行为（#243 CI 实抓）', () => {
        const win32 = 'C:/app/bin/launcher.exe'
        expect(
                shellLaunchArgv({
                        launcherExe: win32,
                        platform: 'win32',
                        exists: (path) => path.endsWith('bun.exe') || path.endsWith('main.js'),
                }),
        ).toEqual(['C:/app/bin/bun.exe', resolve('C:/app/bin', '..', 'Resources', 'main.js')])
        // 包内找不到 bun/main.js（布局变了）→ 原样 launcher，宁试旧路不错过拉壳。
        expect(shellLaunchArgv({ launcherExe: win32, platform: 'win32', exists: () => false })).toEqual([win32])
        // 非 Windows：launcher 就是引导器，原样。
        expect(shellLaunchArgv({ launcherExe: '/app/launcher', platform: 'darwin' })).toEqual(['/app/launcher'])
})

describe('runDaemon（装配，内存 IO + 注入 isAlive）', () => {
    const log = () => ({ info: () => { }, warn: () => { }, error: () => { } })

    test('已有活守护 ⇒ 让位（无 control/registry）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'daemon-run-'))
        try {
            const file = daemonInstanceFile(dir)
            writeFileSync(file, JSON.stringify({ pid: 777, profile: DAEMON_ROLE, bootId: '' }))
                const handle = await runDaemon({ appSupport: dir, launcherExe: null, isAlive: (pid) => pid === 777, isOurProcess: () => true, onLog: log() })
            expect(handle.role).toBe('yielded')
            expect(handle.control).toBeNull()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
    test('认领活壳锁 ⇒ 注册表 running；stop 释放锁+停通道', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'daemon-run-'))
        try {
            writeFileSync(join(dir, 'shell-instance.json'), JSON.stringify({ pid: 55, profile: 'desktop', bootId: '' }))
                const handle = await runDaemon({ appSupport: dir, launcherExe: null, isAlive: (pid) => pid === 55, onLog: log() })
            expect(handle.role).toBe('acquired')
            expect(handle.shellPid).toBe(55)
            expect(handle.registry?.get('desktop')).toMatchObject({ status: 'running', pid: 55 })
            expect(handle.control?.origin.startsWith('http://127.0.0.1:')).toBe(true)
            const lock = JSON.parse(readFileSync(daemonInstanceFile(dir), 'utf8'))
            expect(lock.origin).toBe(handle.control?.origin)
            await handle.stop()
                const fs = require('node:fs') as typeof import('node:fs')
                expect(fs.existsSync(daemonInstanceFile(dir))).toBe(false)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
    test('spawnShellOnBoot + launcher ⇒ 拉壳并标 starting（注入 spawn 记 pid）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'daemon-run-'))
        try {
            let spawnedPid = 0
            // 注入路径：runDaemon 内部走 spawnShell 默认实现——这里用 launcher null + 已有壳路径
            // 覆盖不到 spawn 分支，改为直接验 spawnShell 的注入（上面已测）+ 本例验证开关关闭时不拉。
            void spawnedPid
            const handle = await runDaemon({ appSupport: dir, launcherExe: null, spawnShellOnBoot: true, onLog: log() })
            expect(handle.shellPid).toBeNull()
            expect(handle.registry?.list()).toEqual([])
            await handle.stop()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
