// 壳主进程的 shell.log 落盘（#80 取证缺口）——#221 起改为统一日志内核的壳源适配层。
//
// 旧实现：本文件与 service.ts 各自 createLogSink 同一个 shell.log，互不知情
// （N+1 写者，各自记账、轮转会互相挤掉历史份）。#224 Decision v2 第 1 条把这
// 份重复合并掉：这里只保留「路径解析 + 懒单例 + stdout 镜像防递归 + console tee」
// 这层壳语义，写盘/轮转/级别过滤/归档全部下沉到 bun/logging 内核（进程级唯一 sink）。
// LogSink 的 size/rotate/flush 在内核接管后语义不变：size 读内核台账，rotate 显式触发，
// flush 是 no-op（内核逐行同步写，无缓冲）。

import { type LogSink, type LogSinkOptions } from './log-sink.ts'
import { dshHome } from '../runtime/runtime.ts'
import { loggingKernel } from '../logging/kernel.ts'
import { join } from 'node:path'
import { format } from 'node:util'
import { type LogLevel } from '../../shared/logging/levels.ts'
/** shell.log 路径解析（与 service.ts 的 `#1` 口径一致：DSH_SHELL_LOG 优先，兜 dshHome）。 */
export function resolveShellLogFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_SHELL_LOG ?? join(dshHome(env), 'shell.log')
}

let instance: LogSink | null = null

/**
 * 主进程共享的 shell.log sink（懒创建单例；init 只在首次生效，之后忽略——
 * 测试需要换路径/换参数时传 statIntervalMs: 0 之类，须保证是本进程首次调用）。
 */
export function shellLogSink(init?: Partial<Pick<LogSinkOptions, 'statIntervalMs' | 'maxBytes' | 'keep'>>): LogSink {
  if (instance === null) {
    // 在 sink 创建时锁住**当前** console.log：installShellConsoleTee 会随后替换全局 console，
    // 晚绑定会「写日志 → 镜像 stdout → 再写日志」无限递归；测试也能 spy 到镜像行。
    const originalConsoleLog = console.log.bind(console)
    // 进程级唯一内核单例；shell 源路径与 resolveShellLogFile 同口径（DSH_SHELL_LOG 优先）。
    // init 的 statIntervalMs/maxBytes/keep 是旧参数面：轮转策略已上收内核（10MB/天/保留清理），
    // 这里收下但不再生效，保住调用方兼容。
    void init
    const inner = loggingKernel({ home: dshHome(), files: { shell: resolveShellLogFile() } }).shellSink({
      stdout: (line) => {
        // 未装 tee：用当前 console.log（测试可 spy）；装了就锁原始 console 防递归。
        if (consoleTeeInstalled) originalConsoleLog(line)
        else console.log(line)
      },
    })
    instance = {
      path: inner.path,
      write: (text) => inner.write(text),
        line: (message, level) => inner.line(message, level),
      size: () => loggingKernel().fileStat('shell').bytes,
      tail: (lines) => inner.tail(lines),
      rotate: () => loggingKernel().rotate('shell', 'size'),
      flush: () => { },
    }
  }
  return instance
}

/** 测试隔离口：与 resetLoggingKernelForTests 配套——内核复位后，这里缓存的适配器也必须跟着换，
 * 否则旧适配器还攥着旧内核（路径定格在首次创建时的 env）。 */
export function resetShellLogSinkForTests(): void {
  instance = null
}

/** 主进程一行进 shell.log（时间戳由 sink 统一加；行格式与 service 层一致）。level 缺省 info。 */
export function shellLogLine(message: string, level?: LogLevel): void {
    shellLogSink().line(message, level)
}

/**
 * 把主进程的 console.log/warn/error tee 进 shell.log（#80 取证缺口的根治版）：
 * 打包态壳进程的 stdout 没人接，所有 `[shell]` 前缀行原本只活在终端里；
 * 包一层后每条 console 行同时落盘，dev 终端行为不变。
 *
 * 必须只装一次；stdout 镜像已在 shellLogSink 里锁住原始 console，不会递归。
 */
let consoleTeeInstalled = false

export function installShellConsoleTee(): void {
  if (consoleTeeInstalled) return
  consoleTeeInstalled = true
  const sink = shellLogSink()
  // 先把四个 console 方法的原始实现各存一份再统一包装：部分运行时里 console.debug 与
  // console.log 是同一个实现，逐个 bind 会把已包装的 log 再包一层，造成同一行写盘两次。
  const originals = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }
    // console 级别 → 全局四档（log 即 info）；console 参数（含 %s/%d 占位符）在这里——
    // 调用边界——用 util.format 格式化成最终消息文本，内核不再做任何前缀解析。
    const teeLevels = { log: 'info', warn: 'warn', error: 'error', debug: 'debug' } as const satisfies Record<string, LogLevel>
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
        const original = originals[level]
        const mapped = teeLevels[level]
        console[level] = (...args: unknown[]) => {
            original(...args)
            try {
                sink.line(format(...args), mapped)
            } catch { }
        }
    }

    }
