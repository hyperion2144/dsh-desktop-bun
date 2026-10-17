import { describe, expect, test } from 'bun:test'
import { evaluateRuntimeUpdates } from '../src/shared/runtime-update.ts'
import type { UpdateNoticePayload } from '../src/bun/update-notice-dialog.ts'
import { UPDATE_NOTICE_HEIGHT, UPDATE_NOTICE_WIDTH } from '../src/bun/update-notice-dialog.ts'
import {
  UPDATE_NOTICE_TITLE,
  createUpdateNoticeWindow,
  type NoticeWindowLike,
  type NoticeWindowOptions,
} from '../src/bun/update-notice-window.ts'

class FakeWindow implements NoticeWindowLike {
  closed = false
  private handler: (() => void) | null = null
  constructor(readonly options: NoticeWindowOptions) {}
  close(): void {
    this.closed = true
  }
  on(event: 'closed', handler: () => void): void {
    if (event === 'closed') this.handler = handler
  }
  /** 模拟用户把窗关了。 */
  fireClosed(): void {
    this.closed = true
    this.handler?.()
  }
}

function fakeCtor(): { ctor: new (options: NoticeWindowOptions) => NoticeWindowLike; made: FakeWindow[] } {
  const made: FakeWindow[] = []
  class Ctor {
    constructor(options: NoticeWindowOptions) {
      const win = new FakeWindow(options)
      made.push(win)
      return win as unknown as this
    }
  }
  return { ctor: Ctor as unknown as new (options: NoticeWindowOptions) => NoticeWindowLike, made }
}

function payload(overrides: Partial<UpdateNoticePayload> = {}): UpdateNoticePayload {
  const report = evaluateRuntimeUpdates({
    running: '0.2.1-alpha.5',
    builtin: '0.2.1-alpha.5',
    catalog: [{ version: '0.2.2-alpha.1', channel: 'alpha' }],
    installed: [],
  })
  return { profile: 'desktop', baseline: '0.2.1-alpha.5', preference: null, runtime: report, shell: null, ...overrides }
}

describe('createUpdateNoticeWindow', () => {
  test('没得提醒就不开窗，构造器一次都没被调', () => {
    const { ctor, made } = fakeCtor()
    const handle = createUpdateNoticeWindow(ctor)
    expect(handle.open(payload({ runtime: null }))).toBeNull()
    expect(made).toHaveLength(0)
    expect(handle.isOpen()).toBe(false)
  })

  test('有更新才开窗：标题、隐藏标题栏、尺寸、renderer 都按选型落', () => {
    const { ctor, made } = fakeCtor()
    const handle = createUpdateNoticeWindow(ctor, { renderer: 'native' })
    const win = handle.open(payload()) as FakeWindow
    expect(made).toHaveLength(1)
    expect(win.options.title).toBe(UPDATE_NOTICE_TITLE)
    expect(win.options.titleBarStyle).toBe('hiddenInset')
    expect(win.options.frame).toEqual({ width: UPDATE_NOTICE_WIDTH, height: UPDATE_NOTICE_HEIGHT })
    expect(win.options.renderer).toBe('native')
    expect(win.options.html).toContain('0.2.2-alpha.1')
    expect(handle.isOpen()).toBe(true)
    expect(handle.current()).toBe(win)
  })

  test('不传 renderer 就不带这个键（跟随壳的默认渲染器）', () => {
    const { ctor, made } = fakeCtor()
    const handle = createUpdateNoticeWindow(ctor)
    handle.open(payload())
    expect('renderer' in made[0]!.options).toBe(false)
  })

  test('rpc 实例透传给窗（#139：动作走官方原生桥，没桥就发不出动作）', () => {
    const { ctor, made } = fakeCtor()
    const rpc = { marker: 'rpc-instance' }
    const handle = createUpdateNoticeWindow(ctor, { rpc })
    handle.open(payload())
    expect(made[0]!.options.rpc).toBe(rpc)
  })

  test('没传 rpc 就不带这个键', () => {
    const { ctor, made } = fakeCtor()
    const handle = createUpdateNoticeWindow(ctor)
    handle.open(payload())
    expect('rpc' in made[0]!.options).toBe(false)
  })

  test('重复命中只留最新一张：旧的先收掉，不叠窗', () => {
    const { ctor, made } = fakeCtor()
    const handle = createUpdateNoticeWindow(ctor)
    const first = handle.open(payload()) as FakeWindow
    const second = handle.open(payload()) as FakeWindow
    expect(made).toHaveLength(2)
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(false)
    expect(handle.current()).toBe(second)
  })

  test('用户自己关窗后句柄清干净，后面还能再开', () => {
    const { ctor } = fakeCtor()
    const handle = createUpdateNoticeWindow(ctor)
    const win = handle.open(payload()) as FakeWindow
    win.fireClosed()
    expect(handle.isOpen()).toBe(false)
    expect(handle.current()).toBeNull()
    expect(handle.open(payload())).not.toBeNull()
  })

  test('close() 幂等：没开窗时也不报错', () => {
    const { ctor, made } = fakeCtor()
    const handle = createUpdateNoticeWindow(ctor)
    handle.close()
    expect(made).toHaveLength(0)
    const win = handle.open(payload()) as FakeWindow
    handle.close()
    expect(win.closed).toBe(true)
    expect(handle.isOpen()).toBe(false)
  })
})
