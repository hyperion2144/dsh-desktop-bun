/**
 * CHANGELOG → 发布正文提取。
 *
 * 桌面端与移动端各自独立维护一本 changelog：
 *   - 桌面：CHANGELOG.md
 *   - 移动：CHANGELOG-mobile.md
 * 版本段格式两边相同：
 *   `## [x.y.z] - 日期` 这行起，到下一个 `## ` 行（或文件尾）止，整段就是发布正文。
 *
 * 找不到版本段或段为空返回 null，由调用方决定回落策略
 * （release-publish.mjs 回落到各通道的内置一句话）。
 */

/** 去掉首尾空行（中间空行保留，Markdown 渲染等价）。 */
function trimBlankEdges(lines) {
  const result = [...lines]
  while (result.length > 0 && result[0].trim() === '') result.shift()
  while (result.length > 0 && result[result.length - 1].trim() === '') result.pop()
  return result
}

/**
 * @param {string} text 该通道的 CHANGELOG 全文
 * @param {string} version 纯版本号（如 `0.1.0`，不带 `v` 前缀）
 * @returns {string | null} 发布正文；找不到版本段或段为空时为 null
 */
export function extractReleaseNotesFromChangelog(text, version) {
  const lines = String(text ?? '').split(/\r?\n/)

  // 版本段边界。
  const sectionStart = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  if (sectionStart === -1) return null
  let sectionEnd = lines.length
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('## ')) {
      sectionEnd = index
      break
    }
  }

  const body = trimBlankEdges(lines.slice(sectionStart + 1, sectionEnd))
  if (body.length === 0) return null
  return body.join('\n').trim()
}
