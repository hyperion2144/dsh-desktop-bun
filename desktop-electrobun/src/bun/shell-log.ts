// 壳主进程的 shell.log 落盘（#80 取证缺口）。
//
// 现状：service.ts 的日志走 createLogSink 进 shell.log，而主进程（index.ts）
// 只有裸 console.log——打包态壳进程的 stdout 没人接，所有 `[shell]` 前缀行
// （含 #80 heal 自检）在生产环境全部丢失，票面的「带回日志行」取证路径失效。
//
// 这里给主进程一份自己的 sink：与 service.ts 的 sink 各自独立（appendFileSync
// 每次重开文件 + 周期重新 stat，天然支持多写者同文件，轮转后 ≤1s 自动跟上新份），
// 服务面的 sink 与轮转配置一概不动。stdout 镜像保留 dev 终端可见性。

import { createLogSink, type LogSink, type LogSinkOptions } from './log-sink.ts'
import { dshHome } from './runtime.ts'
import { join } from 'node:path'

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
  instance ??= createLogSink({
    file: resolveShellLogFile(),
    // 低频诊断行，逐行同步写足够；不设 bufferMs 免掉退出钩子
    stdout: (line) => console.log(line),
    ...init,
  })
  return instance
}

/** 主进程一行进 shell.log（时间戳由 sink 统一加；行格式与 service 层一致）。 */
export function shellLogLine(message: string): void {
  shellLogSink().line(message)
}
