/**
 * 运行时管理与壳生命周期命令（contract 中间层）。
 * 版本目录 / 下载安装 / 卸载 / 服务与桌面壳重启 / 代理连通性。
 */

/** 已装运行时清单的一行（$DSH_HOME 运行时清单的 wire 形状）。 */
export interface InstalledRuntime {
  version: string
  source: string
  installed_at: number
}

/** list_runtime_catalog 回显：#107 目录拉取失败不算失败（error 标记 + 空 catalog 降级）。 */

/** 判定层产出的归一候选行（#186/#189：内置 ∪ 已下载 ∪ 目录，去重降序；与壳 shared/runtime-update.ts 的 RuntimeUpdateEntry 同构）。 */
export interface RuntimeCatalogCandidate {
  version: string
  channel: string
  source: 'builtin' | 'downloaded' | 'remote'
  /** 本地已有树（内置或已下载）：切换即可，不必下载。 */
  local: boolean
  /** 内置随包分发，删不掉。 */
  uninstallable: boolean
  action: 'switch' | 'download-and-switch'
  plan: Array<{ rpc: string; args: Record<string, unknown> }>
}

/** 内置行的显示口径：bundled=随包内置 / external=dev 外部树 / none=拿不到版本。 */
export interface RuntimeBuiltinDescriptor {
  version: string | null
  kind: 'bundled' | 'external' | 'none'
  label: string
}

export interface RuntimeCatalogSnapshot {
  source: string
  builtin: string | null
  selected: string | null
  /** #79：偏好版本不在已装目录时的用户可见回退原因；无回退为 null。 */
  note: string | null
  installed: InstalledRuntime[]
  catalog: Array<{ version: string; channel: string }>
  /** 判定层产出的归一候选（#186/#189）：切换面（托盘/面板）直接消费，不再自己并集去重。 */
  candidates: RuntimeCatalogCandidate[]
  /** 内置行的显示口径；消费方不得再写 `builtinVersion ?? runningVersion` 式回退。 */
  builtinDescriptor: RuntimeBuiltinDescriptor
  error?: string
  /** 当前真正在跑的那棵树（面板据此标「运行中」并禁掉它的下载/卸载）。 */
  running: { kind: string; version: string | null; dir: string | null }
}

/** 面板每 600ms 轮询的运行时下载状态（#97 加 cancelled 终态）。 */
export interface RuntimeDownloadStatus {
  active: boolean
  version: string
  resolved: number
  downloaded: number
  added: number
  error: string
  cancelled: boolean
}

export interface RuntimeCommands {
  list_runtime_catalog: {
    args: { source?: string }
    result: RuntimeCatalogSnapshot
  }

  runtime_download_status: { args: {}; result: RuntimeDownloadStatus }

  /** 下载安装（单飞；已有任务时壳抛「已有运行时下载任务」，面板认这个串）。 */
  download_runtime: {
    args: { version: string; source?: string }
    result: { ok: true; version: string }
  }

  /** 幂等：没有任务时回 cancelled:false，面板连点两次不报错。 */
  cancel_runtime_download: {
    args: {}
    result: { cancelled: boolean; version: string }
  }

  /** 卸载：正在用 / 内置的不允许删（壳同款守卫）。 */
  remove_runtime: {
    args: { version: string }
    result: { ok: boolean; version: string }
  }

  /** 面板「重启 dsh 服务」：DSH 侧树级重启，壳本体不退出（#60/#79 语义）。 */
  restart_dsh_service: { args: {}; result: { } }

  /** #119 整应用退出 + 自动重启；失败不抛，原因原样回传让页面说人话。 */
  restart_desktop_app: {
    args: {}
    result: { ok: boolean; reason?: string; message?: string }
  }

  /** TCP 连一次代理，返回耗时 ms。 */
  test_proxy_connectivity: {
    args: { url: string }
    result: number
  }
}
