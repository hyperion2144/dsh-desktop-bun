import { describe, expect, test } from 'bun:test'
import { createAccountWatcher, REMOTE_MUX_PATH, type WebSocketLike } from '../src/bun/host/account-watcher.ts'

interface FakeSocket extends WebSocketLike {
  url: string
  headers: Record<string, string>
  sent: string[]
  closed: boolean
  emit(type: string, event?: { data?: unknown }): void
}

function fakeSocketFactory(url: string, headers: Record<string, string>): FakeSocket {
  const listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()
  const socket: FakeSocket = {
    url,
    headers,
    sent: [],
    closed: false,
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    send(data) {
      socket.sent.push(data)
    },
    close() {
      socket.closed = true
      socket.emit('close')
    },
    emit(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
  }
  return socket
}

const view = (id: string, phase: string, authorizeUrl?: string): unknown => ({
  status: 'signed-out',
  attempt: { id, phase, ...(authorizeUrl === undefined ? {} : { authorizeUrl }) },
})

const item = (streamId: string, value: unknown): string => JSON.stringify({ type: 'item', streamId, value })

describe('主进程账号 watcher（#169）', () => {
  test('连宿主 mux、开 account/watch 流、等浏览器时把授权页交给系统浏览器', () => {
    const sockets: FakeSocket[] = []
    const opened: string[] = []
    const watcher = createAccountWatcher({
      hostOrigin: () => 'http://127.0.0.1:3081',
      cookie: () => 'dsh-auth-test=1',
      openExternal: (url) => opened.push(url),
      theme: () => 'dark',
      log: () => {},
      retryMs: 5,
      createSocket: (url, headers) => {
        const socket = fakeSocketFactory(url, headers)
        sockets.push(socket)
        return socket
      },
    })
    watcher.start()
    expect(sockets).toHaveLength(1)
    const socket = sockets[0]!
    expect(socket.url).toBe(`ws://127.0.0.1:3081${REMOTE_MUX_PATH}`)
    expect(socket.headers.cookie).toBe('dsh-auth-test=1')
    expect(socket.headers.origin).toBe('http://127.0.0.1:3081')

    socket.emit('open')
    const open = JSON.parse(socket.sent[0]!) as { type: string; streamId: string; endpoint: string }
    expect(open.type).toBe('open')
    expect(open.endpoint).toBe('account/watch')
    const streamId = open.streamId

    // 错 streamId 的帧不触发
    socket.emit('message', { data: item('other-stream', view('att-1', 'waiting-browser', 'https://platform.deepseek.com/oauth/authorize?client_id=dsh')) })
    expect(opened).toEqual([])

    socket.emit('message', { data: item(streamId, view('att-1', 'waiting-browser', 'https://platform.deepseek.com/oauth/authorize?client_id=dsh')) })
    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain('theme=dark')

    // 同一 attempt 的重复推送不再开窗
    socket.emit('message', { data: item(streamId, view('att-1', 'waiting-browser', 'https://platform.deepseek.com/oauth/authorize?client_id=dsh')) })
    expect(opened).toHaveLength(1)

    // 新 attempt 再开一次
    socket.emit('message', { data: item(streamId, view('att-2', 'waiting-browser', 'https://platform.deepseek.com/oauth/authorize?client_id=dsh&x=2')) })
    expect(opened).toHaveLength(2)

    watcher.stop()
    expect(socket.closed).toBe(true)
  })

  test('cookie 没换到就先等；断线后重连并带上最新 cookie（宿主重启换 cookie 也跟上）', async () => {
    const sockets: FakeSocket[] = []
    let cookie = ''
    const watcher = createAccountWatcher({
      hostOrigin: () => 'http://127.0.0.1:3081',
      cookie: () => cookie,
      openExternal: () => {},
      log: () => {},
      retryMs: 5,
      createSocket: (url, headers) => {
        const socket = fakeSocketFactory(url, headers)
        sockets.push(socket)
        return socket
      },
    })
    watcher.start()
    expect(sockets).toHaveLength(0)
    await Bun.sleep(20)
    expect(sockets).toHaveLength(0)

    cookie = 'c1'
    await Bun.sleep(20)
    expect(sockets.length).toBeGreaterThan(0)
    expect(sockets[0]!.headers.cookie).toBe('c1')

    sockets[0]!.close()
    cookie = 'c2'
    await Bun.sleep(20)
    expect(sockets.length).toBeGreaterThan(1)
    expect(sockets[sockets.length - 1]!.headers.cookie).toBe('c2')
    watcher.stop()
  })

  test('没有 openExternal（无窗口宿主）不连；stop 后不再重连', async () => {
    const sockets: FakeSocket[] = []
    const factory = (url: string, headers: Record<string, string>): FakeSocket => {
      const socket = fakeSocketFactory(url, headers)
      sockets.push(socket)
      return socket
    }
    const idle = createAccountWatcher({ hostOrigin: () => 'http://127.0.0.1:3081', cookie: () => 'c1', log: () => {}, retryMs: 5, createSocket: factory })
    idle.start()
    expect(sockets).toHaveLength(0)

    const watcher = createAccountWatcher({
      hostOrigin: () => 'http://127.0.0.1:3081',
      cookie: () => 'c1',
      openExternal: () => {},
      log: () => {},
      retryMs: 5,
      createSocket: factory,
    })
    watcher.start()
    expect(sockets).toHaveLength(1)
    watcher.stop()
    await Bun.sleep(20)
    expect(sockets).toHaveLength(1)
  })
})
