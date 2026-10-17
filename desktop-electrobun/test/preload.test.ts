// preload 脚本构造器的回归测试（#101）。
//
// 守的是实机事故：boot 失败时前端链路是 failed(error).catch(...)，旧实现返回 undefined，
// .catch 直接抛 TypeError（unhandled rejection），且用户只能面对无声的永久 loading。
// 这组用例锁三件事：脚本可被 JS 引擎解析、failed 返回 Promise、失败浮层可操作（刷新重试）。
import { describe, expect, test } from 'bun:test'
import { BOOT_ENDPOINT, bootPreloadScript } from '../src/bun/preload.ts'
import { VIEW_TOKEN_HEADER } from '../src/shared/view-grant.ts'

describe('preload 脚本（#101 boot 失败路径）', () => {
  const script = bootPreloadScript('zh-CN', 'darwin', 'http://127.0.0.1:1', 'tok-test')

  test('产出的脚本是合法 JS（可被引擎解析）', () => {
    expect(() => new Function(script)).not.toThrow()
  })

  test('failed 返回 Promise：前端 failed(error).catch(...) 不再踩 undefined', () => {
    const at = script.indexOf('failed: (error)')
    expect(at).toBeGreaterThan(0)
    const block = script.slice(at, script.indexOf('},', at))
    expect(block).toContain('return Promise.resolve()')
  })

  test('失败浮层：一次性挂载 + 可见的标题与错误摘要 + 刷新重试按钮', () => {
    expect(script).toContain('dsh-boot-failed-overlay')
    expect(script).toContain('页面启动失败')
    expect(script).toContain('location.reload()')
    expect(script).toContain('反复失败请重启 dsh 桌面壳')
    // 原样保留 console.error（日志面照旧），浮层逻辑整体兜在 try/catch 里不许再炸
    expect(script).toContain('console.error("desktop boot failed", error)')
    expect(script).toContain('} catch {}')
  })

  test('boot 载荷入口经官方 RPC：typed request 包形，不再打 HTTP 端点（#128）', () => {
    // 旧断言「cache: no-store + 视图 token 头」的等强度替代：载荷请求必须是一条完整的 typed RPC
    // request 包（type/id/method/params）经 __electrobunHostBridge 上送，宿主未就绪时 reject
    // （与旧 /__shell__/boot 的 503「页面会等」同语义），且注入脚本不再碰该端点、不再自己带 token 头。
    expect(script).toContain('request?.("get_boot_payload", {})')
    expect(script).toContain('type: "request", id, method, params')
    expect(script).toContain('bridge.postMessage.bind(bridge)')
    expect(script).toContain('Promise.reject(new Error("shell rpc unavailable"))')
    expect(script).not.toContain(BOOT_ENDPOINT)
    expect(script).not.toContain(VIEW_TOKEN_HEADER)
  })
})
