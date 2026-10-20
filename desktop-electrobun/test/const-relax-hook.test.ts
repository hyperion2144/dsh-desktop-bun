// Patch 17 回归测试：第三方插件的 const 重赋值在 Bun 转译期整条死掉 → 加载时放宽成 let。
//
// 病根形态照抄 dsh-cost-meter 1.9.13 的真实代码（lib/index.js）：
//   const patch = { ... }; patch = { ...patch, ... };
// Bun 在转译期就拒绝生成该模块（BuildMessage: This assignment will throw because "patch" is
// a constant）→ 插件入口 import 失败 → app-boot 记 failed → "1 entry did not activate"。
//
// 做法：造一棵假 profile（package.json + node_modules/<插件包>），用真 bun 跑
// `bun --no-install --preload <preload> <probe>`，DSH_PROFILE_DIR 指到假 profile：
//   · ESM 插件包带这个雷 → 模块能加载（没有 Patch 17 时整条死掉）；
//   · CJS 插件包 → 不被接管（Bun 的 onLoad 不能拒绝接管，硬接管会把 CJS 悄悄读成 ESM）；
//   · 干净的 ESM 插件包 → 正常加载，内容一字不改。
//
// 注意：子进程的 cwd / argv[1] 都在临时目录里 —— 兼容层会顺着这两条往上找 node_modules，
// 否则它可能摸到仓库自己的树。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

const projectRoot = resolve(import.meta.dir, '..')
const preloadPath = resolve(projectRoot, '..', 'resources', 'dsh', 'bun-preload.mjs')

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface PackageSpec {
  /** package.json 的 "type"：module=ESM（会被接管），commonjs=CJS（不该被接管） */
  type: 'module' | 'commonjs'
  /** 相对包根的文件 */
  files: Record<string, string>
}

/** 造一棵假 profile：package.json 的 dependencies 列出这些插件包。 */
function fakeProfile(packages: Record<string, PackageSpec>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-const-relax-'))
  roots.push(dir)
  const dependencies: Record<string, string> = {}
  for (const name of Object.keys(packages)) dependencies[name] = '1.0.0'
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'fake-profile', private: true, dependencies }, null, 2)}\n`,
  )
  for (const [name, spec] of Object.entries(packages)) {
    const packageDir = join(dir, 'node_modules', name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(
      join(packageDir, 'package.json'),
      `${JSON.stringify({ name, version: '1.0.0', type: spec.type, main: 'index.js' }, null, 2)}\n`,
    )
    for (const [file, content] of Object.entries(spec.files)) {
      const target = join(packageDir, file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
  }
  return dir
}

interface ProbeResult {
  code: number
  stdout: string
  stderr: string
}

/** 用真 bun 跑探针脚本（可带 --preload）。 */
function runProbe(script: string, options: { profileDir?: string; preload?: boolean; env?: Record<string, string> } = {}): ProbeResult {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-const-relax-probe-'))
  roots.push(dir)
  const scriptPath = join(dir, 'probe.mjs')
  writeFileSync(scriptPath, script)
  const args = [process.execPath, '--no-install']
  if (options.preload !== false) args.push('--preload', preloadPath)
  args.push(scriptPath)
  const proc = Bun.spawnSync({
    cmd: args,
    cwd: dir,
    env: {
      ...process.env,
      // 兼容层的落盘补丁找不到目标树（假 profile 的树是空的）。
      DSH_BUN_PRELOAD_TREES: join(dir, 'empty-tree'),
      ...(options.profileDir === undefined ? {} : { DSH_PROFILE_DIR: options.profileDir }),
      ...(options.env ?? {}),
    },
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

/** 带雷的插件源码（dsh-cost-meter 1.9.13 的真实形态）。 */
const BUGGY_MODULE = [
  'export function build(rates) {',
  '  const patch = { currency: "USD", amount: 1 };',
  '  patch = { ...patch, exchangeRate: rates[patch.currency] ?? patch.exchangeRate };',
  '  return patch;',
  '}',
  '',
].join('\n')

/** 干净的 ESM 模块。 */
const CLEAN_MODULE = [
  'export const answer = 42;',
  'export function twice(value) {',
  '  return value * 2;',
  '}',
  '',
].join('\n')

/** CJS 模块（type: commonjs）：Bun 的 onLoad 一旦接管就会按 ESM 读，module.exports 会丢。 */
const CJS_MODULE = [
  'const fs = require("node:fs");',
  'module.exports = { tag: "cjs", hasFs: typeof fs.readFileSync === "function" };',
  '',
].join('\n')

describe('Patch 17：第三方插件的 const 重赋值在加载时被放宽为 let', () => {
  test('ESM 插件包带雷时，模块能加载（没有这个补丁时是 BuildMessage 整条死掉）', () => {
    const profileDir = fakeProfile({ 'buggy-plugin': { type: 'module', files: { 'index.js': BUGGY_MODULE } } })
    const result = runProbe(
      [
        `const mod = await import(${JSON.stringify(join(profileDir, 'node_modules', 'buggy-plugin', 'index.js'))})`,
        'console.log("PROBE-OK " + JSON.stringify(mod.build({ USD: 7 })))',
        '',
      ].join('\n'),
      { profileDir },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('PROBE-OK {"currency":"USD","amount":1,"exchangeRate":7}')
    // 放宽动作要留痕（哪个绑定、放宽了哪个文件）。
    expect(result.stderr).toContain('const 放宽为 let')
    expect(result.stderr).toContain('patch')
  })

  test('对照：不带 preload 时同一个插件就是转译期死掉（证明补丁真的在做事）', () => {
    const profileDir = fakeProfile({ 'buggy-plugin': { type: 'module', files: { 'index.js': BUGGY_MODULE } } })
    const result = runProbe(
      [
        `const mod = await import(${JSON.stringify(join(profileDir, 'node_modules', 'buggy-plugin', 'index.js'))})`,
        'console.log("PROBE-OK")',
        '',
      ].join('\n'),
      { profileDir, preload: false },
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('This assignment will throw because "patch" is a constant')
  })

  test('CJS 插件包不被接管：module.exports 原样拿得到', () => {
    const profileDir = fakeProfile({ 'cjs-plugin': { type: 'commonjs', files: { 'index.js': CJS_MODULE } } })
    const result = runProbe(
      [
        `const mod = require(${JSON.stringify(join(profileDir, 'node_modules', 'cjs-plugin', 'index.js'))})`,
        'console.log("PROBE-OK " + JSON.stringify(mod))',
        '',
      ].join('\n'),
      { profileDir },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('PROBE-OK {"tag":"cjs","hasFs":true}')
  })

  test('干净的 ESM 插件包正常加载，内容一字不改', () => {
    const profileDir = fakeProfile({ 'clean-plugin': { type: 'module', files: { 'index.js': CLEAN_MODULE } } })
    const result = runProbe(
      [
        `const mod = await import(${JSON.stringify(join(profileDir, 'node_modules', 'clean-plugin', 'index.js'))})`,
        'console.log("PROBE-OK " + mod.answer + " " + mod.twice(21))',
        '',
      ].join('\n'),
      { profileDir },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('PROBE-OK 42 42')
    expect(result.stderr).not.toContain('const 放宽为 let')
  })

  test('插件包自己的依赖（多为 CJS）不被接管', () => {
    const profileDir = fakeProfile({ 'host-plugin': { type: 'module', files: { 'index.js': CLEAN_MODULE } } })
    const nested = join(profileDir, 'node_modules', 'host-plugin', 'node_modules', 'cjs-dep')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'package.json'), `${JSON.stringify({ name: 'cjs-dep', version: '1.0.0', type: 'commonjs', main: 'index.js' })}\n`)
    writeFileSync(join(nested, 'index.js'), CJS_MODULE)
    const result = runProbe(
      [
        `const mod = require(${JSON.stringify(join(nested, 'index.js'))})`,
        'console.log("PROBE-OK " + JSON.stringify(mod))',
        '',
      ].join('\n'),
      { profileDir },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('PROBE-OK {"tag":"cjs","hasFs":true}')
  })

  test('ESM 插件包里的 .cjs 文件不被接管（onLoad 交回的内容一律按 ESM 读，会悄悄弄坏 CJS）', () => {
    const profileDir = fakeProfile({
      'esm-plugin': { type: 'module', files: { 'index.js': CLEAN_MODULE, 'legacy.cjs': CJS_MODULE } },
    })
    const legacy = join(profileDir, 'node_modules', 'esm-plugin', 'legacy.cjs')
    const result = runProbe(
      [
        `const mod = require(${JSON.stringify(legacy)})`,
        'console.log("PROBE-OK " + JSON.stringify(mod))',
        '',
      ].join('\n'),
      { profileDir },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('PROBE-OK {"tag":"cjs","hasFs":true}')
  })

  test('逃生开关：DSH_SHELL_PRELOAD_RELAX_CONST=0 时不接管（插件照旧死掉）', () => {
    const profileDir = fakeProfile({ 'buggy-plugin': { type: 'module', files: { 'index.js': BUGGY_MODULE } } })
    const result = runProbe(
      [
        `const mod = await import(${JSON.stringify(join(profileDir, 'node_modules', 'buggy-plugin', 'index.js'))})`,
        'console.log("PROBE-OK")',
        '',
      ].join('\n'),
      { profileDir, env: { DSH_SHELL_PRELOAD_RELAX_CONST: '0' } },
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('This assignment will throw because "patch" is a constant')
  })

  test('没有 DSH_PROFILE_DIR 时不装钩子（dsh 命令行等场景零影响）', () => {
    const result = runProbe(
      ['console.log("PROBE-OK")', ''].join('\n'),
      { preload: true, env: { DSH_PROFILE_DIR: '' } },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('PROBE-OK')
  })

  test('宿主起来之后才装上的插件也在作用域内（作用域变化后重新装过滤器）', () => {
    // 起手是空作用域：探针脚本自己把插件装进 profile，再等钩子发现作用域变了。
    const profileDir = fakeProfile({})
    const result = runProbe(
      [
        "import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        `const profileDir = ${JSON.stringify(profileDir)}`,
        "const packageDir = join(profileDir, 'node_modules', 'late-plugin')",
        "mkdirSync(packageDir, { recursive: true })",
        `writeFileSync(join(packageDir, 'package.json'), ${JSON.stringify(JSON.stringify({ name: 'late-plugin', version: '1.0.0', type: 'module', main: 'index.js' }))})`,
        `writeFileSync(join(packageDir, 'index.js'), ${JSON.stringify(BUGGY_MODULE)})`,
        "const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))",
        "manifest.dependencies['late-plugin'] = '1.0.0'",
        "writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\\n')",
        'await new Promise((resolve) => setTimeout(resolve, 800))',
        "const mod = await import(join(packageDir, 'index.js'))",
        'console.log("PROBE-OK " + JSON.stringify(mod.build({ USD: 7 })))',
        '',
      ].join('\n'),
      { profileDir, env: { DSH_SHELL_PRELOAD_RELAX_SCOPE_MS: '100' } },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('PROBE-OK {"currency":"USD","amount":1,"exchangeRate":7}')
    expect(result.stderr).toContain('const 放宽为 let')
  })

  test('宿主起来之后才装上的插件：靠目录监听即时接管（轮询兜底调到 60s 也不影响）', () => {
    // 装插件会改 profile 的 manifest 与 node_modules 顶层目录 → 监听器一到就重算作用域，
    // 不等轮询（轮询间隔调到 60s 验证这一点）。
    const profileDir = fakeProfile({})
    const result = runProbe(
      [
        "import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        `const profileDir = ${JSON.stringify(profileDir)}`,
        "const packageDir = join(profileDir, 'node_modules', 'late-plugin')",
        "mkdirSync(packageDir, { recursive: true })",
        `writeFileSync(join(packageDir, 'package.json'), ${JSON.stringify(JSON.stringify({ name: 'late-plugin', version: '1.0.0', type: 'module', main: 'index.js' }))})`,
        `writeFileSync(join(packageDir, 'index.js'), ${JSON.stringify(BUGGY_MODULE)})`,
        "const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))",
        "manifest.dependencies['late-plugin'] = '1.0.0'",
        "writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\\n')",
        'await new Promise((resolve) => setTimeout(resolve, 800))',
        "const mod = await import(join(packageDir, 'index.js'))",
        'console.log("PROBE-OK " + JSON.stringify(mod.build({ USD: 7 })))',
        '',
      ].join('\n'),
      { profileDir, env: { DSH_SHELL_PRELOAD_RELAX_SCOPE_MS: '60000' } },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('PROBE-OK {"currency":"USD","amount":1,"exchangeRate":7}')
    expect(result.stderr).toContain('const 放宽为 let')
  })

  test('清单已登记、包还没落地（pnpm 正在装）→ 也在作用域里：装完即生效，不等重启', () => {
    // 真实时序：pnpm 先把依赖写进清单，包随后才落到 node_modules；插件管理器的重组合
    // （import 插件）发生在装完之后 → 过滤器必须已经覆盖这个包，否则那次 import 直接死。
    const profileDir = fakeProfile({})
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies['mid-install-plugin'] = '1.0.0'
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const result = runProbe(
      [
        "import { mkdirSync, writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        `const profileDir = ${JSON.stringify(profileDir)}`,
        "const packageDir = join(profileDir, 'node_modules', 'mid-install-plugin')",
        "mkdirSync(packageDir, { recursive: true })",
        `writeFileSync(join(packageDir, 'package.json'), ${JSON.stringify(JSON.stringify({ name: 'mid-install-plugin', version: '1.0.0', type: 'module', main: 'index.js' }))})`,
        `writeFileSync(join(packageDir, 'index.js'), ${JSON.stringify(BUGGY_MODULE)})`,
        "const mod = await import(join(packageDir, 'index.js'))",
        'console.log("PROBE-OK " + JSON.stringify(mod.build({ USD: 7 })))',
        '',
      ].join('\n'),
      { profileDir },
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('PROBE-OK {"currency":"USD","amount":1,"exchangeRate":7}')
    expect(result.stderr).toContain('const 放宽为 let')
  })
})
