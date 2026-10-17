/**
 * 壳自己那些小窗（启动闪屏、更新提醒窗）跟产品主题对齐。
 *
 * 主题是 DSH 那边的事：profile 的 `cordis.patch.yml` 里 `@deepseek-ai/dsh-client-ui-theme`
 * 这个层的 `config.preference` 取 `light` / `dark` / `system`（与宿主 user-settings
 * 文档里的 `ui-theme.preference` 同一个字段）。
 *
 * 读不到这个字段时的缺省是 **浅色**，不是「跟随系统」。实测依据（隔离实例：macOS 浅色、
 * profile 里没写 preference）：DSH 页面渲染浅色，而这个壳里 CEF 的 `prefers-color-scheme`
 * 报的是 dark——照「跟随系统」走，弹窗就成了深色贴在浅色应用上（真机反馈：「白色主题
 * 黑色窗口？？？跟随主题呢？」）。所以缺省取产品在同样情况下的渲染结果（浅色），
 * 只有用户显式选了 `system` 才交给媒体查询。
 *
 *
 * 落实办法是 CSS 变量 + `prefers-color-scheme`，不用 JS 监听系统变化：闪屏和提醒窗都是
 * `html:` 文档，没有桥可用；媒体查询天生就跟着系统走，重开窗口也不会失同步。
 */

/** 与 DSH 主题插件同名的三种取值。 */
export type ShellThemePreference = 'light' | 'dark' | 'system'

export const SHELL_THEME_PREFERENCES: readonly ShellThemePreference[] = ['light', 'dark', 'system']

/** 读不到配置时的缺省：产品在同样情况下渲染浅色（依据见文件头注释）。 */
export const DEFAULT_SHELL_THEME: ShellThemePreference = 'light'

export const SHELL_THEME_PLUGIN = '@deepseek-ai/dsh-client-ui-theme'

/** 变量名沿用产品 CSS 的 alias 命名，`input-modal.ts` 那边也在用同一套。 */
const DARK: Record<string, string> = {
  '--dsw-alias-bg-layer-1': '#1b1d21',
  '--dsw-alias-surface-raised': '#212328',
  '--dsw-alias-border-l2': '#3a3d44',
  '--dsw-alias-label-primary': '#e8e8e8',
  '--dsw-alias-label-secondary': '#9a9aa2',
  '--dsw-alias-state-accent-primary': '#4c6ef5',
  '--dsw-alias-state-accent-fg': '#ffffff',
  '--dsw-alias-state-danger': '#ff8787',
}

const LIGHT: Record<string, string> = {
  '--dsw-alias-bg-layer-1': '#ffffff',
  '--dsw-alias-surface-raised': '#f4f5f7',
  '--dsw-alias-border-l2': '#d9dbe1',
  '--dsw-alias-label-primary': '#1b1d21',
  '--dsw-alias-label-secondary': '#6b6f76',
  '--dsw-alias-state-accent-primary': '#3b5bdb',
  '--dsw-alias-state-accent-fg': '#ffffff',
  '--dsw-alias-state-danger': '#c92a2a',
}

function declarations(palette: Record<string, string>): string {
  return Object.entries(palette).map(([key, value]) => `${key}:${value}`).join(';')
}

/**
 * 塞进 `<style>` 的主题块。规则只有三条：
 *   · 缺省亮色；
 *   · 系统暗色时切成暗色，但 `data-theme="light"` 显式钉住时不算（那是用户选了浅色）；
 *   · `data-theme="dark"` 钉住时永远暗色（系统亮着也是）。
 */
export function shellThemeStyle(): string {
  return [
    `:root{color-scheme:light dark;${declarations(LIGHT)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${declarations(DARK)}}}`,
    `:root[data-theme="dark"]{${declarations(DARK)}}`,
  ].join('\n')
}

/** `<html>` 上的 `data-theme`：显式浅色/暗色才写，`system` 与缺省都留空交给媒体查询。 */
export function shellThemeAttr(preference: ShellThemePreference): string {
  return preference === 'system' ? '' : ` data-theme="${preference}"`
}

function asPreference(value: unknown): ShellThemePreference | null {
  return typeof value === 'string' && (SHELL_THEME_PREFERENCES as readonly string[]).includes(value)
    ? (value as ShellThemePreference)
    : null
}

interface YamlParser {
  parse?: (text: string) => unknown
}

function bunYaml(): YamlParser | null {
  const bun = (globalThis as { Bun?: { YAML?: YamlParser } }).Bun
  return bun?.YAML ?? null
}

/** 没带 YAML 解析器（或解析炸了）时的兜底扫法：认出插件名，再认它下面的 preference 行。 */
function scanPatchYaml(text: string): ShellThemePreference | null {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.includes(SHELL_THEME_PLUGIN))
  if (start < 0) return null
  for (const line of lines.slice(start + 1)) {
    const hit = /^\s*preference\s*:\s*["']?([a-z]+)["']?\s*$/.exec(line)
    if (hit?.[1] !== undefined) return asPreference(hit[1])
    // 出了这个块的 config（下一条 `- id:` 或顶格键）就别再找了。
    if (/^\s*-\s+id\s*:/.test(line)) break
  }
  return null
}

/**
 * profile 的 `cordis.patch.yml` 文本 → 主题偏好。文件没有、没有那个层、值不认识，
 * 一律回 `system`（跟随系统），跟 DSH 自己缺省一致。
 */
export function shellThemeFromPatchYaml(text: string | null): ShellThemePreference {
  if (text === null || text.trim() === '') return DEFAULT_SHELL_THEME
  const parser = bunYaml()
  if (parser?.parse !== undefined) {
    try {
      const parsed: unknown = parser.parse(text)
      const layers = Array.isArray(parsed) ? parsed : [parsed]
      for (const layer of layers) {
        if (typeof layer !== 'object' || layer === null) continue
        const row = layer as Record<string, unknown>
        if (row['name'] !== SHELL_THEME_PLUGIN) continue
        const config = row['config']
        if (typeof config !== 'object' || config === null) continue
        const preference = asPreference((config as Record<string, unknown>)['preference'])
        if (preference !== null) return preference
      }
      return DEFAULT_SHELL_THEME
    } catch {
      // 解析器不认这份 YAML（用户写了锚点、自定义 tag 等）：退到行扫描，仍不成就是跟随系统。
    }
  }
  return scanPatchYaml(text) ?? DEFAULT_SHELL_THEME
}
