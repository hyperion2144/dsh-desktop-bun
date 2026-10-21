#!/usr/bin/env bun
/**
 * 构建产物断言（CI 门禁 + 本地手验）：每个平台的包都要证明「它的渲染器载荷与平台策略一致」。
 * 为什么必须有这道门：Electrobun 里 `renderer: 'cef'` 在**没打 CEF** 时会静默回落系统
 * webview（mac `nativeWrapper.mm:8359`、win `nativeWrapper.cpp:8944`、linux `nativeWrapper.cpp:591`），
 * 界面上看不出任何异常——但那就等于把 #200 那族 JavaScriptCore 崩溃原样带回来。所以不靠
 * 「构建时没报错」，而是打包后直接翻产物：
 *   · mac/linux（bundleCEF:true）→ payload 里必须有 CEF 运行时，缺了即断言失败；
 *   · win（#84 起 bundleCEF:false，走系统 WebView2）→ **不得**出现 CEF 载荷——出现即
 *     渲染器策略回归 / 包体回胖。
 * 两条路都还要求 `version.json` 的 channel 与更新源对得上。
 *
 * 用法：
 *   bun run scripts/assert-artifact.mjs                 # 自动找 build/ 下最新的 <env>-<os>-<arch>
 *   bun run scripts/assert-artifact.mjs <构建目录|.app>  # 指定产物
 *
 * 退出码：0 = 通过；1 = 断言失败（缺/多出 CEF 载荷 / 缺 version.json / 读不出归档）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { dshVersionFromPackageJson, readBuiltinRuntimeDeclaration } from '../src/shared/runtime/builtin-runtime.ts'

const projectRoot = resolve(import.meta.dir, '..')
const buildRoot = join(projectRoot, 'build')

/** 各平台**应带**的 CEF 运行时标志（tar 列表里的路径片段）。win 走系统 WebView2（#84），不打 CEF ⇒ 空。 */
function cefMarkers(platform) {
  if (platform === 'darwin') {
    return [
      'Chromium Embedded Framework.framework/Chromium Embedded Framework',
      'Chromium Embedded Framework.framework/Libraries/libcef_sandbox.dylib',
    ]
  }
  if (platform === 'win32') return []
  return ['libcef.so', 'chrome-sandbox']
}

/** 各平台**不得带**的 CEF 载荷标志（#84 反向断言）：win 产物出现即渲染器策略回归 / 包体回胖。 */
function forbiddenCefMarkers(platform) {
  if (platform === 'win32') return ['libcef.dll', 'chrome_elf.dll']
  return []
}

function listDir(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** 找 payload 归档（Electrobun 的更新包：mac 在 .app/Contents/Resources 下，win/linux 在构建目录里）。 */
function findPayloads(root, depth = 0) {
  if (depth > 4 || !existsSync(root)) return []
  const found = []
  for (const entry of listDir(root)) {
    const full = join(root, entry)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      if (entry.endsWith('.app') || !entry.startsWith('.')) found.push(...findPayloads(full, depth + 1))
      continue
    }
    if (entry.endsWith('.tar.zst')) found.push(full)
  }
  return found
}

/** 自动挑构建目录：优先 stable-<平台>-<架构>，其次最新的一个。 */
function pickTarget() {
  const explicit = process.argv[2]
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const candidates = listDir(buildRoot).filter((name) => !name.startsWith('.'))
  const stable = candidates.filter((name) => name.startsWith('stable-'))
  const chosen = (stable.length > 0 ? stable : candidates).sort().pop()
  if (chosen === undefined) {
    console.error(`[assert] build/ 下没有构建目录：${buildRoot}`)
    process.exit(1)
  }
  return join(buildRoot, chosen)
}

/** `tar --zstd -tf` 拿列表（macOS/Linux 的 bsdtar 与 Windows 自带的 tar 都支持；失败再退一次）。 */
function tarList(archive) {
  for (const args of [['--zstd', '-tf'], ['-tf']]) {
    const result = spawnSync('tar', [...args, archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (result.status === 0 && typeof result.stdout === 'string') return result.stdout.split('\n')
  }
  return null
}

function tarExtract(archive, member) {
  for (const args of [['--zstd', '-xOf'], ['-xOf']]) {
    const result = spawnSync('tar', [...args, archive, member], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    if (result.status === 0 && typeof result.stdout === 'string') return result.stdout
  }
  return null
}

const target = pickTarget()
const platform = process.platform
const payloads = findPayloads(target)

/** version.json 的三条硬杠：有版本号、有 channel、stable 必须有更新源。 */
function checkVersion(raw, label) {
  try {
    const parsed = JSON.parse(raw)
    const channel = String(parsed.channel ?? '')
    const baseUrl = String(parsed.baseUrl ?? '')
    const version = String(parsed.version ?? '')
    console.log(`[assert] ${label} → version=${version} channel=${channel} baseUrl=${baseUrl || '(空)'}`)
    if (version === '') problems.push(`${label} 的 version.json 没有版本号`)
    if (channel === '') problems.push(`${label} 的 version.json 没有 channel`)
    // dev 构建本来就不带更新源（框架也拒绝更新 dev）；stable 必须带，否则自动更新永远不可用。
    if (channel === 'stable' && baseUrl === '') {
      problems.push(`${label}：stable 包没有 baseUrl（release.baseUrl 配错层了？）`)
    }
  } catch (error) {
    problems.push(`${label} 的 version.json 解析失败：${String(error)}`)
  }
}
const problems = []

// 内置 dsh 版本要与声明一致（#16）：prepare:bundle 已校验过落盘树，这里对产物再对
// 一遍——包里带的版本漂了，声明就形同虚设。声明本身读不出来也是 fail。
const declaredBuiltin = readBuiltinRuntimeDeclaration(join(projectRoot, 'builtin-runtime.json'))
const BUILTIN_DSH_PKG = 'dsh/node_modules/@deepseek-ai/dsh/package.json'
if (declaredBuiltin === null) {
  problems.push('内置运行时声明读不出来（desktop-electrobun/builtin-runtime.json）')
}

/** 内置 dsh package.json 的版本要与声明一致；不符计为 problem（门槛拦住）。 */
function checkBuiltinVersion(raw, label) {
  if (declaredBuiltin === null) return
  const version = dshVersionFromPackageJson(raw)
  if (version === null) problems.push(`${label} 的内置 dsh package.json 读不出版本号`)
  else if (version !== declaredBuiltin.dsh) problems.push(`${label} 的内置 dsh 版本 ${version} ≠ 声明 ${declaredBuiltin.dsh}`)
  else console.log(`[assert] ${label} → 内置 dsh ${version}（与声明一致）`)
}

console.log(`[assert] 产物目录：${target}`)
console.log(`[assert] 平台：${platform}`)

if (payloads.length === 0) {
  problems.push('产物里没有 payload 归档（*.tar.zst）——Electrobun 的包结构变了？')
}

// macOS：launcher 必须是原生 Mach-O（#176 exec shim 已撤，shim 是 990B 脚本）；
// launcher.native 是 shim 时期的备份，残留即说明撤得不干净。
// launcher 住在 .app 包里（<产物目录>/<*.app>/Contents/MacOS/launcher）——#192 曾把
// 路径拼成 <产物目录>/Contents/MacOS/launcher（漏了 .app 段），CI 断言恒 ENOENT。
if (platform === 'darwin') {
  const findMacLaunchers = (dir, depth) => {
    const out = []
    if (depth > 3) return out
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = join(dir, entry.name)
      if (entry.name === 'MacOS') {
        const candidate = join(child, 'launcher')
        if (existsSync(candidate)) out.push(candidate)
      } else {
        out.push(...findMacLaunchers(child, depth + 1))
      }
    }
    return out
  }
  const launchers = findMacLaunchers(target, 0)
  if (launchers.length === 0) {
    problems.push('mac 产物里找不到 *.app/Contents/MacOS/launcher——包布局变了？')
  }
  for (const launcher of launchers) {
    try {
      const head = readFileSync(launcher).subarray(0, 4).toString('hex')
      const macho = ['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface']
      if (!macho.includes(head)) problems.push(`launcher 不是原生 Mach-O（magic=${head}）——exec shim 又回来了？`)
    } catch (error) {
      problems.push(`读不出 launcher：${String(error)}`)
    }
    if (existsSync(`${launcher}.native`)) problems.push('launcher.native 仍存在：exec shim 未彻底撤销')
  }
}

/** app 目录布局里也可能有一份 version.json（Windows 的 launcher：exe 旁边就是 Resources\）。 */
function findLauncherDirs(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    if (entries.some((entry) => entry.name === 'launcher.exe')) {
      // launcher 住在 bin/ 下（mac 版式 Contents/MacOS 的对应物）；应用根 = 有 Resources 的那一层
      const withResources = existsSync(join(dir, 'Resources'))
        ? dir
        : existsSync(join(dirname(dir), 'Resources'))
          ? dirname(dir)
          : dir
      out.push(withResources)
      return
    }
    for (const entry of entries) if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1)
  }
  walk(root, 0)
  return out
}

function listFilesRecursive(root) {
  const out = []
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) walk(child)
      else out.push(child)
    }
  }
  walk(root)
  return out
}

function findVersionJsonOnDisk(root, depth = 0) {
  if (depth > 4) return []
  const found = []
  for (const entry of listDir(root)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(root, entry)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      found.push(...findVersionJsonOnDisk(full, depth + 1))
      continue
    }
    if (entry === 'version.json') found.push(full)
  }
  return found
}

const diskVersionFiles = findVersionJsonOnDisk(target)
// Windows 的产物是「exe + Resources/<hash>.tar.zst 载荷」两段式：version.json 落在 app 目录里，
// 不在归档里。这时不再要求归档带它（渲染器载荷断言照跑），改验磁盘上那份。
const needVersionInArchive = diskVersionFiles.length === 0
if (diskVersionFiles.length > 0) {
  console.log(`[assert] 磁盘上发现 ${String(diskVersionFiles.length)} 份 version.json（app 目录布局）`)
}

/** 打包时贴进 `Contents/Resources/app/plugins/` 的壳插件：壳运行时要靠它们注入桌面功能。 */
const REQUIRED_PAYLOAD_FILES = [
  'plugins/dsh-desktop-bun/package.json',
  'plugins/dsh-desktop-bun/lib/client.js',
  'plugins/dsh-mobile-access/package.json',
  // 手机布局插件（#20）：来自 mobile/dsh-mobile-nav 子模块，漏拉子模块时打包不得静默缺包。
  'plugins/dsh-web-mobile/package.json',
  'plugins/dsh-web-mobile/lib/client.js',
  // 内置 dsh 运行时树（goal 第 1 条）：缺了它，干净机器首启直接「找不到可用的 dsh 运行时」。
  // 本地构建曾静默漏带（worktree 没装内置树 + 回退链查不到）⇒ 在门槛里拦住，不再靠肉眼。
  'dsh/node_modules/@deepseek-ai/dsh/package.json',
  // 壳主进程入口与托盘图标：缺了等于「托盘/DevTools 静默失效」，构建期拦住。
  'app/bun/index.js',
  'app/runtime/tray.png',
  // #237 常驻监督进程与其仓内依赖：明文随包发出、包内按 ../src/... 相对引用。漏抄一个，
  // 监督进程 import 阶段即崩（Windows 实测：Cannot find module '../src/.../entry.ts'，重启只剩直拉兜底）。
  'app/runtime/shell-supervisor.mjs',
  'app/src/bun/platform/app-restart.ts',
  'app/src/bun/platform/restart/intent.ts',
  'app/src/bun/platform/restart/cef-lock.ts',
  'app/src/bun/platform/restart/entry.ts',
]

/** 二进制安全地把归档里的某个成员解到磁盘（内层归档可能很大，由调用方负责删）。 */
function tarExtractTo(archive, member, dest) {
  for (const args of [['--zstd', '-xOf'], ['-xOf']]) {
    const result = spawnSync('tar', [...args, archive, member], { maxBuffer: 2 * 1024 * 1024 * 1024 })
    if (result.status === 0 && result.stdout !== null && result.stdout.length > 0) {
      writeFileSync(dest, result.stdout)
      return true
    }
  }
  return false
}

/**
 * 断言一份归档。两类都认：
 *   · 叶子（真正的应用 payload）→ 渲染器载荷符合平台策略（mac/linux 必有 CEF；win 不得有）+ 可用的 version.json；
 *   · 包装层（Windows 的 `*-Setup.tar.zst` 就是这种）→ 里面还有内层 `*.tar.zst`，
 *     解出来递归断言。
 * 路径比较一律先把 `\` 归一成 `/`：Windows 上 tar 列表用的是反斜杠（CI 实测）。
 */
function inspect(archive, label, depth = 0) {
  const listing = tarList(archive)
  if (listing === null) {
    problems.push(`读不出归档列表：${label}（tar 不支持 zstd？装 zstd 或换 bsdtar）`)
    return
  }
  // Windows 的 tar 列表是 CRLF：行尾的 `\r` 会把 `…/version.json` 判成不匹配（CI 实测）。
  const norm = listing
    .map((line) => line.replace(/\r$/, '').replace(/\\/g, '/'))
    .filter((line) => line !== '')
  const versionLine = norm.find((line) => line === 'version.json' || line.endsWith('/version.json'))
  const nested = norm.filter((line) => line.endsWith('.tar.zst'))
  if (versionLine === undefined && nested.length > 0 && depth < 2) {
    console.log(`[assert] ${label} → 包装层（内含 ${String(nested.length)} 份内层归档），逐份解出来再断言`)
    for (const member of nested) {
      const scratch = join(tmpdir(), `dsh-assert-${String(process.pid)}-${String(depth)}.tar.zst`)
      try {
        if (tarExtractTo(archive, member, scratch)) inspect(scratch, `${label} → ${member}`, depth + 1)
        else problems.push(`解不出内层归档：${label} → ${member}`)
      } finally {
        rmSync(scratch, { force: true })
      }
    }
    return
  }
  const joined = norm.join('\n')
  for (const marker of cefMarkers(platform)) {
    if (!joined.includes(marker)) problems.push(`${label} 里缺 CEF 标志：${marker}`)
  }
  for (const marker of forbiddenCefMarkers(platform)) {
    if (joined.includes(marker)) problems.push(`${label} 里多出 CEF 标志：${marker}（本平台应走系统 WebView2，包体不该带 CEF）`)
  }
  // 贴进包里的壳插件：缺了就是「装完设置面板全空」（维护者实机报的），必须在门槛里拦住。
  for (const required of REQUIRED_PAYLOAD_FILES) {
    if (!norm.some((line) => line.endsWith(`/${required}`))) {
      problems.push(`${label} 里缺 ${required}（必需文件没被打进包）`)
    }
  }

/** 壳主进程 index.js 必须带的关键符号（#178：托盘/DevTools 回归教训）。 */
const REQUIRED_INDEX_MARKERS = ['openDevToolsWindow', 'startupTray', 'createTray']
  if (declaredBuiltin !== null) {
    const pkgLine = norm.find((line) => line.endsWith(`/${BUILTIN_DSH_PKG}`))
    if (pkgLine !== undefined) {
      const raw = tarExtract(archive, pkgLine)
      if (raw === null) problems.push(`${label} 的内置 dsh package.json 读不出来`)
      else checkBuiltinVersion(raw, label)
    }

  // 壳主进程符号：缺了等于托盘/DevTools 静默失效（#178）。
  const indexLine = norm.find((line) => line.endsWith('/app/bun/index.js'))
  if (indexLine !== undefined) {
    const raw = tarExtract(archive, indexLine)
    if (raw === null) problems.push(`${label} 的 app/bun/index.js 读不出来`)
    else {
      for (const marker of REQUIRED_INDEX_MARKERS) {
        if (!raw.includes(marker)) problems.push(`${label} 的 app/bun/index.js 缺关键符号：${marker}`)
      }
    }
    }
    // 监督脚本 import 自检：解析包内脚本的相对 import，逐一断言目标在包里——以后往脚本里加
    // import 忘了同步 copy 清单时，构建期就炸，不再等实机翻 .child 日志。
    const supervisorLine = norm.find((line) => line.endsWith('/app/runtime/shell-supervisor.mjs'))
    if (supervisorLine !== undefined) {
      const supervisorRaw = tarExtract(archive, supervisorLine)
      if (supervisorRaw === null) problems.push(`${label} 的 app/runtime/shell-supervisor.mjs 读不出来`)
      else {
        for (const spec of supervisorRaw.matchAll(/from\s+'(\.[^']+)'/g)) {
          // 相对引用按仓库相对结构落在 app/ 之下：'../src/x' → app/src/x；'./y' → app/runtime/y
          const specPath = String(spec[1])
          const target = specPath.startsWith('../') ? `app/${specPath.slice(3)}` : `app/runtime/${specPath.slice(2)}`
          if (!norm.some((line) => line.endsWith(`/${target}`))) {
            problems.push(`${label} 的 shell-supervisor.mjs import 的 ${specPath} 不在包内（copy 清单漏了？）`)
          }
        }
      }
    }
  }
  if (versionLine === undefined) {
    const sample = norm
      .slice(0, 20)
      .map((line) => `      ${line}`)
      .join('\n')
    if (needVersionInArchive) {
      problems.push(`${label} 里没有 version.json（更新与版本号都靠它）；前 20 条：\n${sample}`)
    } else {
      console.log(`[assert] ${label}：归档里没有 version.json（磁盘那份已代劳）`)
    }
    return
  }
  const raw = tarExtract(archive, versionLine)
  if (raw === null) problems.push(`${label} 的 version.json 读不出来`)
  else checkVersion(raw, label)
}

let diskChecked = false
if (platform === 'win32') {
  // Windows：载荷已在打包期解并进应用树（setup 装完即用），不再随包发 *.tar.zst
  // ⇒ 断言改为「应用目录磁盘树」：渲染器载荷（#84 win 反向核验 CEF 不出现）+ 壳插件 + 内置 dsh 树直接在文件系统上找。
  const appDirs = findLauncherDirs(target)
  if (appDirs.length === 0) {
    problems.push('Windows 构建目录里找不到应用根（含 launcher.exe 的目录）')
  }
  for (const appDir of appDirs) {
    const rels = listFilesRecursive(appDir).map((file) => file.slice(appDir.length + 1).replace(/\\/g, '/'))
    const joined = rels.join('\n')
    for (const marker of cefMarkers(platform)) {
      if (!joined.includes(marker)) problems.push(`应用树缺 CEF 标志：${marker}`)
    }
    for (const marker of forbiddenCefMarkers(platform)) {
      if (joined.includes(marker)) problems.push(`应用树多出 CEF 标志：${marker}（#84 起 win 走系统 WebView2，包体不该带 CEF）`)
    }
    for (const required of REQUIRED_PAYLOAD_FILES) {
      if (!rels.some((line) => line.endsWith(`/app/${required}`) || line.endsWith(`/${required}`))) {
        problems.push(`应用树缺 ${required}（必需文件没被打进包）`)
      }
    }
    if (declaredBuiltin !== null) {
      const pkgRel = rels.find((line) => line.endsWith(`/${BUILTIN_DSH_PKG}`))
      if (pkgRel !== undefined) {
        try {
          checkBuiltinVersion(readFileSync(join(appDir, pkgRel), 'utf8'), '应用树（磁盘）')
        } catch (error) {
          problems.push(`读不出应用树里的内置 dsh package.json：${String(error)}`)
        }
      }
    }
    console.log(`[assert] 应用树（磁盘）：${rels.length} 个文件，_required 与渲染器载荷策略已核对`)
    diskChecked = true
  }
}
for (const payload of payloads) inspect(payload, payload.slice(target.length + 1))
if (platform === 'win32' && diskChecked === false && payloads.length === 0 && problems.length === 0) {
  problems.push('Windows 产物既没有归档也没有可断言的应用树')
}
for (const file of diskVersionFiles) {
  try {
    checkVersion(readFileSync(file, 'utf8'), `${file.slice(0, target.length + 1)}…（磁盘）`)
  } catch (error) {
    problems.push(`读不出 ${file}：${String(error)}`)
  }
}

// 安装包形态也顺带报一下（dmg / Setup.zip / tar.gz 都是预期产物，缺了不判失败，只提示）。
const installers = listDir(target).filter((name) => /\.(dmg|zip|tar\.gz|tar\.zst)$/.test(name))
console.log(`[assert] 目录内产物：${installers.length === 0 ? '(只有 app 目录)' : installers.join(', ')}`)

if (problems.length > 0) {
  console.error('[assert] 失败：')
  for (const problem of problems) console.error(`  · ${problem}`)
  process.exit(1)
}
console.log(`[assert] 通过：${payloads.length} 份 payload 的渲染器载荷与可用 version.json 都符合平台策略`)
