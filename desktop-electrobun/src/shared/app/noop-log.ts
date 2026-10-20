/**
 * 什么都不写的 Logger——可选注入点（`log?` / `onLog?`）缺省时的兜底。
 *
 * 分级日志接口（`Logger`）落地后，「可选日志通道」的缺省值不能再是
 * `(line: string, level?: LogLevel) => void` 这种旧签名了：调用点按级别选方法
 * （`log.warn(...)`），旧签名跑不起来。缺省就是「什么都不写」，语义与旧壳一致。
 */
import type { Logger } from '../logging/levels.ts'

/** 空 Logger：四个级别方法全是 no-op。 */
export const NOOP_LOGGER: Logger = {
  debug: (): void => { },
  info: (): void => { },
  warn: (): void => { },
  error: (): void => { },
}
