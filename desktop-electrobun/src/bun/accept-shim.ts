// 文件选择对话框 accept 归一化 shim（#58）。
//
// 背景：上游 electrobun 的 Windows 原生层（package/src/native/win/nativeWrapper.cpp
// OnFileDialog）把 CEF 回调里的 accept token 当「文件扩展名」直接拼匹配模式：
// `image/jpeg` → `".image/jpeg"` → pattern `*.image/jpeg`，匹配不到任何真实文件；
// 且只有 token 恰为 `*` / `*.*` 时才追加 All files。Chromium 本尊在弹框前自己做
// MIME→扩展名映射（net/base/mime_util.cc），mac 侧 electrobun 的 OnFileDialog 被
// 注释掉回落 CEF 默认对话框，所以只有 Windows 坏出三个症状（Linux 同病，自带
// All files 兜底）。
//
// 解法：document-start 往壳内页面注入一段归一化脚本——把 input[type=file] 的 MIME
// token 改写成扩展名形式（win 侧对扩展名 token 拼出的 `*.jpg` 是正确 pattern），
// win32 再追加一个 `*.*` token 命中 win 分支把「所有文件」补上。mac 的 CEF 默认
// 对话框本来就有 All Files，`*.*` 会多出 `*.*.*` 垃圾过滤行，故按平台限定。浏览器
// 不跑壳 preload，零影响。
//
// 逻辑单一来源：NORMALIZE_ACCEPT_SOURCE 是一段**纯 JS**源码文本——既被 `new Function`
// 求值出带类型的导出（测试用），也原文内联进 preload 字符串（页面用）。因此源码里
// 禁用 TS 注解；要改类型，改下面导出的签名，别动源码文本。

import type { CarrierPlatform } from './carrier.ts'

/** MIME → 扩展名（对齐 Chromium net/base/mime_util.cc 的常用子集；键一律小写）。 */
export const MIME_TO_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'image/jpeg': ['jpg', 'jpeg', 'jpe'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'image/avif': ['avif'],
  'image/heic': ['heic'],
  'image/heif': ['heif'],
  'image/bmp': ['bmp'],
  'image/x-icon': ['ico'],
  'image/svg+xml': ['svg'],
  'image/tiff': ['tif', 'tiff'],
  'video/mp4': ['mp4', 'm4v'],
  'video/webm': ['webm'],
  'video/quicktime': ['mov'],
  'video/x-matroska': ['mkv'],
  'audio/mpeg': ['mp3'],
  'audio/ogg': ['ogg', 'oga'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/flac': ['flac'],
  'audio/aac': ['m4a'],
  'application/pdf': ['pdf'],
  'application/json': ['json'],
  'application/zip': ['zip'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
}

// 归一化 accept 属性值（纯 JS，禁 TS 注解，见文件头）。注释用行注释：正文里的 token（如 `*/*`）
// 含 `*/` 序列会提前终结块注释，这是本文件的真实历史事故。
//
// 规则：
//   - MIME token 查表展开为扩展名；类型通配（如 image/*）并上该类型全部已知扩展名；未知 MIME 保留原样；
//   - 扩展名 token 补点前缀；星号族（* 、*.* 、*/*）统一成 *.*；
//   - appendAllFiles 仅在「非空且尚无星号」时追加一个 *.*（win32 用，命中 win 层 All files 分支）；
//   - 空值原样返回；输出按首现顺序去重，重复执行幂等。
export const NORMALIZE_ACCEPT_SOURCE = `function (accept, appendAllFiles, mimeMap) {
  if (typeof accept !== 'string') return accept
  const trimmed = accept.trim()
  if (!trimmed) return accept
  const out = []
  let hasAll = false
  const push = (token) => { if (out.indexOf(token) === -1) out.push(token) }
  const rawTokens = trimmed.split(',')
  for (let i = 0; i < rawTokens.length; i++) {
    const token = rawTokens[i].trim()
    if (!token) continue
    const lower = token.toLowerCase()
    if (lower === '*' || lower === '*.*' || lower === '*/*') { hasAll = true; push('*.*'); continue }
    if (token.indexOf('/') === -1) { push(token.charAt(0) === '.' ? token : '.' + token); continue }
    const mapped = mimeMap[lower]
    if (mapped) { for (let j = 0; j < mapped.length; j++) push('.' + mapped[j]); continue }
    if (lower.charAt(lower.length - 1) === '*') {
      const family = lower.slice(0, -1)
      for (const key in mimeMap) {
        if (key.lastIndexOf(family, 0) === 0) {
          const exts = mimeMap[key]
          for (let j = 0; j < exts.length; j++) push('.' + exts[j])
        }
      }
      continue
    }
    push(token)
  }
  if (appendAllFiles && !hasAll && out.length > 0) push('*.*')
  return out.join(',')
}`

/** 同一源码求值出的实现：测试与本仓调用方用；preload 里内联的是同一份文本。 */
export const normalizeAcceptValue = new Function(`return (${NORMALIZE_ACCEPT_SOURCE})`)() as (
  accept: string,
  appendAllFiles: boolean,
  mimeMap: Readonly<Record<string, readonly string[]>>,
) => string

// 生成 accept 归一化脚本（纯字符串，随 preload 进页面；不用模块作用域——preload 是一段内联 JS）。
//
// win32 追加 *.*（win 原生层只对 * 与 *.* 给 All files）；darwin 的 CEF 默认对话框自带
// All Files，linux 的 gtk 层强制追加 All files，都不追加。
export function acceptShimScript(platform: CarrierPlatform): string {
  return `;(() => {
  if (globalThis.__dshAcceptShim) return
  globalThis.__dshAcceptShim = true
  const APPEND_ALL_FILES = ${JSON.stringify(platform === 'win32')}
  const MIME_MAP = ${JSON.stringify(MIME_TO_EXTENSIONS)}
  const normalizeAcceptValue = ${NORMALIZE_ACCEPT_SOURCE}
  const apply = (input) => {
    try {
      const raw = input.getAttribute('accept')
      if (!raw) return
      const next = normalizeAcceptValue(raw, APPEND_ALL_FILES, MIME_MAP)
      if (next !== raw) input.setAttribute('accept', next)
    } catch {}
  }
  // 已在 DOM 里的先归一化一遍（类型下拉里的 MIME 项直接变成扩展名条目）
  try { document.querySelectorAll('input[type=file]').forEach(apply) } catch {}
  // 点击瞬间兜底：动态创建的 input 在默认动作（弹对话框）之前被改写——CEF 读的是改写后的值。
  // capture 阶段拦 document，label/button 包裹的 input 也覆盖；shadow DOM 穿不透，属已知边界。
  document.addEventListener('click', (event) => {
    const target = event.target
    if (!target || typeof target.closest !== 'function') return
    const input = target.closest('input[type=file]')
    if (input) apply(input)
  }, true)
  // showPicker() 不派发 click：包一层，弹框前同样归一化
  try {
    const proto = HTMLInputElement.prototype
    if (typeof proto.showPicker === 'function') {
      const original = proto.showPicker
      proto.showPicker = function () { apply(this); return original.apply(this, arguments) }
    }
  } catch {}
})()`
}
