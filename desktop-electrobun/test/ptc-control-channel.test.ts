// PTC worker 的继承控制通道（fd 7）在 Bun 下的回归测试（#152）。
//
// 目标不是测 PTC 的协议，而是测「壳的 bun-preload 把 PTC worker 文件补对，
// 补对以后 Bun 子进程能在 fd 7 上发出第一帧 ready」。
//
// 两层：
//   1) 假 PTC 包树 + 真 bun-preload：可复现、无需物化运行时（CI 默认路径）。
//   2) 物化 builtin-runtime 或 DSH_PTC_SOURCE_LIB 指向的真实 PTC 入口：本机验真，
//      树不存在时整组跳过（与 inspector-cdp-bridge.test.ts 的口径一致）。
//
// 预修复断言（Patch 15 未打）也在 1) 里：同一段 worker 在 Bun 下会以 1 退出并打印
// ERR_SOCKET_CLOSED；打上补丁后同一段代码必须发出 ready。这样测试不是「补丁文本存在」
// 的同义反复，而是真实的红→绿回归。
import { spawn } from 'node:child_process'
import type { Duplex } from 'node:stream'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

const projectRoot = resolve(import.meta.dir, '..')
const preloadPath = resolve(projectRoot, '..', 'resources', 'dsh', 'bun-preload.mjs')
const runtimeTree = resolve(projectRoot, 'builtin-runtime')
const defaultRealLib = join(
  runtimeTree,
  'node_modules',
  '@deepseek-ai',
  'dsh-ptc-runtime-node',
  'lib',
)
const realPtcLib = process.env.DSH_PTC_SOURCE_LIB ?? defaultRealLib
const nodeExecutable = process.env.DSH_NODE_EXECUTABLE ?? Bun.which('node')
const win32 = process.platform === 'win32';
// Windows 上真 spawn 一个 node 进程 + 走 bun-preload 补丁 + 等 fd 7 上的 ready 帧，
// 实测要 2.4–5s（Linux 同一用例只要 40–60ms）⇒ Windows 给足预算，别让 CI 偶发红。
const spawnFrameTimeoutMs = win32 ? 20000 : 5000

const roots: string[] = []

function tempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ptc-control-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PTC_ENTRY_UPSTREAM = [
  'import { Socket } from "node:net";',
  '',
  'const SUBPROCESS_CONTROL_ENV = "DSH_SUBPROCESS_CONTROL";',
  'function openInheritedControlChannel() {',
  '\tconst marker = process.env[SUBPROCESS_CONTROL_ENV];',
  '\tReflect.deleteProperty(process.env, SUBPROCESS_CONTROL_ENV);',
  '\tif (marker !== "pipe") throw new Error("subprocess control channel was not inherited");',
  '\treturn new Socket({',
  '\t\tfd: 7,',
  '\t\treadable: true,',
  '\t\twritable: true,',
  '\t\tallowHalfOpen: true',
  '\t});',
  '}',
  '',
  'const stream = openInheritedControlChannel();',
  'const body = Buffer.from(JSON.stringify({ type: "ready" }));',
  'const header = Buffer.alloc(4);',
  'header.writeUInt32BE(body.length);',
  'stream.cork();',
  'stream.write(header);',
  'stream.write(body, (error) => {',
  '  if (error) { console.error(error); process.exit(1); }',
  '});',
  'stream.uncork();',
  'setTimeout(() => process.exit(0), 500);',
  '',
].join('\n')

const PTC_ECHO_UPSTREAM = [
  'import { Socket } from "node:net";',
  '',
  'const SUBPROCESS_CONTROL_ENV = "DSH_SUBPROCESS_CONTROL";',
  'function openInheritedControlChannel() {',
  '\tconst marker = process.env[SUBPROCESS_CONTROL_ENV];',
  '\tReflect.deleteProperty(process.env, SUBPROCESS_CONTROL_ENV);',
  '\tif (marker !== "pipe") throw new Error("subprocess control channel was not inherited");',
  '\treturn new Socket({',
  '\t\tfd: 7,',
  '\t\treadable: true,',
  '\t\twritable: true,',
  '\t\tallowHalfOpen: true',
  '\t});',
  '}',
  '',
  'const stream = openInheritedControlChannel();',
  'function send(frame) {',
  '  const body = Buffer.from(JSON.stringify(frame));',
  '  const header = Buffer.alloc(4);',
  '  header.writeUInt32BE(body.length);',
  '  stream.cork();',
  '  stream.write(header);',
  '  stream.write(body, (error) => { if (error) { console.error(error); process.exit(1); } });',
  '  stream.uncork();',
  '}',
  'send({ type: "ready" });',
  'let buffered = Buffer.alloc(0);',
  'stream.on("data", (chunk) => {',
  '  buffered = Buffer.concat([buffered, chunk]);',
  '  while (buffered.length >= 4) {',
  '    const length = buffered.readUInt32BE(0);',
  '    if (buffered.length < 4 + length) return;',
  '    const frame = JSON.parse(buffered.subarray(4, 4 + length).toString("utf8"));',
  '    buffered = buffered.subarray(4 + length);',
  '    send({ type: "echo", got: frame });',
  '  }',
  '});',
  'setTimeout(() => process.exit(0), 2000);',
  '',
].join('\n')

function ptcLib(tree: string): string {
  return join(tree, 'node_modules', '@deepseek-ai', 'dsh-ptc-runtime-node', 'lib')
}

function writeFakePtcTree(tree: string): string {
  const lib = ptcLib(tree)
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'process.js'), PTC_ENTRY_UPSTREAM, 'utf8')
  writeFileSync(join(lib, 'persistent-process.js'), PTC_ENTRY_UPSTREAM, 'utf8')
  return lib
}

function runPreload(tree: string | string[]): { stdout: string; stderr: string; code: number } {
  const roots = Array.isArray(tree) ? tree : [tree]
  const root = roots[0]!
  const script = join(root, 'noop.mjs')
  writeFileSync(script, 'console.log("child-ok")\n', 'utf8')
  const child = Bun.spawnSync({
    cmd: [process.execPath, '--no-install', '--preload', preloadPath, script],
    cwd: root,
    env: { ...process.env, DSH_BUN_PRELOAD_TREES: roots.join(delimiter), DSH_SHELL_PRELOAD_DEBUG: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
    code: child.exitCode ?? -1,
  }
}

function spawnEntry(executable: string, entry: string) {
  return spawn(executable, [entry, '1048576'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'overlapped'],
    env: { ...process.env, DSH_SUBPROCESS_CONTROL: 'pipe' },
  })
}

function readFrame(child: ReturnType<typeof spawn>, timeoutMs = spawnFrameTimeoutMs): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const control = (child.stdio as unknown as Array<Duplex | null>)[7]
    if (control === null || control === undefined) {
      reject(new Error('fd 7 is not available'))
      return
    }
    const controlStream: Duplex = control
    let buffered = Buffer.alloc(0)
    let settled = false
    const timer = setTimeout(() => finish(new Error('timed out waiting for control frame')), timeoutMs)
    function finish(error?: Error, frame?: string): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      controlStream.off('data', onData)
      controlStream.off('error', onError)
      if (error !== undefined) reject(error)
      else resolvePromise(frame ?? '')
    }
    function onData(chunk: Buffer): void {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)])
      if (buffered.length < 4) return
      const length = buffered.readUInt32BE(0)
      if (buffered.length < 4 + length) return
      finish(undefined, buffered.subarray(4, 4 + length).toString('utf8'))
    }
    function onError(error: Error): void {
      finish(error)
    }
    controlStream.on('data', onData)
    controlStream.on('error', onError)
  })
}

async function readReadyFrame(child: ReturnType<typeof spawn>, timeoutMs = spawnFrameTimeoutMs): Promise<string> {
  try {
    return await readFrame(child, timeoutMs)
  } finally {
    try {
      child.kill('SIGKILL')
    } catch {}
  }
}

function writeFrame(control: Duplex, frame: unknown): void {
  const body = Buffer.from(JSON.stringify(frame))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  control.cork()
  control.write(header)
  control.write(body)
  control.uncork()
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {}
      reject(new Error('timed out waiting for worker exit'))
    }, timeoutMs)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, signal, stderr })
    })
  })
}

function expectPatched(entry: string): void {
  const text = readFileSync(entry, 'utf8')
  expect(text).toContain('bun-preload: PTC worker 控制通道')
  expect(text).toContain('__dshOpenBunInheritedControlChannel')
  expect(text).toContain('if (typeof Bun !== "undefined" && process.platform !== "win32")')
  expect(text).toContain('process.platform !== "win32"')
  expect(text).toContain('import { Duplex as __dshBunDuplex } from "node:stream";')
  expect(text).toContain('__dshBunFsRead')
  expect(text).toContain('return new Socket({')
}

describe('bun-preload Patch 15（PTC worker 继承控制通道，#152）', () => {
  test('per-call 与 persistent 两个入口都打上，且重复运行只刷新指纹', () => {
    const tree = tempTree()
    const lib = writeFakePtcTree(tree)

    const first = runPreload(tree)
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('Patch 15: PTC worker 控制通道（Bun fd 7）applied')
    expectPatched(join(lib, 'process.js'))
    expectPatched(join(lib, 'persistent-process.js'))

    const beforeProcess = readFileSync(join(lib, 'process.js'), 'utf8')
    const beforePersistent = readFileSync(join(lib, 'persistent-process.js'), 'utf8')
    const second = runPreload(tree)
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('Patch 15: bun-preload-rev:')
    expect(readFileSync(join(lib, 'process.js'), 'utf8')).toBe(beforeProcess)
    expect(readFileSync(join(lib, 'persistent-process.js'), 'utf8')).toBe(beforePersistent)
    expect(beforeProcess.split('bun-preload: PTC worker 控制通道').length - 1).toBe(2)
  })

  test('多个 DSH_BUN_PRELOAD_TREES 根都打上', () => {
    const first = tempTree()
    const second = tempTree()
    const firstLib = writeFakePtcTree(first)
    const secondLib = writeFakePtcTree(second)
    const result = runPreload([first, second])
    expect(result.code).toBe(0)
    expectPatched(join(firstLib, 'process.js'))
    expectPatched(join(secondLib, 'process.js'))
  })

  test('上游锚点漂移只警告、不改文件', () => {
    const tree = tempTree()
    const lib = writeFakePtcTree(tree)
    const drifted = PTC_ENTRY_UPSTREAM.replace(
      '\treturn new Socket({',
      '\treturn new Socket(\n\t\t{',
    )
    writeFileSync(join(lib, 'process.js'), drifted, 'utf8')
    writeFileSync(join(lib, 'persistent-process.js'), drifted, 'utf8')

    const result = runPreload(tree)

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('Patch 15: 未找到上游 PTC 控制通道')
    expect(readFileSync(join(lib, 'process.js'), 'utf8')).toBe(drifted)
    expect(readFileSync(join(lib, 'persistent-process.js'), 'utf8')).toBe(drifted)
  })
  // Windows 的额外 stdio fd 7 行为与 macOS 不同；本单未在 Windows 验证，
  // 运行时用例在 win32 跳过，补丁在 Windows 保留上游 net.Socket。

  test.skipIf(win32)('未打补丁的 Bun worker 以 1 退出并报 ERR_SOCKET_CLOSED（红）', async () => {
    const tree = tempTree()
    const lib = writeFakePtcTree(tree)
    const child = spawnEntry(process.execPath, join(lib, 'process.js'))
    const result = await waitForExit(child)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ERR_SOCKET_CLOSED')
  })

  test.skipIf(win32)('打补丁后 per-call 与 persistent 都在 fd 7 上发出 ready（绿）', async () => {
    const tree = tempTree()
    const lib = writeFakePtcTree(tree)
    expect(runPreload(tree).code).toBe(0)

    for (const name of ['process.js', 'persistent-process.js']) {
      const child = spawnEntry(process.execPath, join(lib, name))
      const frame = await readReadyFrame(child)
      expect(JSON.parse(frame)).toEqual({ type: 'ready' })
    }
  })

  test.skipIf(win32)('父写 frame、worker 读并发回 echo（Bun fd 7 Duplex 的读半区）', async () => {
    const tree = tempTree()
    const lib = ptcLib(tree)
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'process.js'), PTC_ECHO_UPSTREAM, 'utf8')
    expect(runPreload(tree).code).toBe(0)
    const child = spawnEntry(process.execPath, join(lib, 'process.js'))
    try {
      expect(JSON.parse(await readFrame(child))).toEqual({ type: 'ready' })
      const control = (child.stdio as unknown as Array<Duplex | null>)[7]
      if (control === null || control === undefined) throw new Error('fd 7 is not available')
      writeFrame(control, { type: 'ping' })
      expect(JSON.parse(await readFrame(child))).toEqual({ type: 'echo', got: { type: 'ping' } })
    } finally {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
  })

  test.skipIf(nodeExecutable === null)('Node 分支仍走 net.Socket，同一 worker 在 Node 下也发 ready', async () => {
    const nodePath = nodeExecutable
    if (nodePath === null) throw new Error('node executable is missing')
    const tree = tempTree()
    const lib = writeFakePtcTree(tree)
    expect(runPreload(tree).code).toBe(0)

    const child = spawnEntry(nodePath, join(lib, 'process.js'))
    const frame = await readReadyFrame(child, spawnFrameTimeoutMs)
    expect(JSON.parse(frame)).toEqual({ type: 'ready' })
  }, spawnFrameTimeoutMs + 5000)
})

const realProcessEntry = join(realPtcLib, 'process.js')
const realPersistentEntry = join(realPtcLib, 'persistent-process.js')

describe('Patch 15 真实 PTC 入口（物化运行时 / DSH_PTC_SOURCE_LIB）', () => {
  test.skipIf(!existsSync(realProcessEntry))('真实 per-call worker 打补丁后发出 ready', async () => {
    const tree = tempTree()
    const lib = ptcLib(tree)
    mkdirSync(lib, { recursive: true })
    copyFileSync(realProcessEntry, join(lib, 'process.js'))
    expect(runPreload(tree).code).toBe(0)
    expectPatched(join(lib, 'process.js'))

    const child = spawnEntry(process.execPath, join(lib, 'process.js'))
    const frame = await readReadyFrame(child)
    expect(JSON.parse(frame)).toEqual({ type: 'ready' })
  })

  test.skipIf(!existsSync(realPersistentEntry))(
    '真实 persistent worker 打补丁后发出 ready',
    async () => {
      const tree = tempTree()
      const lib = ptcLib(tree)
      mkdirSync(lib, { recursive: true })
      copyFileSync(realPersistentEntry, join(lib, 'persistent-process.js'))
      expect(runPreload(tree).code).toBe(0)
      expectPatched(join(lib, 'persistent-process.js'))

      const child = spawnEntry(process.execPath, join(lib, 'persistent-process.js'))
      const frame = await readReadyFrame(child)
      expect(JSON.parse(frame)).toEqual({ type: 'ready' })
    },
  )
})
