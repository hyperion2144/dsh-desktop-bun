import { describe, expect, test } from 'bun:test'
import { PROFILE_OP_METHOD, type ProfileOpRequest, type ProfileOpResult } from '../src/bun/profile-dialog.ts'
import { PROFILE_OP_RPC_MAX_REQUEST_TIME, profileOpRpcRequests } from '../src/bun/profile-op-rpc.ts'

type Handler = (params: unknown) => Promise<unknown>

/** 从 handlers 表里取出通道方法；取不到就是挂点没对上，直接炸。 */
function channelOf(run: (request: ProfileOpRequest) => Promise<ProfileOpResult>): Handler {
  const handler = profileOpRpcRequests({ run }).requests[PROFILE_OP_METHOD]
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
