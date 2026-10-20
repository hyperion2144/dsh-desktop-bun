/**
 * 下载 tab 命令（contract 中间层）。
 * 管理器在壳 src/bun/downloads.ts；页面拦截 blob:/data: 后的三步分块上传也在这一组。
 */

export type DownloadStatus =
  | 'choosing_path'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 任务来源：URL 直链（壳流式下载，支持 Range 续传）或页面 blob/data（页面分块交壳写盘）。 */
export type DownloadKind = 'url' | 'blob'

/** list_downloads 的一行（壳 DownloadTask 的 wire 形状，逐字段一致）。 */
export interface DownloadTask {
  id: number
  kind: DownloadKind
  /** 来源 URL（blob 任务为触发页 origin，仅展示用）。 */
  url: string
  filename: string
  targetPath: string
  /** 服务器 Content-Length；未知为 null。 */
  total: number | null
  received: number
  /** 上次成功响应的 ETag（续传时作 If-Range 校验）。 */
  etag: string | null
  resumed: boolean
  status: DownloadStatus
  error: string | null
  /** unix 秒。 */
  createdAt: number
  updatedAt: number
}

export interface DownloadCommands {
  list_downloads: { args: {}; result: DownloadTask[] }

  get_download_settings: {
    args: {}
    result: { concurrency: number; download_dir: string }
  }

  /** 上限由下载管理器夹取并回写设置；无窗口单测没有管理器时回 {}。 */
  set_download_concurrency: {
    args: { value: number }
    result: { concurrency?: number }
  }

  pause_download: { args: { id: number }; result: { } }
  resume_download: { args: { id: number }; result: { } }
  cancel_download: { args: { id: number }; result: { } }

  clear_finished_downloads: {
    args: {}
    result: { removed: number }
  }

  /** 在文件管理器里定位；任务不存在或没有管理器时 false。 */
  reveal_download: {
    args: { id: number }
    result: boolean
  }

  /** 页面拦截到 blob:/data: 后开任务（返回任务 id）。 */
  start_blob_download: {
    args: { filename?: string; total?: number | null }
    result: number
  }

  /** 512KB 分块 base64 上传；false = 页面必须停发（任务被暂停/取消/失败）。 */
  save_blob_chunk: {
    args: { id: number; chunk: string }
    result: boolean
  }

  finish_blob_download: {
    args: { id: number }
    result: boolean
  }

  /** http(s) 直链：页面拦截带 download 属性的锚点后调这条。 */
  start_url_download: {
    args: { url: string; filename?: string }
    result: number
  }
}
