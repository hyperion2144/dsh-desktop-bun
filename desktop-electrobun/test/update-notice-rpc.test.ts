// 提醒卡动作的通道（#139 实机修）：动作走官方 Typed RPC 的原生桥，不再走
// `/__shell__/update-notice-op`——那扇窗是 html 文档，origin 是 views://，相对 URL
// 解析到 views:// 协议（fetch 直接 TypeError），绝对 loopback URL 又会被准入的同源
// 判据挡掉（cross-site → 403）。同一座桥上还挂了只读的 `runtime_download_status`，
// 让页面画下载进度（实机反馈：光写「处理中…」不够）。这里钉的是通道层的形状校验与透传。
import { describe, expect, test } from 'bun:test'
import {
  UPDATE_NOTICE_OP_METHOD,
  UPDATE_NOTICE_CLOSE_METHOD,
  UPDATE_NOTICE_RESIZE_METHOD,
  UPDATE_NOTICE_STATUS_METHOD,
  type UpdateNoticeOp,
} from '../src/bun/windows/update-notice-dialog.ts'
import {
  UPDATE_NOTICE_RPC_MAX_REQUEST_TIME,
  UPDATE_NOTICE_CLOSE_DELAY_MS,
  UPDATE_NOTICE_STATUS_METHOD as STATUS_METHOD,
  updateNoticeRpcRequests,
  type UpdateNoticeRpcDeps,
} from '../src/bun/windows/update-notice-rpc.ts'

function deps(over: Partial<UpdateNoticeRpcDeps> = {}): UpdateNoticeRpcDeps {
  return {
    run: async () => ({ ok: true, message: '走好了' }),
    downloadStatus: () => ({ active: false, version: '', resolved: 0, downloaded: 0 }),
    resize: () => {},
    close: () => {},
    ...over,
  }
}

function harness(over: Partial<UpdateNoticeRpcDeps> = {}): {
  seen: UpdateNoticeOp[]
  invoke: (params: unknown) => Promise<unknown>
  status: (params?: unknown) => Promise<unknown>
  resize: (params: unknown) => Promise<unknown>
  close: (params?: unknown) => Promise<unknown>
} {
  const seen: UpdateNoticeOp[] = []
  const { requests } = updateNoticeRpcRequests(
    deps({
      run: async (op) => {
        seen.push(op)
        return { ok: true, message: '走好了' }
      },
      ...over,
    }),
  )
  const invoke = requests[UPDATE_NOTICE_OP_METHOD]
  const status = requests[STATUS_METHOD]
  const resize = requests[UPDATE_NOTICE_RESIZE_METHOD]
  const close = requests[UPDATE_NOTICE_CLOSE_METHOD]
  if (invoke === undefined || status === undefined || resize === undefined || close === undefined)
    throw new Error('handler 缺失')
  return { seen, invoke, status, resize, close }
}

describe('提醒卡动作的官方 RPC 通道', () => {
  test('动作与只读查询各占一个方法名，页面与壳各认这一处', () => {
    const { requests } = updateNoticeRpcRequests(deps())
    expect(Object.keys(requests)).toEqual([
      UPDATE_NOTICE_OP_METHOD,
      STATUS_METHOD,
      UPDATE_NOTICE_RESIZE_METHOD,
      UPDATE_NOTICE_CLOSE_METHOD,
    ])
    expect(UPDATE_NOTICE_CLOSE_METHOD).toBe('update_notice_close')
    expect(UPDATE_NOTICE_OP_METHOD).toBe('update_notice_op')
    expect(STATUS_METHOD).toBe('runtime_download_status')
    // 同一串在两处定义：页面引 dialog 的常量，壳命令表也按这个名字注册。
    expect(STATUS_METHOD).toBe(UPDATE_NOTICE_STATUS_METHOD)
  })

  test('形状认了就原样透传给服务面，结果原样回', async () => {
    const { seen, invoke } = harness()
    const res = await invoke({ op: 'download-shell' })
    expect(res).toEqual({ ok: true, message: '走好了' })
    expect(seen).toEqual([{ op: 'download-shell' }])
  })

  test('「全部更新」带壳与运行时两段，透传后一段都不丢', async () => {
    const { seen, invoke } = harness()
    await invoke({
      op: 'update-all',
      shell: true,
      runtime: { version: '0.2.2-alpha.1', action: 'download-and-switch', source: 'npm' },
    })
    expect(seen).toEqual([
      {
        op: 'update-all',
        shell: true,
        runtime: { version: '0.2.2-alpha.1', action: 'download-and-switch', source: 'npm' },
      },
    ])
  })

  test('「不再提示」带两路拉黑目标，原样透传', async () => {
    const { seen, invoke } = harness()
    await invoke({
      op: 'ignore',
      targets: [
        { kind: 'shell', version: '0.3.0' },
        { kind: 'runtime', version: '0.2.2-alpha.1' },
      ],
    })
    expect(seen).toEqual([
      {
        op: 'ignore',
        targets: [
          { kind: 'shell', version: '0.3.0' },
          { kind: 'runtime', version: '0.2.2-alpha.1' },
        ],
      },
    ])
  })

  test('形状不认就 throw，绝不猜着执行（页面据此显示失败）', async () => {
    const { seen, invoke } = harness()
    await expect(invoke({ op: 'rm -rf' })).rejects.toThrow('提醒卡动作不认这个负载')
    await expect(invoke(null)).rejects.toThrow('提醒卡动作不认这个负载')
    await expect(invoke({ op: 'ignore', targets: 'all' })).rejects.toThrow('提醒卡动作不认这个负载')
    expect(seen).toEqual([])
  })

  test('官方请求超时要够跑完「下载 + 切换 + 重启服务」', () => {
    // 壳侧命令表用 120s；提醒卡要下载运行时再重启服务，窄超时会显示失败而任务还在跑。
    expect(UPDATE_NOTICE_RPC_MAX_REQUEST_TIME).toBeGreaterThan(10 * 60_000)
  })
})

describe('提醒卡画进度用的只读查询', () => {
  test('返回壳算好的 {active, version, percent}：百分比在壳侧算，页面只负责画', async () => {
    const { status } = harness({
      downloadStatus: () => ({ active: true, version: '0.2.1-rc.1', resolved: 200, downloaded: 50 }),
    })
    expect(await status(null)).toEqual({ active: true, version: '0.2.1-rc.1', percent: 25 })
  })

  test('没在下载时给 active false，页面据此撤掉进度条', async () => {
    const { status } = harness()
    expect(await status(null)).toEqual({ active: false, version: '', percent: 0 })
  })

  test('还没解析出包数（resolved=0）时不假装有进度', async () => {
    const { status } = harness({
      downloadStatus: () => ({ active: true, version: '0.2.1-rc.1', resolved: 0, downloaded: 0 }),
    })
    expect(await status(null)).toEqual({ active: true, version: '0.2.1-rc.1', percent: 0 })
  })

  test('查询不带参数也不抛：页面每次轮询都传 null', async () => {
    const { status } = harness()
    await expect(status(undefined)).resolves.toMatchObject({ active: false })
  })

  // #130：窗高是页面量出来的，壳只负责夹在上下限里再 setFrame。
  test('页面报来的窗高夹在上下限里再交给壳', async () => {
    const heights: number[] = []
    const { resize } = harness({ resize: (height) => void heights.push(height) })
    await resize({ height: 420 })
    await resize({ height: 120 }) // 低于下限 → 260
    await resize({ height: 5000 }) // 高于上限 → 900
    expect(heights).toEqual([420, 260, 900])
  })

  test('窗高形状不认就抛，不静默回退到默认高', async () => {
    const { resize } = harness()
    await expect(resize(null)).rejects.toThrow('窗高不认这个负载')
    await expect(resize({ height: '420' })).rejects.toThrow('窗高不认这个负载')
    await expect(resize(420)).rejects.toThrow('窗高不认这个负载')
  })
})

// #160 实机：点「稍后」毫无反应。页面里的 window.close() 在这种 html: 文档里是空操作——
// Chromium 忽略非脚本打开文档的 window.close，Electrobun 的注入胶水也没覆写它。所以关窗必须是
// 壳的动作（与主窗 window_close 同口径）。这里钉的是：壳真的去关，且关在回包之后。
describe('关窗交给壳（#160）', () => {
  test('页面叫一声壳就去关；handler 自己先返回，窗稍后才关', async () => {
    const closed: number[] = []
    const { close } = harness({
      close: () => void closed.push(closed.length + 1),
    })
    expect(closed).toEqual([])
    await close()
    // 回包先发：handler 返回时窗还没关，否则这次请求的响应会随窗一起消失（页面只见报错）。
    expect(closed).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, UPDATE_NOTICE_CLOSE_DELAY_MS + 60))
    expect(closed).toEqual([1])
  })

  test('关窗不收参数：谁来叫都一样，关的都是本窗', async () => {
    const closed: number[] = []
    const { close } = harness({ close: () => void closed.push(1) })
    await expect(close({ whatever: true })).resolves.toEqual({})
    await new Promise((resolve) => setTimeout(resolve, UPDATE_NOTICE_CLOSE_DELAY_MS + 60))
    expect(closed).toEqual([1])
  })
})
