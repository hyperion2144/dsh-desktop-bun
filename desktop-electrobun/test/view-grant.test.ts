// 每视图授权（#220 决策 12：授权层重建）——缝 ② 纯逻辑 + 缝 ① 真 HTTP 用例。
//
// 守的是什么：旧壳靠 Tauri 的 capability 文件按**窗口**发 75 条命令的权限；新壳所有窗口同源
// （同一个 loopback origin），只看 Origin + cookie 分不出「主窗」和「贴进来的网页」。这里守：
//   1. 没有 token / token 没登记 ⇒ 壳端点一律 403（页面拿到的是明确错误，不是静默失效）；
//   2. `shell` 视图（我们自己的页面）命令全放行；
//   3. `guest` 视图（外来网页）除报日志外**任何**命令都拒，且拒绝要回可读原因；
//   4. 窗口关了 → token 撤销，旧 token 立刻失效（旧壳的 capability 是静态文件，这里跟着窗口走）。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startShellServer } from '../src/bun/net/shell-server.ts'
import {
  GUEST_ALLOWED_COMMANDS,
  REMOTE_ALLOWED_COMMANDS,
  VIEW_TOKEN_HEADER,
  createViewRegistry,
  denyReason,
  isCommandAllowed,
} from '../src/shared/net/view-grant.ts'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 确定性 token（测试里不关心随机性）。 */
function sequenceTokens(): () => string {
  let n = 0
  return () => {
    n += 1
    return `tok-${String(n)}`
  }
}


describe('每视图授权：纯逻辑', () => {
  test('shell 视图全放行，guest 只放行白名单', () => {
    expect(isCommandAllowed('shell', 'get_desktop_settings_data')).toBe(true)
    expect(isCommandAllowed('shell', 'log_console')).toBe(true)
    for (const command of GUEST_ALLOWED_COMMANDS) expect(isCommandAllowed('guest', command)).toBe(true)
    for (const command of ['get_desktop_settings_data', 'save_desktop_settings', 'download_runtime', 'open_external']) {
      expect(isCommandAllowed('guest', command)).toBe(false)
    }
  })

    test('日志管理三命令（#224 Decision 7/D14 负例）：guest/remote 一律拒，仅 shell 放行', () => {
        for (const command of ['list_log_files', 'export_log_range', 'clear_logs']) {
            expect(isCommandAllowed('guest', command)).toBe(false)
            expect(isCommandAllowed('remote', command)).toBe(false)
            expect(isCommandAllowed('shell', command)).toBe(true)
        }
    })

  test('拒绝原因是给人看的一句话', () => {
    expect(denyReason('guest', 'save_desktop_settings')).toContain('save_desktop_settings')
    expect(denyReason('guest', 'save_desktop_settings')).toContain('guest')
  })

  test('remote 视图（#47）：只放行配对远程白名单，guest 不因此多放', () => {
    for (const command of REMOTE_ALLOWED_COMMANDS) expect(isCommandAllowed('remote', command)).toBe(true)
    for (const command of ['download_runtime', 'save_desktop_settings', 'get_desktop_client_environment']) {
      expect(isCommandAllowed('remote', command)).toBe(false)
      // guest 是不可信视图：remote 的白名单对它不生效
      expect(isCommandAllowed('guest', command)).toBe(false)
    }
    expect(denyReason('remote', 'download_runtime')).toContain('remote')
  })


  test('台账：发 token、查表、撤销', () => {
    const views = createViewRegistry(sequenceTokens())
    const shell = views.issue('shell', 'desktop', 'profile-desktop')
    const guest = views.issue('guest', 'desktop', 'browser-guest-1')
    expect(shell.token).toBe('tok-1')
    expect(guest.token).toBe('tok-2')
    expect(views.lookup('tok-1')?.kind).toBe('shell')
    expect(views.lookup('tok-2')?.kind).toBe('guest')
    expect(views.lookup('tok-1')?.profile).toBe('desktop')
    expect(views.lookup('tok-1')?.label).toBe('profile-desktop')
    expect(views.list()).toHaveLength(2)
  })

  test('空 token / 未登记 token 都查不到', () => {
    const views = createViewRegistry(sequenceTokens())
    views.issue('shell', 'desktop', 'profile-desktop')
    expect(views.lookup(null)).toBeNull()
    expect(views.lookup(undefined)).toBeNull()
    expect(views.lookup('')).toBeNull()
    expect(views.lookup('tok-9')).toBeNull()
  })

  test('撤销：单个 token 与按窗口标签批量', () => {
    const views = createViewRegistry(sequenceTokens())
    views.issue('shell', 'desktop', 'profile-desktop')
    views.issue('guest', 'desktop', 'browser-guest-1')
    views.revoke('tok-1')
    expect(views.lookup('tok-1')).toBeNull()
    // 关掉 guest 窗口：它名下的 token 一起失效
    expect(views.revokeLabel('browser-guest-1')).toBe(1)
    expect(views.lookup('tok-2')).toBeNull()
    expect(views.revokeLabel('browser-guest-1')).toBe(0)
    // 没被点名的窗口不受影响
    const kept = views.issue('shell', 'web', 'profile-web')
    expect(views.revokeLabel('profile-desktop')).toBe(0)
    expect(views.lookup(kept.token)?.profile).toBe('web')
  })
})

describe('每视图授权：壳端点', () => {
  interface Harness {
    origin: string
    views: ReturnType<typeof createViewRegistry>
    calls: string[]
    cleanup: () => void
  }

  async function harness(): Promise<Harness> {
    const dist = tempDir('dsh-view-dist-')
    // #168：壳的端口交给系统分配（句柄里的 origin 就是真实端口）；上游只占位——这个 harness
    // 不反代任何东西，固定一个没人听的端口即可（旧写法是先占后放，那个窗口会被别的 socket 抢走）。
    const views = createViewRegistry(sequenceTokens())
    const calls: string[] = []
    const server = startShellServer({
      distDir: dist,
      token: 'tok',
      cookie: 'dsh-auth-x=v1.y',
      upstreamOrigin: 'http://127.0.0.1:1',
      port: 0,
      bootPayload: () => ({ injections: [{ kind: 'global', name: '__DSH_BOOT__' }], streamBaseUrl: 'http://127.0.0.1:1' }),
      views,
      onRpc: (raw) => {
        const parsed = JSON.parse(raw) as { cmd?: string }
        calls.push(parsed.cmd ?? '?')
        return Promise.resolve({ status: 200, body: { ok: true, value: { echo: parsed.cmd } } })
      },
      onOpenExternal: (url) => calls.push(`external:${url}`),
      onContextMenu: (request) => calls.push(`context-menu:${request.linkUrl ?? ''}`),
      onWindowControl: (action) => calls.push(`window:${action}`),
      onInputConfirm: (flow, value) => calls.push(`confirm:${flow}:${value}`),
    })
    return {
      origin: server.origin,
      views,
      calls,
      cleanup: () => {
        server.stop()
        rmSync(dist, { recursive: true, force: true })
      },
    }
  }

  function rpc(origin: string, token: string | null, command: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token !== null) headers[VIEW_TOKEN_HEADER] = token
    return fetch(`${origin}/__shell__/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cmd: command, args: {} }),
    })
  }

  test('不带 token 的 RPC 被拒，且没有落到命令表', async () => {
    const h = await harness()
    try {
      const response = await rpc(h.origin, null, 'get_desktop_settings_data')
      expect(response.status).toBe(403)
      expect(await response.text()).toContain('shell view token required')
      expect(h.calls).toHaveLength(0)
    } finally {
      h.cleanup()
    }
  })

  test('未登记的 token 被拒（伪造/过期都走这条）', async () => {
    const h = await harness()
    try {
      h.views.issue('shell', 'desktop', 'profile-desktop')
      const response = await rpc(h.origin, 'tok-forged', 'get_desktop_settings_data')
      expect(response.status).toBe(403)
      expect(h.calls).toHaveLength(0)
    } finally {
      h.cleanup()
    }
  })

  test('shell 视图：命令原样放行', async () => {
    const h = await harness()
    try {
      const grant = h.views.issue('shell', 'desktop', 'profile-desktop')
      const response = await rpc(h.origin, grant.token, 'get_desktop_settings_data')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, value: { echo: 'get_desktop_settings_data' } })
      expect(h.calls).toEqual(['get_desktop_settings_data'])
    } finally {
      h.cleanup()
    }
  })

  test('guest 视图：特权命令被拒，拒绝原因可读', async () => {
    const h = await harness()
    try {
      const guest = h.views.issue('guest', 'desktop', 'browser-guest-1')
      const response = await rpc(h.origin, guest.token, 'download_runtime')
      expect(response.status).toBe(403)
      const body = (await response.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('download_runtime')
      expect(h.calls).toHaveLength(0)
    } finally {
      h.cleanup()
    }
  })

  test('guest 视图：报日志是唯一放行的命令', async () => {
    const h = await harness()
    try {
      const guest = h.views.issue('guest', 'desktop', 'browser-guest-1')
      const response = await rpc(h.origin, guest.token, 'log_console')
      expect(response.status).toBe(200)
      expect(h.calls).toEqual(['log_console'])
    } finally {
      h.cleanup()
    }
  })

  test('remote 视图（#47 配对远程）：白名单命令放行，其余拒', async () => {
    const h = await harness()
    try {
      const remote = h.views.issue('remote', 'desktop', 'mobile-access 命令桥')
      const allowed = await rpc(h.origin, remote.token, 'get_notifications_state')
      expect(allowed.status).toBe(200)
      expect(h.calls).toEqual(['get_notifications_state'])
      const denied = await rpc(h.origin, remote.token, 'download_runtime')
      expect(denied.status).toBe(403)
      expect(((await denied.json()) as { error: string }).error).toContain('download_runtime')
      expect(h.calls).toEqual(['get_notifications_state'])
    } finally {
      h.cleanup()
    }
  })

  test('guest 仍能开外链（外链端点只认 token，不看命令白名单）', async () => {
    const h = await harness()
    try {
      const guest = h.views.issue('guest', 'desktop', 'browser-guest-1')
      const response = await fetch(`${h.origin}/__shell__/open-external`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [VIEW_TOKEN_HEADER]: guest.token },
        body: JSON.stringify({ url: 'https://example.com/a' }),
      })
      expect(response.status).toBe(204)
      expect(h.calls).toEqual(['external:https://example.com/a'])
    } finally {
      h.cleanup()
    }
  })

  test('boot 载荷也要 token（页面拿不到注入就等于黑屏，必须带）', async () => {
    const h = await harness()
    try {
      const denied = await fetch(`${h.origin}/__shell__/boot`)
      expect(denied.status).toBe(403)
      const grant = h.views.issue('shell', 'desktop', 'profile-desktop')
      const ok = await fetch(`${h.origin}/__shell__/boot`, { headers: { [VIEW_TOKEN_HEADER]: grant.token } })
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as { injections: unknown[] }).injections).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test('窗口关闭后旧 token 立刻失效', async () => {
    const h = await harness()
    try {
      const grant = h.views.issue('shell', 'desktop', 'profile-desktop')
      expect((await rpc(h.origin, grant.token, 'get_desktop_settings_data')).status).toBe(200)
      h.views.revokeLabel('profile-desktop')
      expect((await rpc(h.origin, grant.token, 'get_desktop_settings_data')).status).toBe(403)
    } finally {
      h.cleanup()
    }
  })

  // #130：壳自答端点里会**改变状态**的那几条（右键菜单 / 窗口控制 / 确认回填 / 批量转发）
  // 以前只过网络准入（同源），不查视图 token。同源闸门只约束浏览器——本机进程直接打就能弹菜单、
  // 关窗、代答确认弹窗，所以这一组守「未登记视图一律 403，且根本没落到回调」。
  const MUTATING_ENDPOINTS: { name: string; path: string; body: string }[] = [
    { name: 'context-menu', path: '/__shell__/context-menu', body: JSON.stringify({ linkUrl: 'https://example.com/x' }) },
    { name: 'window', path: '/__shell__/window', body: JSON.stringify({ action: 'minimize' }) },
    { name: 'input-confirm', path: '/__shell__/input-confirm', body: JSON.stringify({ flow: 'f1', value: 'v' }) },
    { name: 'batch', path: '/__shell__/batch', body: JSON.stringify({ requests: [{ method: 'GET', path: '/api/x' }] }) },
  ]

  for (const endpoint of MUTATING_ENDPOINTS) {
    test(`${endpoint.name}：不带 token 被拒，且没有落到回调`, async () => {
      const h = await harness()
      try {
        const denied = await fetch(`${h.origin}${endpoint.path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: endpoint.body,
        })
        expect(denied.status).toBe(403)
        expect(await denied.text()).toContain('shell view token required')
        expect(h.calls).toEqual([])
      } finally {
        h.cleanup()
      }
    })
  }

  test('context-menu：已登记视图能弹（与 open-external 同级，不按命令白名单细分）', async () => {
    const h = await harness()
    try {
      const shell = h.views.issue('shell', 'desktop', 'profile-desktop')
      const ok = await fetch(`${h.origin}/__shell__/context-menu`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [VIEW_TOKEN_HEADER]: shell.token },
        body: JSON.stringify({ linkUrl: 'https://example.com/x' }),
      })
      expect(ok.status).toBe(204)
      expect(h.calls).toEqual(['context-menu:https://example.com/x'])
      // guest 是有 token 的视图就放行——这一层只管「是不是壳的页面」，不管命令白名单
      const guest = h.views.issue('guest', 'desktop', 'browser-guest-1')
      const viaGuest = await fetch(`${h.origin}/__shell__/context-menu`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [VIEW_TOKEN_HEADER]: guest.token },
        body: JSON.stringify({}),
      })
      expect(viaGuest.status).toBe(204)
      expect(h.calls).toHaveLength(2)
    } finally {
      h.cleanup()
    }
  })
})
