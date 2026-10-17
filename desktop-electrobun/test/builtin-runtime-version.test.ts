// 内置运行时物化树版本闸（#68）：
// 声明（builtin-runtime.json）升级后，仓内 gitignore 的 builtin-runtime/ 不会自动跟着变；
// 这里用真 bun 跑 scripts/verify-builtin-runtime.mjs，验证「不一致就 fail、一致才放行」。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  DECLARATION_FILE,
  readBuiltinRuntimeDeclaration,
} from '../src/shared/builtin-runtime.ts'

const projectRoot = resolve(import.meta.dir, '..')
const tree = join(projectRoot, 'builtin-runtime')
const treePresent = existsSync(join(tree, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
const declared = readBuiltinRuntimeDeclaration(join(projectRoot, DECLARATION_FILE))
if (declared === null) throw new Error(`读不出来 ${DECLARATION_FILE}，测试无法继续`)

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-builtin-guard-'))
  roots.push(dir)
  return dir
}

/** 造一棵最小可校验树：dsh 的 package.json/bin.js + pnpm 的 package.json/pnpm.cjs。 */
function writeTree(dir: string, dsh: string, pnpm: string): void {
  const dshDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(dshDir, 'lib'), { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: dsh }))
  writeFileSync(join(dshDir, 'lib', 'bin.js'), '// fixture\n')
  const pnpmDir = join(dir, 'node_modules', 'pnpm')
  mkdirSync(join(pnpmDir, 'bin'), { recursive: true })
  writeFileSync(join(pnpmDir, 'package.json'), JSON.stringify({ name: 'pnpm', version: pnpm }))
  writeFileSync(join(pnpmDir, 'bin', 'pnpm.cjs'), '// fixture\n')
}

function runGuard(explicitDir?: string): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env }
  if (explicitDir === undefined) delete env.DSH_SHELL_BUILTIN_DIR
  else env.DSH_SHELL_BUILTIN_DIR = explicitDir
  const result = spawnSync(process.execPath, ['scripts/verify-builtin-runtime.mjs'], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('内置运行时物化树版本闸', () => {
  test('声明版本与物化树一致→放行', () => {
    if (treePresent) {
      expect(runGuard().status).toBe(0)
      return
    }
    const dir = tempTree()
    writeTree(dir, declared.dsh, declared.pnpm)
    const result = runGuard(dir)
    expect(result.status).toBe(0)
  })

  test('物化树版本落后（alpha.2 vs 声明 rc.2）→ fail 并把差异写进 stderr', () => {
    const dir = tempTree()
    writeTree(dir, '0.2.1-alpha.2', declared.pnpm)
    const result = runGuard(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('物化树与')
    expect(result.stderr).toContain('dsh 版本不符')
    expect(result.stderr).toContain('0.2.1-alpha.2')
    expect(result.stderr).toContain(declared.dsh)
  })

  test('pnpm 版本不符同样 fail', () => {
    const dir = tempTree()
    writeTree(dir, declared.dsh, '0.0.0')
    const result = runGuard(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('pnpm 版本不符')
  })

  test('显式 DSH_SHELL_BUILTIN_DIR 指向缺失的树→直接失败，不静默回退', () => {
    const result = runGuard(join(tempTree(), 'missing'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('不存在')
  })
})
