// #242 守护骨架：控制通道 HTTP 面。
//
// 守的是什么：
//   1. token 准入与页面 token 同口径（x-dsh-shell-view），没带对一律 403——这是
//      控制通道的安全边界，壳事件/状态查询都叠在它后面。
//   2. 事件体宽容解析：坏 JSON / 坏字段 / 空 profile / 非法 pid ⇒ 400，不落注册表。
//   3. register/heartbeat/exit 三事件的注册表迁移语义（与 spawn.ts 同口径）。
// 直接喂 route()（不经网络）+ 一次真 Bun.serve 冒烟，两种都跑。

import { describe, expect, test } from 'bun:test'
import { VIEW_TOKEN_HEADER } from '../src/shared/net/view-grant.ts'
import { DAEMON_SHELL_EVENT_PATH, DAEMON_STATE_PATH, applyShellEvent, parseShellEvent, startControlServer } from '../src/bun/daemon/control.ts'
import { ProfileRegistry, type RegistryIo } from '../src/bun/daemon/registry.ts'

function memoryIo(): RegistryIo {
    const store = new Map<string, string>()
    return {
        readFile: (path) => store.get(path) ?? null,
        writeFile: (path, text) => void store.set(path, text),
    }
}

function registryOf(): ProfileRegistry {
    return new ProfileRegistry('/tmp/unused', memoryIo())
}

describe('parseShellEvent（宽容解析）', () => {
    test('坏 JSON / 坏 type / 空 profile / 非法 pid ⇒ null', () => {
        for (const bad of ['', 'not-json', '{}', '{"type":"nope","profile":"a","pid":1}', '{"type":"register","profile":"","pid":1}', '{"type":"register","profile":"a","pid":0}']) {
            expect(parseShellEvent(bad)).toBeNull()
        }
    })
    test('合法体解析（exitCode 缺省 null）', () => {
        expect(parseShellEvent('{"type":"exit","profile":"a","pid":3,"exitCode":1}')).toEqual({
            type: 'exit', profile: 'a', pid: 3, exitCode: 1,
        })
        expect(parseShellEvent('{"type":"heartbeat","profile":"a","pid":3}')).toEqual({
            type: 'heartbeat', profile: 'a', pid: 3, exitCode: null,
        })
    })
})

describe('applyShellEvent（注册表迁移）', () => {
    test('register/heartbeat ⇒ running；exit 0 ⇒ stopped、非零 ⇒ crashed', () => {
        const registry = registryOf()
        expect(applyShellEvent(registry, { type: 'register', profile: 'desktop', pid: 9 })).toMatchObject({ status: 'running', pid: 9 })
        expect(applyShellEvent(registry, { type: 'heartbeat', profile: 'desktop', pid: 9 })).toMatchObject({ status: 'running', pid: 9 })
        expect(applyShellEvent(registry, { type: 'exit', profile: 'desktop', pid: 9, exitCode: 0 })).toMatchObject({ status: 'stopped', pid: null })
        expect(applyShellEvent(registry, { type: 'register', profile: 'desktop', pid: 10 })).toMatchObject({ status: 'running', pid: 10 })
        expect(applyShellEvent(registry, { type: 'exit', profile: 'desktop', pid: 10, exitCode: 2 })).toMatchObject({ status: 'crashed' })
    })
})

describe('控制通道路由（直喂 handle）', () => {
    test('无 token / 错 token ⇒ 403（安全边界）', async () => {
        const channel = startControlServer({ registry: registryOf(), token: 'secret' })
        try {
                for (const headers of [new Headers(), new Headers({ [VIEW_TOKEN_HEADER]: 'wrong' })]) {
                const response = await channel.handle(new Request(`http://x${DAEMON_STATE_PATH}`, { headers }))
                expect(response.status).toBe(403)
            }
        } finally {
            channel.stop()
        }
    })
    test('state 返回注册表快照', async () => {
        const registry = registryOf()
        registry.upsertLocal('desktop')
        const channel = startControlServer({ registry, token: 'secret' })
        try {
            const response = await channel.handle(new Request(`http://x${DAEMON_STATE_PATH}`, { headers: { [VIEW_TOKEN_HEADER]: 'secret' } }))
            expect(response.status).toBe(200)
            const body = (await response.json()) as { profiles: Array<{ id: string }> }
            expect(body.profiles[0]?.id).toBe('desktop')
        } finally {
            channel.stop()
        }
    })
    test('shell-event：register 落表；坏体 400；GET 405', async () => {
        const registry = registryOf()
        const channel = startControlServer({ registry, token: 'secret' })
        try {
            const post = (body: string): Request =>
                new Request(`http://x${DAEMON_SHELL_EVENT_PATH}`, { method: 'POST', headers: { [VIEW_TOKEN_HEADER]: 'secret' }, body })
            const ok = await channel.handle(post('{"type":"register","profile":"desktop","pid":7}'))
            expect(ok.status).toBe(200)
            expect(registry.get('desktop')).toMatchObject({ status: 'running', pid: 7 })
            expect((await channel.handle(post('garbage'))).status).toBe(400)
            const get = await channel.handle(new Request(`http://x${DAEMON_SHELL_EVENT_PATH}`, { headers: { [VIEW_TOKEN_HEADER]: 'secret' } }))
            expect(get.status).toBe(405)
        } finally {
            channel.stop()
        }
    })
    test('未知路径 ⇒ 404', async () => {
        const channel = startControlServer({ registry: registryOf(), token: 'secret' })
        try {
            const response = await channel.handle(new Request('http://x/nope', { headers: { [VIEW_TOKEN_HEADER]: 'secret' } }))
            expect(response.status).toBe(404)
        } finally {
            channel.stop()
        }
    })
})

describe('真 serve 冒烟（端口 0 内核分配）', () => {
    test('origin 可用、403/200 走完整链路', async () => {
        const channel = startControlServer({ registry: registryOf(), token: 'smoke' })
        try {
            expect(channel.origin.startsWith('http://127.0.0.1:')).toBe(true)
            const denied = await fetch(`${channel.origin}${DAEMON_STATE_PATH}`)
            expect(denied.status).toBe(403)
            const allowed = await fetch(`${channel.origin}${DAEMON_STATE_PATH}`, { headers: { [VIEW_TOKEN_HEADER]: 'smoke' } })
            expect(allowed.status).toBe(200)
            const body = (await allowed.json()) as { profiles: unknown[] }
            expect(Array.isArray(body.profiles)).toBe(true)
        } finally {
            channel.stop()
        }
    })
})
