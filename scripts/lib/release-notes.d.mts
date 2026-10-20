/**
 * scripts/lib/release-notes.mjs 的类型声明（纯 JS 模块，壳的 tsc 门禁要它）。
 */
export function extractReleaseNotesFromChangelog(
  text: string,
  version: string,
): string | null
