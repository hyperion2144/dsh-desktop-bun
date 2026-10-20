// profile 树 reconcile：真文件系统用例，钉住 #1 的几个修点——
// ① 悬空（坏）symlink 先删后建，不再 EEXIST（根因 2）；
// ② runtimeOwned（@deepseek-ai/*）被真目录占住时替换为运行时树链接（根因 3）；
// ③ 指向别处（旧壳残留形态）的 runtimeOwned symlink 重指回运行时树（根因 4）；
// ④ 第三方包按碰撞策略保留（profile 里已有的为准）；
// ⑤ 指向正确的链接幂等保留，不抖动。

import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createDirLink } from '../src/shared/profiles/dir-link.ts'
import { dirLinksEqual, pruneLegacyPoolLinks, reconcileProfileRuntimeTree, reconcileProfileTree, runtimePackageNames } from '../src/bun/profiles/profile-tree.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'dsh-profile-tree-'))

/** 在 profile 树里预置一条目录链接（父目录不存在时先补齐，createDirLink 不会自己建）。 */
function preLink(target: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true })
  createDirLink(target, dest)
}

/** lstat 视角的条目存在性（不跟随链接）：断言「链接没了」用。 */
function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** 造壳自管布局（<root>/runtimes/<ver>/node_modules）的两棵运行时树：当前版 + 旧版本。 */
function makeRuntimesLayout(): {
  runtimeModules: string
  oldRuntimeModules: string
  aiFoo: string
  oldFoo: string
  third: string
} {
  const root = tempDir()
  const runtimeModules = join(root, 'runtimes', '0.2.1-alpha.2', 'node_modules')
  const oldRuntimeModules = join(root, 'runtimes', '0.2.0-alpha.1', 'node_modules')
  const aiFoo = join(runtimeModules, '@deepseek-ai', 'foo')
  const third = join(runtimeModules, 'third-pkg')
  const oldFoo = join(oldRuntimeModules, '@deepseek-ai', 'foo')
  for (const dir of [aiFoo, third, oldFoo]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{}')
  }
  return { runtimeModules, oldRuntimeModules, aiFoo, oldFoo, third }
}

/** 造一棵运行时树：两个 @deepseek-ai/* 包 + 一个第三方包。 */
function makeRuntimeTree(): { runtimeModules: string; aiFoo: string; aiBar: string } {
  const runtimeModules = tempDir()
  const aiFoo = join(runtimeModules, '@deepseek-ai', 'foo')
  const aiBar = join(runtimeModules, '@deepseek-ai', 'bar')
  const third = join(runtimeModules, 'third-pkg')
  for (const dir of [aiFoo, aiBar, third]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{}')
  }
  return { runtimeModules, aiFoo, aiBar }
}

describe('runtimePackageNames', () => {
  test('收包名：scope 两段式、跳过点开头条目、排序稳定', () => {
    const { runtimeModules } = makeRuntimeTree()
    mkdirSync(join(runtimeModules, '.bin'), { recursive: true })
    const names = runtimePackageNames(runtimeModules)
    expect(names).toEqual(['@deepseek-ai/bar', '@deepseek-ai/foo', 'third-pkg'])
  })
})

describe('reconcileProfileTree（#1：坏 symlink 与 runtimeOwned 占位）', () => {
  test('全新 profile：运行时包全部新链，落点与指向正确', () => {
    const { runtimeModules, aiFoo } = makeRuntimeTree()
    const profileModules = tempDir()

    const result = reconcileProfileTree({ runtimeModules, profileModules })

    expect(result).toEqual({ linked: 3, repointed: 0, kept: 0 })
    const dest = join(profileModules, '@deepseek-ai', 'foo')
    expect(existsSync(dest)).toBe(true)
    expect(readlinkSync(dest)).toBe(aiFoo)
  })

  test('悬空（坏）symlink：先删后建，不再 EEXIST（根因 2）', () => {
    const { runtimeModules, aiFoo } = makeRuntimeTree()
    const profileModules = tempDir()
    const dest = join(profileModules, '@deepseek-ai', 'foo')
    // 指向不存在目标的链接：existsSync=false 但条目存在，旧实现会直接 createDirLink → EEXIST
    preLink(join(profileModules, 'no-such-target'), dest)

    const logs: string[] = []
    const result = reconcileProfileTree({ runtimeModules, profileModules, onLog: (l) => logs.push(l) })

    expect(result.repointed).toBe(1)
    expect(existsSync(dest)).toBe(true)
    expect(readlinkSync(dest)).toBe(aiFoo)
    expect(logs.join('\n')).not.toContain('EEXIST')
  })

  test('指向别处的 runtimeOwned symlink（旧壳残留形态）：重指到运行时树（根因 4）', () => {
    const oldShellTree = tempDir()
    const oldPkg = join(oldShellTree, 'com.arcreel.dsh-desktop-tauriapp', 'dsh-hook-protocol')
    mkdirSync(oldPkg, { recursive: true })
    const { runtimeModules, aiFoo } = makeRuntimeTree()
    const profileModules = tempDir()
    const dest = join(profileModules, '@deepseek-ai', 'foo')
    preLink(oldPkg, dest)

    const result = reconcileProfileTree({ runtimeModules, profileModules })

    expect(result.repointed).toBe(1)
    expect(readlinkSync(dest)).toBe(aiFoo)
  })

  test('runtimeOwned 被真目录占住：删掉换成运行时树链接（根因 3）', () => {
    const { runtimeModules, aiBar } = makeRuntimeTree()
    const profileModules = tempDir()
    const dest = join(profileModules, '@deepseek-ai', 'bar')
    mkdirSync(dest, { recursive: true })
    const staleFile = join(dest, 'stale.txt')
    writeFileSync(staleFile, 'old runtime copy')

    const result = reconcileProfileTree({ runtimeModules, profileModules })

    expect(result.repointed).toBe(1)
    expect(existsSync(staleFile)).toBe(false)
    expect(readlinkSync(dest)).toBe(aiBar)
  })

  test('第三方包真目录：按碰撞策略保留不动', () => {
    const { runtimeModules } = makeRuntimeTree()
    const profileModules = tempDir()
    const dest = join(profileModules, 'third-pkg')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'package.json'), '{"name":"third-pkg","version":"9.9.9"}')

    const result = reconcileProfileTree({ runtimeModules, profileModules })

    expect(result.kept).toBe(1)
    expect(readFileSync(join(dest, 'package.json'), 'utf8')).toContain('9.9.9')
    expect(lstatSync(dest).isSymbolicLink()).toBe(false)
  })

  test('悬空的第三方 symlink：删掉重指到运行时树（链接不是用户资产，真目录才是）', () => {
    const { runtimeModules } = makeRuntimeTree()
    const profileModules = tempDir()
    const dest = join(profileModules, 'third-pkg')
    preLink(join(profileModules, 'vanished-target'), dest)

    const result = reconcileProfileTree({ runtimeModules, profileModules })

    expect(result.repointed).toBe(1)
    expect(readlinkSync(dest)).toBe(join(runtimeModules, 'third-pkg'))
  })

  test('指向别处的第三方 symlink（旧壳残留形态）：同样删掉重指，不保留错链', () => {
    const { runtimeModules } = makeRuntimeTree()
    const profileModules = tempDir()
    const dest = join(profileModules, 'third-pkg')
    const stale = join(profileModules, 'old-shell-plugins')
    mkdirSync(stale, { recursive: true })
    preLink(stale, dest)
    const result = reconcileProfileTree({ runtimeModules, profileModules })
    expect(result.repointed).toBe(1)
    expect(readlinkSync(dest)).toBe(join(runtimeModules, 'third-pkg'))
  })

  test('指向正确的 runtimeOwned symlink：幂等保留，不重指不抖动', () => {
    const { runtimeModules, aiFoo } = makeRuntimeTree()
    const profileModules = tempDir()
    preLink(aiFoo, join(profileModules, '@deepseek-ai', 'foo'))
    const result = reconcileProfileTree({ runtimeModules, profileModules })

    // 关键是不重指：指向正确的链接不被抖动（repointed=0）；bar/third-pkg 本就不存在，按新链收。
    expect(result).toEqual({ linked: 2, repointed: 0, kept: 1 })
    expect(readlinkSync(join(profileModules, '@deepseek-ai', 'foo'))).toBe(aiFoo)
  })

  test('dirLinksEqual：相等为真；null 指向视为不等，走重指；大小写语义按平台', () => {
    expect(dirLinksEqual('/a/b', '/a/b')).toBe(true)
    expect(dirLinksEqual(null, '/a/b')).toBe(false)
    if (process.platform === 'win32') {
      // Windows 路径不区分大小写：大小写不同视为相等（防每次启动 rm+create 抖动）
      expect(dirLinksEqual('/a/b', '/a/B')).toBe(true)
    } else {
      // POSIX 严格比较：大小写不同就是不同文件
      expect(dirLinksEqual('/a/b', '/a/B')).toBe(false)
    }
  })
})


describe('pruneLegacyPoolLinks（#13 迁移：清 per-profile 池的壳遗留运行时链接）', () => {
  test('指当前运行时树的壳遗留链接：清掉（近者优会遮蔽共享层）', () => {
    const { aiFoo } = makeRuntimesLayout()
    const pool = tempDir()
    const dest = join(pool, '@deepseek-ai', 'foo')
    preLink(aiFoo, dest)

    const result = pruneLegacyPoolLinks({ poolModules: pool })

    expect(result).toEqual({ removed: 1, kept: 0 })
    expect(entryExists(dest)).toBe(false)
  })

  test('指同根旧版本运行时树：同样清掉（切版本后的错配根源）', () => {
    const { oldFoo } = makeRuntimesLayout()
    const pool = tempDir()
    const dest = join(pool, '@deepseek-ai', 'foo')
    preLink(oldFoo, dest)

    const result = pruneLegacyPoolLinks({ poolModules: pool })

    expect(result.removed).toBe(1)
    expect(entryExists(dest)).toBe(false)
  })

  test('悬空残骸（运行时已卸载）：清掉', () => {
    makeRuntimesLayout()
    const pool = tempDir()
    const dest = join(pool, '@deepseek-ai', 'foo')
    preLink(join(tempDir(), 'vanished-runtime', 'node_modules', '@deepseek-ai', 'foo'), dest)

    const result = pruneLegacyPoolLinks({ poolModules: pool })

    expect(result.removed).toBe(1)
    expect(entryExists(dest)).toBe(false)
  })

  test('pnpm 自有链接（指 profile 自身 .pnpm store）：保留', () => {
    makeRuntimesLayout()
    const pool = tempDir()
    const store = join(pool, '.pnpm', '@deepseek-ai+foo@9.9.9', 'node_modules', '@deepseek-ai', 'foo')
    mkdirSync(store, { recursive: true })
    const dest = join(pool, '@deepseek-ai', 'foo')
    preLink(store, dest)

    const result = pruneLegacyPoolLinks({ poolModules: pool })

    expect(result).toEqual({ removed: 0, kept: 1 })
    expect(entryExists(dest)).toBe(true)
    expect(readlinkSync(dest)).toBe(store)
  })

  test('指向池自身的悬空链接（pnpm store 半装）：保留，不代劳', () => {
    makeRuntimesLayout()
    const pool = tempDir()
    const store = join(pool, '.pnpm', '@deepseek-ai+foo@9.9.9', 'node_modules', '@deepseek-ai', 'foo')
    const dest = join(pool, '@deepseek-ai', 'foo')
    preLink(store, dest)
    const result = pruneLegacyPoolLinks({ poolModules: pool })
    expect(result).toEqual({ removed: 0, kept: 1 })
    expect(entryExists(dest)).toBe(true)
  })

  test('真目录（用户/pnpm 资产）：不动', () => {
    makeRuntimesLayout()
    const pool = tempDir()
    const dest = join(pool, '@deepseek-ai', 'foo')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'package.json'), '{"name":"@deepseek-ai/foo","version":"9.9.9"}')

    const result = pruneLegacyPoolLinks({ poolModules: pool })

    expect(result).toEqual({ removed: 0, kept: 1 })
    expect(readFileSync(join(dest, 'package.json'), 'utf8')).toContain('9.9.9')
  })

  test('陌生指向（外部 CLI 树、非 node_modules 形态）：保守保留不猜布局', () => {
    makeRuntimesLayout()
    const pool = tempDir()
    const devPkg = join(tempDir(), 'somewhere', 'dsh-checkout')
    mkdirSync(devPkg, { recursive: true })
    const dest = join(pool, '@deepseek-ai', 'foo')
    preLink(devPkg, dest)

    const result = pruneLegacyPoolLinks({ poolModules: pool })

    expect(result).toEqual({ removed: 0, kept: 1 })
    expect(entryExists(dest)).toBe(true)
  })

  test('池不存在（新机器/新 profile）：返回零值不抛', () => {
    makeRuntimesLayout()
    const result = pruneLegacyPoolLinks({ poolModules: join(tempDir(), 'nope') })
    expect(result).toEqual({ removed: 0, kept: 0 })
  })

  test('scope 外的条目不碰：清理只作用于 @deepseek-ai', () => {
    const { oldRuntimeModules } = makeRuntimesLayout()
    const pool = tempDir()
    const dest = join(pool, 'dsh-web-mobile')
    preLink(join(oldRuntimeModules, 'dsh-web-mobile'), dest)

    const result = pruneLegacyPoolLinks({ poolModules: pool })

    expect(result).toEqual({ removed: 0, kept: 0 })
    expect(entryExists(dest)).toBe(true)
  })
})

describe('reconcileProfileRuntimeTree（#13 共享池落点 + 迁移）', () => {
  test('共享池里旧壳遗留的陈旧链接（指 App 包内树）：重指到当前运行时树', () => {
    const { runtimeModules, aiFoo } = makeRuntimesLayout()
    const home = tempDir()
    const appFoo = join(tempDir(), 'DeepSeek.app', 'Contents', 'Resources', 'dsh', 'node_modules', '@deepseek-ai', 'foo')
    mkdirSync(appFoo, { recursive: true })
    const dest = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'foo')
    preLink(appFoo, dest)
    reconcileProfileRuntimeTree({ home, profile: 'desktop', runtimeModules })
    expect(readlinkSync(dest)).toBe(aiFoo)
  })

  test('落点：链接进 <home>/profiles/node_modules；per-profile 壳遗留链接被清、用户资产不动', () => {
    const { runtimeModules, aiFoo } = makeRuntimesLayout()
    const home = tempDir()
    const profileModules = join(home, 'profiles', 'desktop', 'node_modules')
    const legacy = join(profileModules, '@deepseek-ai', 'foo')
    preLink(aiFoo, legacy)
    const userDir = join(profileModules, 'third-pkg')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'package.json'), '{"name":"third-pkg","version":"1.0.0"}')

    const result = reconcileProfileRuntimeTree({ home, profile: 'desktop', runtimeModules })

    const sharedDest = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'foo')
    expect(result.shared.linked).toBe(2)
    expect(existsSync(sharedDest)).toBe(true)
    expect(readlinkSync(sharedDest)).toBe(aiFoo)
    expect(result.pruned.removed).toBe(1)
    expect(entryExists(legacy)).toBe(false)
    expect(lstatSync(userDir).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(userDir, 'package.json'), 'utf8')).toContain('"version":"1.0.0"')
  })

  test('重入不抖动；切运行时版本后共享池整体重指，per-profile 池保持干净', () => {
    const { runtimeModules, oldRuntimeModules, oldFoo } = makeRuntimesLayout()
    const home = tempDir()
    const sharedDest = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'foo')

    const first = reconcileProfileRuntimeTree({ home, profile: 'web', runtimeModules })
    expect(first.shared.linked).toBe(2)

    const again = reconcileProfileRuntimeTree({ home, profile: 'web', runtimeModules })
    expect(again.shared).toEqual({ linked: 0, repointed: 0, kept: 2 })
    expect(again.pruned.removed).toBe(0)

    const switched = reconcileProfileRuntimeTree({ home, profile: 'web', runtimeModules: oldRuntimeModules })
    expect(switched.shared.repointed).toBe(1)
    expect(readlinkSync(sharedDest)).toBe(oldFoo)
  })

  test('两个 profile 先后启动：共享池只有一份链接，第二份不再复制', () => {
    const { runtimeModules } = makeRuntimesLayout()
    const home = tempDir()
    reconcileProfileRuntimeTree({ home, profile: 'web', runtimeModules })

    const second = reconcileProfileRuntimeTree({ home, profile: 'desktop', runtimeModules })

    expect(second.shared.linked).toBe(0)
    expect(second.shared.kept).toBe(2)
    expect(second.pruned.removed).toBe(0)
  })
})
