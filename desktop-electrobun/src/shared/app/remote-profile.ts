/**
 * 远程 profile 条目的统一标识与地址换算（#246）。
 *
 * 远程 dsh 地址在托盘「profile 管理」、会话表、设置三处以 `remote:<addr>` 条目身份出现：
 * 前缀是条目身份（托盘/会话用它区分本地实例），后缀是用户填的原始地址串（settings
 * `remote_list` 的原样保留，不做大小写归一——展示与回填都要原样）。
 * daemon/registry.ts 的 remoteProfileId 是另一套（注册表归一化，含小写化），别混用。
 */
export const REMOTE_PROFILE_PREFIX = 'remote:'

export function isRemoteProfile(profile: string): boolean {
  return profile.startsWith(REMOTE_PROFILE_PREFIX)
}

/** 条目身份 → 用户地址（不带前缀；非远程条目返回 null）。 */
export function remoteProfileAddress(profile: string): string | null {
  return isRemoteProfile(profile) ? profile.slice(REMOTE_PROFILE_PREFIX.length) : null
}

/** 用户地址 → 条目身份。 */
export function remoteProfileId(address: string): string {
  return `${REMOTE_PROFILE_PREFIX}${address}`
}
