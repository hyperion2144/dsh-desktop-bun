// #75 防休眠能力提示的纯逻辑（UI 无关，node scripts/test-client.mjs 用 esbuild 转译后断言）。
// 壳把「本环境能不能拿到系统防休眠通道」翻成 keep_awake 字段（platform / backend / available / reason），
// 设置面板「电源」区据此说明开关的实际效果：拿不到抑制通道时必须明说降级，不许静默。
// 文案口径与面板其余说明一致：macOS 走 IOKit、Windows 走线程执行状态、Linux 走 logind / GNOME 会话抑制。

export interface KeepAwakeCapabilityLike {
  platform?: string | null
  backend?: string | null
  available?: boolean | null
  reason?: string | null
}

export interface KeepAwakeNote {
  /** info：能力正常（或老壳没这个字段）的说明；warn：本环境拿不到防休眠通道，降级必须可见。 */
  tone: 'info' | 'warn'
  text: string
}

/** 各分支共用的尾句：说清断言的有效期、屏幕照关、合盖照睡、改动即时生效。 */
const NOTE_TAIL =
  '直到会话跑完、dsh 实例停止或退出壳。屏幕该关还是照关，只是不让整机睡过去；合盖仍然会睡。改动立即生效。'

/** 缺位（老壳没有 keep_awake 字段）与未知 backend 的通用说明：三平台口径都说到。 */
const GENERIC_HEAD =
  '熄屏后若还有会话在跑，壳会持有系统防休眠断言（macOS 走 IOKit、Windows 走线程执行状态、Linux 走 logind/GNOME 会话抑制）'

/**
 * backend → 平台口径。用 Map 而不是对象字面量：backend 是壳给的字符串，
 * 对象字面量会把 'constructor' / 'toString' 这类键命中原型链，Map 只认自己放进去的通道。
 */
const BACKEND_HEAD = new Map<string, string>([
  ['caffeinate', '熄屏后若还有会话在跑，壳会持有系统防休眠断言（macOS 走 IOKit / caffeinate）'],
  ['execution-state', '熄屏后若还有会话在跑，壳会持有系统防休眠断言（Windows 走线程执行状态）'],
  ['systemd-inhibit', '熄屏后若还有会话在跑，壳会持有系统防休眠断言（Linux 走 logind 抑制锁，systemd-inhibit）'],
  [
    'gnome-session-inhibit',
    '熄屏后若还有会话在跑，壳会持有系统防休眠断言（Linux 走 GNOME 会话抑制，gnome-session-inhibit）',
  ],
])

/** reason 是壳给出的用户可见原因：空/非字符串一律落到固定兜底句，禁止把 undefined 漏进文案。 */
function reasonText(reason: string | null | undefined): string {
  return typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : '原因未知'
}

/**
 * keep_awake 能力 → 面板文案。
 * - 缺位（老壳）/ available 缺失 → info，通用说明（宁可少说也不谎报降级）；
 * - available === false → warn，明说本环境拿不到防休眠通道 + 壳给的原因；
 * - available === true → info，按 backend 给平台口径，未知 backend 回退通用说明。
 */
export function keepAwakeNote(capability: KeepAwakeCapabilityLike | null | undefined): KeepAwakeNote {
  // 老壳（整个字段缺位）与 null 一起归一成空对象：下面只看 available，不猜。
  const cap: KeepAwakeCapabilityLike = capability ?? {}
  if (cap.available === false) {
    return {
      tone: 'warn',
      text: `本环境拿不到防休眠通道：${reasonText(cap.reason)}。开关就算开着，跑会话期间系统仍可能空闲休眠；${NOTE_TAIL}`,
    }
  }
  if (cap.available === true) {
    return { tone: 'info', text: `${BACKEND_HEAD.get(cap.backend ?? '') ?? GENERIC_HEAD}，${NOTE_TAIL}` }
  }
  return { tone: 'info', text: `${GENERIC_HEAD}，${NOTE_TAIL}` }
}
