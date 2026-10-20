// 内置运行时声明与校验的单测（#16）：解析边界、树校验逐项 problems、来源计划。
// 树校验走桩 io（不碰磁盘），另补一组真实临时目录的全链路用例兜底。

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dshVersionFromPackageJson,
  parseBuiltinRuntimeDeclaration,
  planBuiltinSource,
  readBuiltinRuntimeDeclaration,
  verifyBuiltinTree,
  type BuiltinIo,
} from '../src/shared/runtime/builtin-runtime.ts'

const DECLARED = { dsh: '0.2.1-alpha.2', pnpm: '11.16.0' }

/** 桩 io：按路径表提供文件内容；值 null 表示存在但读不出；未登记的路径不存在。 */
function stubIo(entries: Record<string, string | null>): BuiltinIo {
  return {
    exists: (path) => Object.prototype.hasOwnProperty.call(entries, path),
    readText: (path) => {
      const value = entries[path]
      if (value === null || value === undefined) throw new Error(`ENOENT: ${path}`)
      return value
    },
  }
}

const dshPkgJson = (version: string): string => JSON.stringify({ name: '@deepseek-ai/dsh', version })
const pnpmPkgJson = (version: string): string => JSON.stringify({ name: 'pnpm', version })

/** 一棵与声明一致的树（路径前缀 root 由调用方定）。 */
function declaredTree(root: string): Record<string, string | null> {
  return {
    [join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')]: dshPkgJson(DECLARED.dsh),
    [join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]: '// bin',
    [join(root, 'node_modules', 'pnpm', 'package.json')]: pnpmPkgJson(DECLARED.pnpm),
    [join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')]: '// pnpm',
  }
}

describe('parseBuiltinRuntimeDeclaration', () => {
  test('合法声明', () => {
    expect(parseBuiltinRuntimeDeclaration(JSON.stringify(DECLARED))).toEqual(DECLARED)
  })

  test('坏 JSON / 数组 / 标量 → null', () => {
    expect(parseBuiltinRuntimeDeclaration('{')).toBeNull()
    expect(parseBuiltinRuntimeDeclaration('[]')).toBeNull()
    expect(parseBuiltinRuntimeDeclaration('42')).toBeNull()
    expect(parseBuiltinRuntimeDeclaration('null')).toBeNull()
  })

  test('字段缺失或版本不合法 → null（「latest」不是声明）', () => {
    expect(parseBuiltinRuntimeDeclaration('{"dsh":"0.2.1-alpha.2"}')).toBeNull()
    expect(parseBuiltinRuntimeDeclaration('{"pnpm":"11.16.0"}')).toBeNull()
    expect(parseBuiltinRuntimeDeclaration('{"dsh":"latest","pnpm":"11.16.0"}')).toBeNull()
    expect(parseBuiltinRuntimeDeclaration('{"dsh":1,"pnpm":"11.16.0"}')).toBeNull()
  })
})

describe('readBuiltinRuntimeDeclaration', () => {
  test('读得到就解析；读不到（文件缺失）返回 null 不抛', () => {
    const io = stubIo({ '/x/builtin-runtime.json': JSON.stringify(DECLARED) })
    expect(readBuiltinRuntimeDeclaration('/x/builtin-runtime.json', io)).toEqual(DECLARED)
    expect(readBuiltinRuntimeDeclaration('/x/missing.json', io)).toBeNull()
  })
})

describe('verifyBuiltinTree', () => {
  test('与声明一致的树 → ok', () => {
    const state = verifyBuiltinTree('/tree', DECLARED, stubIo(declaredTree('/tree')))
    expect(state.ok).toBe(true)
    expect(state.problems).toEqual([])
    expect(state.dshVersion).toBe(DECLARED.dsh)
    expect(state.pnpmVersion).toBe(DECLARED.pnpm)
  })

  test('dsh 版本漂移 → 不 ok，报「版本不符」', () => {
    const entries = declaredTree('/tree')
    entries[join('/tree', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')] = dshPkgJson('0.2.1-alpha.3')
    const state = verifyBuiltinTree('/tree', DECLARED, stubIo(entries))
    expect(state.ok).toBe(false)
    expect(state.problems.some((problem) => problem.includes('dsh 版本不符') && problem.includes('0.2.1-alpha.3'))).toBe(true)
  })

  test('缺 bin.js → 不 ok（不是可用运行时树）', () => {
    const entries = declaredTree('/tree')
    delete entries[join('/tree', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]
    const state = verifyBuiltinTree('/tree', DECLARED, stubIo(entries))
    expect(state.ok).toBe(false)
    expect(state.problems.some((problem) => problem.includes('bin.js'))).toBe(true)
  })

  test('缺 pnpm / pnpm 版本漂移 → 不 ok（壳的下载通道依赖它）', () => {
    const missing = declaredTree('/tree')
    delete missing[join('/tree', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')]
    expect(verifyBuiltinTree('/tree', DECLARED, stubIo(missing)).problems.some((problem) => problem.includes('pnpm'))).toBe(true)

    const drifted = declaredTree('/tree')
    drifted[join('/tree', 'node_modules', 'pnpm', 'package.json')] = pnpmPkgJson('11.15.0')
    const state = verifyBuiltinTree('/tree', DECLARED, stubIo(drifted))
    expect(state.problems.some((problem) => problem.includes('pnpm 版本不符') && problem.includes('11.15.0'))).toBe(true)
  })

  test('package.json 损坏 → 报「读不出版本号」而不是抛', () => {
    const entries = declaredTree('/tree')
    entries[join('/tree', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')] = null
    const state = verifyBuiltinTree('/tree', DECLARED, stubIo(entries))
    expect(state.ok).toBe(false)
    expect(state.problems.some((problem) => problem.includes('读不出版本号'))).toBe(true)
  })

  test('空目录 → dsh 与 pnpm 两条问题都在', () => {
    const state = verifyBuiltinTree('/tree', DECLARED, stubIo({}))
    expect(state.ok).toBe(false)
    expect(state.problems).toHaveLength(2)
  })
})

describe('planBuiltinSource', () => {
  test('目标树已是声明版本 → reuse', () => {
    expect(planBuiltinSource({ targetReady: true, force: false }).kind).toBe('reuse')
  })

  test('force 或树不可用 → download', () => {
    expect(planBuiltinSource({ targetReady: true, force: true }).kind).toBe('download')
    expect(planBuiltinSource({ targetReady: false, force: false }).kind).toBe('download')
  })

  test('DSH_SHELL_BUILTIN_SOURCE 一旦设置就强制 external（哪怕目标树可用）', () => {
    const plan = planBuiltinSource({ envSource: '/somewhere/tree', targetReady: true, force: false })
    expect(plan).toEqual({ kind: 'external', dir: '/somewhere/tree' })
  })

  test('env 为空白等同未设置', () => {
    expect(planBuiltinSource({ envSource: '   ', targetReady: true, force: false }).kind).toBe('reuse')
    expect(planBuiltinSource({ envSource: '', targetReady: false, force: false }).kind).toBe('download')
  })
})

describe('dshVersionFromPackageJson', () => {
  test('正常 / 无 version / 坏 JSON', () => {
    expect(dshVersionFromPackageJson(dshPkgJson('0.2.1-alpha.2'))).toBe('0.2.1-alpha.2')
    expect(dshVersionFromPackageJson('{"name":"@deepseek-ai/dsh"}')).toBeNull()
    expect(dshVersionFromPackageJson('nope')).toBeNull()
  })
})

describe('真实临时目录全链路', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-builtin-runtime-'))

  test('写出声明与树，默认 io 读回并通过校验；改声明后校验失败', () => {
    mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pnpm', 'bin'), { recursive: true })
    try {
      writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), dshPkgJson(DECLARED.dsh))
      writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// bin')
      writeFileSync(join(root, 'node_modules', 'pnpm', 'package.json'), pnpmPkgJson(DECLARED.pnpm))
      writeFileSync(join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '// pnpm')

      const declarationPath = join(root, 'builtin-runtime.json')
      writeFileSync(declarationPath, `${JSON.stringify(DECLARED, null, 2)}\n`)
      const declared = readBuiltinRuntimeDeclaration(declarationPath)
      expect(declared).toEqual(DECLARED)
      expect(verifyBuiltinTree(root, DECLARED).ok).toBe(true)

      // 声明改成 9.9.9 → 同一棵树不再通过校验
      expect(verifyBuiltinTree(root, { dsh: '9.9.9', pnpm: DECLARED.pnpm }).ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
