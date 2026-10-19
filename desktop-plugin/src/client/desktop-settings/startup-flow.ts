// 启动检查弹窗（#182）：壳发起的独立流程（不属于设置面板），从 desktop-settings.tsx 收口到这里。
//
// 拆成两段：
//   · startupDialogModel —— 纯函数：check_startup_needed 的契约裁决折成弹窗模型（node 可测）；
//   · mountStartupDialog —— 薄 DOM：按模型搭窗，四个动作全部由 hooks 注入，自己不做任何决策。
// runStartupFlow 把两者接起来并给动作接上 toast + confirm_startup_profile（#190 invokeCommand）。
// DOM 仍是 document.createElement 手拼（两个弹窗是壳级浮层，不走 React 树；样式与文案逐字保留）。
import { invokeCommand } from './rpc.ts'
import type { StartupNeeded } from '../../../../contracts/index.ts'

/** 弹窗模型：三裁决各一种（外加「没有 profile 名的不完整裁决 = 不弹」）。 */
export type StartupDialogModel =
  | { kind: 'none' }
  | { kind: 'select'; profiles: string[] }
  | { kind: 'incomplete'; profile: string; missingDesc: string }

/** 契约裁决 → 弹窗模型（纯函数）。缺失明细的拼接口径与拆分前逐字一致。 */
export function startupDialogModel(res: StartupNeeded | null | undefined): StartupDialogModel {
  if (!res || res.action === 'none') return { kind: 'none' }
  if (res.action === 'profile-selection') return { kind: 'select', profiles: res.profiles ?? [] }
  const profile = res.profile ?? ''
  if (!profile) return { kind: 'none' }
  const details = res.details
  const missingDesc = details
    ? [
        ...details.missing_files,
        ...(details.node_modules_exists ? [] : ['node_modules']),
        ...(details.dir_exists ? [] : ['profile 目录']),
      ].join(', ')
    : ''
  return { kind: 'incomplete', profile, missingDesc }
}

/** mountStartupDialog 的四个动作：DOM 只负责「点了哪个」，做什么由注入方决定。 */
export interface StartupFlowHooks {
  /** 选已有 profile 启动（select 弹窗的按钮）。 */
  onSelectProfile(profile: string): void
  /** 用输入的新名字建并启动（select 弹窗的「新建并启动」）。 */
  onCreateProfile(name: string): void
  /** 不完整 profile 直接启动（不修复）。 */
  onStartProfile(profile: string): void
  /** 不完整 profile 修复并启动。 */
  onRepairProfile(profile: string): void
}

/** 按模型搭窗（薄 DOM）：结构与样式逐字来自拆分前的两段手拼代码。 */
export function mountStartupDialog(model: StartupDialogModel, hooks: StartupFlowHooks): void {
  if (model.kind === 'none') return
  if (model.kind === 'select') {
    const el = document.createElement('div')
    el.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)'
    const card = document.createElement('div')
    card.style.cssText = 'background:var(--dsw-alias-bg-base,#16181d);border:1px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:12px;padding:24px;min-width:320px;max-width:400px'
    const title = document.createElement('div')
    title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:16px;color:var(--dsw-alias-label-primary,#e7eaf0)'
    title.textContent = '选择要启动的 Profile'
    card.appendChild(title)
    const list = document.createElement('div')
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px'
    for (const p of model.profiles) {
      const btn = document.createElement('button')
      btn.style.cssText = 'padding:10px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);background:transparent;color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;cursor:pointer;text-align:left'
      btn.textContent = p
      btn.onmouseenter = () => (btn.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))')
      btn.onmouseleave = () => (btn.style.background = 'transparent')
      btn.onclick = () => {
        el.remove()
        hooks.onSelectProfile(p)
      }
      list.appendChild(btn)
    }
    const input = document.createElement('input')
    input.style.cssText = 'margin-top:12px;padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);background:var(--dsw-alias-bg-base,#151517);color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;width:100%;box-sizing:border-box'
    input.placeholder = '或输入新 profile 名称'
    const startBtn = document.createElement('button')
    startBtn.style.cssText = 'margin-top:8px;padding:8px 14px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary-new-color,#4176e6);color:#fff;font-size:13px;cursor:pointer;width:100%'
    startBtn.textContent = '新建并启动'
    startBtn.onclick = () => {
      const name = input.value.trim()
      if (!name) return
      el.remove()
      hooks.onCreateProfile(name)
    }
    card.appendChild(list)
    card.appendChild(input)
    card.appendChild(startBtn)
    el.appendChild(card)
    document.body.appendChild(el)
    return
  }
  // kind === 'incomplete'
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)'
  const card = document.createElement('div')
  card.style.cssText = 'background:var(--dsw-alias-bg-base,#16181d);border:1px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:12px;padding:24px;min-width:340px;max-width:420px;text-align:center'
  const title = document.createElement('div')
  title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:8px;color:var(--dsw-alias-label-primary,#e7eaf0)'
  title.textContent = `Profile「${model.profile}」不完整`
  const desc = document.createElement('div')
  desc.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#9aa4b2);margin-bottom:20px'
  desc.textContent = `缺失：${model.missingDesc}。是否修复？`
  const btns = document.createElement('div')
  btns.style.cssText = 'display:flex;gap:10px'
  const noBtn = document.createElement('button')
  noBtn.style.cssText = 'flex:1;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);background:transparent;color:var(--dsw-alias-label-primary,#e7eaf0);font-size:13px;cursor:pointer'
  noBtn.textContent = '直接启动'
  noBtn.onclick = () => {
    el.remove()
    hooks.onStartProfile(model.profile)
  }
  const yesBtn = document.createElement('button')
  yesBtn.style.cssText = 'flex:1;padding:10px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary-new-color,#4176e6);color:#fff;font-size:13px;cursor:pointer'
  yesBtn.textContent = '修复并启动'
  yesBtn.onclick = () => {
    el.remove()
    hooks.onRepairProfile(model.profile)
  }
  btns.appendChild(noBtn)
  btns.appendChild(yesBtn)
  card.appendChild(title)
  card.appendChild(desc)
  card.appendChild(btns)
  el.appendChild(card)
  document.body.appendChild(el)
}

/**
 * 启动检查流程入口：模型 → 弹窗 → toast + confirm_startup_profile。
 * notify 直接吃 showToast（签名一致）；四条回执文案与拆分前逐字一致。
 */
export function runStartupFlow(res: StartupNeeded | null | undefined, notify: (text: string, ok: boolean) => void): void {
  const model = startupDialogModel(res)
  mountStartupDialog(model, {
    onSelectProfile: (p) => {
      notify(`正在启动 ${p} profile…`, true)
      void invokeCommand('confirm_startup_profile', { name: p, repair: false }).catch((e) => notify(`启动失败：${String(e)}`, false))
    },
    onCreateProfile: (name) => {
      notify(`正在创建并启动 ${name} profile…`, true)
      void invokeCommand('confirm_startup_profile', { name, repair: true }).catch((e) => notify(`创建失败：${String(e)}`, false))
    },
    onStartProfile: (profile) => {
      void invokeCommand('confirm_startup_profile', { name: profile, repair: false }).catch((e) => notify(`启动失败：${String(e)}`, false))
    },
    onRepairProfile: (profile) => {
      notify(`正在修复 ${profile} profile…`, true)
      void invokeCommand('confirm_startup_profile', { name: profile, repair: true }).catch((e) => notify(`修复失败：${String(e)}`, false))
    },
  })
}
