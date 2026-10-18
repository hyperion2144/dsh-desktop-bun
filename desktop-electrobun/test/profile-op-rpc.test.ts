import { describe, expect, test } from 'bun:test'
import {
  PROFILE_CLOSE_METHOD,
  PROFILE_OP_METHOD,
  type ProfileOpRequest,
  type ProfileOpResult,
} from '../src/bun/profile-dialog.ts'
import {
  PROFILE_CLOSE_DELAY_MS,
  PROFILE_OP_RPC_MAX_REQUEST_TIME,
  profileOpRpcRequests,
} from '../src/bun/profile-op-rpc.ts'

type Handler = (params: unknown) => Promise<unknown>

/** 从 handlers 表里取出通道方法；取不到就是挂点没对上，直接炸。 */
function channelOf(run: (request: ProfileOpRequest) => Promise<ProfileOpResult>): Handler {
  const handler = profileOpRpcRequests({ run, close: () => {} }).requests[PROFILE_OP_METHOD]
  if (handler === undefined) throw new Error(`通道上没挂 ${PROFILE_OP_METHOD}`)
  return handler
}

describe('profile_op 通道（#129）', () => {
  test('方法名与页面侧常量对齐', () => {
    expect(PROFILE_OP_METHOD).toBe('profile_op')
  })

  test('超时够跑完一次依赖树迁移（≥ 10 分钟），官方到点只放弃回包不取消任务', () => {
    expect(PROFILE_OP_RPC_MAX_REQUEST_TIME).toBeGreaterThanOrEqual(10 * 60_000)
  })

  test('create：合法入参原样交给业务层，结果原样回给页面', async () => {
    const seen: ProfileOpRequest[] = []
    const handler = channelOf(async (request) => {
      seen.push(request)
      return { ok: true, message: 'profile demo 已创建', profile: 'demo' }
    })
    const result = await handler({ op: 'create', target: 'demo' })
    expect(seen).toEqual([{ op: 'create', target: 'demo' }])
    expect(result).toEqual({ ok: true, message: 'profile demo 已创建', profile: 'demo' })
  })

  test('migrate：source 与 overwrite 完整穿过去', async () => {
    const seen: ProfileOpRequest[] = []
    const handler = channelOf(async (request) => {
      seen.push(request)
      return { ok: true, message: '迁移完成', profile: 'web' }
    })
    await handler({ op: 'migrate', target: 'web', source: 'desktop', overwrite: true })
    expect(seen).toEqual([{ op: 'migrate', target: 'web', source: 'desktop', overwrite: true }])
  })

  test('形状不认就 throw，绝不猜着调业务层', async () => {
    let called = 0
    const handler = channelOf(async () => {
      called += 1
      return { ok: true, message: '' }
    })
    await expect(handler({ op: 'delete', target: 'x' })).rejects.toThrow('Profile 操作不认这个负载')
    await expect(handler(null)).rejects.toThrow('Profile 操作不认这个负载')
    await expect(handler({ op: 'migrate', target: 'b' })).rejects.toThrow('Profile 操作不认这个负载')
    expect(called).toBe(0)
  })

  test('业务层回 ok:false 时原样透传（页面据它显示红字）', async () => {
    const handler = channelOf(async () => ({ ok: false, message: '名称仅允许小写字母、数字与连字符（1-64 字符）' }))
    expect(await handler({ op: 'create', target: 'Bad Name' })).toEqual({
      ok: false,
      message: '名称仅允许小写字母、数字与连字符（1-64 字符）',
    })
  })
})

// #162：页面自己关不掉自己（html: 文档里的 window.close 是空操作），成功后请壳代劳。
// 与更新提醒窗 #160 同一颗雷、同一修法：通道上多挂一个 profile_close，回包先发、窗稍后才关。
describe('profile_close 通道（#162）', () => {
  test('通道上挂着 profile_close，且与方法名常量一致', () => {
    const { requests } = profileOpRpcRequests({
      run: async () => ({ ok: true, message: '已创建' }),
      close: () => {},
    })
    expect(Object.keys(requests)).toEqual([PROFILE_OP_METHOD, PROFILE_CLOSE_METHOD])
    expect(PROFILE_CLOSE_METHOD).toBe('profile_close')
  })

  test('页面叫一声壳就去关；handler 自己先返回，窗稍后才关', async () => {
    const closed: number[] = []
    const { requests } = profileOpRpcRequests({
      run: async () => ({ ok: true, message: '已创建' }),
      close: () => void closed.push(closed.length + 1),
    })
    const handler = requests[PROFILE_CLOSE_METHOD]
    if (handler === undefined) throw new Error('通道上没挂 profile_close')
    expect(closed).toEqual([])
    await handler(null)
    // 回包先发：handler 返回时窗还没关，否则这次请求的响应会随窗一起消失（页面只见报错）。
    expect(closed).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, PROFILE_CLOSE_DELAY_MS + 60))
    expect(closed).toEqual([1])
  })

  test('关窗不收参数：谁来叫都一样，关的都是本窗', async () => {
    const closed: number[] = []
    const { requests } = profileOpRpcRequests({
      run: async () => ({ ok: true, message: '已迁移' }),
      close: () => void closed.push(1),
    })
    const handler = requests[PROFILE_CLOSE_METHOD]
    if (handler === undefined) throw new Error('通道上没挂 profile_close')
    await expect(handler({ whatever: true })).resolves.toEqual({})
    await new Promise((resolve) => setTimeout(resolve, PROFILE_CLOSE_DELAY_MS + 60))
    expect(closed).toEqual([1])
  })
})
