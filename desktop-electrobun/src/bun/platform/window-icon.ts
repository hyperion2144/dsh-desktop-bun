// Windows 运行中窗口的任务栏/缩略图图标（#203）。
//
// 为什么需要这一层：Electrobun 的 BrowserWindow 没有 icon 选项（读全 WindowOptionsType 确认），
// native 注册的窗口类不携带应用图标 → 运行中窗口的任务栏按钮与悬停缩略图回退系统默认白框。
// #199 已把官方多帧 ico 嵌进 launcher.exe 的资源段，但 exe 资源图标只影响 Explorer 对**文件**的
// 展示（固定/开始菜单走 lnk 的 IconUri），不进窗口类——必须在窗口层面补。
//
// 做法（壳进程 bun 侧 FFI，与 devtools 合成 F12 同一路径风格）：
//   1. LoadImageW(LR_LOADFROMFILE) 从安装树的 ico 文件加载大/小图标（HICON 是共享 GDI 句柄，
//      可跨进程用）。装包诊断实证 ExtractIconExW 读不出 rcedit 嵌的资源段（返回 -1），
//      已按维护者指令删掉 exe 提取路；候选路径依次试 bin/ 与 Resources/。
//   2. 枚举顶层窗口，命中「本进程或 launcher.exe/bun.exe 进程」的逐个 WM_SETICON（立即生效）——
//      Windows 上壳窗口（含 WebView2 容器顶层窗）由 launcher.exe 进程创建，bun 只是 JS 工作进程，
//      所以过滤不能只看 process.pid（首版教训：只过滤本进程 pid 枚举到 0 扇窗口）；
//   3. 对**自己进程**的窗口额外 SetClassLongPtrW 改类默认（跨进程改类无效）；窗口集合变化时
//      重新跑一遍（幂等），覆盖后建的主窗与弹窗。
// 全部防御式：FFI 不可用/提不出图标/枚举不到窗口都只记日志返回原因，绝不拖垮启动。

import { dlopen, ptr } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Logger } from '../../shared/logging/levels.ts'

const WM_SETICON = 0x0080
const ICON_SMALL = 0
const ICON_BIG = 1
const GCLP_HICON = -14
const GCLP_HICONSM = -34
const IMAGE_ICON = 1
const LR_LOADFROMFILE = 0x10
const ICON_BIG_SIZE = 32
const ICON_SMALL_SIZE = 16


/** 壳侧可持有图标窗口的进程镜像名（小写比对；bun 是 JS 工作进程，launcher 是窗口宿主）。 */
export const WINDOW_HOST_IMAGE_HINTS = ['launcher.exe', 'bun.exe']

/** 镜像路径尾段是否命中窗口宿主 hints（供跨进程窗口过滤与单测复用）。 */
export function imageMatchesHints(imagePath: string, hints: readonly string[] = WINDOW_HOST_IMAGE_HINTS): boolean {
  const base = imagePath.replaceAll('\\', '/').split('/').pop() ?? ''
  return hints.includes(base.toLowerCase())
}
export interface ApplyWindowIconResult {
  /** true ⇒ 至少对一个窗口完成了设置 */
  ok: boolean
  /** 处理到的本进程顶层窗口数 */
  windows: number
  /** ok=false 时的人话原因（直接进日志） */
  reason: string | null
}

/**
 * tasklist 之外本仓第二个 Windows 专属 FFI 面。user32 的四件套足够：
 * FindWindowExW 枚举顶层窗口（不回调，循环推进）、GetWindowThreadProcessId 过滤本进程、
 * SendMessageW 发 WM_SETICON、SetClassLongPtrW 改窗口类（GCLP_HICON/GCLP_HICONSM）。
 */
interface HostLibs {
  findWindowExW: (parent: bigint | null, after: bigint | null, cls: bigint | null, title: bigint | null) => bigint | null
  getWindowThreadProcessId: (hwnd: bigint, outPid: unknown) => number
  sendMessageW: (hwnd: bigint, msg: number, wparam: number, lparam: bigint) => bigint
  setClassLongPtrW: (hwnd: bigint, index: number, value: bigint) => bigint
  loadImageW: (inst: bigint | null, name: unknown, type: number, cx: number, cy: number, flags: number) => bigint | null
  openProcess: (access: number, inherit: number, pid: number) => bigint
  imageOfProcess: (handle: bigint, flags: number, buffer: unknown, sizePtr: unknown) => number
}
let hostLibsCache: HostLibs | null = null

const pidImageCache = new Map<number, string | null>()

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const IMAGE_PATH_BUFSIZE = 1024
const utf16 = new TextDecoder('utf-16le')

function loadHostLibs(): HostLibs {
  if (hostLibsCache !== null) return hostLibsCache
  const user32 = dlopen('user32.dll', {
    FindWindowExW: { args: ['ptr', 'ptr', 'ptr', 'ptr'], returns: 'ptr' },
    GetWindowThreadProcessId: { args: ['ptr', 'ptr'], returns: 'u32' },
    SendMessageW: { args: ['ptr', 'u32', 'usize', 'usize'], returns: 'usize' },
    SetClassLongPtrW: { args: ['ptr', 'i32', 'usize'], returns: 'usize' },
  }).symbols
  const user32Extra = dlopen('user32.dll', {
    // 路径是 LPCWSTR，不能走 'cstring'（UTF-8），用 'ptr' + 自编 UTF-16 缓冲
    LoadImageW: { args: ['ptr', 'ptr', 'u32', 'i32', 'i32', 'u32'], returns: 'ptr' },
  }).symbols
  const kernel32 = dlopen('kernel32.dll', {
    OpenProcess: { args: ['u32', 'u32', 'u32'], returns: 'ptr' },
    QueryFullProcessImageNameW: { args: ['ptr', 'u32', 'ptr', 'ptr'], returns: 'u32' },
  }).symbols
  hostLibsCache = {
    findWindowExW: user32.FindWindowExW as HostLibs['findWindowExW'],
    getWindowThreadProcessId: user32.GetWindowThreadProcessId as HostLibs['getWindowThreadProcessId'],
    sendMessageW: user32.SendMessageW as HostLibs['sendMessageW'],
    setClassLongPtrW: user32.SetClassLongPtrW as HostLibs['setClassLongPtrW'],
    loadImageW: user32Extra.LoadImageW as HostLibs['loadImageW'],
    openProcess: kernel32.OpenProcess as HostLibs['openProcess'],
    imageOfProcess: kernel32.QueryFullProcessImageNameW as HostLibs['imageOfProcess'],
  }
  return hostLibsCache
}

/** 查 pid 的进程镜像名（小写；带缓存）。读不到（权限/已退）返回 null，按不命中处理。 */
function imageOfPid(libs: HostLibs, pid: number): string | null {
  if (pidImageCache.has(pid)) return pidImageCache.get(pid) ?? null
  let image: string | null = null
  try {
    const handle = libs.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
    if (handle !== 0n && handle !== null) {
      const buffer = new ArrayBuffer(IMAGE_PATH_BUFSIZE * 2)
      const sizeBuf = new Uint32Array([IMAGE_PATH_BUFSIZE])
      if (libs.imageOfProcess(handle, 0, ptr(buffer), ptr(sizeBuf)) !== 0) {
        const size = sizeBuf[0] ?? 0
        const text = utf16.decode(buffer.slice(0, size * 2))
        // 返回完整镜像路径（小写）；尾段提取与反斜杠归一交给 imageMatchesHints（
        // 首版教训：这里曾内联 replaceAll('\\\\', '/') —— 字面是「两个反斜杠」，
        // Windows 单反斜杠路径根本不被归一，永远不命中宿主 hints → 一个窗口都没设图标。
        image = text.toLowerCase()
      }
    }
  } catch {
    image = null
  }
  pidImageCache.set(pid, image)
  return image
}

/** UTF-16LE 编码（LoadImageW 的 LPCWSTR 入参用；含终止符）。 */
function utf16Buffer(text: string): ArrayBuffer {
  const out = new ArrayBuffer(text.length * 2 + 2)
  const view = new Uint16Array(out)
  for (let i = 0; i < text.length; i += 1) view[i] = text.charCodeAt(i)
  return out
}

interface ResolvedIcons {
  big: bigint
  small: bigint
  /** 图标来源（进日志，定位用）。 */
  how: string
}

let iconsFailure: string | null = null // 失败只记一次：refreshTray 高频重入不刷屏，失败原因不会自愈

function ensureIcons(libs: HostLibs, icoCandidates: readonly string[]): ResolvedIcons | null {
  if (iconsFailure !== null) return null
  for (const icoFile of icoCandidates) {
    if (!existsSync(icoFile)) continue
    try {
      const big = libs.loadImageW(null, ptr(utf16Buffer(icoFile)), IMAGE_ICON, ICON_BIG_SIZE, ICON_BIG_SIZE, LR_LOADFROMFILE) ?? 0n
      const small = libs.loadImageW(null, ptr(utf16Buffer(icoFile)), IMAGE_ICON, ICON_SMALL_SIZE, ICON_SMALL_SIZE, LR_LOADFROMFILE) ?? 0n
      if (big !== 0n || small !== 0n) {
        // 只加载到一边时另一边复用同一句柄：任务栏用大图（32），标题栏/缩略图角标用小图（16）
        return { big: big !== 0n ? big : small, small: small !== 0n ? small : big, how: `ico 文件 ${icoFile}` }
      }
    } catch {
      // 换下一个候选
    }
  }
  iconsFailure = `安装树里找不到可加载的 ico（候选：${icoCandidates.map((p) => `${p}${existsSync(p) ? '' : ' [缺失]'}`).join('、')}）`
  return null
}

/** 安装树里的 ico 候选（依次试）：bin/ 是安装器拷贝，Resources/ 是打包既有物。 */
export function windowIconCandidates(execDir: string): string[] {
  return [
    join(execDir, 'app-icon.ico'),
    resolve(execDir, '..', 'Resources', 'app-icon.ico'),
    resolve(execDir, '..', 'Resources', 'app.ico'),
  ]
}

export function applyWindowsIcon(log: Logger, icoCandidates: readonly string[]): ApplyWindowIconResult {
  if (process.platform !== 'win32') return { ok: false, windows: 0, reason: '非 Windows 平台' }
  try {
    const libs = loadHostLibs()
    const icons = ensureIcons(libs, icoCandidates)
    if (icons === null) {
      const reason = iconsFailure ?? '拿不到图标'
      log.warn(`窗口图标设置失败（不影响启动）：${reason}`)
      return { ok: false, windows: 0, reason }
    }
    const { big, small } = icons
    const pidBuf = new Uint32Array(1)
    const myPid = process.pid
    let count = 0
    let after: bigint | null = null
    // 顶层窗口枚举：FindWindowExW(hwndParent=NULL, hwndChildAfter=上一次, cls=NULL, title=NULL)
    // 逐个推进到 NULL 为止。窗口宿主是 launcher.exe 进程（bun 只是 JS 工作进程），
    // 所以命中「本进程 pid 或镜像名命中宿主 hints」都算壳窗口。
    for (;;) {
      // 64 位运行时 'ptr' 返回就是 bigint；显式标注打断 hwnd↔after 的自引用推导
      const hwnd: bigint | null = libs.findWindowExW(null, after, null, null)
      if (hwnd === null || hwnd === 0n) break
      after = hwnd
      libs.getWindowThreadProcessId(hwnd, ptr(pidBuf))
      const ownerPid = pidBuf[0] ?? 0
      const isHost = ownerPid === myPid || imageMatchesHints(imageOfPid(libs, ownerPid) ?? '')
      if (!isHost) continue
      count += 1
      // HICON 是共享 GDI 句柄，跨进程 WM_SETICON 有效
      libs.sendMessageW(hwnd, WM_SETICON, ICON_BIG, big)
      libs.sendMessageW(hwnd, WM_SETICON, ICON_SMALL, small)
      if (ownerPid === myPid) {
        // 类默认图标只对自己进程的窗口有效；宿主进程的后续窗口靠重跑本函数覆盖
        libs.setClassLongPtrW(hwnd, GCLP_HICON, big)
        libs.setClassLongPtrW(hwnd, GCLP_HICONSM, small)
      }
    }
    if (count === 0) {
      return { ok: false, windows: 0, reason: '没有枚举到壳窗口（launcher/bun 进程的顶层窗口）' }
    }
    log.debug(`窗口图标已设置（${icons.how} → ${String(count)} 扇壳窗口；宿主进程窗口随窗口集合变化重跑覆盖）`)
    return { ok: true, windows: count, reason: null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log.warn(`窗口图标设置失败（不影响启动）：${reason}`)
    return { ok: false, windows: 0, reason }
  }
}
