import { readlinkSync, symlinkSync } from 'node:fs'

/**
 * 目录链接的 Windows 安全封装。
 *
 * 为什么需要：Windows 上「符号链接」需要管理员或开发者模式，普通用户进程 symlinkSync
 * 直接 EPERM——插件池挂载（materializePoolPackage）与 profile 依赖树摊平（reconcileProfile）
 * 全靠目录链接，Windows 上全军覆没（实机症状：桌面三插件没注入、设置面板没有桌面 tab）。
 * 目录联接（junction）不需要特权，指向绝对路径，效果等同；非 Windows 平台维持原 symlink。
 */
export function createDirLink(target: string, link: string): 'junction' | 'symlink' {
  if (process.platform === 'win32') {
    try {
      symlinkSync(target, link, 'junction')
      return 'junction'
    } catch {
      // 个别环境禁 junction 时再退回 symlink（失败由调用方处理）
    }
  }
  symlinkSync(target, link, 'dir')
  return 'symlink'
}

/** 读目录链接的指向；Windows junction 会带 `\\?\` 前缀，这里剥掉以便路径比较。 */
export function readDirLink(link: string): string | null {
  try {
    const raw = readlinkSync(link)
    return raw.startsWith('\\\\?\\') ? raw.slice(4) : raw
  } catch {
    return null
  }
}
