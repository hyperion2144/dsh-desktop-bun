// macOS 主进程 handoff 的构建期安装器：把 full app 内的原生 launcher 换成 exec shim。
//
// 不能只改 bootstrap：hutch 的 bootstrap 里 launcher 负责首启自解压，换成 shim 会打不开；
// sign-app 已经会把 payload 里的完整树解出来重签，所以 full app（payload 内层或已解压形态）
// 在签名前换成 shim 即可，外层 bootstrap 保持原生 launcher。

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const shimSource = readFileSync(join(here, 'macos-launcher.sh'), 'utf8')

/** 判断文件是否 Mach-O；shim 本身不是 Mach-O，不能参与 codesign 归属断言。 */
export function isMachOFile(path) {
  const probe = spawnSync('/usr/bin/file', ['-b', path], { encoding: 'utf8' })
  return (probe.stdout ?? '').includes('Mach-O')
}

/** bootstrap 形态：Resources 下只有一个 .tar.zst payload；full app 形态没有 payload。 */
export function hasBootstrapPayload(appPath) {
  const resources = join(appPath, 'Contents', 'Resources')
  if (!existsSync(resources)) return false
  return readdirSync(resources).some((name) => name.endsWith('.tar.zst'))
}

/**
 * 把 full app 的 Contents/MacOS/launcher 换成 exec shim；原 launcher 保留为 launcher.native。
 * 返回是否安装（非 darwin / 无 MacOS 目录时不安装）。
 */
export function installMacosLauncherShim(appPath) {
  if (process.platform !== 'darwin') return false
  const macosDir = join(appPath, 'Contents', 'MacOS')
  if (!existsSync(macosDir)) return false
  const launcher = join(macosDir, 'launcher')
  const nativeLauncher = join(macosDir, 'launcher.native')
  if (existsSync(launcher) && isMachOFile(launcher)) {
    if (existsSync(nativeLauncher)) rmSync(nativeLauncher, { force: true })
    renameSync(launcher, nativeLauncher)
    console.log(`[macos-launcher] 保留原生 launcher：${nativeLauncher}`)
  }
  writeFileSync(launcher, shimSource, { mode: 0o755 })
  console.log(`[macos-launcher] 安装 exec shim：${launcher}`)
  return true
}
