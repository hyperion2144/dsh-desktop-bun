// #61 E2E：真 inspector 栈（startInspector → worker → WS CDP）验证 CDP 桥闭环。
//
// 依赖物化运行时树（desktop-electrobun/builtin-runtime，gitignore）：树不存在时整组
// 跳过（CI 默认无树；本地跑 `bun run scripts/prepare-bundle.mjs` 后生效）。
// 子进程用真 bun + bun-preload（DSH_BUN_PRELOAD_TREES 指向物化树），探针脚本对每条
// CDP 链路自带断言，全绿才打 PROBE-OK——测试只断言退出码与 PROBE-OK。
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

const projectRoot = resolve(import.meta.dir, '..')
const preloadPath = resolve(projectRoot, '..', 'resources', 'dsh', 'bun-preload.mjs')
const runtimeTree = resolve(projectRoot, 'builtin-runtime')
const inspectorIndex = join(runtimeTree, 'node_modules', '@deepseek-ai', 'dsh-experimental-inspector', 'lib', 'index.js')

const probeScript = [
  '// 探针：桥的四条链路（求值对象句柄 / awaitPromise / 堆快照 / 异常路径）。',
  'const { startInspector } = await import(process.argv[2])',
  'const inspector = await startInspector({ host: "127.0.0.1", port: 0 })',
  'const wsUrl = inspector.endpoint.webSocketDebuggerUrl',
  '',
  'let mid = 0',
  'const pending = new Map()',
  'const events = []',
  'const ws = new WebSocket(wsUrl)',
  'const send = (method, params = {}) => new Promise((resolve, reject) => {',
  '  const id = ++mid',
  '  pending.set(id, { resolve, reject })',
  '  ws.send(JSON.stringify({ id, method, params }))',
  '})',
  'ws.onmessage = (event) => {',
  '  const message = JSON.parse(String(event.data))',
  '  if (message.id !== undefined) {',
  '    const entry = pending.get(message.id)',
  '    if (entry === undefined) return',
  '    pending.delete(message.id)',
  '    if (message.error !== undefined) entry.reject(new Error(message.error.message))',
  '    else entry.resolve(message.result)',
  '  } else {',
  '    events.push(message)',
  '  }',
  '}',
  'await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })',
  'await send("Runtime.enable")',
  'await send("HeapProfiler.enable")',
  '',
  '// 链路 1：求值返回对象句柄 + 预览，getProperties 用句柄展开。',
  'const evaluated = await send("Runtime.evaluate", {',
  '  expression: "globalThis.__bridgeProbe = { tag: 1 + 1, nested: { deep: [true] } }; __bridgeProbe",',
  '  generatePreview: true,',
  '})',
  'if (evaluated.result?.type !== "object") throw new Error("bridge evaluate: not an object: " + JSON.stringify(evaluated))',
  'if (typeof evaluated.result.objectId !== "string") throw new Error("bridge evaluate: no objectId")',
  'const previewTag = (evaluated.result.preview?.properties ?? []).find((item) => item.name === "tag")?.description',
  'if (previewTag !== "2") throw new Error("bridge evaluate: preview tag = " + previewTag)',
  'const properties = await send("Runtime.getProperties", { objectId: evaluated.result.objectId })',
  'const tag = (properties.result ?? []).find((record) => record.name === "tag")',
  'if (tag?.value?.value !== 2) throw new Error("bridge getProperties: tag = " + JSON.stringify(tag))',
  '',
  '// 链路 2：thenable + awaitPromise → 服务端补 await（拿到的是已决值，不是 Promise 本体）。',
  'const promised = await send("Runtime.evaluate", {',
  '  expression: "Promise.resolve({ ok: 1 })",',
  '  awaitPromise: true,',
  '})',
  'if (promised.result?.className !== "Object") throw new Error("bridge awaitPromise: className = " + promised.result?.className)',
  '// 链路 2b：Runtime.awaitPromise op（对对象表里的 Promise 句柄显式等待）+ callFunctionOn（对象表引用上执行）。',
  'const pendingPromise = await send("Runtime.evaluate", { expression: "Promise.resolve(41)" })',
  'const awaited = await send("Runtime.awaitPromise", { promiseObjectId: pendingPromise.result.objectId, returnByValue: true })',
  'if (awaited.result?.value !== 41) throw new Error("bridge awaitPromise op: value = " + JSON.stringify(awaited))',
  'const called = await send("Runtime.callFunctionOn", { objectId: evaluated.result.objectId, functionDeclaration: "function () { return this.tag * 10 }", returnByValue: true })',
  'if (called.result?.value !== 20) throw new Error("bridge callFunctionOn: value = " + JSON.stringify(called))',
  '',
  '',
  '// 链路 3：堆快照以 addHeapSnapshotChunk 合成事件流出，拼回合法 .heapsnapshot JSON。',
  'const snapshotBefore = events.filter((event) => event.method === "HeapProfiler.addHeapSnapshotChunk").length',
  'await send("HeapProfiler.takeHeapSnapshot")',
  'const chunks = events',
  '  .filter((event) => event.method === "HeapProfiler.addHeapSnapshotChunk")',
  '  .slice(snapshotBefore)',
  '  .map((event) => event.params.chunk)',
  'if (chunks.length === 0) throw new Error("bridge snapshot: no chunks")',
  'let snapshotNodes = 0',
  'try {',
  '  const snapshot = JSON.parse(chunks.join(""))',
  '  snapshotNodes = snapshot.snapshot?.meta?.node_fields?.length ?? 0',
  '} catch {}',
  'if (snapshotNodes === 0) throw new Error("bridge snapshot: not a heapsnapshot JSON")',
  '',
  '// 链路 4：求值异常 → exceptionDetails（不是协议层错误）。',
  'const errored = await send("Runtime.evaluate", { expression: "throw new Error(\'boom-61\')" })',
  'if (errored.exceptionDetails?.exception?.subtype !== "error") throw new Error("bridge error path: no exceptionDetails")',
  '',
  'ws.close()',
  'await inspector.close()',
  'console.log("PROBE-OK")',
  'process.exit(0)',
].join('\n')

const nodeProbeScript = [
  '// Node 回归：补丁后 bundle 在 Node 下全走原生（shim 不接管）。',
  'const { startInspector } = await import(process.argv[2])',
  'const inspector = await startInspector({ host: "127.0.0.1", port: 0 })',
  'const wsUrl = inspector.endpoint.webSocketDebuggerUrl',
  'let mid = 0',
  'const pending = new Map()',
  'const ws = new WebSocket(wsUrl)',
  'const send = (method, params = {}) => new Promise((resolve, reject) => {',
  '  const id = ++mid',
  '  pending.set(id, { resolve, reject })',
  '  ws.send(JSON.stringify({ id, method, params }))',
  '})',
  'ws.onmessage = (event) => {',
  '  const message = JSON.parse(String(event.data))',
  '  if (message.id !== undefined) {',
  '    const entry = pending.get(message.id)',
  '    if (entry === undefined) return',
  '    pending.delete(message.id)',
  '    if (message.error !== undefined) entry.reject(new Error(message.error.message))',
  '    else entry.resolve(message.result)',
  '  }',
  '}',
  'await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })',
  'await send("Runtime.enable")',
  'const evaluated = await send("Runtime.evaluate", { expression: "globalThis.__n = { tag: 7 }; __n", generatePreview: true })',
  'if (evaluated.result?.type !== "object") throw new Error("node native evaluate broken: " + JSON.stringify(evaluated))',
  'const objectId = evaluated.result?.objectId ?? ""',
  '// shim 不接管：objectId 不得出现桥前缀（原生 V8/inspector 句柄形态）。',
  'if (objectId.includes("dsh-bridge-object-")) throw new Error("node regression: bridge shim took over")',
  'const properties = await send("Runtime.getProperties", { objectId })',
  'const tag = (properties.result ?? []).find((r) => r.name === "tag")',
  'if (tag?.value?.value !== 7) throw new Error("node native getProperties broken: " + JSON.stringify(tag))',
  'ws.close()',
  'await inspector.close()',
  'console.log("NODE-PROBE-OK")',
  'process.exit(0)',
].join('\n')

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('inspector CDP 桥 E2E（需要物化树，CI 无树自动跳过）', () => {
  test.skipIf(!existsSync(inspectorIndex))(
    'Bun 下求值族 / awaitPromise / 堆快照 / 异常路径全链路走桥',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-inspector-bridge-'))
      roots.push(dir)
      const script = join(dir, 'probe.mjs')
      writeFileSync(script, probeScript, 'utf8')

      const child = Bun.spawnSync({
        cmd: [process.execPath, '--no-install', '--preload', preloadPath, script, `file://${inspectorIndex}`],
        cwd: dir,
        env: { ...process.env, DSH_BUN_PRELOAD_TREES: runtimeTree },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 20000,
      })

      const stdout = child.stdout.toString()
      if (child.exitCode !== 0 || !stdout.includes('PROBE-OK')) {
        throw new Error(`probe failed (exit ${child.exitCode}):\n${stdout}\n${child.stderr.toString()}`)
      }
      expect(stdout).toContain('PROBE-OK')
    },
    30000,
  )

  test.skipIf(!existsSync(inspectorIndex) || Bun.which('node') === null)(
    'Node 回归：同一探针在 Node 下全走原生路径（shim 不接管）',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-inspector-bridge-node-'))
      roots.push(dir)
      const script = join(dir, 'probe-node.mjs')
      writeFileSync(script, nodeProbeScript, 'utf8')

      const child = Bun.spawnSync({
        cmd: ['node', script, `file://${inspectorIndex}`],
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 20000,
      })

      const stdout = child.stdout.toString()
      if (child.exitCode !== 0 || !stdout.includes('NODE-PROBE-OK')) {
        throw new Error(`node probe failed (exit ${child.exitCode}):\n${stdout}\n${child.stderr.toString()}`)
      }
      expect(stdout).toContain('NODE-PROBE-OK')
    },
    30000,
  )
})

