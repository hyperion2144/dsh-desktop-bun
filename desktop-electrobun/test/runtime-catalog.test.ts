// 运行时目录与选中：纯逻辑（版本比较 / 目录载荷解析 / 清单）+ IO（扫描 / 回收站）。
//
// 对应旧壳 desktop/src-tauri/src/runtime/registry.rs 与 builtin.rs 的测试面：
// 版本号大小（alpha.10 > alpha.2）、渠道标注、坏 JSON 不炸、目录扫描只认有效树、
// 卸载先入回收站、显式覆盖（root / 包根两种布局）。

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  compareRuntimeVersions,
  mergeInstalled,
  parseCliVersion,
  parseGithubCatalog,
  parseInstalledManifest,
  parseNpmCatalog,
  removeInstalledEntry,
  runtimeChannel,
  selectRuntimeVersion,
  serializeInstalledManifest,
  sortRuntimeVersionsDesc,
  upsertInstalled,
  type InstalledRuntime,
} from '../src/shared/runtime/runtime-catalog.ts'
import {
  fetchRuntimeCatalog,
  installedManifestPath,
  isRuntimeTreeValid,
  listInstalledRuntimes,
  purgeRuntimeTrash,
  readInstalledManifest,
  readRuntimeVersion,
  recordInstalledRuntime,
  runtimeDirOf,
  runtimeTrashDir,
  scanInstalledVersions,
  trashInstalledRuntime,
  writeInstalledManifest,
} from '../src/bun/runtime/runtime-store.ts'
import {
  packagedResourcesFromLauncher,
  packagedResourcesFromProcess,
  packagedRootFromLauncher,
  packagedRootFromProcess,
  resolveLauncherExecutablePath,
  resolveRuntimeSelection,
  runtimePathsOf,
} from '../src/bun/runtime/runtime.ts'

const tempDirs: string[] = []

function tempDir(prefix = 'dsh-rt-'): string {
  // macOS 的 /tmp 是指向 /private/tmp 的软链：先 realpath，免得与 realpathSync 的结果不一致
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/** 造一棵「有效」运行时树：node_modules/@deepseek-ai/dsh/{lib/bin.js,package.json}。 */
function makeRuntimeTree(root: string, version: string): string {
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'lib', 'bin.js'), '// stub\n')
  writeFileSync(join(pkg, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version })}\n`)
  const dist = join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<div id="root"></div>\n')
  return root
}

describe('版本比较与排序', () => {
  test('预发布段按数值比：alpha.10 > alpha.2（旧壳 #95 踩过的坑）', () => {
    expect(compareRuntimeVersions('0.2.1-alpha.10', '0.2.1-alpha.2')).toBe(1)
    expect(compareRuntimeVersions('0.2.1-alpha.2', '0.2.1-alpha.10')).toBe(-1)
    expect(compareRuntimeVersions('0.2.1-alpha.2', '0.2.1-alpha.2')).toBe(0)
  })

  test('预发布 < 正式；核心段按数值', () => {
    expect(compareRuntimeVersions('0.2.1-alpha.2', '0.2.1-rc.1')).toBe(-1)
    expect(compareRuntimeVersions('0.2.1-rc.1', '0.2.1')).toBe(-1)
    expect(compareRuntimeVersions('0.10.0', '0.9.9')).toBe(1)
  })

  test('排序取降序，非版本号不参与破坏', () => {
    expect(sortRuntimeVersionsDesc(['0.2.0', '0.2.1-alpha.2', '0.2.1-alpha.10', '0.1.9'])).toEqual([
      '0.2.1-alpha.10',
      '0.2.1-alpha.2',
      '0.2.0',
      '0.1.9',
    ])
  })
})

describe('渠道标注', () => {
  test('dist-tag 命中优先，否则按预发布段猜', () => {
    expect(runtimeChannel('0.2.1', { latest: '0.2.1' })).toBe('latest')
    expect(runtimeChannel('0.2.1-alpha.2', { alpha: '0.2.1-alpha.2' })).toBe('alpha')
    expect(runtimeChannel('0.2.1-rc.1', { rc: '0.2.1-rc.1' })).toBe('rc')
    expect(runtimeChannel('0.1.7-rc.2')).toBe('rc')
    expect(runtimeChannel('0.2.1-alpha.2')).toBe('alpha')
    expect(runtimeChannel('0.2.1')).toBe('')
  })
})

describe('目录载荷解析', () => {
  test('GitHub：剥 dsh-/v 前缀、去重、坏行跳过', () => {
    const entries = parseGithubCatalog([
      { tag_name: 'dsh-v0.2.1-alpha.2' },
      { tag_name: 'dsh-v0.2.1-alpha.2' },
      { tag_name: 'v0.1.7-rc.2' },
      { tag_name: 'not-a-version' },
      { tag_name: 42 },
      null,
      { tag_name: 'dsh-v0.2.0' },
    ])
    expect(entries.map((entry) => entry.version)).toEqual(['0.2.1-alpha.2', '0.1.7-rc.2', '0.2.0'])
    expect(entries[0]?.channel).toBe('alpha')
  })

  test('GitHub：非数组载荷回空表', () => {
    expect(parseGithubCatalog(null)).toEqual([])
    expect(parseGithubCatalog({ message: 'rate limited' })).toEqual([])
  })

  test('npm：dist-tags 标渠道、版本降序、上限 20', () => {
    const versions: Record<string, unknown> = {}
    for (let index = 0; index < 25; index += 1) versions[`0.2.${String(index)}`] = {}
    versions['0.2.1-alpha.2'] = {}
    const entries = parseNpmCatalog({ 'dist-tags': { latest: '0.2.24', alpha: '0.2.1-alpha.2' }, versions })
    expect(entries.length).toBe(20)
    expect(entries[0]).toEqual({ version: '0.2.24', channel: 'latest' })
    expect(entries.some((entry) => entry.version === '0.2.1-alpha.2' && entry.channel === 'alpha')).toBe(true)
  })

  test('npm：坏载荷回空表', () => {
    expect(parseNpmCatalog(null)).toEqual([])
    expect(parseNpmCatalog({ versions: 'nope' })).toEqual([])
  })

  test('清单：数组与 {runtimes} 两种形态都认，坏 JSON/坏行丢弃', () => {
    expect(parseInstalledManifest('not json')).toEqual([])
    expect(parseInstalledManifest('[{"version":"0.2.1","source":"npm","installed_at":5}]')).toEqual([
      { version: '0.2.1', source: 'npm', installed_at: 5 },
    ])
    expect(parseInstalledManifest('{"runtimes":[{"version":"0.2.1"},{"version":"0.2.1"},{"source":"x"},7]}')).toEqual([
      { version: '0.2.1', source: '', installed_at: 0 },
    ])
  })

  test('清单：序列化按版本降序，往返一致', () => {
    const list: InstalledRuntime[] = [
      { version: '0.2.0', source: 'npm', installed_at: 1 },
      { version: '0.2.1-alpha.2', source: 'github', installed_at: 2 },
    ]
    const text = serializeInstalledManifest(list)
    expect(parseInstalledManifest(text)).toEqual([
      { version: '0.2.1-alpha.2', source: 'github', installed_at: 2 },
      { version: '0.2.0', source: 'npm', installed_at: 1 },
    ])
  })

  test('清单增删：upsert 覆盖同号，remove 摘掉', () => {
    const list: InstalledRuntime[] = [{ version: '0.2.0', source: 'npm', installed_at: 1 }]
    expect(upsertInstalled(list, { version: '0.2.0', source: 'github', installed_at: 9 })).toEqual([
      { version: '0.2.0', source: 'github', installed_at: 9 },
    ])
    expect(removeInstalledEntry(list, '0.2.0')).toEqual([])
  })
})

describe('CLI 版本与选中', () => {
  test('从 dsh --version 输出里取版本号', () => {
    expect(parseCliVersion('0.1.7-rc.2')).toBe('0.1.7-rc.2')
    expect(parseCliVersion('dsh/0.2.1-alpha.2 darwin-arm64 node-v24.21.0')).toBe('0.2.1-alpha.2')
    expect(parseCliVersion('command not found')).toBeNull()
  })

  test('设置指哪个用哪个；设置为空或拿不到就 null（= 内置兜底），不自动爬已装最高', () => {
    expect(selectRuntimeVersion({ installed: ['0.2.0', '0.2.1'], preferred: '0.2.0' })).toBe('0.2.0')
    // 设置的版本没装 → null 交给内置兜底（**不是**已装最高）
    expect(selectRuntimeVersion({ installed: ['0.2.0', '0.2.1'], preferred: '0.9.9' })).toBeNull()
    expect(selectRuntimeVersion({ installed: ['0.2.1-alpha.2', '0.2.1-alpha.10'], preferred: null })).toBeNull()
    expect(selectRuntimeVersion({ installed: [], preferred: '0.2.1' })).toBeNull()
    // 设置的版本就是随包内置的版本号 → 命中（壳拿它去走内置分支）
    expect(selectRuntimeVersion({ installed: ['0.2.1'], preferred: '0.2.0', builtin: '0.2.0' })).toBe('0.2.0')
    expect(selectRuntimeVersion({ installed: ['0.2.1'], preferred: null, builtin: '0.2.0' })).toBeNull()
  })

  test('mergeInstalled：清单提供来源与时间，目录扫描补漏', () => {
    const merged = mergeInstalled(
      [{ version: '0.2.0', source: 'npm', installed_at: 7 }],
      ['0.2.0', '0.2.1-alpha.2'],
    )
    expect(merged).toEqual([
      { version: '0.2.1-alpha.2', source: '', installed_at: 0 },
      { version: '0.2.0', source: 'npm', installed_at: 7 },
    ])
  })
})

describe('运行时目录 IO', () => {
  test('扫描只认有效树，跳过坏目录与 .trash', () => {
    const appSupport = tempDir()
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.0'), '0.2.0')
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.1-alpha.2'), '0.2.1-alpha.2')
    mkdirSync(runtimeDirOf(appSupport, '9.9.9'), { recursive: true }) // 半成品：没有 dsh 包
    mkdirSync(join(runtimeTrashDir(appSupport), '123-0.1.0'), { recursive: true })
    expect(scanInstalledVersions(appSupport)).toEqual(['0.2.1-alpha.2', '0.2.0'])
    expect(isRuntimeTreeValid(runtimeDirOf(appSupport, '0.2.0'))).toBe(true)
    expect(isRuntimeTreeValid(runtimeDirOf(appSupport, '9.9.9'))).toBe(false)
    expect(readRuntimeVersion(runtimeDirOf(appSupport, '0.2.1-alpha.2'))).toBe('0.2.1-alpha.2')
  })

  test('清单读写与 list 合并', () => {
    const appSupport = tempDir()
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.0'), '0.2.0')
    expect(readInstalledManifest(appSupport)).toEqual([])
    recordInstalledRuntime(appSupport, { version: '0.2.0', source: 'npm', installed_at: 11 })
    expect(existsSync(installedManifestPath(appSupport))).toBe(true)
    expect(listInstalledRuntimes(appSupport)).toEqual([{ version: '0.2.0', source: 'npm', installed_at: 11 }])
    // 目录里多出一个（上次壳留下的），清单没记：也要出现在列表里
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.1'), '0.2.1')
    expect(listInstalledRuntimes(appSupport).map((row) => row.version)).toEqual(['0.2.1', '0.2.0'])
    writeInstalledManifest(appSupport, [])
    expect(readInstalledManifest(appSupport)).toEqual([])
  })

  test('清单里的陈旧条目（目录已不在）不进已装列表（#79：不渲染假成功态）', () => {
    const appSupport = tempDir()
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.0'), '0.2.0')
    recordInstalledRuntime(appSupport, { version: '0.2.0', source: 'npm', installed_at: 11 })
    // 安装失败窗口期：installRuntime 校验失败后把半成品树 rm 掉了，但 manifest 还记着这一条
    recordInstalledRuntime(appSupport, { version: '0.2.1-alpha.3', source: 'github', installed_at: 22 })
    rmSync(runtimeDirOf(appSupport, '0.2.1-alpha.3'), { recursive: true, force: true })
    expect(listInstalledRuntimes(appSupport).map((row) => row.version)).toEqual(['0.2.0'])
  })

  test('卸载先入回收站：目录消失、清单摘掉、purge 才真删', () => {
    const appSupport = tempDir()
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.0'), '0.2.0')
    recordInstalledRuntime(appSupport, { version: '0.2.0', source: 'npm', installed_at: 1 })
    trashInstalledRuntime(appSupport, '0.2.0')
    expect(existsSync(runtimeDirOf(appSupport, '0.2.0'))).toBe(false)
    expect(readInstalledManifest(appSupport)).toEqual([])
    const trashed = scanInstalledVersions(appSupport)
    expect(trashed).toEqual([])
    const purged = purgeRuntimeTrash(appSupport)
    expect(purged).toBe(1)
    expect(existsSync(join(runtimeTrashDir(appSupport), '123-0.2.0'))).toBe(false)
    expect(purgeRuntimeTrash(appSupport)).toBe(0)
  })
})


describe('版本目录抓取', () => {
  const okResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })

  test('npm 源：解析 dist-tags 与版本表', async () => {
    const result = await fetchRuntimeCatalog({
      source: 'npm',
      fetchImpl: (async () => okResponse({ 'dist-tags': { latest: '0.2.1' }, versions: { '0.2.1': {}, '0.2.0': {} } })) as unknown as typeof fetch,
    })
    expect(result.error).toBeUndefined()
    expect(result.entries).toEqual([
      { version: '0.2.1', channel: 'latest' },
      { version: '0.2.0', channel: '' },
    ])
  })

  test('github 源：带上仓库名与 UA，默认官方仓库', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return okResponse([{ tag_name: 'dsh-v0.2.1-alpha.2' }])
    }) as unknown as typeof fetch
    const result = await fetchRuntimeCatalog({ source: 'github', fetchImpl })
    expect(seen[0]).toContain('api.github.com/repos/deepseek-ai/deepseek-harness/releases')
    expect(result.entries).toEqual([{ version: '0.2.1-alpha.2', channel: 'alpha' }])
    await fetchRuntimeCatalog({ source: 'github', repo: 'me/other', fetchImpl })
    expect(seen[1]).toContain('repos/me/other/releases')
  })

  test('HTTP 失败与网络异常都回 error，不抛', async () => {
    const failing = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    expect((await fetchRuntimeCatalog({ source: 'npm', fetchImpl: failing })).error).toContain('HTTP 503')
    const throwing = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const result = await fetchRuntimeCatalog({ source: 'github', fetchImpl: throwing })
    expect(result.entries).toEqual([])
    expect(result.error).toContain('offline')
  })
})

describe('运行时选中', () => {
  test('显式覆盖最优先，包根布局也能认', () => {
    const appSupport = tempDir()
    const root = makeRuntimeTree(join(tempDir(), 'tree'), '0.2.0')
    const selection = resolveRuntimeSelection({ env: {}, overrideDir: root, appSupport, installed: [] })
    expect(selection.kind).toBe('override')
    expect(selection.version).toBe('0.2.0')
    expect(selection.layout).toBe('root')
    expect(runtimePathsOf(root).dshLibDir).toBe(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib'))
  })

  test('显式覆盖指到包根布局（DSH_SHELL_RUNTIME_DIR 指包根）也能认', () => {
    const appSupport = tempDir()
    const pkg = join(tempDir(), 'lib', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    writeFileSync(join(pkg, 'lib', 'bin.js'), '// stub\n')
    writeFileSync(join(pkg, 'package.json'), '{"version":"0.2.1-alpha.2"}\n')
    const selection = resolveRuntimeSelection({ env: {}, overrideDir: pkg, appSupport, installed: [] })
    expect(selection.kind).toBe('override')
    expect(selection.layout).toBe('package')
    expect(selection.version).toBe('0.2.1-alpha.2')
    expect(runtimePathsOf(pkg, 'package').dshLibDir).toBe(join(pkg, 'lib'))
  })

  test('选中规则（#97）：设置指哪个用哪个；设置那个拿不到就回内置，不自动爬已装最高', () => {
    const appSupport = tempDir()
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.0'), '0.2.0')
    makeRuntimeTree(runtimeDirOf(appSupport, '0.2.1'), '0.2.1')
    const builtin = makeRuntimeTree(join(tempDir(), 'builtin'), '0.3.0')

    // 设置点名了已装的 0.2.0 → 就用它（不是已装的更高版本 0.2.1）
    const preferred = resolveRuntimeSelection({ env: {}, appSupport, builtinDir: builtin, preferred: '0.2.0' })
    expect(preferred.kind).toBe('installed')
    expect(preferred.version).toBe('0.2.0')
    expect(preferred.note).toBeNull()

    // 设置点名的就是随包内置的版本号（同一版本号没装进已装目录）→ 直接用内置那一棵
    const preferredBuiltin = resolveRuntimeSelection({ env: {}, appSupport, builtinDir: builtin, preferred: '0.3.0' })
    expect(preferredBuiltin.kind).toBe('builtin')
    expect(preferredBuiltin.version).toBe('0.3.0')
    expect(preferredBuiltin.root).toBe(builtin)

    // 内置优先于已下载目录：设置点名 0.3.0、而 0.3.0 也恰好在已装列表里 → 仍然用内置那棵
    const builtinFirst = resolveRuntimeSelection({
      env: {},
      appSupport,
      builtinDir: builtin,
      preferred: '0.3.0',
      installed: ['0.2.0', '0.3.0'],
    })
    expect(builtinFirst.kind).toBe('builtin')
    expect(builtinFirst.root).toBe(builtin)
    expect(builtinFirst.note).toBeNull()
    expect(preferredBuiltin.note).toBeNull()

    // 没设置（出厂默认）→ 用随包内置，**不是**已装最高 0.2.1：设置没点名就不替用户改选择
    const noPreference = resolveRuntimeSelection({ env: {}, appSupport, builtinDir: builtin })
    expect(noPreference.kind).toBe('builtin')
    expect(noPreference.version).toBe('0.3.0')
    expect(noPreference.note).toBeNull()

    // 设置点名的版本既没装、也不是内置 → 回随包内置兜底，并如实带 note（#79 回退可见化）
    const unavailable = resolveRuntimeSelection({ env: {}, appSupport, builtinDir: builtin, preferred: '9.9.9' })
    expect(unavailable.kind).toBe('builtin')
    expect(unavailable.version).toBe('0.3.0')
    expect(unavailable.note).toContain('9.9.9')
    expect(unavailable.note).toContain('随包内置')
  })

  test('什么都没有时抛清楚的错（带两个可用环境变量）', () => {
    const appSupport = tempDir()
    expect(() => resolveRuntimeSelection({ env: {}, appSupport, builtinDir: null })).toThrow(/找不到可用的 dsh 运行时/)
  })
})

describe('打包布局的运行进程锚定（#62）', () => {
  const fileSet = (...paths: string[]) => {
    const files = new Set(paths)
    return (path: string) => files.has(path)
  }

  test('解压式自定义安装：<安装目录>/<应用树>/{bin/bun.exe + Resources/app/{runtime,plugins}}', () => {
    const app = resolve('/opt/dsh/App')
    const exe = join(app, 'bin', 'bun.exe')
    const root = join(app, 'Resources', 'app')
    const exists = fileSet(
      exe,
      join(root, 'runtime', 'dsh-host.mjs'),
      join(root, 'plugins', 'dsh-desktop-bun', 'package.json'),
    )
    expect(packagedRootFromProcess(exe, exists)).toBe(root)
    expect(packagedResourcesFromProcess(exe, exists)).toBe(root)
  })

  test('扁平树：bin 旁就是 runtime/plugins 也认', () => {
    const tree = resolve('/srv/dsh')
    const exe = join(tree, 'bin', 'bun.exe')
    const exists = fileSet(
      exe,
      join(tree, 'runtime', 'dsh-host.mjs'),
      join(tree, 'plugins', 'dsh-desktop-bun', 'package.json'),
    )
    expect(packagedRootFromProcess(exe, exists)).toBe(tree)
    expect(packagedResourcesFromProcess(exe, exists)).toBe(tree)
  })

  test('dev 态（工具链 bun，祖先无标记）探测落空回 null，调用方回落 import.meta 链', () => {
    const never = () => false
    const exe = join(resolve('/Users/u/.hutch/toolchains/bun/1.4.0/macos-arm64'), 'bin', 'bun')
    expect(packagedRootFromProcess(exe, never)).toBeNull()
    expect(packagedResourcesFromProcess(exe, never)).toBeNull()
  })

  test('launcher 旁 bun 与 launcher 锚定：launcher 优先于进程锚（自定义安装目录说了算，#62）', () => {
    const app = resolve('/opt/dsh/App')
    const launcher = join(app, 'bin', 'launcher.exe')
    const root = join(app, 'Resources', 'app')
    const canonical = join(resolve('/opt/规范根/com.hyperion.dsh-desktop-bun/stable'), 'Resources', 'app')
    const exists = fileSet(
      launcher,
      join(app, 'bin', 'bun.exe'),
      join(root, 'runtime', 'dsh-host.mjs'),
      join(root, 'plugins', 'dsh-desktop-bun', 'package.json'),
      join(canonical, 'runtime', 'dsh-host.mjs'),
    )
    expect(packagedRootFromLauncher(launcher, exists)).toBe(root)
    expect(packagedResourcesFromLauncher(launcher, exists)).toBe(root)
    expect(packagedRootFromLauncher(null)).toBeNull()
    expect(packagedRootFromLauncher(join(resolve('/opt/规范根/missing'), 'bin', 'launcher.exe'), exists)).toBeNull()
  })
})

describe('launcher 可执行文件路径发现（#62）', () => {
  test('无 ELECTROBUN_LAUNCHER_PID 且 ppid 无效 → null，不发起进程探测', () => {
    let spawned = 0
    const run = () => {
      spawned += 1
      return { status: 0, stdout: '' }
    }
    expect(resolveLauncherExecutablePath({}, 0, run, () => null, 'darwin')).toBeNull()
    expect(spawned).toBe(0)
  })

  test('darwin：拿 PID 走 ps -o comm=，取首个非空行为 exe 路径', () => {
    const out = resolveLauncherExecutablePath(
      { ELECTROBUN_LAUNCHER_PID: '4242' },
      0,
      () => ({ status: 0, stdout: '  /opt/dsh/App/bin/launcher  \n' }),
      () => null,
      'darwin',
    )
    expect(out).toBe('/opt/dsh/App/bin/launcher')
  })

  test('linux：读 /proc/<pid>/exe 的 readlink 结果', () => {
    const out = resolveLauncherExecutablePath(
      { ELECTROBUN_LAUNCHER_PID: '9' },
      0,
      () => ({ status: 1, stdout: '' }),
      (path) => (path === '/proc/9/exe' ? '/opt/dsh/App/bin/launcher' : null),
      'linux',
    )
    expect(out).toBe('/opt/dsh/App/bin/launcher')
  })

  test('win32：走 PowerShell CIM 拿 ExecutablePath', () => {
    const seen: string[][] = []
    const out = resolveLauncherExecutablePath(
      { ELECTROBUN_LAUNCHER_PID: '11' },
      0,
      (argv) => {
        seen.push(argv)
        return { status: 0, stdout: 'C:\\App\\bin\\launcher.exe\r\n' }
      },
      () => null,
      'win32',
    )
    expect(out).toBe('C:\\App\\bin\\launcher.exe')
    expect(seen[0]?.[0]).toBe('powershell')
    expect(seen[0]?.join(' ')).toContain('ProcessId=11')
  })

  test('探测失败（非零退出/空输出）→ null，调用方逐级兑底', () => {
    expect(
      resolveLauncherExecutablePath({ ELECTROBUN_LAUNCHER_PID: '7' }, 0, () => ({ status: 1, stdout: '' }), () => null, 'darwin'),
    ).toBeNull()
    expect(
      resolveLauncherExecutablePath({ ELECTROBUN_LAUNCHER_PID: '7' }, 0, () => ({ status: 0, stdout: '\n' }), () => null, 'darwin'),
    ).toBeNull()
  })
})
