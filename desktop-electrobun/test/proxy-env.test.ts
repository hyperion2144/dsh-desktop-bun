// 代理注入纯逻辑的测试（#79）：resolveProxyEnv 的模式语义在旧壳时代已验；
// 这里补 proxyEnvRecord——ProxyEnv → pnpm 安装子进程 env 记录的映射。

import { describe, expect, test } from 'bun:test'
import { proxyEnvRecord, PROXY_LOOPBACK_ENTRIES } from '../src/shared/proxy-env.ts'

describe('proxyEnvRecord', () => {
  test('manual http 代理：HTTP(S)_PROXY 大小写都写，NO_PROXY 带回环保底', () => {
    const record = proxyEnvRecord({
      http: 'http://127.0.0.1:7890',
      https: 'http://127.0.0.1:7890',
      all: null,
      no_proxy: `localhost,${PROXY_LOOPBACK_ENTRIES.join(',')}`,
    })
    expect(record.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(record.http_proxy).toBe('http://127.0.0.1:7890')
    expect(record.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(record.https_proxy).toBe('http://127.0.0.1:7890')
    expect(record.ALL_PROXY).toBeUndefined()
    expect(record.NO_PROXY).toContain('localhost')
  })

  test('socks5 代理：只写 ALL_PROXY（resolveProxyEnv 的 manual 语义）', () => {
    const record = proxyEnvRecord({ http: null, https: null, all: 'socks5://127.0.0.1:1080', no_proxy: 'localhost' })
    expect(record.ALL_PROXY).toBe('socks5://127.0.0.1:1080')
    expect(record.all_proxy).toBe('socks5://127.0.0.1:1080')
    expect(record.HTTP_PROXY).toBeUndefined()
    expect(record.HTTPS_PROXY).toBeUndefined()
    expect(record.NO_PROXY).toBe('localhost')
  })

  test('null/空条目不写键（代理关闭时不动用户环境里的同名变量）', () => {
    const record = proxyEnvRecord({ http: null, https: null, all: null, no_proxy: '' })
    expect(Object.keys(record)).toEqual([])
  })
})
