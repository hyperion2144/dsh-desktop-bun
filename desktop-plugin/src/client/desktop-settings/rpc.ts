// 面板的持久化通道：唯一一处「怎么跟壳说话」。
//
// #95 v0.1.7：dsh 废除 settings.yaml 插件命名空间——壳设置搬出 dsh，
// 走壳自己的 RPC（宿主单写者，$DSH_HOME/desktop-settings.json），不再经宿主 RPC。
// nsRpc（dsh settings 服务的 connection 捕获口）过去是个模块级可变变量，由注册入口写、
// 由「回填启动时 profile」那处读；把它和它的捕获口收在一起，调用方只拿得到
// 「有没有可用」和「存不存」两个动作，不用知道它是个可变量。
import { shellRpc, type ShellRpcInvokeOptions } from '../shell-rpc.ts'
import type { NsRpc } from './types.ts'

/** 壳 RPC 统一通道（#50）：签名保持旧本地 invoke 不变，调用点零改动。 */
export function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
  // #97：透传通道选项——下载类调用要传 `{ noTimeout: true }`，别让客户端超时把它们砍成失败
  options?: ShellRpcInvokeOptions,
): Promise<T> {
  return shellRpc.invoke<T>(cmd, args, options)
}

let nsRpc: NsRpc | null = null

/**
 * 捕获 dsh settings 服务的命名空间读写通道。
 * 过去这段 try/catch 与赋值散在注册入口里，而变量本体在文件另一头；现在两者同处一模块。
 * 读 `ctx.connection` 仍包 try：取属性本身就可能抛（跨 realm 的 getter），抛了就当没有。
 */
export function captureNsRpc(ctx: unknown): void {
  try {
    nsRpc = (ctx as { connection?: NsRpc }).connection ?? null
  } catch {
    nsRpc = null
  }
}

/** 有没有捕获到 connection RPC。没捕获到就不落盘（那是旧路径的能力判据，别改成永远写）。 */
export function hasNsRpc(): boolean {
  return nsRpc !== null
}

export async function nsSave(patch: Record<string, unknown>): Promise<void> {
  await invoke('save_desktop_settings', { patch })
}

export async function nsGet(): Promise<Record<string, unknown>> {
  // 读侧走既有 get_desktop_settings_data 的设置段（同一 Rust 读源）
  const d = await invoke<{ settings?: Record<string, unknown> }>('get_desktop_settings_data')
  return (d.settings && typeof d.settings === 'object' ? d.settings : {}) as Record<string, unknown>
}
