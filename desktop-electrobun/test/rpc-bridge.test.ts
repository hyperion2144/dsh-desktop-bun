// 官方 RPC 缝合层（#50）——缝 ② 纯漏斗用例（defineRPC 挂点需要运行时，单测打漏斗）。
//
// 守的是什么：官方 Typed RPC 把 `{method, params}` 交给 requests 表，`_` 通配漏斗必须——
//   1. 命令语义与 HTTP 兜底（/__shell__/rpc）同源：都走 dispatchRpc，成功回值、失败 throw；
//   2. 每视图白名单在这里仍然生效（guest/remote 即便拿到 RPC 实例也一条命令都不放行）；
//   3. 窗口三键走显式方法、直接操作本窗，不进命令表；
//   4. 命令表未就绪/命令抛错，都回可读错误而不是 resolve undefined。

import { describe, expect, test } from 'bun:test'
import { createRpcRouter, type RpcHandler } from '../src/bun/rpc.ts'
import { createShellRpcFunnel, type ShellRpcDeps } from '../src/bun/rpc-bridge.ts'
import { deriveMaximized, type WindowFrame } from '../src/bun/window-max.ts'
import { createViewRegistry } from '../src/shared/view-grant.ts'
function makeDeps(overrides: Partial<ShellRpcDeps> = {}): ShellRpcDeps {
  const views = createViewRegistry()
  return {
    // 默认 darwin（原生路径语义）；win32 系统最大化语义由显式用例钉死，别依赖 runner 平台
    platform: 'darwin',
    router: () =>
      createRpcRouter({
        get_desktop_client_environment: () => ({ platform: 'win32', profile: 'main' }),
        echo: (args) => args,
        log_console: () => null,
        get_notifications_state: () => ({ enabled: false }),
        boom: () => {
          throw new Error('炸了')
        },
      }),
    grant: views.issue('shell', 'main', 'win:main'),
    window: {
      minimize: () => {},
      isMaximized: () => false,
      unmaximize: () => {},
      maximize: () => {},
      close: () => {},
      getFrame: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    },
    ...overrides,
  }
}

describe('壳 RPC 漏斗（官方 Typed RPC → 命令表）', () => {
  test('shell 视图：命令成功回值，与 HTTP 兜底同语义', async () => {
    const funnel = createShellRpcFunnel(makeDeps())
    await expect(funnel('get_desktop_client_environment', {})).resolves.toEqual({
      platform: 'win32',
      profile: 'main',
    })
  })

  test('未知命令：throw 明确文案（官方协议映射 success:false，面板可显示）', async () => {
    const funnel = createShellRpcFunnel(makeDeps())
    await expect(funnel('no_such_command', {})).rejects.toThrow('unsupported command: no_such_command')
  })

  test('命令抛错：错误信息原样往外传（不吞）', async () => {
    const funnel = createShellRpcFunnel(makeDeps())
    await expect(funnel('boom', {})).rejects.toThrow('炸了')
  })

  test('guest 视图：报日志之外的命令一律拒，回可读原因', async () => {
    const views = createViewRegistry()
    const grant = views.issue('guest', 'main', 'guest:1')
    const funnel = createShellRpcFunnel(makeDeps({ grant }))
    await expect(funnel('get_desktop_client_environment', {})).rejects.toThrow('不允许来自 guest')
    await expect(funnel('log_console', {})).resolves.toBeNull()
  })

  test('remote 视图：白名单外的命令拒（对齐旧壳 remote-desktop 语义）', async () => {
    const views = createViewRegistry()
    const grant = views.issue('remote', 'main', 'remote:paired')
    const funnel = createShellRpcFunnel(makeDeps({ grant }))
    await expect(funnel('get_dsh_status', {})).rejects.toThrow('不允许来自 remote')
    await expect(funnel('get_notifications_state', {})).resolves.toEqual({ enabled: false })
  })

  test('窗口三键：显式方法直接操作本窗，返回 null；授权先行', async () => {
    const calls: string[] = []
    const funnel = createShellRpcFunnel(
      makeDeps({
        window: {
          minimize: () => calls.push('minimize'),
          isMaximized: () => true,
          unmaximize: () => calls.push('unmaximize'),
          maximize: () => calls.push('maximize'),
          close: () => calls.push('close'),
          getFrame: () => ({ x: 0, y: 0, width: 0, height: 0 }),
        },
      }),
    )
    await expect(funnel('window_minimize', undefined)).resolves.toBeNull()
    await expect(funnel('window_toggle_maximize', undefined)).resolves.toBeNull()
    await expect(funnel('window_close', undefined)).resolves.toBeNull()
    expect(calls).toEqual(['minimize', 'unmaximize', 'close'])
    // guest 视图连三键也不给（授权先行，白名单是最后一道闸）
    const views = createViewRegistry()
    const guest = createShellRpcFunnel(makeDeps({ grant: views.issue('guest', 'main', 'guest:2') }))
    await expect(guest('window_close', undefined)).rejects.toThrow('不允许来自 guest')
  })

  test('toggle_zoom：F13 旧命令归入漏斗，作用本窗且不进命令表（#128）', async () => {
    const calls: string[] = []
    const funnel = createShellRpcFunnel(
      makeDeps({
        // router 给 null：命令表没就绪。若还走命令表，这里必然报 'shell rpc not ready'。
        router: () => null,
        window: {
          minimize: () => calls.push('minimize'),
          isMaximized: () => true,
          unmaximize: () => calls.push('unmaximize'),
          maximize: () => calls.push('maximize'),
          close: () => calls.push('close'),
          getFrame: () => ({ x: 0, y: 0, width: 0, height: 0 }),
        },
      }),
    )
    await expect(funnel('toggle_zoom', undefined)).resolves.toEqual({ ok: true })
    // 改的是本窗（先前走 focusedWindow()，多窗口下会盖错窗），且语义与 window_toggle_maximize 相同
    expect(calls).toEqual(['unmaximize'])
  })

  describe('Windows 系统最大化（样式补丁，window-max.ts）', () => {
    const WORK: WindowFrame = { x: 0, y: 0, width: 1920, height: 1040 }

    function makeStateWindow(initial: WindowFrame) {
      let frame = initial
      let maximized = false
      const calls: string[] = []
      return {
        calls,
        minimize: () => calls.push('minimize'),
        isMaximized: () => maximized,
        unmaximize: () => {
          maximized = false
          calls.push('unmaximize')
        },
        maximize: () => {
          maximized = true
          calls.push('maximize')
        },
        close: () => calls.push('close'),
        getFrame: (): WindowFrame => frame,
      }
    }

    test('补丁生效：系统行为最大化（maximize/unmaximize，不自算 setFrame）', async () => {
      const win = makeStateWindow({ x: 100, y: 80, width: 800, height: 600 })
      const funnel = createShellRpcFunnel(
        makeDeps({ platform: 'win32', maximizeStylesPatched: () => true, workArea: () => null, window: win }),
      )
      await expect(funnel('window_get_state', undefined)).resolves.toEqual({ maximized: false })
      await funnel('window_toggle_maximize', undefined)
      expect(win.calls).toEqual(['maximize'])
      await expect(funnel('window_get_state', undefined)).resolves.toEqual({ maximized: true })
      await funnel('window_toggle_maximize', undefined)
      expect(win.calls).toEqual(['maximize', 'unmaximize'])
    })

    test('补丁失败：仍走原生 maximize（#80 维护者指令：不做 setFrame 自绘兜底）', async () => {
      const win = makeStateWindow({ x: 100, y: 80, width: 800, height: 600 })
      const funnel = createShellRpcFunnel(
        makeDeps({ platform: 'win32', maximizeStylesPatched: () => false, workArea: () => WORK, window: win }),
      )
      await funnel('window_toggle_maximize', undefined)
      expect(win.calls).toEqual(['maximize'])
      await funnel('window_toggle_maximize', undefined)
      expect(win.calls).toEqual(['maximize', 'unmaximize'])
    })

    test('guest 视图：window_get_state 也在白名单外，拒绝', async () => {
      const views = createViewRegistry()
      const funnel = createShellRpcFunnel(makeDeps({ grant: views.issue('guest', 'main', 'guest:3') }))
      await expect(funnel('window_get_state', undefined)).rejects.toThrow('不允许来自 guest')
    })

    test('deriveMaximized 纯判定：几何相等/容差/无工作区退回原生旗标', () => {
      expect(deriveMaximized(WORK, WORK, false)).toBe(true)
      expect(deriveMaximized({ x: 0, y: 0, width: 1920, height: 1035 }, WORK, false)).toBe(true)
      expect(deriveMaximized({ x: 0, y: 0, width: 1920, height: 1000 }, WORK, false)).toBe(false)
      expect(deriveMaximized(WORK, null, true)).toBe(true)
      expect(deriveMaximized(WORK, null, false)).toBe(false)
      // 实机回归：旗标为 true 时无论几何坐标空间差多少（逻辑 px vs 物理 px）都算已最大化
      expect(deriveMaximized({ x: 100, y: 80, width: 800, height: 600 }, WORK, true)).toBe(true)
    })
  }),

  test('命令表未就绪：throw shell rpc not ready（不静默）', async () => {
    const funnel = createShellRpcFunnel(makeDeps({ router: () => null }))
    await expect(funnel('get_desktop_client_environment', {})).rejects.toThrow('shell rpc not ready')
  })

  test('params 非对象按 {} 归一（与 shim 时代的 args 语义一致）', async () => {
    let seen: Record<string, unknown> | undefined
    const handler: RpcHandler = (args) => {
      seen = args
      return null
    }
    const funnel = createShellRpcFunnel(makeDeps({ router: () => createRpcRouter({ echo: handler }) }))
    await funnel('echo', '不是对象')
    expect(seen).toEqual({})
  })

})
