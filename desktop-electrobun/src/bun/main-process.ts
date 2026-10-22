// 主进程（守护）编排入口（map #240 / #243）。
//
// launcher 占用的进程就是它：零窗、无托盘、不跑 DSH/服务面——只管理壳进程
// （拉起/杀掉/重启/watchdog）。它由原「临时拉起的监督守护进程」进化而来：
// 提前到启动链最前面并常驻（壳怎么折腾主进程都不退）。
//
// 本文件刻意不 import electrobun——native 主线程（CEF/Dock 图标）由 launcher
// 的 main.js 装载序列负责（dlopen → new Worker(本文件) → run_main_thread），
// 这里只做纯编排。

import { dirname, join } from 'node:path'
import { appSupportDir, resolveLauncherForRelaunch } from './runtime/runtime.ts'
import { installShellConsoleTee, resolveShellLogFile } from './platform/shell-log.ts'
import { runDaemon } from './daemon/run.ts'
import { DAEMON_ACTIVATE_PATH } from './daemon/control.ts'

installShellConsoleTee()

const log = {
  info: (msg: string, ...rest: unknown[]) => console.log(`[main] ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`[main] ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) => console.error(`[main] ${msg}`, ...rest),
}

const appSupport = appSupportDir()
const launcherExe = resolveLauncherForRelaunch().launcherExe
const shellLogFile = join(dirname(resolveShellLogFile()), 'shell-relay.log')

/**
 * 壳侧 CEF 身份：<identifier>-shell（#243 冒烟实抓：主进程与壳同 identifier ⇒ 同一
 * CEF 数据目录的 ProcessSingleton 互斥，后到方 abort 退出）。壳换目录、主进程保留默认；
 * 读不到 version.json（dev 等）= 不覆盖，降级同旧版行为。
 */
function resolveShellCefIdentity(bundleDir: string): string | null {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const raw = fs.readFileSync(join(bundleDir, '..', '..', 'version.json'), 'utf8') as string
    const parsed = JSON.parse(raw) as { identifier?: string }
    if (typeof parsed.identifier !== 'string' || parsed.identifier === '') return null
    return `${parsed.identifier}-shell`
  } catch {
    return null
  }
}

const handle = await runDaemon({
  appSupport,
  launcherExe,
  shellLogFile,
  spawnShellOnBoot: true,
  shellCefIdentity: resolveShellCefIdentity(import.meta.dir) ?? undefined,
  onLog: log,
})

if (handle.role === 'yielded') {
  // 已有主进程在跑：本次启动（用户又点了一次图标）的意图就是「给我开桌面」——
  // 通知已有主进程拉壳（壳活着则幂等不动），本实例随即退（单实例激活语义，
  // 三平台统一；mac 上壳常驻+关窗只隐藏，走到这里的都是壳真退过的场景）。
  if (handle.previousOrigin !== null) {
    const activated = await requestActivate(handle.previousOrigin)
    log.info(activated ? '已通知已有主进程拉起桌面' : '通知已有主进程失败（它可能刚退出）')
  }
  process.exit(0)
}

log.info(`主进程就绪（pid=${String(process.pid)}）：壳 pid=${String(handle.shellPid ?? 0)}`)

// 信号清理：杀壳（等死透）→ 停控制通道 → 释放主锁 → 退。
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`收到 ${signal}：收尾（杀壳+释放主锁）`)
    void handle
      .stop({ killShell: true })
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  })
}

/** 通知已有主进程拉壳（activate 端点免凭据：单实例激活的第二实例天然没有 token）。 */
async function requestActivate(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}${DAEMON_ACTIVATE_PATH}`, { method: 'POST' })
    return response.ok
  } catch {
    return false
  }
}
