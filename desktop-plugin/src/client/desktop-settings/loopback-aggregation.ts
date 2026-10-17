// #128 loopback 数据面聚合档位（面板只负责选与存，判定全在壳侧）。
//
// 值域的唯一事实源是壳侧 desktop-electrobun/src/shared/settings.ts 的 LOOPBACK_AGGREGATION_MODES /
// DEFAULT_LOOPBACK_AGGREGATION。面板**不**跨包 import 壳代码：lib/client.js 是随插件单独发布的产物，
// 把壳的 settings 模块编进去等于把两边的发布边界焊死。读值走壳回吐的设置快照（get_desktop_settings_data 的
// settings 段 = serializeSettings 的下划线键），与 dev_tools / prevent_sleep 同一条路。
//
// 下面这张表既是渲染清单也是白名单（loopbackAggregationMode 复用它校验）——别再另立一份字面量，
// 也别把档位换名：full / stream / none 是壳落盘的键，换个说法等于换键。
export type LoopbackAggregationMode = 'full' | 'stream' | 'none'

export const LOOPBACK_AGGREGATION_OPTIONS: ReadonlyArray<{
  value: LoopbackAggregationMode
  label: string
  detail: string
}> = [
  { value: 'full', label: '全开', detail: '合并并发 GET，并整条缓冲 ≤256KB 的响应' },
  // 默认档＝壳侧 DEFAULT_LOOPBACK_AGGREGATION。面板不跨包 import 壳代码，两边各写一份字面量，
  // 所以改默认值必须两边同时改（test-client.mjs 会核对这里与 use-initial-data.ts 的初始值都等于 stream）。
  { value: 'stream', label: '只关缓冲（默认）', detail: '仍合并，但响应边到边下发' },
  { value: 'none', label: '全关', detail: '不合并，每个请求各自打宿主' },
]

/** 壳回吐的原始值 → 面板认的档位：旧设置文件没这个键、或值不认识，一律回默认（壳侧同款回退 = stream）。 */
export function loopbackAggregationMode(raw: unknown): LoopbackAggregationMode {
  const hit = LOOPBACK_AGGREGATION_OPTIONS.find((o) => o.value === raw)
  return hit === undefined ? 'stream' : hit.value
}
