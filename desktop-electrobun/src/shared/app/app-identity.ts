// 应用身份（bundle identifier）的构建期解析：只管 identifier 这一件事。
//
// 为什么存在：identifier 烙进产物 Resources/version.json，hutch launcher 读它
// 经 FFI 传给 native core，CEF 数据目录（<id>/<channel>/CEF）与 Chromium
// ProcessSingleton 锁都由它派生。dev 并行开第二份带窗实例时必须换 id——否则
// 两实例共用同一 CEF 数据目录，第二份会被 ProcessSingleton 转发到第一份后
// 直接退出（#38）。
//
// 口径：DSH_SHELL_DEV_IDENTIFIER 非空（去首尾空白）则覆盖，否则用默认 id。
// 只有 dev 并行场景该设它；正式构建（CI/发布链）不设，产物、升级与签名链零感知。
// 注意：src/bun/runtime.ts 的 APP_SUPPORT 常量自带同一默认 id 的路径字面量，但那是有意
// 不与本模块联动的独立默认值（改默认 id 需两处同步，#38 评审已知悉的取舍）。

/** 与既有产物一致的默认 bundle id；正式构建永远用它。 */
export const DEFAULT_BUNDLE_IDENTIFIER = 'com.hyperion.dsh-desktop-bun'

/**
/** DSH_SHELL_DEV_IDENTIFIER 的覆盖值（去首尾空白）；未设或空白返回 null。 */
export function bundleIdentifierOverride(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const trimmed = env.DSH_SHELL_DEV_IDENTIFIER?.trim()
  return trimmed ? trimmed : null
}

/**
 * 解析本次构建用的 bundle identifier。
 * @param env 环境变量表（缺省 process.env；测试可注入）
 */
export function resolveBundleIdentifier(
  env: Record<string, string | undefined> = process.env,
): string {
  return bundleIdentifierOverride(env) ?? DEFAULT_BUNDLE_IDENTIFIER
}
