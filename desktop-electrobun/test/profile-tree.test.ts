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

import { createDirLink } from '../src/shared/dir-link.ts'
import { dirLinksEqual, reconcileProfileTree, runtimePackageNames } from '../src/bun/profile-tree.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'dsh-profile-tree-'))

/** 在 profile 树里预置一条目录链接（父目录不存在时先补齐，createDirLink 不会自己建）。 */
function preLink(target: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true })
  createDirLink(target, dest)
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
