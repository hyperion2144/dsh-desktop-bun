/**
 * 主题偏好的**取值入口**：壳读 profile 的 `cordis.patch.yml`，拿 `ui-theme` 层的
 * `config.preference`。判定规则全在 `shared/shell-theme.ts`（纯函数，能单测），
 * 这个模块只管找到那份文件——找不到、读不动、没配就是「跟随系统」。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { profileDirOf } from '../profiles/profile-scaffold.ts'
import {
  DEFAULT_SHELL_THEME,
  shellThemeFromPatchYaml,
  type ShellThemePreference,
} from '../../shared/settings/shell-theme.ts'

/** profile 的补丁层文件：主题偏好就写在这里（也可能压根没写）。 */
export const PROFILE_PATCH_FILE = 'cordis.patch.yml'

export function readProfilePatchYaml(home: string, profile: string): string | null {
  try {
    return readFileSync(join(profileDirOf(home, profile), PROFILE_PATCH_FILE), 'utf8')
  } catch {
    return null
  }
}

export function readShellTheme(home: string, profile: string): ShellThemePreference {
  return shellThemeFromPatchYaml(readProfilePatchYaml(home, profile))
}

export { DEFAULT_SHELL_THEME }
