// #68 Patch 16：inspector Client bootstrap 有界退避 + F7 可观测性。
//
// 做法与 test/bun-preload.test.ts 同构：造一棵假 node_modules，用**真 bun + 真 preload**
// 打补丁（DSH_BUN_PRELOAD_TREES 指到假树），再在子 bun 里**真执行**补丁产出的 client.js。
// 故障注入靠探针里的 fetch 桩：前 N 次 404，之后返回合法 bootstrap。
//
// 探针为什么能执行 bundle：client.js 是 `window.__ModuleLoader__.load({ factory: (require) => … })`
// 形态；这里用一个极简 loader 提供 factory 需要的 `require("@deepseek-ai/cordis")`（只用到
// Context.is）与 `require.async("./client.page.js")`，其余 fetch/AbortController 是全局。
// 这个夹具（fixture）保留了真实失败分支的逐字缩进，所以 Patch 16 的字符串锚点与真 bundle 相同；
// 另有 real-client 用例断言物化树里的真 client.js 已预打 Patch 16（构建期 prepatch 生效）；
// 锚点漂移由 prepare-bundle 的预打补丁断言兜住。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

const projectRoot = resolve(import.meta.dir, '..')
const repoRoot = resolve(projectRoot, '..')
const preloadPath = join(repoRoot, 'resources', 'dsh', 'bun-preload.mjs')
const realClient = join(
  projectRoot,
  'builtin-runtime',
  'node_modules',
  '@deepseek-ai',
  'dsh-experimental-inspector',
  'lib',
  'client.js',
)

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inspector-retry-'))
  roots.push(dir)
  return dir
}

function clientPath(tree: string): string {
  return join(tree, 'node_modules', '@deepseek-ai', 'dsh-experimental-inspector', 'lib', 'client.js')
}

function writeClient(tree: string, content: string): string {
  const file = clientPath(tree)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
  return file
}

/** 真实 client.js 的失败分支形态（缩进逐字保留；Patch 16 的锚点按它写）。 */
const FIXTURE_CLIENT = [
  'const INSPECTOR_BOOTSTRAP_ROUTE = "api/experimental-inspector/bootstrap";',
  'function parseInspectorClientBootstrap(value) {',
  '\tif (!value || typeof value.endpoint !== "string") throw new Error("bad bootstrap");',
  '\treturn value;',
  '}',
  'async function startInspectorClient(bootstrap) {',
  '\treturn { sourceId: "probe-source", close() {} };',
  '}',
  'function publishCordisTree() {',
  '\treturn () => {};',
  '}',
  'async function apply(ctx) {',
  '\tconst session = new InspectorClientSession(ctx);',
  '\tctx.effect(() => () => session.dispose(), "experimental-inspector: Client lifetime");',
  '\tctx.on("connection/reset", () => {',
  '\t\tsession.refresh().catch((error) => {',
  '\t\t\tctx.logger.warn("experimental-inspector: Client connection failed; reconnect or reload the page to retry", error);',
  '\t\t});',
  '\t});',
  '\tawait session.refresh();',
  '}',
  'var InspectorClientSession = class {',
  '\t\t\tctx;',
  '\t\t\tlifetime = new AbortController();',
  '\t\t\tpending = Promise.resolve();',
  '\t\t\tbootstrap;',
  '\t\t\trelease;',
  '\t\t\tconstructor(ctx) {',
  '\t\t\t\tthis.ctx = ctx;',
  '\t\t\t}',
  '\t\t\trefresh() {',
  '\t\t\t\treturn this.enqueue(() => this.readBootstrap());',
  '\t\t\t}',
  '\t\t\tconnect(bootstrap) {',
  '\t\t\t\treturn this.enqueue(() => this.replace(bootstrap));',
  '\t\t\t}',
  '\t\t\tasync readBootstrap() {',
  '\t\t\t\tlet response;',
  '\t\t\t\ttry {',
  '\t\t\t\t\tresponse = await fetch(INSPECTOR_BOOTSTRAP_ROUTE, { signal: this.lifetime.signal });',
  '\t\t\t\t} catch (error) {',
  '\t\t\t\t\tthis.connectionFailed(error);',
  '\t\t\t\t\treturn;',
  '\t\t\t\t}',
  '\t\t\t\tif (!response.ok) {',
  '\t\t\t\t\tthis.connectionFailed(/* @__PURE__ */ new Error(`Inspector bootstrap failed: HTTP ${response.status}`));',
  '\t\t\t\t\treturn;',
  '\t\t\t\t}',
  '\t\t\t\tconst value = await response.json();',
  '\t\t\t\tawait this.replace(parseInspectorClientBootstrap(value));',
  '\t\t\t}',
  '\t\t\tconnectionFailed(error) {',
  '\t\t\t\tif (this.lifetime.signal.aborted) return;',
  '\t\t\t\tthis.ctx.logger.warn("experimental-inspector: Client connection failed; reconnect or reload the page to retry", error);',
  '\t\t\t}',
  '\t\t\tenqueue(task) {',
  '\t\t\t\tconst pending = this.pending.then(() => {',
  '\t\t\t\t\tthis.lifetime.signal.throwIfAborted();',
  '\t\t\t\t\treturn task();',
  '\t\t\t\t});',
  '\t\t\t\tthis.pending = pending.catch(() => {});',
  '\t\t\t\treturn pending;',
  '\t\t\t}',
  '\t\t\tasync replace(bootstrap) {',
  '\t\t\t\tthis.lifetime.signal.throwIfAborted();',
  '\t\t\t\tif (this.bootstrap?.endpoint === bootstrap.endpoint && this.bootstrap.protocol === bootstrap.protocol) return;',
  '\t\t\t\tawait this.release?.();',
  '\t\t\t\tthis.release = void 0;',
  '\t\t\t\tthis.bootstrap = void 0;',
  '\t\t\t\tlet source;',
  '\t\t\t\ttry {',
  '\t\t\t\t\tsource = await startInspectorClient(bootstrap);',
  '\t\t\t\t} catch (error) {',
  '\t\t\t\t\tthis.connectionFailed(error);',
  '\t\t\t\t\treturn;',
  '\t\t\t\t}',
  '\t\t\t\tconst disposers = [];',
  '\t\t\t\tconst dispose = () => {',
  '\t\t\t\t\tfor (const d of disposers.reverse()) d();',
  '\t\t\t\t\tsource.close();',
  '\t\t\t\t};',
  '\t\t\t\ttry {',
  '\t\t\t\t\tdisposers.push(publishCordisTree(this.ctx, source, {}));',
  '\t\t\t\t\tdisposers.push(this.ctx.provide("inspector", {}));',
  '\t\t\t\t\tconst panel = this.ctx.inject([',
  '\t\t\t\t\t\t"slots",',
  '\t\t\t\t\t\t"shortcuts",',
  '\t\t\t\t\t\t"locale"',
  '\t\t\t\t\t], async (ctx) => {',
  '\t\t\t\t\t\tconst { registerInspectorPage } = await require.async("./client.page.js");',
  '\t\t\t\t\t\tregisterInspectorPage(ctx, source.sourceId);',
  '\t\t\t\t\t});',
  '\t\t\t\t\tdisposers.push(() => panel.dispose());',
  '\t\t\t\t} catch (error) {',
  '\t\t\t\t\tawait dispose();',
  '\t\t\t\t\tthrow error;',
  '\t\t\t\t}',
  '\t\t\t\tthis.bootstrap = bootstrap;',
  '\t\t\t\tthis.release = dispose;',
  '\t\t\t}',
  '\t\t\tasync dispose() {',
  '\t\t\t\tthis.lifetime.abort();',
  '\t\t\t\tawait this.pending;',
  '\t\t\t\tawait this.release?.();',
  '\t\t\t}',
  '};',
  '',
].join('\n')

/** 子 bun 里的真执行探针；模式见各测试。 */
const PROBE = String.raw`import { readFileSync } from 'node:fs'

const code = readFileSync(process.argv[2], 'utf8')
const mode = process.argv[3]
const failures = Number(process.argv[4] ?? '0')
const bootstrap = {
  endpoint: 'ws://127.0.0.1:65000/ingest',
  protocol: 'dsh-inspector',
  reconnectBaseMs: 250,
  reconnectMaxMs: 5000
}

let fetches = 0
globalThis.fetch = async () => {
  fetches += 1
  if (mode === 'always') return new Response(null, { status: 404 })
  if (fetches <= failures) return new Response(null, { status: 404 })
  return new Response(JSON.stringify(bootstrap), { status: 200, headers: { 'content-type': 'application/json' } })
}

const warns = []
const registered = []
let disposeLifetime
const ctx = {
  effect(fn) {
    disposeLifetime = fn()
    return () => {}
  },
  on() {
    return () => {}
  },
  provide() {
    return () => {}
  },
  logger: {
    warn: (...args) => warns.push(args.map((value) => String(value)))
  },
  inject(_deps, cb) {
    const pending = cb(ctx)
    registered.push(pending)
    return { dispose() {} }
  }
}
const requireStub = {
  async async() {
    if (mode === 'f7') throw new Error('client.page.js failed to load')
    return { registerInspectorPage: (_ctx, sourceId) => registered.push(sourceId) }
  }
}
const apply = new Function('require', code + '\nreturn apply;')(requireStub)

const run = async () => {
  const pending = apply(ctx)
  if (mode === 'dispose') {
    await new Promise((resolve) => setTimeout(resolve, 120))
    disposeLifetime()
  }
  await pending
  await Promise.all(registered.map((value) => Promise.resolve(value).catch(() => {})))
}

run().then(() => {
  const text = warns.map((args) => args.join(' ')).join('\n')
  if (mode === 'success') {
    if (fetches !== 3) throw new Error('expected 3 fetches, got ' + fetches)
    if (!registered.includes('probe-source')) throw new Error('inject callback did not register')
    if (text.includes('Client connection failed after')) throw new Error('terminal warn fired on success')
  } else if (mode === 'always') {
    if (fetches !== 7) throw new Error('expected 7 fetches, got ' + fetches)
    if (!text.includes('after 7 attempts')) throw new Error('terminal warn missing: ' + text)
  } else if (mode === 'f7') {
    if (!text.includes('Client page registration failed')) throw new Error('f7 warn missing: ' + text)
  } else if (mode === 'dispose') {
    if (fetches !== 1) throw new Error('expected 1 fetch after dispose, got ' + fetches)
    if (text.includes('Client connection failed after')) throw new Error('terminal warn fired after dispose')
  } else {
    throw new Error('unknown mode ' + mode)
  }
  console.log('PROBE-OK ' + JSON.stringify({ fetches, warns: warns.length, registered: registered.length }))
}).catch((error) => {
  console.error('PROBE-FAIL', error)
  process.exit(1)
})
`

function runPreload(tree: string): { stdout: string; stderr: string; code: number } {
  const script = join(tree, 'noop.mjs')
  writeFileSync(script, 'console.log("child-ok")\n', 'utf8')
  const child = Bun.spawnSync({
    cmd: [process.execPath, '--no-install', '--preload', preloadPath, script],
    cwd: tree,
    env: { ...process.env, DSH_BUN_PRELOAD_TREES: tree, DSH_SHELL_PRELOAD_DEBUG: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
    code: child.exitCode ?? -1,
  }
}

function runProbe(tree: string, mode: string, failures = 0): { stdout: string; stderr: string; code: number } {
  const probe = join(tree, 'probe.mjs')
  writeFileSync(probe, PROBE, 'utf8')
  const child = Bun.spawnSync({
    cmd: [process.execPath, probe, clientPath(tree), mode, String(failures)],
    cwd: tree,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
    code: child.exitCode ?? -1,
  }
}

describe('Patch 16：inspector Client bootstrap 退避 + F7', () => {
  test('打入 F1/F2 重试与 F7 日志；二次启动幂等', () => {
    const tree = tempTree()
    writeClient(tree, FIXTURE_CLIENT)

    const first = runPreload(tree)
    const patched = readFileSync(clientPath(tree), 'utf8')

    expect(first.code).toBe(0)
    expect(first.stdout).toContain('Patch 16: inspector Client bootstrap 退避重试')
    expect(patched).toContain('bun-preload: bootstrap 有界退避重试')
    expect(patched).toContain('await this.retryBootstrap(error);')
    expect(patched).toContain('await this.retryBootstrap(/* @__PURE__ */ new Error(`Inspector bootstrap failed: HTTP ${response.status}`));')
    expect(patched).toContain('Client page registration failed')
    expect(patched).toContain('Client connection failed after ${delays.length + 1} attempts')
    // 原有 connectionFailed 只负责 F5（replace 里 startInspectorClient 失败）；别把 F1/F2 也改走它。
    expect(patched).toContain('\t\t\tconnectionFailed(error) {')

    const second = runPreload(tree)
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('Patch 16: bun-preload-rev:')
    expect(readFileSync(clientPath(tree), 'utf8')).toBe(patched)
    expect(patched.split('bun-preload: bootstrap 有界退避重试').length - 1).toBe(1)
  })

  test('故障注入：前 2 次 404、第 3 次成功→fetch 3 次、注册成功、无终局 warn', () => {
    const tree = tempTree()
    writeClient(tree, FIXTURE_CLIENT)
    runPreload(tree)
    const result = runProbe(tree, 'success', 2)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('PROBE-OK')
    expect(result.stderr).toBe('')
  })

  test('始终失败→fetch 上限 7 次、终局 warn 含尝试次数、apply 不 reject', () => {
    const tree = tempTree()
    writeClient(tree, FIXTURE_CLIENT)
    runPreload(tree)
    const result = runProbe(tree, 'always')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('PROBE-OK')
    expect(result.stderr).toBe('')
  }, 25_000)

  test('F7：client.page.js 加载失败时日志可观测（不再纯静默）', () => {
    const tree = tempTree()
    writeClient(tree, FIXTURE_CLIENT)
    runPreload(tree)
    const result = runProbe(tree, 'f7')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('PROBE-OK')
    expect(result.stderr).toBe('')
  })

  test('dispose 后不再重试（abort 生效）', () => {
    const tree = tempTree()
    writeClient(tree, FIXTURE_CLIENT)
    runPreload(tree)
    const result = runProbe(tree, 'dispose', 99)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('PROBE-OK')
    expect(result.stderr).toBe('')
  })

  test.skipIf(!existsSync(realClient))('物化树里的真实 client.js 已预打 Patch 16（构建期 prepatch 生效）', () => {
    const source = readFileSync(realClient, 'utf8')
    expect(source).toContain('bun-preload: bootstrap 有界退避重试')
    expect(source).toContain('async retryBootstrap(lastError)')
    expect(source).toContain('Client connection failed after')
  })
})
