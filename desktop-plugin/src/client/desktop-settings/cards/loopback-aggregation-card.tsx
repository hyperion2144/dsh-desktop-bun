// 「loopback 数据面聚合」卡：#128。三档单选，改档即存。
// 面板只负责选与存，判定全在壳侧（档位表见 loopback-aggregation.ts）。
import React, { useEffect, useState } from 'react'
import { SectionBox } from '../chrome.tsx'
import { NOTE_STYLE, RADIO_ROW_STYLE, RADIO_TEXT_STYLE } from '../styles.ts'
import { nsSave } from '../rpc.ts'
import { LOOPBACK_AGGREGATION_OPTIONS, type LoopbackAggregationMode } from '../loopback-aggregation.ts'

export function LoopbackAggregationCard({ value }: { value: LoopbackAggregationMode }): React.ReactElement {
  const [loopbackAggregation, setLoopbackAggregation] = useState<LoopbackAggregationMode>(value)
  const [loopbackAggregationNote, setLoopbackAggregationNote] = useState<string | null>(null)

  // 壳首次回话前的显示值由父级给；回话后拨到真实档位（此前是面板里一次 setState，语义一致）。
  useEffect(() => {
    setLoopbackAggregation(value)
  }, [value])

  /**
   * #128：保存 loopback 数据面聚合档位。改 radio 即存（同 prevent_sleep 的路子：壳每次请求在热路径上读
   * 内存里的 liveSettings，切完立刻生效，所以文案里不许出现「重启生效」）。
   * 存失败把 radio 拨回盘上那一档：单选钮停在一个没存上的值上，比只给一行提示更误导。
   */
  const handleSaveLoopbackAggregation = (next: LoopbackAggregationMode): void => {
    const prev = loopbackAggregation
    if (next === prev) return
    setLoopbackAggregation(next)
    void nsSave({ loopback_aggregation: next })
      .then(() =>
        setLoopbackAggregationNote(
          `已保存：${LOOPBACK_AGGREGATION_OPTIONS.find((o) => o.value === next)?.label ?? next}（立即生效，无需重启）`,
        ),
      )
      .catch((e) => {
        setLoopbackAggregation(prev)
        setLoopbackAggregationNote(`保存失败，已回到原档位：${String(e)}`)
      })
  }

  return (
    <SectionBox title="loopback 数据面聚合">
      {LOOPBACK_AGGREGATION_OPTIONS.map((opt) => (
        <label key={opt.value} style={RADIO_ROW_STYLE}>
          <input
            type="radio"
            name="loopback-aggregation"
            data-desktop-settings={`loopback-aggregation-${opt.value}`}
            checked={loopbackAggregation === opt.value}
            onChange={() => handleSaveLoopbackAggregation(opt.value)}
          />
          <span style={RADIO_TEXT_STYLE}>
            {opt.label}
            <span style={{ color: 'var(--dsw-alias-label-secondary,#9aa4b2)', marginLeft: 8 }}>
              {opt.detail}
            </span>
          </span>
        </label>
      ))}
      {loopbackAggregationNote && <div style={NOTE_STYLE}>{loopbackAggregationNote}</div>}
      <div style={NOTE_STYLE}>
        桌面壳回环数据面（桌面页面和手机远程访问都走它）对 GET 请求的合并与缓冲策略。「只关缓冲」保留合并，
        只让响应边到边下发；「全关」连合并也停掉，每个请求各自打上游，不会关掉别的功能。改动立即生效，
        不需要重启。
      </div>
    </SectionBox>
  )
}
