/**
 * Profile 新建/迁移弹窗的**通道**：官方 Electrobun Typed RPC 的原生桥（#129）。
 *
 * 这扇窗是 `html:` 文档，origin 是 `views://internal`——相对 URL 解析到 views:// 协议（请求
 * 根本发不出去），换成绝对 loopback URL 也会被准入的同源判据挡掉（`Sec-Fetch-Site: cross-site`
 * → 403，`shared/admission.ts` 的跨站判据在 shell 分支之前）。两条路都不通，于是和更新提醒窗
 * （#139）同一个路子改走官方原生桥：它不过这两道，也不必带视图 token。
 *
 * 只挂 `defineRPC`、不挂 `attachShellRpc` + 视图授权：这扇窗没有视图身份、也不需要整个命令表
 * ——它只要一个方法。窗口一次建一张，rpc 实例可以复用（见 index.ts 的缓存）。
 *
 * handlers 是纯逻辑、可单测；electrobun 运行时只在真挂点（建窗）时才动态载入。
 */
import {
  PROFILE_OP_METHOD,
  PROFILE_CLOSE_METHOD,
  profileOpRequest,
  type ProfileOpRequest,
  type ProfileOpResult,
} from '../windows/profile-dialog.ts'

/**
 * 官方通道的请求超时。迁移要复制整棵依赖树再跑 pnpm install，可能好几分钟；官方到点只
 * **放弃回包**、不取消壳侧任务（#97 同理），超时窄了会让用户看着「失败」而迁移还在后台跑。
 */
export const PROFILE_OP_RPC_MAX_REQUEST_TIME = 30 * 60_000

/** 关窗前给回包留的时间（#162）：够官方通道把响应发出去，再让窗消失。 */
export const PROFILE_CLOSE_DELAY_MS = 120

export interface ProfileOpRpcDeps {
  /** 执行业务动作（服务面那侧；本模块只管通道与形状校验）。 */
  run: (request: ProfileOpRequest) => Promise<ProfileOpResult>
  /** 请壳关掉本窗（#162）：页面自己关不掉自己（html: 文档里的 window.close 是空操作）。 */
  close: () => void
}

/** handlers 表（纯逻辑，可单测）：形状不认就不猜，直接 throw 让页面显示失败。 */
export function profileOpRpcRequests(deps: ProfileOpRpcDeps): {
  requests: Record<string, (params: unknown) => Promise<unknown>>
} {
  return {
    requests: {
      [PROFILE_OP_METHOD]: async (params: unknown) => {
        const request = profileOpRequest(params)
        if (request === null) throw new Error('Profile 操作不认这个负载')
        return deps.run(request)
      },
      // 关窗（#162，与更新提醒窗 #160 同款）：页面成功后请壳关窗。回包先发、窗稍后才关——
      // 在 handler 里同步关掉会让这次请求的响应随窗一起消失（页面只见报错）。不收参数：
      // 这扇窗一次建一张、rpc 实例跟着它走，叫关的就是本窗。
      [PROFILE_CLOSE_METHOD]: async () => {
        setTimeout(() => deps.close(), PROFILE_CLOSE_DELAY_MS)
        return {}
      },
    },
  }
}

/** 官方 defineRPC 挂点：返回的 rpc 实例原样喂给 `new BrowserWindow({ rpc })`。 */
export async function attachProfileOpRpc(deps: ProfileOpRpcDeps): Promise<unknown> {
  const { BrowserView } = await import('electrobun/bun')
  return BrowserView.defineRPC({
    maxRequestTime: PROFILE_OP_RPC_MAX_REQUEST_TIME,
    handlers: profileOpRpcRequests(deps),
  })
}
