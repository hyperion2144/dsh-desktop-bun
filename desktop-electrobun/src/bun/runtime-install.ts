// 运行时下载安装：把 `@deepseek-ai/dsh@<version>` 装成一棵 hoisted 运行时树
// （旧壳 `desktop/src-tauri/src/runtime/registry.rs::pnpm_add_runtime` 的等价物）。
//
// 与旧壳的两处差别（都是本仓的既定方向）：
// ① 包管理器跑在**我们的 Bun** 上（`<bun> <pnpm.cjs> add …`），不再依赖系统 Node（#211 的结论）；
// ② 安装进度是壳侧单飞状态，面板每 600ms 轮询 `runtime_download_status` 读它（页面是 loopback origin，
//   事件通道照旧不用）。
//
// 旧壳踩过的坑全部照抄：独立 store（#114）、`packages: []` 截断 workspace 向上搜索（#95）、
// hoisted 平铺（#95）、allowBuilds 白名单（#135）、错误尾巴优先 stderr 再回退 stdout（#95 Bug 1）。

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { NPM_PACKAGE, isRuntimeVersion } from '../shared/runtime-catalog.ts'
import { runtimeNpmrc, runtimeWorkspaceYaml } from '../shared/profile-template.ts'
import { isRuntimeTreeValid, runtimeDirOf, runtimesDir } from './runtime-store.ts'
import { createPlatformProbe, stopProcessTree } from './process-tree.ts'


/**
 * 用户取消安装（#97）——**独立终态，不是失败**：面板据此显示中性「已取消」而不是红色失败，
 * 也不会回落成「安装失败（exit -15）」那种吓人的报错文案。
 */
export class RuntimeInstallCancelledError extends Error {
  constructor(version: string) {
    super(`dsh ${version} 安装已取消`)
    this.name = 'RuntimeInstallCancelledError'
  }
}
export const INSTALL_TIMEOUT_MS = 15 * 60_000
/** 失败报错里保留的输出行数（旧壳同口径：stderr 去噪后截尾 12 行） */
export const OUTPUT_TAIL_LINES = 12

export interface PnpmProgress {
  resolved: number
  downloaded: number
  added: number
}

// pnpm 11 的 default reporter 在 resolved 与 downloaded 之间多一段 `reused N,`（旧壳的解析器没算它，
// 于是从来没读到过进度）；这里把 reused 当可选段，新旧两种格式都认。
const PROGRESS_PATTERN =
  /Progress:\s*resolved\s+([\d,]+),\s*(?:reused\s+[\d,]+,\s*)?downloaded\s+([\d,]+),\s*added\s+([\d,]+)/

/** `Progress: resolved 1,234, downloaded 5, added 2` → 三个数字（非进度行回 null）。 */
export function parsePnpmProgress(line: string): PnpmProgress | null {
  const match = PROGRESS_PATTERN.exec(line)
  if (match === null) return null
  const toNumber = (raw: string | undefined): number => Number.parseInt((raw ?? '').replace(/,/g, ''), 10) || 0
  return { resolved: toNumber(match[1]), downloaded: toNumber(match[2]), added: toNumber(match[3]) }
}

/** node 的 TLS 告警与 `(node:1) Warning:` 噪声（旧壳同款过滤）。 */
function denoise(text: string): string {
  return text
    // pnpm 的 default reporter 会打 ANSI 光标控制码（进度行靠它原地重画），报错里不需要它们
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .filter((line) => !line.includes('NODE_TLS_REJECT_UNAUTHORIZED'))
    .filter((line) => !/^\(node:\d+\)/.test(line.trim()))
    .join('\n')
}

export function tailLines(text: string, count = OUTPUT_TAIL_LINES): string {
  const lines = denoise(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
  return lines.slice(-count).join('\n')
}

/** 错误尾巴：stderr 有真东西就用它，否则回退 stdout（pnpm 非 TTY 下把 ERR_* 打到 stdout）。 */
export function pickInstallerErrorTail(stderr: string, stdout: string): string {
  const fromErr = tailLines(stderr)
  if (fromErr !== '') return fromErr
  return tailLines(stdout)
}

/** node 垫片：pnpm 的构建脚本会找 PATH 上叫 `node` 的命令，而本仓只有 Bun。 */
export function nodeShimScript(bunPath: string): string {
  return `#!/bin/sh\nexec "${bunPath}" "$@"\n`
}

/** pnpm 垫片（#70）：宿主 PATH 上的 `pnpm` → 我们的 Bun 跑内置 pnpm.cjs（不再依赖系统装了 pnpm）。 */
export function pnpmShimScript(bunPath: string, pnpmCjs: string): string {
  return `#!/bin/sh\nexec "${bunPath}" "${pnpmCjs}" "$@"\n`
}

/**
 * Windows 垫片形态（.cmd）：execa 在 Windows 上把裸命令交给 cmd.exe 解析，只认得到 `.cmd`；
 * `@` 免回显、`%*` 透传参数，CRLF 保险。
 */
export function shimCmdScript(bunPath: string, pnpmCjs?: string): string {
  const target = pnpmCjs === undefined ? '' : ` "${pnpmCjs}"`
  return `@"${bunPath}"${target} %*\r\n@exit /b %ERRORLEVEL%\r\n`
}

export interface EnsureShimDirInput {
  appSupport: string
  bunPath: string
  hasNode: boolean
  /** 内置 pnpm.cjs（#70 宿主 PATH 垫片）；null/缺省 = 只管 node 垫片（旧通道语义） */
  pnpmCjs?: string | null
  log?: (line: string) => void
}

/**
 * 物化垫片目录（`<appSupport>/runtimes/.node-shim`，POSIX 与 Windows 形态都写、互相无害）：
 * 目录名沿用 node 垫片时代的 `.node-shim`（历史名，现同时容纳 pnpm 垫片；已落盘的持久路径，不改名以免留孤儿）。
 * - 没有 node 时写 `node`/`node.cmd`（pnpm 构建脚本要找 node；有系统 node 就不插手）；
 * - 有 pnpmCjs 时写 `pnpm`/`pnpm.cmd`（#70：宿主子进程解析到内置 pnpm，全新机器也可解析）。
 * - pnpmCjs 显式为 null（宿主通道、解析不到）时清掉陈旧 pnpm 垫片（不留死垫片）；旧通道
 *   （pnpmCjs 缺省，ensureNodeShim）从不写/删 pnpm 垫片，行为与 #70 前完全一致。
 * 返回垫片目录；没有可写的垫片（或写失败）回 null，调用方就不动 PATH。
 */
export function ensureShimDir(input: EnsureShimDirInput): string | null {
  const wantsNode = !input.hasNode
  const hostChannel = input.pnpmCjs !== undefined // 旧通道（ensureNodeShim）与 pnpm 垫片无涉：不写也不删
  const wantsPnpm = hostChannel && input.pnpmCjs !== null && input.pnpmCjs !== ''
  // 宿主通道 + 解析不到：清掉陈旧 pnpm 垫片——只写不删的话，切运行时/删树后宿主 PATH 会踩到
  // 指向已删 pnpm.cjs 的死垫片（报「模块找不到」而非干净 ENOENT，更难排查）。
  const cleanPnpm = hostChannel && !wantsPnpm
  if (!wantsNode && !wantsPnpm && !cleanPnpm) return null
  const dir = join(runtimesDir(input.appSupport), '.node-shim')
  try {
    mkdirSync(dir, { recursive: true })
    if (wantsNode) {
      // 系统里有 node 就不插手：让构建脚本用它最稳（我们不改用户的工具链）。
      writeFileSync(join(dir, 'node'), nodeShimScript(input.bunPath), { mode: 0o755 })
      writeFileSync(join(dir, 'node.cmd'), shimCmdScript(input.bunPath), { mode: 0o755 })
      input.log?.(`垫片：PATH 上没有 node，已用 Bun 垫片（${join(dir, 'node')}）`)
    }
    if (wantsPnpm && input.pnpmCjs) {
      writeFileSync(join(dir, 'pnpm'), pnpmShimScript(input.bunPath, input.pnpmCjs), { mode: 0o755 })
      writeFileSync(join(dir, 'pnpm.cmd'), shimCmdScript(input.bunPath, input.pnpmCjs), { mode: 0o755 })
      input.log?.(`垫片：内置 pnpm 已进宿主 PATH（${dir}）`)
    }
    if (cleanPnpm) {
      rmSync(join(dir, 'pnpm'), { force: true })
      rmSync(join(dir, 'pnpm.cmd'), { force: true })
      input.log?.(`垫片：pnpm.cjs 解析不到，已清掉陈旧 pnpm 垫片（${dir}）`)
    }
    return wantsNode || wantsPnpm ? dir : null
  } catch (error) {
    input.log?.(`垫片目录创建失败（${error instanceof Error ? error.message : String(error)}）`)
    return null
  }
}

/** 旧通道（运行时安装/profile 依赖重建）的 node 垫片：语义与 #70 前完全一致（有 node 就不插手）。 */
export function ensureNodeShim(input: Omit<EnsureShimDirInput, 'pnpmCjs'>): string | null {
  return ensureShimDir(input)
}

export interface ResolvePnpmInput {
  env?: Record<string, string | undefined>
  /** 当前生效运行时树（内置或已下载） */
  runtimeRoot?: string | null
  builtinDir?: string | null
  appSupport: string
  isFileImpl?: (path: string) => boolean
}

/**
 * pnpm.cjs 的定位：显式 env > 当前运行时树 > 随包内置树 > 任一已下载树。
 * 内置树由 prepare:bundle 按 builtin-runtime.json 声明物化（#16），那份 pnpm 的版本即声明里的 pnpm 字段。
 */
export function resolvePnpmCjs(input: ResolvePnpmInput): string | null {
  const env = input.env ?? process.env
  const file = input.isFileImpl ?? ((path: string) => existsSync(path))
  const explicit = env.DSH_SHELL_PNPM
  if (explicit !== undefined && explicit !== '') {
    if (file(explicit)) return explicit
  }
  const roots = [input.runtimeRoot ?? null, input.builtinDir ?? null]
  for (const root of roots) {
    if (root === null || root === '') continue
    const candidate = join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    if (file(candidate)) return candidate
  }
  let entries: string[] = []
  try {
    entries = readdirSync(runtimesDir(input.appSupport), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    entries = []
  }
  for (const version of entries) {
    const candidate = join(runtimeDirOf(input.appSupport, version), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    if (file(candidate)) return candidate
  }
  return null
}

function lineSplitter(onLine: (line: string) => void): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder()
  let buffer = ''
  return (chunk: Uint8Array): void => {
    buffer += decoder.decode(chunk, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      onLine(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  }
}

async function pump(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  if (stream === null || stream === undefined) return
  const push = lineSplitter(onLine)
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) push(chunk)
}

export interface InstallRuntimeInput {
  appSupport: string
  version: string
  bunPath: string
  pnpmCjs: string
  /** 需要时把 `node` 垫片目录放到 PATH 最前（见 ensureNodeShim） */
  nodeShimDir?: string | null
  env?: Record<string, string | undefined>
  timeoutMs?: number
  onProgress?: (progress: PnpmProgress) => void
  onLog?: (line: string) => void
  /** #97：取消信号。到达后树级停止安装进程树 + 清半成品，并以 RuntimeInstallCancelledError 收场 */
  signal?: AbortSignal
  /** #97：树级停止实现（默认 process-tree.stopProcessTree；单测注入假实现，不真杀进程） */
  stopTree?: (input: { rootPid: number; rootExited: Promise<number> }) => Promise<void>
  spawnImpl?: (command: string[], options: Record<string, unknown>) => { exited: Promise<number>; stdout?: unknown; stderr?: unknown; kill?: () => void; pid?: number }
}

/**
 * 装一棵运行时树。失败时把半成品目录删掉并带上可读原因（面板直接显示它）。
 * 成功判据不是退出码而是 `isRuntimeTreeValid`（旧壳同判据）。
 */
export async function installRuntime(input: InstallRuntimeInput): Promise<void> {
  if (!isRuntimeVersion(input.version)) throw new Error(`版本号不合法：${input.version}`)
  const dir = runtimeDirOf(input.appSupport, input.version)
  if (isRuntimeTreeValid(dir)) throw new Error(`dsh ${input.version} 已经装好了`)
  const storeDir = join(runtimesDir(input.appSupport), '.pnpm-store')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: `dsh-runtime-${input.version}`, private: true }, null, 2)}\n`)
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), runtimeWorkspaceYaml(storeDir))
  writeFileSync(join(dir, '.npmrc'), runtimeNpmrc(storeDir))

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...(input.env ?? {}) })) {
    if (value !== undefined) env[key] = value
  }
  if (input.nodeShimDir !== undefined && input.nodeShimDir !== null && input.nodeShimDir !== '') {
    // Windows 上 PATH 的分隔符是 `;`
    env.PATH = `${input.nodeShimDir}${delimiter}${env.PATH ?? ''}`
  }
  const spawn = input.spawnImpl ?? ((command: string[], options: Record<string, unknown>) => Bun.spawn(command, options as never))
  input.onLog?.(`运行时安装：${input.bunPath} ${input.pnpmCjs} add ${NPM_PACKAGE}@${input.version}（cwd = ${dir}）`)
  // `--reporter=default`：非 TTY 下 pnpm 默认走 append-only，**不打 Progress 行**（本机实测），
  // 面板的进度就永远是 0；显式要 default reporter 才有进度可读（旧壳没带这个旗标，一直读不到）。
  const proc = spawn([input.bunPath, input.pnpmCjs, 'add', '--reporter=default', `${NPM_PACKAGE}@${input.version}`], {
    cwd: dir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  }) as {
    exited: Promise<number>
    stdout?: ReadableStream<Uint8Array> | null
    stderr?: ReadableStream<Uint8Array> | null
    kill?: () => void
    pid?: number
  }

  // #97：取消与超时都走**树级**停止。安装进程是 pnpm，再往下是它的构建/lifecycle 子进程，那些
  // 子进程继承着 stdout/stderr 的写端——只杀直接子进程，管道迟迟等不到 EOF，installRuntime 就
  // 永远不 settle，面板进度条也就永久转圈（与「装完了却一直转圈」同一个病根）。仓里已有
  // process-tree 的树级停止（#60），这里接上；单测通过 stopTree 注入假实现，不真杀进程。
  const stopTree =
    input.stopTree ??
    (async ({ rootPid, rootExited }): Promise<void> => {
      await stopProcessTree({
        rootPid,
        rootExited,
        probe: createPlatformProbe(),
        onLog: (line) => {
          input.onLog?.(line)
        },
      })
    })
  const procPid = typeof proc.pid === 'number' ? proc.pid : 0
  const stopInstallTree = (): void => {
    if (procPid > 0) {
      void stopTree({ rootPid: procPid, rootExited: proc.exited }).catch((error: unknown) => {
        input.onLog?.(`运行时安装：安装进程树停止失败：${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    // 拿不到 pid（自定义 spawnImpl / 平台不给）：退化为停单进程，好过放任它跑完。
    try {
      proc.kill?.()
    } catch {}
  }
  let cancelled = false
  const onAbort = (): void => {
    cancelled = true
    stopInstallTree()
    input.onLog?.(`运行时安装：收到取消信号，正在停止安装进程树（dsh ${input.version}）`)
  }
  if (input.signal !== undefined) {
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener('abort', onAbort, { once: true })
  }

  let stdoutTail = ''
  let stderrTail = ''
  const timeoutMs = input.timeoutMs ?? INSTALL_TIMEOUT_MS
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // #97：看门狗同样走树级停止——只杀 pnpm 直接子进程，它的构建/lifecycle 孙进程仍持管道写端，
    // 状态永远落不下来（进度条永久转圈的同一个病根）。
    stopInstallTree()
  }, timeoutMs)
  try {
    await Promise.all([
      pump(proc.stdout, (line) => {
        const progress = parsePnpmProgress(line)
        if (progress !== null) {
          input.onProgress?.(progress)
          return
        }
        stdoutTail = `${stdoutTail}${line}\n`.slice(-8000)
      }),
      pump(proc.stderr, (line) => {
        stderrTail = `${stderrTail}${line}\n`.slice(-8000)
      }),
    ])
    const code = await proc.exited
    // #97：取消优先于退出码判读。装完了才收到取消信号（竞态）时 installRuntime 早已 return 成功；
    // 走到这里说明确实是被取消打断的：清半成品 + 落取消终态，绝不报「安装失败（exit -15）」。
    if (cancelled) {
      rmSync(dir, { recursive: true, force: true })
      throw new RuntimeInstallCancelledError(input.version)
    }
    if (timedOut) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`dsh ${input.version} 安装超时（${Math.round(timeoutMs / 1000)}s）`)
    }
    if (code !== 0) {
      const tail = pickInstallerErrorTail(stderrTail, stdoutTail)
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`dsh ${input.version} 安装失败（exit ${String(code)}）${tail === '' ? '' : `：\n${tail}`}`)
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }
  if (!isRuntimeTreeValid(dir)) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`dsh ${input.version} 装完了但运行时树不完整（缺 node_modules/@deepseek-ai/dsh/lib/bin.js）`)
  }
}

/** 面板轮询读到的下载状态（旧壳 `runtime_download_status` 同形状 + #97 的 cancelled）。 */
export interface RuntimeDownloadStatus {
  active: boolean
  version: string
  resolved: number
  downloaded: number
  added: number
  error: string
  /** #97：最近一次任务是**用户取消**（独立终态，≠ 失败）。面板据此显示中性「已取消」+ 可重试，不弹失败红字。 */
  cancelled: boolean
}

export interface RuntimeDownloader {
  /** 单飞：已有任务在跑就直接抛「已有运行时下载任务」（旧壳同文案，面板认这个串） */
  start: (version: string, source: string) => Promise<{ ok: true; version: string }>
  status: () => RuntimeDownloadStatus
  /** #97：取消进行中的安装。幂等——没有任务时是 no-op（面板连点两次不炸也不报错）。 */
  cancel: () => Promise<{ cancelled: boolean; version: string }>
}

export interface DownloaderDeps {
  /** 真正的安装动作（service 里接 installRuntime；第三个参数是取消信号，取消时 install 抛 RuntimeInstallCancelledError） */
  install: (version: string, onProgress: (progress: PnpmProgress) => void, signal: AbortSignal) => Promise<void>
  /** 装成功后记进 installed.json */
  record: (version: string, source: string) => void
  log?: (line: string) => void
}

export function createRuntimeDownloader(deps: DownloaderDeps): RuntimeDownloader {
  let status: RuntimeDownloadStatus = { active: false, version: '', resolved: 0, downloaded: 0, added: 0, error: '', cancelled: false }
  /** 进行中任务的取消句柄（#97）；null = 当前没有任务 */
  let inflight: { version: string; controller: AbortController } | null = null
  return {
    status: () => ({ ...status }),
    start: async (version, source) => {
      if (status.active) throw new Error('已有运行时下载任务')
      const controller = new AbortController()
      inflight = { version, controller }
      status = { active: true, version, resolved: 0, downloaded: 0, added: 0, error: '', cancelled: false }
      try {
        await deps.install(
          version,
          (progress) => {
            status = { ...status, resolved: progress.resolved, downloaded: progress.downloaded, added: progress.added }
          },
          controller.signal,
        )
        deps.record(version, source)
        // #79：成功终态把 downloaded 对齐 resolved——pnpm 的最后一条 Progress 行往往停在下载中段
        // （linking 阶段不再打进度），原样保留就成了「86% 定格」的假活；装成了就是全部拉完。
        status = { active: false, version, resolved: status.resolved, downloaded: status.resolved, added: status.added, error: '', cancelled: false }
        deps.log?.(`运行时安装完成：dsh ${version}（来源 ${source}）`)
        return { ok: true as const, version }
      } catch (error) {
        // #97：取消是独立终态——error 留空，面板读到 cancelled 才显示「已取消」；失败才带 error。
        if (controller.signal.aborted || error instanceof RuntimeInstallCancelledError) {
          status = { active: false, version, resolved: status.resolved, downloaded: status.downloaded, added: status.added, error: '', cancelled: true }
          deps.log?.(`运行时安装已取消：dsh ${version}`)
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        // #79：失败终态原样保留最后进度快照 + error——面板靠 error 判定失败、靠数字展示「拉到哪断的」。
        status = { active: false, version, resolved: status.resolved, downloaded: status.downloaded, added: status.added, error: message, cancelled: false }
        deps.log?.(`运行时安装失败：dsh ${version} —— ${message}`)
        throw error
      } finally {
        inflight = null
      }
    },
    cancel: async () => {
      const task = inflight
      if (task === null || !status.active) return { cancelled: false, version: '' }
      deps.log?.(`运行时安装取消中：dsh ${task.version}`)
      task.controller.abort()
      // 终态（cancelled 标记 + 半成品清理）由安装收尾路径落状态，面板从轮询快照读到；这里只
      // 回报「取消已受理」——官方通道 120s 上限会把长回包丢掉，面板不能等这个 Promise 收尾。
      return { cancelled: true, version: task.version }
    },
  }
}
