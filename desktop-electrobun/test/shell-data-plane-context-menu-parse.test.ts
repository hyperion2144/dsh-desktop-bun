// #144-2：右键菜单请求的归一化解析只剩一份实现，两条入口逐字段一致。
//
// 改造前 commands.ts 的 show_context_menu 与 shell-server.ts 的 /__shell__/context-menu
// 各自解析一份同款逻辑（triage 已核验行为完全相同）。本文件锁住「一份实现 + 两条入口等价」：
// 同一个请求体喂进去，两边产出的归一化对象必须逐字段相同，菜单项集合与位置也就跟着相同。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startShellServer } from '../src/bun/shell-server.ts'
import { createCommandTable, type CommandDeps } from '../src/bun/commands.ts'
import { createRpcRouter, dispatchRpc } from '../src/bun/rpc.ts'
import { contextMenuItems, parseContextMenuRequest, type ContextMenuRequest } from '../src/bun/context-menu.ts'
import { defaultSettings } from '../src/shared/settings.ts'

const EMPTY: ContextMenuRequest = {
  linkUrl: null,
  hasSelection: false,
  editable: false,
  filesEntry: null,
  filesPath: null,
}

function takeFreePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('probe') })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) throw new Error('临时端口没拿到')
  return port
}

interface Harness {
  origin: string
  /** 两条入口共用的收集口——归一化后的请求按到达顺序落这里。 */
  seen: ContextMenuRequest[]
  cleanup: () => void
}

/** 真命令表 + 真壳服务面：两条入口都指向同一个 sink，这样「等价」是可以逐条比对的。 */
function harness(): Harness {
  const seen: ContextMenuRequest[] = []
  const settings = defaultSettings()
  const deps: CommandDeps = {
    home: tmpdir(),
    profile: 'desktop',
    platform: 'darwin',
    log: () => {},
    settings: () => settings,
    save: () => settings,
    showContextMenu: (request) => seen.push(request),
  }
  const dist = mkdtempSync(join(tmpdir(), 'dsh-ctxmenu-'))
  const server = startShellServer({
    distDir: dist,
    token: 'tok',
    cookie: 'dsh-auth-x=v1.y',
    upstreamOrigin: `http://127.0.0.1:${String(takeFreePort())}`,
    port: takeFreePort(),
    bootPayload: () => null,
    onContextMenu: (request) => seen.push(request),
    onRpc: async (raw) => dispatchRpc(createRpcRouter(createCommandTable(deps)), raw),
  })
  return {
    origin: server.origin,
    seen,
    cleanup: () => {
      server.stop()
      rmSync(dist, { recursive: true, force: true })
    },
  }
}

/** 入口 A：官方 RPC 的 show_context_menu（走真实 HTTP RPC 端点，命令表是真表）。 */
async function viaRpc(origin: string, seen: ContextMenuRequest[], args: Record<string, unknown>): Promise<ContextMenuRequest> {
  const res = await fetch(`${origin}/__shell__/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'show_context_menu', args }),
  })
  expect(res.status).toBe(200)
  expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true })
  return seen.pop() as ContextMenuRequest
}

/** 入口 B：壳自答 HTTP 端点 /__shell__/context-menu。 */
async function viaHttp(origin: string, seen: ContextMenuRequest[], body: string): Promise<ContextMenuRequest> {
  const res = await fetch(`${origin}/__shell__/context-menu`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  expect(res.status).toBe(204)
  return seen.pop() as ContextMenuRequest
}

/** 真实可达的请求体：RPC args 恒为 plain object（parseRpcRequest 非 record 直接 400）。 */
const CASES: { name: string; args: Record<string, unknown>; expected: ContextMenuRequest }[] = [
  { name: '缺全部字段', args: {}, expected: EMPTY },
  {
    name: '五个字段齐全',
    args: {
      linkUrl: 'https://x.dev/a',
      hasSelection: true,
      editable: true,
      filesEntry: 'file',
      filesPath: '/tmp/a.txt',
    },
    expected: {
      linkUrl: 'https://x.dev/a',
      hasSelection: true,
      editable: true,
      filesEntry: 'file',
      filesPath: '/tmp/a.txt',
    },
  },
  { name: '空串 linkUrl 归 null', args: { linkUrl: '' }, expected: EMPTY },
  { name: '非字符串 linkUrl 归 null', args: { linkUrl: 123 }, expected: EMPTY },
  { name: 'null linkUrl 归 null', args: { linkUrl: null }, expected: EMPTY },
  {
    name: '布尔只认严格 true（1 / "true" / "yes" 都不算）',
    args: { hasSelection: 1, editable: 'true' },
    expected: EMPTY,
  },
  {
    name: 'filesEntry 白名单：file / directory / other',
    args: { filesEntry: 'directory', filesPath: '/tmp/proj' },
    expected: { ...EMPTY, filesEntry: 'directory', filesPath: '/tmp/proj' },
  },
  {
    name: 'filesEntry=other 保留（但 other 不给打开项，由菜单结构决定）',
    args: { filesEntry: 'other', filesPath: '/tmp/x' },
    expected: { ...EMPTY, filesEntry: 'other', filesPath: '/tmp/x' },
  },
  { name: 'filesEntry 大小写不同的 File 归 null', args: { filesEntry: 'File' }, expected: EMPTY },
  { name: 'filesEntry 非字符串归 null', args: { filesEntry: 3 }, expected: EMPTY },
  {
    name: 'filesPath：posix 绝对路径放行',
    args: { filesEntry: 'file', filesPath: '/tmp/a.txt' },
    expected: { ...EMPTY, filesEntry: 'file', filesPath: '/tmp/a.txt' },
  },
  {
    name: 'filesPath：Windows 盘符 + 反斜杠放行',
    args: { filesEntry: 'file', filesPath: 'C:\\Users\\me\\a.txt' },
    expected: { ...EMPTY, filesEntry: 'file', filesPath: 'C:\\Users\\me\\a.txt' },
  },
  {
    name: 'filesPath：Windows 盘符 + 正斜杠放行',
    args: { filesEntry: 'file', filesPath: 'C:/Users/me' },
    expected: { ...EMPTY, filesEntry: 'file', filesPath: 'C:/Users/me' },
  },
  {
    name: 'filesPath：相对路径归 null（防 etc/passwd 混入）',
    args: { filesEntry: 'file', filesPath: 'etc/passwd' },
    expected: { ...EMPTY, filesEntry: 'file' },
  },
  {
    name: 'filesPath：URL 形态归 null',
    args: { filesEntry: 'file', filesPath: 'https://evil.test/a' },
    expected: { ...EMPTY, filesEntry: 'file' },
  },
  { name: 'filesPath：空串归 null', args: { filesEntry: 'file', filesPath: '' }, expected: { ...EMPTY, filesEntry: 'file' } },
  { name: 'filesPath：非字符串归 null', args: { filesEntry: 'file', filesPath: 7 }, expected: { ...EMPTY, filesEntry: 'file' } },
]

describe('#144-2 右键菜单请求解析去重', () => {
  test('解析器本身：非对象输入一律按空请求处理（HTTP body 可能不是对象）', () => {
    for (const input of [null, undefined, 5, 'str', true, [], [1, 2, 3]]) {
      expect(parseContextMenuRequest(input)).toEqual(EMPTY)
    }
  })

  for (const item of CASES) {
    test(`两条入口等价：${item.name}`, async () => {
      const h = harness()
      try {
        const byRpc = await viaRpc(h.origin, h.seen, item.args)
        const byHttp = await viaHttp(h.origin, h.seen, JSON.stringify(item.args))
        expect(byRpc).toEqual(item.expected)
        expect(byHttp).toEqual(item.expected)
        // 关键断言：两条入口对同一请求体产出完全相同（不只是都等于期望值）
        expect(byHttp).toEqual(byRpc)
      } finally {
        h.cleanup()
      }
    })
  }

  test('HTTP 入口的畸形 body 兜底：非 JSON 与非对象都按空请求处理，不抛也不漏', async () => {
    const h = harness()
    try {
      for (const raw of ['not json at all', '[]', '5', '"str"', 'null', '{}']) {
        const res = await fetch(`${h.origin}/__shell__/context-menu`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        })
        expect(res.status).toBe(204)
        expect(h.seen.pop()).toEqual(EMPTY)
      }
    } finally {
      h.cleanup()
    }
  })

  test('HTTP 入口只认 POST：GET 405，且不产生任何菜单请求', async () => {
    const h = harness()
    try {
      expect((await fetch(`${h.origin}/__shell__/context-menu`)).status).toBe(405)
      expect(h.seen).toHaveLength(0)
    } finally {
      h.cleanup()
    }
  })

  test('归一化结果直接喂菜单结构：项集合与位置逐字不变（链接 + 工作区文件行）', () => {
    const items = contextMenuItems(
      parseContextMenuRequest({
        linkUrl: 'https://x.dev/a',
        hasSelection: true,
        editable: true,
        filesEntry: 'file',
        filesPath: '/tmp/a.txt',
      }),
      true,
    )
    expect(items.map((item) => [item.type ?? item.label ?? item.role])).toEqual([
      ['打开'],
      ['separator'],
      ['在系统浏览器打开链接'],
      ['复制链接地址'],
      ['separator'],
      ['刷新'],
      ['separator'],
      ['cut'],
      ['copy'],
      ['paste'],
      ['selectAll'],
    ])
    // 数据随项带回去：打开/外链/复制的 data 都是归一化后的值
    expect(items[0]?.data).toEqual({ path: '/tmp/a.txt' })
    expect(items[2]?.data).toEqual({ url: 'https://x.dev/a' })
    expect(items[3]?.data).toEqual({ url: 'https://x.dev/a' })
  })
})
