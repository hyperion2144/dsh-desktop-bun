/**
 * dsh web 运行时注入模块的本地类型契约。
 *
 * 值导入的模块（如 primitives）在构建期是 esbuild external（scripts/build-client.mjs
 * 的 external 列表），由 dsh web 的 ModuleLoader 运行时注入 require，包本体从不进
 * bundle；纯类型侧导入（theme/client）被 esbuild 转译期擦除、不在该列表，其空模块
 * 声明只为让 tsc 解析 import type 通过。
 * 不能把它们装成 devDependencies：其 peerDependencies 链上有未公开发布的
 * @deepseek-ai 内部包（dsh-paths / dsh-compact / dsh-type-meta /
 * dsh-user-interaction 在 npm 404），安装即失败。
 *
 * 因此这里只声明插件实际触达的面（与 src/client 的 import 一一对应）。
 * 上游 API 漂移（如 #103 的图标改名）运行时才暴露——test:client 与 CI 的
 * 双跑兜底；若后续上游公开了类型链路，可换回真实包类型并删除本文件。
 */

type DshIconComponent = import('react').ComponentType<{ size?: number | string }>

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** dsh 官方按钮（toolbar/ghost 变体，样式由 --dsw-alias-button-* token 家族接管）。 */
  export const Button: import('react').ComponentType<{
    variant?: string
    size?: string
    icon?: import('react').ReactNode
    title?: string
    'aria-label'?: string
    onClick?: () => void
    children?: import('react').ReactNode
  }>
  /** #103：dsh 0.1.7 改名 IconDownloadOutline16 → IconDownloadOutlineRegular；
   * CJS require 下旧名缺失（undefined），保留 ?? 兼容两代运行时。 */
  export const IconDownloadOutline16: DshIconComponent | undefined
  export const IconDownloadOutlineRegular: DshIconComponent
}

declare module '@deepseek-ai/dsh-client-ui-theme/client' {}
