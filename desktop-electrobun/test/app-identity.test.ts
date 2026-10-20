// 应用身份（bundle identifier）：构建期烙进产物 Resources/version.json，
// hutch launcher 读它经 FFI 传给 native core，CEF 数据目录（<id>/<channel>/CEF）
// 与 Chromium ProcessSingleton 锁都由它派生（#38）。
//
// 守的是什么：
//   1. 默认（不设 DSH_SHELL_DEV_IDENTIFIER）解析出的 identifier 与现状完全一致——
//      正式产物、升级链、签名链零感知。
//   2. 设了 DSH_SHELL_DEV_IDENTIFIER 的构建拿到独立 identifier——第二份 dev 实例
//      因此获得独立 CEF 数据目录，Chromium 单例不再把它转发给第一实例。
//   3. 空串/纯空白视同未设——覆盖口径由 bundleIdentifierOverride 统一给出。

import { describe, expect, test } from 'bun:test'
import { bundleIdentifierOverride, DEFAULT_BUNDLE_IDENTIFIER, resolveBundleIdentifier } from '../src/shared/app/app-identity.ts'

describe('resolveBundleIdentifier（构建期 bundle id 解析）', () => {
  test('未设 DSH_SHELL_DEV_IDENTIFIER：回落默认 id，与既有产物一致', () => {
    expect(resolveBundleIdentifier({})).toBe(DEFAULT_BUNDLE_IDENTIFIER)
    expect(DEFAULT_BUNDLE_IDENTIFIER).toBe('com.hyperion.dsh-desktop-bun')
  })

  test('设了 DSH_SHELL_DEV_IDENTIFIER：用覆盖值（去首尾空白）', () => {
    expect(
      resolveBundleIdentifier({ DSH_SHELL_DEV_IDENTIFIER: 'com.hyperion.dsh-desktop-bun.t2' }),
    ).toBe('com.hyperion.dsh-desktop-bun.t2')
    expect(resolveBundleIdentifier({ DSH_SHELL_DEV_IDENTIFIER: '  com.hyperion.dev2  ' })).toBe(
      'com.hyperion.dev2',
    )
  })

  test('空串与纯空白视同未设，回落默认', () => {
    expect(resolveBundleIdentifier({ DSH_SHELL_DEV_IDENTIFIER: '' })).toBe(DEFAULT_BUNDLE_IDENTIFIER)
    expect(resolveBundleIdentifier({ DSH_SHELL_DEV_IDENTIFIER: '   ' })).toBe(DEFAULT_BUNDLE_IDENTIFIER)
  })

  test('缺省参数走真实 process.env（本进程未设 → 默认）', () => {
    const saved = process.env.DSH_SHELL_DEV_IDENTIFIER
    delete process.env.DSH_SHELL_DEV_IDENTIFIER
    try {
      expect(resolveBundleIdentifier()).toBe(DEFAULT_BUNDLE_IDENTIFIER)
    } finally {
      if (saved !== undefined) process.env.DSH_SHELL_DEV_IDENTIFIER = saved
    }
  })
})

describe('bundleIdentifierOverride（覆盖值提取）', () => {
  test('未设/空白 → null；设置 → 去首尾空白', () => {
    expect(bundleIdentifierOverride({})).toBeNull()
    expect(bundleIdentifierOverride({ DSH_SHELL_DEV_IDENTIFIER: '   ' })).toBeNull()
    expect(bundleIdentifierOverride({ DSH_SHELL_DEV_IDENTIFIER: '  a.b  ' })).toBe('a.b')
  })
})

describe('electrobun.config 的 app.identifier（构建期单一来源）', () => {
  test('委托 resolveBundleIdentifier，不许写死旁路（源码断言，不吃 ambient env）', async () => {
    const source = await Bun.file(new URL('../electrobun.config.ts', import.meta.url)).text()
    expect(source).toContain('identifier: resolveBundleIdentifier()')
    expect(source).not.toContain(`identifier: '${DEFAULT_BUNDLE_IDENTIFIER}'`)
  })
})
