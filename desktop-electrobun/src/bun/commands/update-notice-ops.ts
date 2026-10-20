/**
 * 提醒卡的动作执行器（#139，map #135）：把 `UpdateNoticeOp` 落到**已有的**四条路径上。
 *
 * 这层只做编排，不重新发明任何一条动作：
 * - 运行时「下载并切换」＝ 运行时下载器（进 `runtimesDir`，单飞/可取消/终态与面板同一套）
 *   → 落设置 → 重启服务；
 * - 运行时「切换到此版本」＝ 只落设置 + 重启服务。设置写的是
 *   `{ dsh_runtime: version, dsh_mode: 'builtin' }`——**内置行也写版本号**，这是 #97 修的坑：
 *   写 null 会让壳把「切回内置」当成没设置，进而拿已装最高版本顶上。
 * - 壳「下载更新」＝ 壳 updater 的 download。**不碰 apply**：跨重启换 `.app` 是维护者的动作，
 *   提醒窗不自动装。
 * - 「稍后」什么都不做；「不再提示」交给 #142 的 `update-notice.json`（拉黑版本号）。
 *
 * 依赖全从外面注入，所以本文件能单测：一个假下载器就能把「下载失败不许继续切」「两段里
 * 一段失败另一段照走」这些时序钉死，不必起壳。
 *
 * 顺带钉住一条边界：**多 profile 不互相影响**。执行器只作用于注入进来的这一份依赖，
 * 而依赖由对应 profile 的服务面注入——所以一个 profile 在切运行时时，别的不受影响。
 */

import type { UpdateNoticeOp, UpdateNoticeRuntimeTarget } from '../windows/update-notice-dialog.ts'
import type { UpdateNoticeTarget } from '../../shared/notify/update-notice-policy.ts'

export interface UpdateNoticeOpResult {
  ok: boolean
  /** 一句人话，页面直接显示在卡片底部。 */
  message: string
}


export interface UpdateNoticeOpDeps {
  /** 壳更新下载（`updater.download()`）。 */
  downloadShell: () => Promise<unknown>
  /** 运行时下载（进 `runtimesDir`；已有任务在跑时由下载器自己抛「已有运行时下载任务」）。 */
  downloadRuntime: (version: string, source: string) => Promise<unknown>
  /** 落设置：把选中版本钉成目标（含内置，见上方 #97 红线）。 */
  switchRuntime: (version: string) => unknown
  /** 重启 DSH 服务，让新运行时生效。 */
  restartService: () => Promise<unknown>
  /** 把版本号拉黑（#142 的持久化；没接上时如实报不可用，不假装记住了）。 */
  ignoreVersions: (targets: UpdateNoticeTarget[]) => unknown
}

export type UpdateNoticeOpRunner = (op: UpdateNoticeOp) => Promise<UpdateNoticeOpResult>

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function runRuntime(target: UpdateNoticeRuntimeTarget, deps: UpdateNoticeOpDeps): Promise<UpdateNoticeOpResult> {
  if (target.action === 'download-and-switch') {
    try {
      await deps.downloadRuntime(target.version, target.source)
    } catch (error) {
      // 下载失败就到此为止：绝不带着半成品目录去切版本。
      return { ok: false, message: `下载 ${target.version} 失败：${reasonOf(error)}` }
    }
  }
  try {
    deps.switchRuntime(target.version)
  } catch (error) {
    return { ok: false, message: `切换到 ${target.version} 失败：${reasonOf(error)}` }
  }
  try {
    await deps.restartService()
  } catch (error) {
    return { ok: false, message: `已选中 ${target.version}，但重启服务失败：${reasonOf(error)}` }
  }
  return {
    ok: true,
    message: target.action === 'download-and-switch' ? '下载完成，正在切换并重启…' : '已切换到目标版本，正在重启…',
  }
}

/**
 * 执行一个提醒卡动作。**任何一步失败都在那一步停下**，失败原因回给页面显示；
 * 「全部更新」例外——两段各自尽力，壳那段的失败不该连坐运行时那段。
 */
export function createUpdateNoticeOpRunner(deps: UpdateNoticeOpDeps): UpdateNoticeOpRunner {
  return async (op: UpdateNoticeOp): Promise<UpdateNoticeOpResult> => {
    switch (op.op) {
      case 'later':
        return { ok: true, message: '稍后再说' }
      case 'ignore':
        try {
          deps.ignoreVersions(op.targets)
          return { ok: true, message: `不再提醒 ${op.targets.map((target) => target.version).join('、')}` }
        } catch (error) {
          return { ok: false, message: `记不住忽略名单：${reasonOf(error)}` }
        }
      case 'download-shell':
        try {
          await deps.downloadShell()
          return { ok: true, message: '正在下载桌面壳更新，下载完重启应用即可' }
        } catch (error) {
          return { ok: false, message: `桌面壳更新下载失败：${reasonOf(error)}` }
        }
      case 'runtime':
        return await runRuntime(op, deps)
      case 'update-all': {
        const parts: string[] = []
        let ok = true
        if (op.shell) {
          try {
            await deps.downloadShell()
            parts.push('桌面壳开始下载')
          } catch (error) {
            ok = false
            parts.push(`桌面壳下载失败：${reasonOf(error)}`)
          }
        }
        if (op.runtime !== undefined) {
          const result = await runRuntime(op.runtime, deps)
          parts.push(result.ok ? '运行时更新完成' : result.message)
          if (!result.ok) ok = false
        }
        if (parts.length === 0) return { ok: true, message: '没有需要更新的内容' }
        return { ok, message: `${parts.join('；')}。` }
      }
      default:
        return { ok: false, message: '不认识的动作' }
    }
  }
}
