// dsh 宿主进程（官方 apps/desktop-host/src/index.ts 的等价物，Bun 版）。
//
// 契约（与官方一致）：
//   loadProfileDirectory('dsh', projectDir, installAnchor) → runProfile({ ..., args: ['--no-open','--host','127.0.0.1','--port','0'] })
//   → 取 ctx.webServer.port 与 ctx.connection.authenticatedUrl(base) → 向壳报告 { type:'ready', url, injections }
//   injections = ctx.webServer.collectIndexInjections()（进程内取，绝不走 HTTP 面——页面此时还没有 Cordis 树）
//
// 端口由本进程自己拿（--port 0），壳不再猜端口：这是与 Tauri 版最大的差别之一。
//
// 用法：bun --no-install --preload <bun-preload.mjs> dsh-host.mjs <dshLibDir> <profile> [fresh|existing]
// 环境：DSH_HOME 由壳注入（buildChildEnv），另有 DSH_CLIENT_VERSION 等（见 src/shared/child-env.ts）

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { watchParent } from './parent-watch.mjs'

const [libDir, profileDir, profileName = 'desktop', mode = 'existing'] = process.argv.slice(2)
if (libDir === undefined || profileDir === undefined) {
  console.error('[host] 缺少参数：dsh-host.mjs <dshLibDir> <profileDir> [profile] [mode]')
  process.exit(2)
}

const runtimeDir = join(libDir, '..', '..', '..', '..')
const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const require = createRequire(join(libDir, 'bin.js'))

const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
const { runProfile } = await import(pathToFileURL(join(libDir, 'profile-boot.js')).href)

// 官方对齐（apps/desktop/src/project-manager.ts）：desktop profile 的 bundles 与 web 一致，
// 首次创建用 dsh 自己的 initProfile（profile 目录不存在 package.json 时），不再由壳手写脚手架。
const WEB_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** 壳交给我们的 `--patch` 清单（冒号分隔；空串 = 无注入）。 */
function patchFiles() {
  const raw = process.env.DSH_SHELL_PATCH_FILES ?? ''
  const files = raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (files.length > 0) console.log(`[host] 注入清单：${files.join('、')}`)
  return files
}

console.log(
  `[host] bun = ${process.versions.bun} | profile = ${profileName} | DSH_HOME = ${process.env.DSH_HOME ?? '(unset)'} | DSH_CLIENT_VERSION = ${process.env.DSH_CLIENT_VERSION ?? '(unset)'}`,
)
// 官方对齐（apps/desktop-host/src/index.ts）：loadProfileDirectory → reportSkippedBundles →
// runProfile 带 resolvedProfile。bundle 一律经 installAnchor 从运行时树解析，profile 目录
// 不需要装依赖——这正是官方 profile「看起来是空的也能跑」的原因。
if (!existsSync(join(profileDir, 'package.json'))) {
  boot.initProfile(profileDir, WEB_PROFILE_BUNDLES)
  console.log(`[host] profile 初始化（dsh 自己的逻辑）：${profileDir}`)
}
const loadedProfile = boot.loadProfileDirectory('dsh', profileDir, installAnchor)
boot.reportSkippedBundles('dsh', loadedProfile)
if (mode !== 'existing') console.log(`[host] 启动模式：${mode}（seed 语义已废弃，交给 dsh initProfile）`)
const application = runProfile({
  environment: boot.loadLayeredEnv('dsh'),
  profile: profileName,
  resolvedProfile: { profile: loadedProfile, installAnchor },
  // 注入清单：壳写好的 `--patch` 覆盖层（connection inject / 网关心跳 / 壳插件行）。
  // 旧壳把同一份文件交给 dsh CLI 的 `--patch`；这里走 runProfile 的 patchFiles 入口。
  patchFiles: patchFiles(),
  args: ['--no-open', '--host', '127.0.0.1', '--port', listenPort()],
})

// 监听端口：壳给了 `DSH_DESKTOP_PORT` 就用它（旧壳固定 3080/3081，且手机访问插件靠这个变量找上游）；
// 没给就 `--port 0` 自己拿（官方 desktop-host 的做法）。
function listenPort() {
  const raw = Number(process.env.DSH_DESKTOP_PORT ?? '')
  if (Number.isInteger(raw) && raw > 0 && raw <= 65535) {
    console.log(`[host] 监听端口由壳指定：${String(raw)}`)
    return String(raw)
  }
  return '0'
}

// 父进程看门狗：壳崩溃/被 SIGKILL/退出后，我们会变成孤儿继续占着会话——
// 所以由子进程反过来盯着壳（DSH_SHELL_PARENT_PID 由壳注入）。
watchParent({
  parentPid: Number(process.env.DSH_SHELL_PARENT_PID ?? '0'),
  onDead: (reason) => {
    console.error(`[host] 壳已不在（${reason}），宿主随之退出`)
    shutdown('parent-gone')
  },
})

const { ctx } = await application

// 官方桌面（0.2.1-alpha.2 起）能读到 ctx.webServer.protocol；更老的树（含 0.2.1-alpha.1）没有这个字段，
// 拼出来就是 `undefined//127.0.0.1:6396` → authenticatedUrl 抛 `Invalid URL`。运行时可以下到任意版本，
// 所以这里宽容一点：没有 protocol 就按 http（loopback 本来就是 http）。
const protocol = typeof ctx.webServer.protocol === 'string' && ctx.webServer.protocol !== '' ? ctx.webServer.protocol : 'http:'
const base = `${protocol}//127.0.0.1:${String(ctx.webServer.port)}`
const url = ctx.connection.authenticatedUrl(base)
const injections = ctx.webServer.collectIndexInjections()
console.log(`[host] webServer.port = ${String(ctx.webServer.port)} | injections = ${String(injections.length)}`)
console.log(`HOST-READY ${JSON.stringify({ type: 'ready', url, injections })}`)

// #101：注入清单监控。壳把 boot 载荷冻在 HOST-READY 那一刻，而宿主侧 client-module 图会在
// 运行期重算（插件市场更新/装卸，dsh-client-hmr 的 stat 轮询触发 recompose）——之后刷新页面
// 拿的还是旧图 URL，宿主只保留最近两代批次，旧 URL 必 404（页面永久卡 loading）。
// 这里周期性重采集注入清单，变了就经 stdout 补发一行 HOST-INJECTIONS（壳侧刷新 boot 载荷），
// 让下一次刷新直接落在新图上。与上游每请求现采同源，成本同量级（内存图快照）。
const INJECTIONS_WATCH_MS = 1_000
let reportedInjections = injections
const injectionsWatch = setInterval(() => {
  let fresh
  try {
    fresh = ctx.webServer.collectIndexInjections()
  } catch (error) {
    console.error(`[host] 注入清单采集失败（跳过本轮）：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (!Array.isArray(fresh)) return
  if (JSON.stringify(fresh) === JSON.stringify(reportedInjections)) return
  reportedInjections = fresh
  console.log(`[host] 注入清单更新：injections = ${String(fresh.length)}（client-module 图重算，已上报壳）`)
  console.log(`HOST-INJECTIONS ${JSON.stringify({ type: 'injections', injections: fresh })}`)
}, INJECTIONS_WATCH_MS)
injectionsWatch.unref?.()

// 壳要求退出时，把关闭交给运行时（对齐官方 shutdown 语义）。
// 用函数声明（会提升）：父进程看门狗可能在 await 之前就触发。
let disposed = false
function shutdown(reason = 'signal') {
  if (disposed) return
  disposed = true
  try {
    clearInterval(injectionsWatch)
  } catch {}
  console.log(`[host] 退出（${reason}）`)
  try {
    application.dispose?.()
  } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('message', (message) => {
  if (message === 'shutdown') shutdown()
})
