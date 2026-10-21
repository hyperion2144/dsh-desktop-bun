// `shell_update_status` 的合成逻辑（#235）：把「Windows 自管安装包下载器」与「框架
// updater 视图」两个状态源合成一个页面能直接画的形状。
//
// 为什么收在纯逻辑层：组装处（service.ts）只是把两个现成快照递进来，优先级与字段
// 翻译在这里钉死并单测——三平台共用这一个口径，
// 页面只认这一张表，不再自己猜该信哪个源。
//
// 优先级：
//   1. 安装包下载器在跑 → 进度（win 下载中的唯一真相）；
//   2. 下载器就绪 → updateReady + 安装包路径（「已下载未安装直接装」的窗上呈现；
//      且文件真的在磁盘上——被删了就回落）；
//   3. 下载器上次失败 → 红字（弹窗不关了的失败必须可见）；
//   4. 都不是 → 回落自管 check 的远端视图（有没有新版本、检查失败原因在这里）；
//      状态是 idle，但安装包还躺在磁盘上。取消（3b）与 idle 同路回落远端视图，
//      允许用户再点一次下载。

import type { InstallerDownloadStatus } from './installer-download.ts'
import { existsSync } from 'node:fs'
import type { UpdateView } from '../../shared/runtime/update.ts'
// #235：单一真源在契约（contracts/updates.ts），平台模块 re-export——命令表回执与
// 提醒窗 RPC 用的是同一个形状，结构与 UpdateSnapshot 一样走契约校验。
import type { ShellUpdateStatus } from '../../../../contracts/index.ts'
export type { ShellUpdateStatus }

export function shellUpdateStatusOf(input: {
  installer: InstallerDownloadStatus
  view: UpdateView
  /** 开窗/轮询时的磁盘就绪探测（`findReady(view.latest)`）；空串 = 没有。 */
  readyPath?: string
  /** #235：下载中的落点展示（票面「下载文件位置」）——组装处按 root+version 算好递进来。 */
  targetPath?: string
  /** #235 实机反馈：文件存在性检查（默认 fs.existsSync）——安装包被用户/清理工具删掉后，
   *  内存「下载完成」不再算数（磁盘实际为准）。单测注入假函数。 */
  exists?: (path: string) => boolean
}): ShellUpdateStatus {
  const installer = input.installer
  if (installer.active) {
    return {
      active: true,
      version: installer.version,
      percent: installer.percent,
      error: '',
      updateReady: false,
      installerPath: input.targetPath ?? '',
    }
  }
  const view = input.view
  // 就绪态要求版本对得上：快照拿不到 latest（空串）时信下载器，否则新版本发布后
  // 就绪态要求：版本对得上（快照拿不到 latest 空串时信下载器），且文件真的还在——
  // 用户/清理工具删掉安装包后，内存「下载完成」不算数（磁盘实际为准），
  // 否则点「安装」只会报「还没就绪」：呈现与动作自相矛盾。
  const fileExists = input.exists ?? existsSync
  if (
    installer.phase === 'ready' &&
    (view.latest === '' || installer.version === view.latest) &&
    fileExists(installer.filePath)
  ) {
    return {
      active: false,
      version: installer.version,
      percent: 100,
      error: '',
      updateReady: true,
      installerPath: installer.filePath,
    }
  }
  if (installer.phase === 'error') {
    return {
      active: false,
      version: installer.version,
      percent: null,
      error: installer.error,
      updateReady: false,
      installerPath: '',
    }
  }
  const readyPath = input.readyPath ?? ''
  if (readyPath !== '') {
    return {
      active: false,
      version: view.latest,
      percent: 100,
      error: '',
      updateReady: true,
      installerPath: readyPath,
    }
  }
  return {
    active: view.phase === 'downloading' || view.phase === 'preparing',
    version: view.latest,
    percent: view.progress,
    error: view.error,
    updateReady: view.updateReady,
    installerPath: '',
  }
}
