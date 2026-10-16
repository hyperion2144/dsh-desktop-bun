// preload 脚本构造器的回归测试（#101）。
//
// 守的是实机事故：boot 失败时前端链路是 failed(error).catch(...)，旧实现返回 undefined，
// .catch 直接抛 TypeError（unhandled rejection），且用户只能面对无声的永久 loading。
// 这组用例锁三件事：脚本可被 JS 引擎解析、failed 返回 Promise、失败浮层可操作（刷新重试）。
import { describe, expect, test } from 'bun:test'
import { bootPreloadScript } from '../src/bun/preload.ts'

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

  test('boot 载荷入口语义不变：no-store + 视图 token 头', () => {
    expect(script).toContain("cache: 'no-store'")
    expect(script).toContain('viewToken')
  })
})
