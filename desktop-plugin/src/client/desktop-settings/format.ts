// 面板用到的两个纯函数：字节格式化与远程地址归一化。
// 两者都不碰 React 与壳通道，单测可以直接 import。

export function fmtBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** 地址归一化（对齐 Rust normalize_remote_url 核心规则）：完整 URL 或 host[:port]。 */
export function normalizeRemote(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  if (/^https?:\/\//.test(t)) return t
  if (/^socks5:\/\//.test(t)) return t
  if (/^[A-Za-z0-9.-]+(:\d+)?$/.test(t)) return `https://${t}`
  return null
}
