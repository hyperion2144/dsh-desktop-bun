// Bun 兼容层（bun-preload.mjs）的补丁应用测试（不含真 dsh 运行时，缝 ② 可测）。
//
// 做法：造一棵假 node_modules，把上游文件的关键文本写进去，然后用真 bun 跑
// `bun --preload <preload> <script>`（`DSH_BUN_PRELOAD_TREES=<假树>` 指路），
// 进程跑完后断言文件被改写成了什么。
//
// 注意两条：
//   · 子进程的 cwd / argv[1] 都在临时目录里 —— 兼容层会顺着这两条往上找 node_modules，
//     否则它可能摸到仓库自己的树；
//   · 补丁是**持久**的（`_patches` 只记账，不还原），所以退出后可以直接读文件。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

const projectRoot = resolve(import.meta.dir, '..')
const preloadPath = resolve(projectRoot, '..', 'resources', 'dsh', 'bun-preload.mjs')

const roots: string[] = []

function tempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-preload-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})


/** 守卫行原文（preload 用它定位）。 */
const INSPECTOR_GUARD_LINE =
  '\tif (descriptor !== void 0 && !("value" in descriptor)) throw new Error("inspector: globalThis.fetch is an accessor and cannot be observed safely");'
/** rev≤6 旧补丁的归一块产物（无 rev 指纹、未修 spread 定义）。 */
const INSPECTOR_LEGACY_NORMALIZE = [
  '\t// bun-preload: fetch 访问器归一（billion-context 装的是访问器，inspector 原本会硬拒）',
  '\tif (descriptor !== void 0 && !("value" in descriptor)) {',
  '\t\tObject.defineProperty(globalThis, "fetch", { value: original, writable: true, configurable: true, enumerable: descriptor.enumerable ?? true });',
  '\t}',
].join('\n')
/** 上游 spread 定义块（#6：descriptor 是 const，旧 get/set 不能与 value 共存 → Bun 拒绝）。 */
const INSPECTOR_SPREAD_FROM = '\t} : {\n\t\t...descriptor,\n\t\tvalue: observedFetch\n\t});'
const INSPECTOR_SPREAD_TO = '\t} : {\n\t\tvalue: observedFetch,\n\t\twritable: true,\n\t\tconfigurable: true\n\t});'
/** 上游 inspector 的真实形态：descriptor/original + 守卫行 + spread 定义块。 */
const INSPECTOR_UPSTREAM = [
  'const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");',
  'const original = globalThis.fetch;',
  'if (typeof original !== "function") throw new Error("inspector: globalThis.fetch is unavailable");',
  'const observedFetch = original;',
  INSPECTOR_GUARD_LINE,
  '\tObject.defineProperty(globalThis, "fetch", descriptor === void 0 ? {',
  '\t\tvalue: observedFetch,',
  '\t\twritable: true,',
  '\t\tconfigurable: true',
  '\t} : {',
  '\t\t...descriptor,',
  '\t\tvalue: observedFetch',
  '\t});',
  'export const done = true;',
  '',
].join('\n')
/** Patch 13/14 与 Patch 12 的 rev≥7 夹具共用的上游 port1 泵锚块（真实上游自带）。 */
const INSPECTOR_HOST_PUMP_LINES = [
  'class HostInspectorSource {',
  '\tconstructor(port) {',
  '\t\tport.on("message", (value) => {',
  '\t\t\ttry {',
  '\t\t\t\tif (this.queries.receive(value)) return;',
  '\t\t\t\tthis.receive(value);',
  '\t\t\t} catch {',
  '\t\t\t\tthis.close();',
  '\t\t\t}',
  '\t\t});',
  '\t}',
  '}',
]

function inspectorPath(tree: string): string {
  return join(tree, 'node_modules', '@deepseek-ai', 'dsh-experimental-inspector', 'lib', 'index.js')
}

function writeInspector(tree: string, content: string): string {
  const file = inspectorPath(tree)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return file
}

/** 跑一次兼容层（真 bun 子进程），返回 stdout/stderr。 */
function runPreload(tree: string): { stdout: string; stderr: string; code: number } {
  const script = join(tree, 'noop.mjs')
  writeFileSync(script, 'console.log("child-ok")\n', 'utf8')
  const child = Bun.spawnSync({
    cmd: [process.execPath, '--no-install', '--preload', preloadPath, script],
    cwd: tree,
  // 旧断言依赖 Patch N 的 stdout 日志：preload 的信息性日志现在默认静默（#62），测试显式打开
  env: { ...process.env, DSH_BUN_PRELOAD_TREES: tree, DSH_SHELL_PRELOAD_DEBUG: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { stdout: child.stdout.toString(), stderr: child.stderr.toString(), code: child.exitCode ?? -1 }
}

describe('bun-preload Patch 12（inspector 的 fetch 访问器）', () => {
  test('把「访问器就拒绝启动」改成先归一成数据属性', () => {
    const tree = tempTree()
    writeInspector(tree, INSPECTOR_UPSTREAM)

    const result = runPreload(tree)
    const patched = readFileSync(inspectorPath(tree), 'utf8')

    // console.log 走 stdout，console.warn 才走 stderr。
    expect(result.stdout).toContain('Patch 12: fetch 访问器归一 applied')
    expect(patched).toContain('bun-preload: fetch 访问器归一')
    expect(patched).not.toContain('cannot be observed safely')
    // 归一那句必须是「把当时的 fetch 落成数据属性」——只删检查不归一，后面照样读不到值。
    expect(patched).toContain('Object.defineProperty(globalThis, "fetch", { value: original, writable: true, configurable: true, enumerable: descriptor.enumerable ?? true })')
    // 同文件其余行不能动。
    expect(patched).toContain('const original = globalThis.fetch;')
    expect(patched).toContain('export const done = true;')
  })

  test('重复启动幂等（不叠第二份归一）', () => {
    const tree = tempTree()
    writeInspector(tree, INSPECTOR_UPSTREAM)

    runPreload(tree)
    const first = readFileSync(inspectorPath(tree), 'utf8')
    const second = runPreload(tree)

    expect(second.stdout).toContain('Patch 12: bun-preload-rev:')
    expect(readFileSync(inspectorPath(tree), 'utf8')).toBe(first)
    expect(first.split('bun-preload: fetch 访问器归一').length - 1).toBe(1)
  })

  test('spread 定义换成数据属性（#6：旧访问器描述符 spread+value 会被 Bun 拒）', () => {
    const tree = tempTree()
    writeInspector(tree, INSPECTOR_UPSTREAM)

    const result = runPreload(tree)
    const patched = readFileSync(inspectorPath(tree), 'utf8')

    expect(result.stdout).toContain('Patch 12: fetch 访问器归一 applied')
    expect(patched).not.toContain('...descriptor')
    expect(patched).toContain(INSPECTOR_SPREAD_TO)
    // spread 修复不碍归一块：归一那行还在，同文件其余行不动。
    expect(patched).toContain('Object.defineProperty(globalThis, "fetch", { value: original, writable: true, configurable: true, enumerable: descriptor.enumerable ?? true })')
    expect(patched).toContain('export const done = true;')
  })

  test('rev≤6 旧补丁机器：旧归一块刷新成带 rev 指纹的新补丁，并补上 spread 修复', () => {
    const tree = tempTree()
    writeInspector(tree, INSPECTOR_UPSTREAM.replace(INSPECTOR_GUARD_LINE, INSPECTOR_LEGACY_NORMALIZE))

    const result = runPreload(tree)
    const patched = readFileSync(inspectorPath(tree), 'utf8')

    expect(result.stdout).toContain('Patch 12: fetch 访问器归一 applied')
    expect(patched).toMatch(/bun-preload-rev:\d+/)
    // 旧产物首行（无 rev 前缀）必须被换掉，否则下个 rev 还是刷不动。
    expect(patched).not.toContain('\t// bun-preload: fetch 访问器归一（')
    expect(patched).not.toContain('...descriptor')
    expect(patched).toContain(INSPECTOR_SPREAD_TO)
  })

  test('rev≥7 产物（归一形态、无守卫行）：只刷指纹，不误判上游版本不符', () => {
    const tree = tempTree()
    const patchedRev6 = [
      'const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");',
      'const original = globalThis.fetch;',
      'const observedFetch = original;',
      '\t// bun-preload-rev:6 bun-preload: fetch 访问器归一（billion-context 装的是访问器，inspector 原本会硬拒）',
      '\tif (descriptor !== void 0 && !("value" in descriptor)) {',
      '\t\tObject.defineProperty(globalThis, "fetch", { value: original, writable: true, configurable: true, enumerable: descriptor.enumerable ?? true });',
      '\t}',
      '\t} : {',
      '\t\tvalue: observedFetch,',
      '\t\twritable: true,',
      '\t\tconfigurable: true',
      '\t});',
      // 今天真实上游自带 Patch 14 的 port1 泵锚：补上它，Patch 14 才不会报「上游版本不符」。
      ...INSPECTOR_HOST_PUMP_LINES,
    ].join('\n')
    writeInspector(tree, patchedRev6)

    const result = runPreload(tree)
    const patched = readFileSync(inspectorPath(tree), 'utf8')

    expect(result.stderr).not.toContain('上游版本不符')
    expect(patched).toMatch(/bun-preload-rev:\d+/)
    expect(patched).not.toMatch(/bun-preload-rev:6(?!\d)/)
    expect(patched).not.toContain('...descriptor')
  })

  test('结果层：访问器 fetch 下 import 打过补丁的 inspector 不抛（#6 真实失败面）', () => {
    const tree = tempTree()
    writeInspector(tree, INSPECTOR_UPSTREAM)
    runPreload(tree)

    // 真 bun 子进程：先把 fetch 装成访问器（Windows 报障形态），再 import 打过补丁的 inspector。
    const script = join(tree, 'probe.mjs')
    writeFileSync(script, [
      'Object.defineProperty(globalThis, "fetch", {',
      '  get() { return () => "fetched" },',
      '  configurable: true,',
      '})',
      'await import("./node_modules/@deepseek-ai/dsh-experimental-inspector/lib/index.js")',
      'const d = Object.getOwnPropertyDescriptor(globalThis, "fetch")',
      'if (!d || !("value" in d) || !d.writable || !d.configurable) throw new Error("fetch not a writable data property")',
      'globalThis.fetch = async () => "overwritten"',
      'console.log("probe-ok:" + await globalThis.fetch())',
    ].join('\n'))
    const child = Bun.spawnSync({
      cmd: [process.execPath, '--no-install', script],
      cwd: tree,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(child.stderr.toString()).not.toContain('Invalid property')
    expect(child.stdout.toString()).toContain('probe-ok:overwritten')
  })

  test('上游文本变了只警告、不动文件（下次上游自带修复也不会被我们覆盖）', () => {
    const tree = tempTree()
    const drifted = INSPECTOR_UPSTREAM.replace('cannot be observed safely', 'cannot be observed at all')
    writeInspector(tree, drifted)

    const result = runPreload(tree)

    expect(result.stderr).toContain('Patch 12: 未找到上游 accessor 检查文本')
    expect(readFileSync(inspectorPath(tree), 'utf8')).toBe(drifted)
  })

  test('没装 inspector 时不报错（包不存在就整段跳过）', () => {
    const tree = tempTree()
    const result = runPreload(tree)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('child-ok')
    expect(result.stderr).not.toContain('Patch 12: 未找到上游 accessor 检查文本')
  })
})

describe('bun-preload Patch 6（koffi 禁用，rev 提升防叠加）', () => {
  function koffiPath(tree: string): string {
    return join(tree, 'node_modules', '@deepseek-ai', 'dsh-win32-process', 'lib', 'index.js')
  }

  test('rev≤6 旧产物：刷指纹，不再叠一层 throw（行尾锚定修复）', () => {
    const tree = tempTree()
    const legacy = [
      "function loadWin32ProcessBindings() { if (typeof Bun !== 'undefined') throw new Error('koffi not available on Bun runtime'); // bun-preload-rev:6",
      'const x = 1;',
    ].join('\n')
    mkdirSync(dirname(koffiPath(tree)), { recursive: true })
    writeFileSync(koffiPath(tree), legacy, 'utf8')

    const result = runPreload(tree)
    const patched = readFileSync(koffiPath(tree), 'utf8')

    expect(result.stdout).toContain('Patch 6:')
    // 层数不增：throw 恰好一处；旧 rev 注释统一刷成当前 rev。
    expect(patched.split('koffi not available on Bun runtime').length - 1).toBe(1)
    expect(patched).not.toContain('bun-preload-rev:6')
    expect(patched).not.toMatch(/bun-preload-rev:6(?!\d)/)
  })

  test('实机 4 层叠加产物：刷指纹收敛，层数不再增长', () => {
    const tree = tempTree()
    const layer = " if (typeof Bun !== 'undefined') throw new Error('koffi not available on Bun runtime');"
    const layered = [
      'function loadWin32ProcessBindings() {' + layer + ' // bun-preload-rev:6' + layer + ' // bun-preload-rev:5' + layer + ' // bun-preload-rev:4' + layer + ' // bun-preload-rev:3',
      'const x = 1;',
    ].join('\n')
    mkdirSync(dirname(koffiPath(tree)), { recursive: true })
    writeFileSync(koffiPath(tree), layered, 'utf8')

    const result = runPreload(tree)
    const patched = readFileSync(koffiPath(tree), 'utf8')

    expect(result.stdout).toContain('Patch 6:')
    expect(patched.split('koffi not available on Bun runtime').length - 1).toBe(4)
    expect(patched).not.toMatch(/bun-preload-rev:[3-6](?!\d)/)
    expect(patched).toMatch(/bun-preload-rev:\d+/)
  })

  test('原始上游：函数头单行化打上 throw（FROM 行尾锚定不误伤产物形态）', () => {
    const tree = tempTree()
    const upstream = [
      'function loadWin32ProcessBindings() {',
      '  const koffi = require("koffi")',
      '  return koffi',
      '}',
    ].join('\n')
    mkdirSync(dirname(koffiPath(tree)), { recursive: true })
    writeFileSync(koffiPath(tree), upstream, 'utf8')

    const result = runPreload(tree)
    const patched = readFileSync(koffiPath(tree), 'utf8')

    expect(result.stdout).toContain('Patch 6: koffi 禁用 applied')
    const head = patched.split('\n')[0]
    expect(head).toContain('function loadWin32ProcessBindings() { if (typeof Bun')
    expect(head).toMatch(/bun-preload-rev:\d+$/)
    expect(patched).toContain('  const koffi = require("koffi")')
  })
})

describe('bun-preload Patch 13/14（inspector CDP 桥，#61）', () => {
  function workerPath(tree: string): string {
    return join(tree, 'node_modules', '@deepseek-ai', 'dsh-experimental-inspector', 'lib', 'worker.js')
  }

  /**
   * Patch 13/14 需要的上游锚点：worker 的 request() 头 + 入口行，index 的 port1 消息泵行。
   * index 同时带上 Patch 12 的锚点（复用 INSPECTOR_UPSTREAM），用于验证同文件多补丁共存。
   */
  function writeInspectorPair(tree: string, options?: { driftWorker?: boolean; driftHost?: boolean }): void {
    const worker = options?.driftWorker
      ? 'export const done = true;\n'
      : [
          'class HostInspectorSession {',
          '\trequest(method, params) {',
          '\t\tconst failure = this.connect();',
          '\t\treturn void 0;',
          '\t}',
          '}',
          '\t\tif (!hostQueries.receive(value)) sources.receive(hostConnection, value);',
          'export const done = true;',
        ].join('\n')
    const host = options?.driftHost
      ? INSPECTOR_UPSTREAM
      : INSPECTOR_UPSTREAM.replace(
          'export const done = true;',
          [...INSPECTOR_HOST_PUMP_LINES, 'export const done = true;'].join('\n'),
        )
    mkdirSync(dirname(inspectorPath(tree)), { recursive: true })
    writeFileSync(inspectorPath(tree), host, 'utf8')
    mkdirSync(dirname(workerPath(tree)), { recursive: true })
    writeFileSync(workerPath(tree), worker, 'utf8')
  }

  test('两侧同时打上：worker 入口与 request() 被接管，index 消息泵前插桥，且与 Patch 12 同文件共存', () => {
    const tree = tempTree()
    writeInspectorPair(tree)

    const result = runPreload(tree)
    const worker = readFileSync(workerPath(tree), 'utf8')
    const host = readFileSync(inspectorPath(tree), 'utf8')

    expect(result.stdout).toContain('Patch 13: inspector CDP 桥（worker 侧）applied')
    expect(result.stdout).toContain('Patch 14: inspector CDP 桥（主线程侧）applied')
    // Patch 12 依然在同一份 index.js 上工作（同文件多补丁互不短路）。
    expect(result.stdout).toContain('Patch 12: fetch 访问器归一 applied')
    expect(worker).toContain('if (__dshCdpBridgeReceive(value)) return; // bun-preload-rev:')
    expect(worker).toContain('__dshInspectorCdpBridge(this, method, params)')
    expect(worker).toContain('bun-preload: inspector CDP 桥（worker 侧）')
    expect(host).toContain('if (__dshInspectorCdpBridgeServe(value, this)) return; // bun-preload-rev:')
    expect(host).toContain('const DSH_CDP_BRIDGE_HOST = {')
    expect(host).toContain('bun-preload: inspector CDP 桥（主线程侧）')
    // 原入口行保留：桥不认领的帧放行原流。
    expect(worker).toContain('if (!hostQueries.receive(value)) sources.receive(hostConnection, value);')
  })

  test('重复启动幂等：只刷指纹，文件字节不变', () => {
    const tree = tempTree()
    writeInspectorPair(tree)
    runPreload(tree)
    const workerBefore = readFileSync(workerPath(tree), 'utf8')
    const hostBefore = readFileSync(inspectorPath(tree), 'utf8')

    const second = runPreload(tree)

    expect(second.stdout).toContain('Patch 13: bun-preload-rev:')
    expect(second.stdout).toContain('Patch 14: bun-preload-rev:')
    expect(second.stdout).not.toContain('Patch 13: inspector CDP 桥（worker 侧）applied')
    expect(second.stdout).not.toContain('Patch 14: inspector CDP 桥（主线程侧）applied')
    expect(readFileSync(workerPath(tree), 'utf8')).toBe(workerBefore)
    expect(readFileSync(inspectorPath(tree), 'utf8')).toBe(hostBefore)
  })

  test('上游锚点漂移只警告不落笔，worker 与 index 各自独立、不连坐 Patch 12', () => {
    const tree = tempTree()
    writeInspectorPair(tree, { driftWorker: true, driftHost: true })

    const result = runPreload(tree)

    expect(result.stderr).toContain('Patch 13: 未找到上游 request/worker-entry 文本')
    expect(result.stderr).toContain('Patch 14: 未找到上游 port1 消息泵文本')
    expect(readFileSync(workerPath(tree), 'utf8')).not.toContain('__dshCdpBridgeReceive')
    expect(readFileSync(inspectorPath(tree), 'utf8')).not.toContain('DSH_CDP_BRIDGE_HOST')
    // Patch 12 锚没漂：照常应用。
    expect(result.stdout).toContain('Patch 12: fetch 访问器归一 applied')
  })

  test('Node 形态守卫：桥两端都以 typeof Bun 分流（同一份 bundle 给 Node 跑时零变化）', () => {
    const tree = tempTree()
    writeInspectorPair(tree)

    runPreload(tree)

    expect(readFileSync(workerPath(tree), 'utf8')).toContain('if (typeof Bun !== "undefined") {')
    expect(readFileSync(inspectorPath(tree), 'utf8')).toContain('if (typeof Bun === "undefined") return false;')
  })

  test('没装 inspector 时 13/14 静默跳过', () => {
    const tree = tempTree()

    const result = runPreload(tree)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('child-ok')
    expect(result.stderr).not.toContain('Patch 13:')
    expect(result.stderr).not.toContain('Patch 14:')
  })
})
