// 面板的通用外壳件：卡片框、按钮、端口输入格、全局 toast。
// 抽出来是因为每张卡片都要用，而它们过去是入口文件里的私有函数——卡片模块只能反向 import 入口，
// 于是入口和卡片互相 import、循环依赖、谁都不好单测。这里是卡片层的最底层依赖，不再依赖任何卡片。
import React from 'react'
import {
  BTN_DANGER_STYLE,
  BTN_GHOST_STYLE,
  BTN_PRIMARY_STYLE,
  INPUT_BASE_STYLE,
  SECTION_STYLE,
  TITLE_STYLE,
} from './styles.ts'

export function SectionBox({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={SECTION_STYLE}>
      <div style={TITLE_STYLE}>{title}</div>
      {children}
    </div>
  )
}

export function PfBtn({
  variant = 'primary',
  disabled = false,
  onClick,
  children,
  style,
  title,
  testId,
}: {
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
  style?: React.CSSProperties
  title?: string
  /** 测试 id → data-desktop-settings（同 PortCell 的 testId 惯例，#221 新控件都要带 id）。 */
  testId?: string
}): React.ReactElement {
  const baseStyle =
    variant === 'primary' ? BTN_PRIMARY_STYLE : variant === 'ghost' ? BTN_GHOST_STYLE : BTN_DANGER_STYLE
  const cls = variant === 'primary' ? 'pf-btn' : `pf-btn ${variant}`
  return (
    <button
      type="button"
      className={cls}
      disabled={disabled}
      title={title}
      onClick={onClick}
      data-desktop-settings={testId}
      style={{ ...baseStyle, ...(style ?? {}) }}
    >
      {children}
    </button>
  )
}

// #22：Profile 端口表三类口的输入格同构（输入 + 保存），只差占位/测试 id/回调。
export function PortCell({
  testId,
  placeholder,
  value,
  onChange,
  onEnter,
  onSave,
}: {
  testId: string
  placeholder: string
  value: string
  onChange: (v: string) => void
  onEnter: () => void
  onSave: () => void
}): React.ReactElement {
  return (
    <>
      <input
        placeholder={placeholder}
        style={{ ...INPUT_BASE_STYLE, width: 84 }}
        data-desktop-settings={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter()
        }}
      />
      <PfBtn variant="ghost" style={{ marginLeft: 6 }} onClick={onSave}>
        保存
      </PfBtn>
    </>
  )
}

/** 全局 toast：挂 document.body，不依赖设置面板是否打开。 */
export function showToast(text: string, ok: boolean, tone: 'ok' | 'error' | 'info' = ok ? 'ok' : 'error'): void {
  // #97：三档配色——取消走中性蓝，不冒充成功（绿）也不吓唬人（红）
  const palette =
    tone === 'info'
      ? 'background:rgba(96,165,250,.15);border:1px solid rgba(96,165,250,.6);color:#93c5fd'
      : tone === 'ok'
        ? 'background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.6);color:#4ade80'
        : 'background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.6);color:#f87171'
  const el = document.createElement('div')
  el.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:500;max-width:480px;box-shadow:0 4px 12px rgba(0,0,0,.4);cursor:pointer;backdrop-filter:blur(8px);${palette}`
  el.textContent = text
  el.addEventListener('click', () => el.remove())
  document.body.appendChild(el)
  if (ok) window.setTimeout(() => el.remove(), 5000)
}
