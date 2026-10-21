// 测试用的 Logger 桩（#228：壳的日志通道改成按级别分流后，测试注入点也得分级别）。
//
// 过去壳里的日志通道是一个 `(line) => void` 回调，谁写都一样；现在每个通道都是
// Logger（debug/info/warn/error + 结构化参数），测试要断言的东西通常还是那两件：
//   「有没有写」与「写了什么」——前者用 silentLogger，后者用 collectingLogger；
// 需要按级别区分时用 recordingLogger（级别 + 最终文本一起收）。

import { formatMessage, type LogLevel, type Logger } from '../../src/shared/logging/levels.ts'

/** 只收文本、不分级别：替掉过去的 `log: (line) => lines.push(line)`。 */
export function collectingLogger(lines: string[]): Logger {
  const push = (message: string, ...args: readonly unknown[]): void => {
    lines.push(formatMessage(message, args))
  }
  return { debug: push, info: push, warn: push, error: push }
}

/** 连级别一起收：替掉过去的 `warn: (line) => warns.push(line)` 这类分钩子。 */
export function recordingLogger(sink: (level: LogLevel, message: string) => void): Logger {
  const tap =
    (level: LogLevel) =>
      (message: string, ...args: readonly unknown[]): void => {
        sink(level, formatMessage(message, args))
      }
  return { debug: tap('debug'), info: tap('info'), warn: tap('warn'), error: tap('error') }
}

/** 什么都不写的 Logger：替掉过去的 `log: () => {}`。 */
export const silentLogger: Logger = {
  debug: () => { },
  info: () => { },
  warn: () => { },
  error: () => { },
}
