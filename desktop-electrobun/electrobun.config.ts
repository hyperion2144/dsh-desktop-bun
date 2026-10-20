import type { ElectrobunConfig } from 'electrobun'
import { APP_NAME } from './src/shared/app/app.ts'
import { bundleIdentifierOverride, resolveBundleIdentifier } from './src/shared/app/app-identity.ts'
import { DEFAULT_UPDATE_BASE_URL } from './src/shared/runtime/update.ts'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoDir = resolve(import.meta.dir, '..')

// 开发态「只带链接」模式：DSH_SHELL_BUILTIN_LINK=<给定的 runtime 目录>
//   · 跳过内置运行时的 copy（几百 MB 的树每次 dev build 都白拷一遍）；
//   · 改在 dev 包的位置直接放一条指向 <目录>/node_modules 的目录链接——包内照样用那棵树，
//     但包里不再带它。
// 为什么不能「拷一个链接进去」：Electrobun 的 copy 不保目录链接，链接会被压成 0 字节的普通
// 文件（实测 dev 包里 app/dsh/node_modules 就是这么变成 0 字节的），所以这条链接只能在拷贝
// 之外、在包的位置自己建。
// 范围：只对 macOS 的 dev 包生效（包结构是 .app 目录）；别的平台与非 dev 通道照旧拷实体树。
// 开关没设时行为一行不变：release（stable/canary）照旧带实体树，签名语义不动。
const builtinLinkDir = (process.env.DSH_SHELL_BUILTIN_LINK ?? '').trim()
let builtinLinked = false
if (builtinLinkDir !== '' && process.platform === 'darwin') {
  const linkTarget = join(resolve(builtinLinkDir), 'node_modules')
  const dshDir = join(
    import.meta.dir,
    'build',
    `dev-macos-${process.arch}`,
    `${APP_NAME}-dev.app`,
    'Contents',
    'Resources',
    'app',
    'dsh',
  )
  const linkPath = join(dshDir, 'node_modules')
  mkdirSync(dshDir, { recursive: true })
  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(linkTarget, linkPath, 'dir')
  builtinLinked = true
  // 走 stderr：hutch 会把配置的 stdout 当 JSON 解析，println 会把它顶成 SyntaxError。
  console.warn(`[electrobun.config] 内置运行时改用链接：${linkPath} → ${linkTarget}`)
}

/** 递归列文件（返回相对给定目录的 POSIX 相对路径；目录不存在就空数组）。 */
function listFiles(root: string, rel = ''): string[] {
  const abs = rel === '' ? root : join(root, rel)
  if (!existsSync(abs)) return []
  const out: string[] = []
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFiles(root, child))
    else out.push(child)
  }
  return out
}

/**
 * 把仓内的插件包摊成 `build.copy` 映射（源 → 包内 `plugins/<name>/…`）。
 *
 * 为什么要逐文件列、并且只列真的存在的：
 *   · 打包态的壳插件必须住在 `Contents/Resources/app/plugins/<name>/`，否则 runtime.ts 的
 *     `packagedResources()` 返回 null，`stagePlugins()` 找不到包 —— 界面上就是「装了新包但桌面插件
 *     没注入、各项设置全空」（维护者实机报的）；
 *   · Electrobun 的 copy 没有「源缺就跳过」，写死一个不存在的路径就 `CopySourceMissing`
 *     直接构建失败（Windows/Linux CI 上踩过）；
 *   · `mobile/dsh-mobile-nav` 是子模块，本地常常是空的。
 */
function pluginCopy(sourceDir: string, packageName: string, files: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const rel of files) {
    const source = join(sourceDir, rel)
    if (existsSync(source)) map[source] = `plugins/${packageName}/${rel}`
  }
  return map
}

const desktopPluginDir = join(repoDir, 'desktop-plugin')
const desktopPluginFiles = ['package.json', 'index.js', 'cordis.patch.yml', 'README.md', 'LICENSE', ...listFiles(desktopPluginDir, 'lib')]
const mobileAccessDir = join(repoDir, 'plugins', 'dsh-mobile-access')
const mobileAccessFiles = ['package.json', 'cordis.patch.yml', ...listFiles(mobileAccessDir, 'lib'), ...listFiles(mobileAccessDir, 'client')]
const mobileLayoutDir = join(repoDir, 'mobile', 'dsh-mobile-nav')
const mobileLayoutFiles = ['package.json', 'cordis.patch.yml', 'README.md', ...listFiles(mobileLayoutDir, 'lib'), ...listFiles(mobileLayoutDir, 'assets')]

// #38：dev 并行实例的构建期换 id 口子（DSH_SHELL_DEV_IDENTIFIER）。命中覆盖时大声提醒——
// 这个变量漏进 canary/stable 构建会静默产出换 id 的正式包，签名与升级链都会错位。
const identifierOverride = bundleIdentifierOverride()
if (identifierOverride !== null) {
  console.warn(
    `[electrobun.config] DSH_SHELL_DEV_IDENTIFIER=${identifierOverride}：本次构建将覆盖 bundle id（并行测试实例专用，正式构建勿设）`,
  )
}

export default {
  app: {
    name: APP_NAME,
    // bundle id：dev 并行第二实例用 DSH_SHELL_DEV_IDENTIFIER 换 id（#38），默认与既有产物一致；
    // 它决定 CEF 数据目录（<id>/<channel>/CEF）与 Chromium ProcessSingleton 锁的归属。
    identifier: resolveBundleIdentifier(),
    version: '0.1.0',
  },
  build: {
    // 规格第 1 条：stable 2.0.2 默认主进程运行时是 cottontail，必须显式选 bun
    mainProcess: 'bun',
    bun: {
      entrypoint: 'src/bun/index.ts',
    },
    // 渲染器平台条件化（#84）：win 走系统 WebView2（同为 Chromium 内核，窗口直绘，无 CEF OSR
    // 的 30fps 上限/全帧 memcpy/GDI 提交税，且包体 -150MB）；mac/linux 保持 bundleCEF——系统
    // webview 是 WKWebView/WebKitGTK，渲染一致性是我们当初 bundle CEF 的原因，不随 win 改变。
    // 三处开关：这里两处 + src/bun/index.ts 建窗 renderer（取自 availableRenderers）+ 平台化启动断言。
    mac: { bundleCEF: true, defaultRenderer: 'cef' },
    linux: { bundleCEF: true, defaultRenderer: 'cef' },
    win: { bundleCEF: false, defaultRenderer: 'native', icon: 'resources/app-icon.ico' },
    // 包内资源：宿主脚本（Bun 跑 dsh 的等价物）与 Bun 兼容层（由 scripts/prepare-bundle.mjs
    // 从仓内单一来源物化到 runtime/）。落地位置＝<app>/Contents/Resources/app/<dest>，
    // 与 runtime.ts 的 packagedRoot() 约定一致。
    copy: {
      'runtime/dsh-host.mjs': 'runtime/dsh-host.mjs',
      'runtime/parent-watch.mjs': 'runtime/parent-watch.mjs',
      'runtime/bun-preload.mjs': 'runtime/bun-preload.mjs',
      // 托盘图标：prepare:bundle 把旧的 32x32.png 拷到 resources/tray.png，再落进包内 runtime/
      'resources/tray.png': 'runtime/tray.png',
      // Windows 托盘：shell tray 用 .ico（win32 原生格式），资源同上链路
      // Windows 通知身份图标（#107）：身份注册的 IconUri 指向包内这份（运行时经
      // win-notify-identity 解析 resources/ 与 runtime/ 两处）。源由 prepare:bundle 物化，
      // 缺失时不声明这条 copy（Electrobun 的 copy 不会「源缺就跳过」，与 dylib 同口径）。
      ...(existsSync(join(import.meta.dir, 'resources', 'app-icon.ico'))
        ? { 'resources/app-icon.ico': 'runtime/app-icon.ico' }
        : {}),
      'resources/tray.ico': 'runtime/tray.ico',
      // macOS 通知桥（旧壳 notify_un.rs 的等价物）：dylib 由 `bun run build:native` 编出来，
      // 先编后打（见 package.json 的 build 链），装完才有真授权状态与真投递。
      // 只在 darwin 上声明：Linux/Windows 上根本没这个产物，写死会让 `hutch electrobun build`
      // 报 `error: CopySourceMissing`（Electrobun 的 copy 不会「源缺就跳过」）。
      ...(process.platform === 'darwin'
        ? { 'native/libdsh-notify.dylib': 'runtime/libdsh-notify.dylib' }
        : {}),
      // 壳插件与手机访问插件：装到 `<app>/Contents/Resources/app/plugins/`，运行时再挂进 profile 池。
      ...pluginCopy(desktopPluginDir, 'dsh-desktop-bun', desktopPluginFiles),
      ...pluginCopy(mobileAccessDir, 'dsh-mobile-access', mobileAccessFiles),
      ...pluginCopy(mobileLayoutDir, 'dsh-web-mobile', mobileLayoutFiles),
      // 内置 dsh 运行时（随包发出，item 1）：prepare:bundle 按 builtin-runtime.json 声明物化一棵可用树到
      // builtin-runtime/（声明版本下载 / 已就绪复用 / DSH_SHELL_BUILTIN_SOURCE 显式逃生口，#16）。
      // 只在真的物化成功时声明：Electrobun 的 copy 不会「源缺就跳过」，写死会 CopySourceMissing。
      // 链接模式下不声明这条 copy：那棵树已经在 dev 包的位置用链接接上了（见上面的链接模式分支）。
      ...(!builtinLinked
        && existsSync(join(import.meta.dir, 'builtin-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
        ? { 'builtin-runtime': 'dsh' }
        : {}),
    },
    // 关窗不退出：托盘在的时候，关掉最后一个窗口只是隐藏（与旧 Tauri 壳同行为）。
    // 没有托盘时（Linux 某些桌面环境）隐藏后就再也叫不回来了，所以 index.ts
    // 会在没有托盘时把「关窗」当成真退出处理。
    runtime: { exitOnLastWindowClosed: false },
  },
  // 应用更新（#220 决策 11）：Electrobun 按 `<baseUrl>/<buildEnvironment>-<os>-<arch>-update.json`
  // 取清单，再按「补丁链优先、失败回落整包」换掉整个 `.app`。这里指到 GitHub Releases
  // 的 `latest/download` 别名（资产名稳定指向最新一版）。
  // 注意：`release` 是**顶层**字段（ElectrobunConfig.ts:642），不是 `build` 的子项——
  // 放错层会被静默忽略（实测构建日志会打 “no release.baseUrl configured; skipping delta patch”）。
  release: {
    baseUrl: DEFAULT_UPDATE_BASE_URL,
    // 我们还没发过 Electrobun 版，补丁链没有可比对的上一版 ⇒ 先关掉补丁生成，只出整包
    generatePatch: false,
  },
} satisfies ElectrobunConfig
