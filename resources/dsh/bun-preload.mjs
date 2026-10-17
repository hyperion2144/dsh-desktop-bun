/**
 * Bun preload script for DSH compatibility.
 *
 * Patches:
 * 1. Intercept require("node-addon-require-builtin") → return stub (Bun lacks V8 context symbols)
 * 2. Provide stripTypeScriptTypes via Bun.Transpiler on node:module
 * 3. Set DSH_BUN_COMPAT_DISABLE_HMR=1 to skip Cordis HMR
 * 4. Shim node-pty onto Bun.spawn({ terminal }) — the N-API addon spawns but never delivers output on Bun
 * 5. Fix the stripTypeScriptTypes named import inside @deepseek-ai/dsh-ptc-runtime-node
 * 6. Disable koffi bindings in @deepseek-ai/dsh-win32-process (Bun loads koffi but its N-API binding is broken)
 * 7. node-pty dispatcher + Bun.Terminal shim (see Patch 7 below)
 * 8. @xterm/headless synchronous write (Bun fires the deferred write after DSH serializes the buffer)
 * 9. node-addon-require-builtin dispatcher — the stub must exist in worker contexts too (#205)
 * 10. Patch 13/14: inspector CDP 桥（#61）——worker 侧把 Runtime 求值族与 HeapProfiler 堆快照
 *     转给主线程的 vm/v8 服务端，DevTools 面板在 Bun 下可用；全部 typeof Bun 守卫，Node 零变化
 * 15. PTC worker 继承控制通道的 Bun 兜底（fd 7 Duplex；process.js + persistent-process.js）
 * 16. inspector Client bootstrap 有界退避重试 + F7 可观测性（#68）——rc.2 已修宿主侧，客户端兜底
 *
 * 补丁落盘策略（#210）：物化后**不还原**，带 rev 指纹幂等——运行时树是被多个 dsh 进程共享的，
 * 任何进程退出时回写原文件都会把别的进程正在用的补丁抹掉（实测会把终端与 inspector 打回失败态）。
 */
import { Module } from "node:module";
import { Transpiler } from "bun";
import { resolve, dirname, join, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";

// 信息性日志（每个补丁的「已就位/applied」）默认静默：dsh 命令行每次跑 preload 都会打出十几行
// [bun-preload] Patch N 噪声（#62 PR 实测）；排障时设 DSH_SHELL_PRELOAD_DEBUG=1 打开。
const _trace = (...args) => {
  if (process.env.DSH_SHELL_PRELOAD_DEBUG === "1") console.log(...args);
};
// ── Helper: resolve bare specifier through node_modules with exports support ──
function _resolveBare(specifier, parentURL, H) {
  const { join, dirname, resolve, fileURLToPath, pathToFileURL, existsSync, readFileSync } = H;
  // Try import.meta.resolve first
  try { return H.esmResolve(specifier); } catch {}
  // 真正的 Node 语义优先：createRequire(parentURL).resolve 会读 exports 映射；
  // Bun 下同样可用。缺了这一步，只有 exports['.'] 而没有 main 的包（billion-context）
  // 会走下面的目录猜测，得到空模块或 MODULE_NOT_FOUND。
  if (parentURL) {
    try {
      const viaNode = require("node:module").createRequire(parentURL).resolve(specifier);
      return viaNode.startsWith("node:") ? viaNode : H.pathToFileURL(viaNode).href;
    } catch {}
  }
  // Parse bare specifier: @scope/name/subpath or name/subpath
  const m = specifier.match(/^(@[^/]+\/[^/]+|[^/]+)(\/.*)?$/);
  if (!m) return null;
  const pkgName = m[1];
  const subpath = m[2] || '';
  const _dshRoot = resolve(dirname(fileURLToPath(H.selfUrl)));
  const dirs = [
    join(_dshRoot, 'node_modules'),
    parentURL ? join(fileURLToPath(parentURL), 'node_modules') : '',
  ].filter(Boolean);
  for (const dir of dirs) {
    const pkgDir = join(dir, pkgName);
    if (!existsSync(pkgDir)) continue;
    // Try direct file path (e.g. /locale/en.json)
    if (subpath) {
      const fullPath = join(pkgDir, subpath);
      if (existsSync(fullPath)) return pathToFileURL(fullPath).href;
    }
    // Try exports field lookup (e.g. /tools → ./tools in exports)
    const pjPath = join(pkgDir, 'package.json');
    if (existsSync(pjPath)) {
      try {
        const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
        if (subpath && pj.exports) {
          const exportKey = '.' + subpath;
          const exp = pj.exports[exportKey];
          if (exp) {
            const target = typeof exp === 'string' ? exp : (exp.import || exp.default || exp.require || exp.node);
            if (target && existsSync(join(pkgDir, target))) return pathToFileURL(join(pkgDir, target)).href;
          }
        }
        if (!subpath) {
          if (pj.main && existsSync(join(pkgDir, pj.main))) return pathToFileURL(join(pkgDir, pj.main)).href;
          if (pj.exports && pj.exports['.']) {
            const exp = pj.exports['.'];
            const target = typeof exp === 'string' ? exp : (exp.import || exp.default || exp.require || exp.node);
            if (target && existsSync(join(pkgDir, target))) return pathToFileURL(join(pkgDir, target)).href;
          }
        }
      } catch {}
    }
  }
  return null;
}


// ── Patch 1: stripTypeScriptTypes ──
if (typeof Module.stripTypeScriptTypes !== "function") {
  const transpiler = new Transpiler({ loader: "ts" });
  Module.stripTypeScriptTypes = function stripTypeScriptTypes(code, options = {}) {
    if (typeof code !== "string") throw new TypeError("code must be a string");
    let stripped;
    try {
      stripped = transpiler.transformSync(code);
    } catch (err) {
      throw new SyntaxError(err instanceof Error ? err.message : String(err));
    }
    return options.sourceUrl
      ? `${stripped}\n//# sourceURL=${options.sourceUrl}`
      : stripped;
  };
}

// ── Patch 2: Intercept node-addon-require-builtin ──
// Dependencies the stub needs when it is stringified into the package entry (Patch 9).
const _stubDeps = {
  join, dirname, resolve, fileURLToPath, pathToFileURL, existsSync, readFileSync,
  esmResolve: (specifier) => import.meta.resolve(specifier),
  selfUrl: import.meta.url,
};
const _origCreateRequire = Module.createRequire;

Module.createRequire = function _patchedCreateRequire(filename) {
  const origRequire = _origCreateRequire.call(Module, filename);

  function patchedRequire(id) {
    if (id === "node-addon-require-builtin") {
      return createAddonStub(origRequire, Module, _stubDeps);
    }
    return origRequire(id);
  }

  // Preserve require properties
  patchedRequire.resolve = origRequire.resolve;
  patchedRequire.extensions = origRequire.extensions;
  patchedRequire.cache = origRequire.cache;
  patchedRequire.main = origRequire.main;
"  patchedRequire.paths = origRequire.paths;"

  return patchedRequire;
};

/**
 * Create a stub for node-addon-require-builtin that provides fake Node internal modules.
 * DSH uses these to intercept require/import for profile-specific resolution.
 * Under Bun, we provide stubs that pass validation but make installRuntimeInterception a no-op.
 */
function createAddonStub(origRequire, nodeModule, H) {
  const { join, dirname } = H;
  const Module = nodeModule;
  // Try to get the real Module constructor for _resolveFilename
  let RealModule;
  try {
    RealModule = origRequire("module");
  } catch {
    RealModule = Module;
  }

  return {
    requireBuiltin(name) {
      switch (name) {
        case "internal/modules/esm/loader":
          return {
            getOrInitializeCascadedLoader() {
              return {
                loadCache: new Map(),
                resolveSync(parentURL_or_specifier, request_or_parentURL, ...rest) {
                  let specifier, parentURL;
                  if (typeof request_or_parentURL === 'object' && request_or_parentURL !== null && 'specifier' in request_or_parentURL) {
                    parentURL = parentURL_or_specifier;
                    specifier = request_or_parentURL.specifier;
                  } else {
                    specifier = parentURL_or_specifier;
                    parentURL = request_or_parentURL;
                  }
                  // For relative/file specifiers, resolve against parentURL
                  if (specifier && (specifier.startsWith('.') || specifier.startsWith('file:') || specifier.startsWith('http'))) {
                    try { return { url: new URL(specifier, parentURL).href, format: undefined, shortCircuit: true }; } catch { return { url: specifier, format: undefined, shortCircuit: true }; }
                  }
                  // For bare specifiers, use _resolveBare helper
                  if (specifier) {
                    const resolved = _resolveBare(specifier, parentURL, H);
                    if (resolved) return { url: resolved, format: undefined, shortCircuit: true };
                  }
                  // For bare specifiers that couldn't be resolved, throw MODULE_NOT_FOUND
                  // so optionalResourcePath can handle it gracefully
                  if (specifier && !specifier.startsWith('.') && !specifier.startsWith('file:') && !specifier.startsWith('http')) {
                    const err = new Error(`Cannot find module '${specifier}'`);
                    err.code = 'MODULE_NOT_FOUND';
                    throw err;
                  }
                  // For relative specifiers, fall back to URL resolution
                  try { return { url: new URL(specifier, parentURL).href, format: undefined, shortCircuit: true }; } catch { return { url: specifier, format: undefined, shortCircuit: true }; }
                },
                getOrCreateModuleJob(parentURL, request, ...args) {
                  let specifier = typeof request === 'object' && request !== null ? request.specifier : request;
                  return undefined;
                },
                getModuleJobForImport(specifier, parentURL, ...args) {
                  return undefined;
                },
                resolve(specifier, parent, ...args) {
                  if (specifier && !specifier.startsWith('.') && !specifier.startsWith('file:') && !specifier.startsWith('http')) {
                    const r = _resolveBare(specifier, parent, H);
                    if (r) return Promise.resolve(r);
                  }
                  try { return Promise.resolve(new URL(specifier, parent).href); } catch { return Promise.resolve(specifier); }
                },
                async import(specifier, parentURL, attributes, ...rest) {
                  if (specifier && specifier.startsWith('.')) {
                    return await import(new URL(specifier, parentURL).href);
                  }
                  // Bun 的 NODE_PATH 兜底对「有 exports['.'] 但没有 main」的包会把包根解析成
                  // 空模块（实测 billion-context）⇒ cordis 拿到的插件没有 apply/name，entry 永远
                  // 没有 fiber，dsh 只报 “failed to import”。所以先按 parentURL 做一次真正的
                  // Node 解析（createRequire 会读 exports），失败再退回裸 import。
                  if (parentURL) {
                    try {
                      const viaNode = origRequire("node:module").createRequire(parentURL).resolve(specifier);
                      return await import(viaNode.startsWith("node:") ? viaNode : H.pathToFileURL(viaNode).href);
                    } catch {}
                  }
                  try { return await import(specifier); } catch {}
                  const resolved = _resolveBare(specifier, parentURL, H);
                  if (resolved) return await import(resolved);
                  throw new Error(`Cannot find package '${specifier}'`);
                },
                async load(url, context) {
                  return await import(url);
                },
                register() {}
              };
            },
          };

        case "internal/modules/cjs/loader":
          return {
            Module: {
              _resolveFilename(request, parent, isMain, options) {
                try {
                  return origRequire.resolve(request);
                } catch {
                  // Fall back to returning the request as-is
                  return request;
                }
              },
              _nodeModulePaths(from) {
                if (typeof from !== "string") return [];
                let paths = [];
                let dir = from;
                for (let i = 0; i < 50; i++) {
                  paths.push(join(dir, "node_modules"));
                  const parent = dirname(dir);
                  if (parent === dir) break;
                  dir = parent;
                }
                return paths;
              },
              _cache: {},
              _pathCache: {},
            },
          };

        case "internal/modules/helpers":
          return {
            getCjsConditions() {
              return ["node", "require"];
            },
          };

        case "internal/modules/esm/utils":
          return {
            getDefaultConditions() {
              return ["node", "import"];
            },
          };

        case "internal/modules/esm/resolve":
          return {
            defaultResolve(specifier, context, conditions) {
              const parentURL = context?.parentURL;
              if (specifier && !specifier.startsWith('.') && !specifier.startsWith('file:') && !specifier.startsWith('http')) {
                const r = _resolveBare(specifier, parentURL, H);
                if (r) return { url: r, format: undefined, shortCircuit: true };
              }
              try {
                const url = parentURL
                  ? new URL(specifier, parentURL).href
                  : new URL(specifier).href;
                return { url, format: undefined, shortCircuit: true };
              } catch {
                return { url: specifier, format: undefined, shortCircuit: true };
              }
            },
          };

        default:
          // For any other internal module, return an empty object
          // This may cause issues but lets us see what's actually needed
          console.warn(`[bun-preload] stub: unhandled internal module: ${name}`);
          return {};
      }
    },
    isAllowedInternalId() {
      return true;
    },
    getBindingInfo() {
      return { binding: "bun-preload-stub" };
    },
  };
}

// ── Patch 3: HMR disable ──
process.env.DSH_BUN_COMPAT_DISABLE_HMR = "1";

// ── Patch 5: Fix stripTypeScriptTypes named import in dsh-ptc-runtime-node ──
// Bun doesn't export stripTypeScriptTypes from node:module as a named export.
// Patch the file to use Module.stripTypeScriptTypes instead.
// ── 补丁落盘策略（#210 决策）：物化后不还原，带 rev 指纹幂等 ──
// 早期版本在 exit/SIGINT/SIGTERM 上把文件写回原样。但运行时树被同一台机器上多个 dsh 进程
// 共享（应用宿主 + 缝①黑盒测试的第二实例），任何一个进程退出都会把别的进程正在用的补丁
// 抹掉——实测：黑盒测试宿主退出后，运行中的窗口终端立刻变回「进程已退出（1）」、inspector
// 也起不来。改为「打上就不动」：目标文件是 dispatcher 形态（Bun 走 shim、其它运行时转
// index.original.js），对 Node 无害；每条补丁带 rev 指纹，rev 变了才重写。
const PATCH_REV = 11;
const REV_MARK = `bun-preload-rev:${PATCH_REV}`;
/** 已处理的文件，仅用于结尾汇总日志。 */
const _patches = new Set();
/** 幂等写入：内容一致就不动（多进程同跑时避免来回覆写）。 */
function writePatch(filePath, content) {
  try { if (existsSync(filePath) && readFileSync(filePath, 'utf8') === content) { _patches.add(filePath); return false; } } catch {}
  writeFileSync(filePath, content);
  _patches.add(filePath);
  return true;
}
/** 该文件是否已经是当前 rev 的产物。 */
function hasCurrentRev(filePath) {
  try { return readFileSync(filePath, 'utf8').includes(REV_MARK); } catch { return false; }
}

/** 旧 rev 产物升级：把文件里所有旧 rev 指纹注释刷成当前 rev（形态不变）。 */
function bumpRev(content) {
  return content.replace(/\/\/ bun-preload-rev:\d+/g, `// ${REV_MARK}`);
}

// Find DSH root from preload location
const _dshRoot = resolve(dirname(fileURLToPath(import.meta.url)));
// 和 Patch 7/9 一样按「所有可能被解析到的树」找目标：运行时树往往不是 preload 所在的树
// （随包运行时、下载运行时、profile 树）。只打 preload 旁边那份 = 实际生效的那份没打上，
// 实测后果就是 ptc-runtime 起不来 → workflow-ptc/tool-workflow 一直等它 → 新建会话失败。
const PTC_IMPORT_FROM = 'import { stripTypeScriptTypes } from "node:module";';
const PTC_IMPORT_TO = `// ${REV_MARK}\nimport { Module } from "node:module"; const stripTypeScriptTypes = Module.stripTypeScriptTypes;`;
for (const target of packageTargets('@deepseek-ai/dsh-ptc-runtime-node/lib/index.js')) {
  if (hasCurrentRev(target)) {
    _trace(`[bun-preload] Patch 5: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  const src = readFileSync(target, 'utf8');
  if (!src.includes(PTC_IMPORT_FROM)) {
    // 已经是我们写过的形态（只是 rev 指纹陈旧）⇒ 刷新指纹，不要误报「上游版本不符」
    if (src.includes('const stripTypeScriptTypes = Module.stripTypeScriptTypes;')) {
      writePatch(target, src.replace(/\/\/ bun-preload-rev:\d+/g, `// ${REV_MARK}`));
      _trace(`[bun-preload] Patch 5: ${REV_MARK} 已就位（刷新指纹）${target}`);
      continue;
    }
    console.warn(`[bun-preload] Patch 5: 上游版本不符（找不到具名导入）：${target}`);
    continue;
  }
  writePatch(target, src.replace(PTC_IMPORT_FROM, PTC_IMPORT_TO));
  _trace(`[bun-preload] Patch 5: stripTypeScriptTypes 具名导入改写 applied to ${target}`);
}

// ── Patch 6: Disable koffi (dsh-win32-process) on Bun ──
// koffi loads but produces broken N-API bindings on Bun (JavaScriptCore, not V8).
// Make loadWin32ProcessBindings throw → probeWindowsJob returns false → fallback to child_process.spawn.
// 行尾锚定：TO 产物以函数头开头，若 FROM 不带 \n 会永久命中、每次 rev 提升叠一层
// throw（实测上游实机已叠 4 层 rev:3-6）。带 \n 后产物落入下方「刷新指纹」分支。
const KOFFI_GUARD_FROM = 'function loadWin32ProcessBindings() {\n';
const KOFFI_GUARD_TO = `function loadWin32ProcessBindings() { if (typeof Bun !== 'undefined') throw new Error('koffi not available on Bun runtime'); // ${REV_MARK}\n`;
for (const target of packageTargets('@deepseek-ai/dsh-win32-process/lib/index.js')) {
  if (hasCurrentRev(target)) {
    _trace(`[bun-preload] Patch 6: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  const src = readFileSync(target, 'utf8');
  if (!src.includes(KOFFI_GUARD_FROM)) {
    // 同上：已是打过补丁的形态，只刷新 rev 指纹
    if (src.includes('koffi not available on Bun runtime')) {
      writePatch(target, bumpRev(src));
      _trace(`[bun-preload] Patch 6: ${REV_MARK} 已就位（刷新指纹）${target}`);
      continue;
    }
    console.warn(`[bun-preload] Patch 6: 上游版本不符（找不到 loadWin32ProcessBindings）：${target}`);
    continue;
  }
  writePatch(target, src.replace(KOFFI_GUARD_FROM, KOFFI_GUARD_TO));
  _trace(`[bun-preload] Patch 6: koffi 禁用 applied to ${target}`);
}

// ── Patch 4: module.register no-op shim ──
// Bun treats module.register as no-op, but some code may expect it to work.
// We leave it as-is (Bun's no-op) and hope for the best.

// ── Patch 7: node-pty shim over Bun.spawn({ terminal }) ──
// The node-pty N-API addon spawns its child under Bun but never delivers the output
// (measured on Bun 1.4.0/macOS: `/bin/echo hello` yields 0 chunks where Node yields 1),
// so DSH sees a live process that never talks and reports the terminal as exited(1).
// Bun.spawn({ terminal }) carries the same bytes, so node-pty is replaced by a shim.
//
// The shim has to land on the copy the *active* runtime resolves — a downloaded runtime
// tree is not the tree this preload ships in, and patching only the latter silently
// does nothing. The patched file becomes a dispatcher so a crash can never leave a
// Bun-only shim in front of a Node run.
const PTY_SHIM_SOURCE = [
  `// bun-preload: node-pty shim over Bun.spawn({ terminal }); the N-API addon never delivers output on Bun. ${REV_MARK}`,
  'function spawnPty(file, args, options = {}) {',
  '  const cols = options.cols || 80;',
  '  const rows = options.rows || 24;',
  '  const name = options.name || "xterm-256color";',
  '  const env = { ...options.env, TERM: name, LANG: "en_US.UTF-8" };',
  '  let onDataCb = null, onExitCb = null, paused = false;',
  '  const buffered = [];',
  '  const decoder = new TextDecoder("utf-8");',
  '  const proc = Bun.spawn([file, ...args], {',
  '    cwd: options.cwd,',
  '    env,',
  '    windowsHide: true,',
  '    terminal: {',
  '      cols, rows, name,',
  '      data(_term, data) {',
  '        const text = decoder.decode(data instanceof Uint8Array ? data : Buffer.from(data), { stream: true });',
  '        if (text === "") return;',
  '        if (paused) { buffered.push(text); return; }',
  '        if (onDataCb !== null) onDataCb(text);',
  '      },',
  '      exit(_term, exitCode) { if (onExitCb !== null) onExitCb({ exitCode, signal: null }); },',
  '    },',
  '    onExit(_proc, exitCode, signalCode) { if (onExitCb !== null) onExitCb({ exitCode, signal: signalCode }); },',
  '  });',
  '  return {',
  '    pid: proc.pid,',
  '    process: proc,',
  '    write(data) { try { proc.terminal.write(data); } catch { return false; } return true; },',
  '    onData(cb) { onDataCb = cb; return { dispose() { if (onDataCb === cb) onDataCb = null; } }; },',
  '    onExit(cb) { onExitCb = cb; return { dispose() { if (onExitCb === cb) onExitCb = null; } }; },',
  '    pause() { paused = true; },',
  '    resume() {',
  '      paused = false;',
  '      for (const text of buffered.splice(0)) if (onDataCb !== null) onDataCb(text);',
  '    },',
  '    clear() {},',
  '    kill(signal) { try { proc.kill(signal); } catch {} },',
  '    resize(cols, rows) { try { proc.terminal.resize(cols, rows); } catch {} },',
  '  };',
  '}',
  'module.exports = { spawn: spawnPty };',
  ''
].join('\n');
const PTY_DISPATCHER_SOURCE = [
  `// bun-preload: node-pty dispatcher — Bun gets the Bun.Terminal shim, every other runtime the real addon. ${REV_MARK}`,
  'if (typeof Bun === "undefined") module.exports = require("./index.original.js");',
  'else module.exports = require("./bun-shim.js");',
  ''
].join('\n');
/**
 * node_modules roots this process could resolve a patched package from: the tree this
 * preload ships in, any tree named in DSH_BUN_PRELOAD_TREES, then upwards from the entry
 * script and the working directory (a downloaded runtime is entered through its launcher).
 */
function nodeModulesRoots() {
  const seen = new Set();
  const roots = [];
  const add = (dir) => {
    const root = resolve(dir);
    if (seen.has(root)) return;
    seen.add(root);
    roots.push(root);
  };
  add(join(_dshRoot, 'node_modules'));
  for (const extra of (process.env.DSH_BUN_PRELOAD_TREES ?? '').split(delimiter)) {
    if (extra !== '') add(join(resolve(extra), 'node_modules'));
  }
  for (const start of [process.argv[1], process.cwd()]) {
    if (start === undefined) continue;
    let dir = dirname(resolve(start));
    for (let depth = 0; depth < 8; depth += 1) {
      add(join(dir, 'node_modules'));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return roots;
}
/** Every existing copy of `relativePath` under those roots. */
function packageTargets(relativePath) {
  const targets = [];
  const seen = new Set();
  for (const root of nodeModulesRoots()) {
    const file = join(root, relativePath);
    if (!existsSync(file)) continue;
    // One file can be reachable by several roots (/tmp and /private/tmp are the same
    // node_modules); patch it once, or it is patched twice in the same run.
    let key = file;
    try { key = realpathSync(file); } catch {}
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(key);
  }
  return targets;
}
for (const target of packageTargets('node-pty/lib/index.js')) {
  const directory = dirname(target);
  const originalPath = join(directory, 'index.original.js');
  const shimPath = join(directory, 'bun-shim.js');
  if (hasCurrentRev(shimPath) && hasCurrentRev(target)) {
    _trace(`[bun-preload] Patch 7: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  // A dispatcher left behind by an earlier run still holds the real addon next to it.
  const dispatched = existsSync(originalPath);
  const original = readFileSync(dispatched ? originalPath : target, 'utf8');
  if (!dispatched) writePatch(originalPath, original);
  writePatch(shimPath, PTY_SHIM_SOURCE);
  writePatch(target, PTY_DISPATCHER_SOURCE);
  _trace(`[bun-preload] Patch 7: node-pty shim applied to ${target}`);
}

// ── Patch 8: xterm.js headless sync write fix ──
// xterm.js defers non-user-input writes via setTimeout(0), which on Bun may fire
// after I/O events. DSH serializes the buffer before the setTimeout fires, seeing
// empty data. Fix: replace setTimeout with synchronous _innerWrite() call.
const XTERM_SYNC_WRITE_FROM = 'setTimeout((()=>this._innerWrite()))}this._pendingData+=e.length,this._writeBuffer.push(e),this._callbacks.push(t)}_innerWrite';
const XTERM_SYNC_WRITE_TO = '0}this._pendingData+=e.length,this._writeBuffer.push(e),this._callbacks.push(t),this._innerWrite()}_innerWrite';
for (const target of packageTargets('@xterm/headless/lib-headless/xterm-headless.js')) {
  if (hasCurrentRev(target)) {
    _trace(`[bun-preload] Patch 8: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  const source = readFileSync(target, 'utf8');
  const patched = source.replace(XTERM_SYNC_WRITE_FROM, XTERM_SYNC_WRITE_TO);
  if (patched === source) {
    // 早期版本打过补丁但没留指纹（或者上游换了写法）：能认出已是补丁体就补写指纹
    if (source.includes(XTERM_SYNC_WRITE_TO)) {
      writePatch(target, `${source}\n/* ${REV_MARK} */\n`);
      _trace(`[bun-preload] Patch 8: 已是同步写形态，补写 ${REV_MARK} 指纹 ${target}`);
    } else {
      console.warn(`[bun-preload] Patch 8: 目标里没有可替换的写入模式（上游版本变了？）${target}`);
    }
    continue;
  }
  writePatch(target, `${patched}\n/* ${REV_MARK} */\n`);
  _trace(`[bun-preload] Patch 8: xterm.js sync write applied to ${target}`);
}

// ── Patch 9: node-addon-require-builtin dispatcher (works in every context) ──
// Patch 2 only covers this process: Bun does not run --preload scripts in worker threads
// (measured), and a worker's ESM `createRequire` binding ignores the monkey patch, so a
// worker loading this package reaches the native addon and dies with
// "node-addon-require-builtin unsupported: Unsupported/no-context" (experimental-inspector).
// Rewriting the package entry makes the stub available to every consumer and context.
const ADDON_STUB_MODULE_SOURCE = [_resolveBare.toString(), createAddonStub.toString()].join('\n');
const ADDON_DISPATCHER_SOURCE = [
  '"use strict";',
  `// ${REV_MARK}`,
  'Object.defineProperty(exports, "__esModule", { value: true });',
  'const H = {',
  '  join: require("node:path").join,',
  '  dirname: require("node:path").dirname,',
  '  resolve: require("node:path").resolve,',
  '  fileURLToPath: require("node:url").fileURLToPath,',
  '  pathToFileURL: require("node:url").pathToFileURL,',
  '  existsSync: require("node:fs").existsSync,',
  '  readFileSync: require("node:fs").readFileSync,',
  '  esmResolve() { throw new Error("import.meta.resolve is unavailable in this context"); },',
  `  selfUrl: ${JSON.stringify(import.meta.url)},`,
  '};',
  'if (typeof Bun === "undefined") {',
  '  const original = require("./index.original.js");',
  '  exports.requireBuiltin = original.requireBuiltin;',
  '  exports.isAllowedInternalId = original.isAllowedInternalId;',
  '  exports.getBindingInfo = original.getBindingInfo;',
  '  exports.default = original.default;',
  '} else {',
  ADDON_STUB_MODULE_SOURCE,
  '  const nodeModule = require("node:module").Module ?? require("node:module");',
  '  const impl = createAddonStub(require, nodeModule, H);',
  '  exports.requireBuiltin = (moduleId) => impl.requireBuiltin(moduleId);',
  '  exports.isAllowedInternalId = () => impl.isAllowedInternalId();',
  '  exports.getBindingInfo = () => impl.getBindingInfo();',
  '  exports.default = { requireBuiltin: exports.requireBuiltin, isAllowedInternalId: exports.isAllowedInternalId, getBindingInfo: exports.getBindingInfo };',
  '}',
  ''
].join('\n');
for (const target of packageTargets('node-addon-require-builtin/lib/index.js')) {
  if (hasCurrentRev(target)) {
    _trace(`[bun-preload] Patch 9: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  const directory = dirname(target);
  const originalPath = join(directory, 'index.original.js');
  const dispatched = existsSync(originalPath);
  const original = readFileSync(dispatched ? originalPath : target, 'utf8');
  if (!dispatched) writePatch(originalPath, original);
  writePatch(target, ADDON_DISPATCHER_SOURCE);
  _trace(`[bun-preload] Patch 9: node-addon-require-builtin stub applied to ${target}`);
}

// ── Patch 10: 插件展示元数据（名称/描述/图标）在 Bun 下解析不到 ──
// dsh 自带的插件页通过 dsh-app-boot 的 readPluginMeta 读每个插件的 locale/en.json、
// package.json 与 icon，而 resolvePluginResource 走的是 Node 内部 ESM resolver
// （ModuleLoader.fromInternal() + loader.resolveSync）。Bun 的这个入口对上述三个子路径
// 一律答 MODULE_NOT_FOUND ⇒ readPluginMeta 返回 undefined ⇒ 插件页只剩裸包名+默认图标。
// 这里补一层兜底：先试公共 resolver（createRequire），再按 Node 的查找顺序手查文件系统
// （不看 exports 映射——元数据读取只读文件，从不 import 它们），都找不到时抛 MODULE_NOT_FOUND
// 以保持 optionalResourcePath 的「缺失即 undefined」语义。
const APP_BOOT_RESOLVER_FROM = [
  '\tif (loader === void 0) throw new Error("Plugin metadata requires the Node module resolver");',
  '\treturn fileURLToPath((loader.version === "v2" ? loader.resolveSync(parentURL, {',
  '\t\tspecifier,',
  '\t\tattributes: {}',
  '\t}) : loader.resolveSync(specifier, parentURL, {})).url);',
].join('\n');
const APP_BOOT_FALLBACK_SOURCE = [
  `// ${REV_MARK}`,
  'function pluginResourceFallback(specifier, parentURL) {',
  '\tconst request = createRequire(parentURL);',
  '\ttry {',
  '\t\treturn request.resolve(specifier);',
  '\t} catch {}',
  '\tconst parts = specifier.split("/");',
  '\tconst packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];',
  '\tconst subpath = specifier.slice(packageName.length).replace(/^\\/+/, "");',
  '\tlet directory = dirname(fileURLToPath(parentURL));',
  '\tfor (let depth = 0; depth < 12; depth += 1) {',
  '\t\tconst packageDir = join(directory, "node_modules", packageName);',
  '\t\tif (subpath !== "" && existsSync(join(packageDir, "package.json"))) {',
  '\t\t\tconst target = join(packageDir, subpath);',
  '\t\t\tfor (const probe of [target, `${target}.js`, join(target, "index.js")]) {',
  '\t\t\t\tif (existsSync(probe)) return realpathSync(probe);',
  '\t\t\t}',
  '\t\t\tbreak;',
  '\t\t}',
  '\t\tconst parent = dirname(directory);',
  '\t\tif (parent === directory) break;',
  '\t\tdirectory = parent;',
  '\t}',
  "\tconst error = new Error(`Cannot find module '${specifier}' from '${parentURL}'`);",
  '\terror.code = "MODULE_NOT_FOUND";',
  '\tthrow error;',
  '}',
].join('\n');
const APP_BOOT_RESOLVER_TO = [
  `\tif (loader === void 0) return pluginResourceFallback(specifier, parentURL); // ${REV_MARK}`,
  '\ttry {',
  '\t\treturn fileURLToPath((loader.version === "v2" ? loader.resolveSync(parentURL, {',
  '\t\t\tspecifier,',
  '\t\t\tattributes: {}',
  '\t\t}) : loader.resolveSync(specifier, parentURL, {})).url);',
  '\t} catch (error) {',
  '\t\tif (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_MODULE_NOT_FOUND") throw error;',
  '\t\treturn pluginResourceFallback(specifier, parentURL);',
  '\t}',
  APP_BOOT_FALLBACK_SOURCE
].join('\n');
for (const target of packageTargets('@deepseek-ai/dsh-app-boot/lib/index.js')) {
  const source = readFileSync(target, 'utf8');
  if (source.includes('pluginResourceFallback')) {
    if (!hasCurrentRev(target)) writePatch(target, bumpRev(source));
    _trace(`[bun-preload] Patch 10: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  if (!source.includes(APP_BOOT_RESOLVER_FROM)) {
    console.warn(`[bun-preload] Patch 10: 未找到上游 resolvePluginResource 文本，跳过 ${target}（上游版本不符）`);
    continue;
  }
  writePatch(target, source.replace(APP_BOOT_RESOLVER_FROM, APP_BOOT_RESOLVER_TO));
  _trace(`[bun-preload] Patch 10: 插件展示元数据解析兜底 applied to ${target}`);
}

// ── Patch 11: 插件说明符按 Loader 的 baseUrl 解析（Bun 没有 Node 内部 loader）──
// cordis 的 Loader.import() 在 Node 下走 internal.import(name, baseUrl)；Bun 下 internal 缺失
// （ModuleLoader.fromInternal() 返回 undefined），退化成「从本文件位置裸 import(name)」。
// 于是 profile 里带子路径的插件（billion-context/dsh）解析不到 ⇒ 该 entry 的 fiber 永远建不起来，
// dsh 只报「bili-native (billion-context): failed to import」。这里补上与 Node 同语义的解析：
// 用 createRequire(baseUrl) 解析后 import 文件 URL；解析不了时原样返回（node: 内建、相对路径照旧）。
const LOADER_RESOLVE_IMPORT_FROM = [
  '\t\t\telse return await import(__rewriteRelativeImportExtension(',
  '\t\t\t\t/* @vite-ignore */',
  '\t\t\t\tname',
  '\t\t\t));'
].join('\n');
const LOADER_RESOLVE_IMPORT_TO = [
  '\t\t\telse return await __bunImportFromBase(name, this.ctx.baseUrl, __rewriteRelativeImportExtension);'
].join('\n');
const LOADER_URL_IMPORT_FROM = 'import { createRequire } from "node:module";';
const LOADER_URL_IMPORT_TO = [
  'import { createRequire } from "node:module";',
  'import { pathToFileURL as __bunPathToFileURL } from "node:url";'
].join('\n');
const LOADER_RESOLVE_HELPER = [
  `// ${REV_MARK} — Bun 下把插件说明符解析到 Loader baseUrl（与 Node 的 internal.import(name, baseUrl) 同语义）`,
  'function __bunResolveFromBase(name, baseUrl) {',
  '\ttry {',
  '\t\tif (name.startsWith("node:")) return name;',
  '\t\tconst resolved = createRequire(baseUrl).resolve(name);',
  '\t\treturn resolved.startsWith("node:") ? resolved : __bunPathToFileURL(resolved).href;',
  '\t} catch {',
  '\t\treturn name;',
  '\t}',
  '}',
  'async function __bunImportFromBase(name, baseUrl, rewrite) {',
  '\tconst target = __bunResolveFromBase(name, baseUrl);',
  '\ttry {',
  '\t\treturn await import(/* @vite-ignore */ rewrite(target));',
  '\t} catch (error) {',
  '\t\tconsole.error(`[bun-preload] 插件导入失败：${name} ← ${target}`, error);',
  '\t\tthrow error;',
  '\t}',
  '}',
  ''
].join('\n');
for (const target of packageTargets('@deepseek-ai/cordis-plugin-loader/lib/index.js')) {
  const source = readFileSync(target, 'utf8');
  if (source.includes('__bunResolveFromBase')) {
    if (!hasCurrentRev(target)) writePatch(target, bumpRev(source));
    _trace(`[bun-preload] Patch 11: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  if (!source.includes(LOADER_RESOLVE_IMPORT_FROM) || !source.includes(LOADER_URL_IMPORT_FROM)) {
    console.warn(`[bun-preload] Patch 11: 未找到上游 Loader.import 文本，跳过 ${target}（上游版本不符）`);
    continue;
  }
  const patched = source
    .replace(LOADER_URL_IMPORT_FROM, LOADER_URL_IMPORT_TO)
    .replace(LOADER_RESOLVE_IMPORT_FROM, LOADER_RESOLVE_IMPORT_TO);
  writePatch(target, `${patched}\n${LOADER_RESOLVE_HELPER}`);
  _trace(`[bun-preload] Patch 11: 插件说明符按 baseUrl 解析 applied to ${target}`);
}

// ── Patch 12: experimental-inspector 容忍 fetch 访问器 ──
// 缘起：「@deepseek-ai/dsh-experimental-inspector 内置插件启动失败」——第三方插件
// billion-context（bili-native）为了在别的插件替换掉 fetch 后重新爬到链顶，把
// `globalThis.fetch` 装成带 get/set 的**访问器**；而 inspector 取保守策略：描述符不是数据属性
// 就直接拒绝启动（lib/index.js 的 installFetchObserver 开头）。两边单看都有道理，凑在一起就是内置
// 插件永远起不来。这里把那一行改成「先归一成数据属性再观察」：值就是当时的 fetch（也就是
// billion-context 的链），跟 Node 下 fetch 本来就是数据属性的形态一致。
// 上游文本一旦变了（没命中），只警告不报错，后续版本自会回到「拒绝启动」的原生行为。
const INSPECTOR_FETCH_GUARD =
  '\tif (descriptor !== void 0 && !("value" in descriptor)) throw new Error("inspector: globalThis.fetch is an accessor and cannot be observed safely");';
const INSPECTOR_FETCH_MARK = 'bun-preload: fetch 访问器归一';
// #6：descriptor 是 const，归一只改属性本身动不了它；上游随后把它 spread 进新描述符再叠 value，
// Bun 直接拒绝（TypeError: Invalid property.  'value' present on property with getter or setter.）——
// spread 定义也要一并换成干净数据属性。
const INSPECTOR_FETCH_NORMALIZE = [
  `\t// ${REV_MARK} ${INSPECTOR_FETCH_MARK}（billion-context 装的是访问器，inspector 原本会硬拒）`,
  '\tif (descriptor !== void 0 && !("value" in descriptor)) {',
  '\t\tObject.defineProperty(globalThis, "fetch", { value: original, writable: true, configurable: true, enumerable: descriptor.enumerable ?? true });',
  '\t}',
].join('\n');
// rev≤6 时代的归一块（无 rev 指纹）：报障实机上就是它占着守卫行的位置。
const INSPECTOR_FETCH_LEGACY = [
  `\t// ${INSPECTOR_FETCH_MARK}（billion-context 装的是访问器，inspector 原本会硬拒）`,
  '\tif (descriptor !== void 0 && !("value" in descriptor)) {',
  '\t\tObject.defineProperty(globalThis, "fetch", { value: original, writable: true, configurable: true, enumerable: descriptor.enumerable ?? true });',
  '\t}',
].join('\n');
const INSPECTOR_FETCH_SPREAD_FROM = '\t} : {\n\t\t...descriptor,\n\t\tvalue: observedFetch\n\t});';
const INSPECTOR_FETCH_SPREAD_TO = '\t} : {\n\t\tvalue: observedFetch,\n\t\twritable: true,\n\t\tconfigurable: true\n\t});';
for (const target of packageTargets('@deepseek-ai/dsh-experimental-inspector/lib/index.js')) {
  if (hasCurrentRev(target)) {
    _trace(`[bun-preload] Patch 12: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  const source = readFileSync(target, 'utf8');
  // 三种已知形态各自认领（rev 提升不能让已归一的机器被永久跳过）：
  //  a) 原始上游：守卫行在 → 归一替换；
  //  b) rev≤6 产物：旧归一块（无 rev 指纹）在 → 升级成当前归一块；
  //  c) rev≥7 产物：归一形态（首行已带 rev 前缀）→ 只刷指纹。
  let next;
  if (source.includes(INSPECTOR_FETCH_GUARD)) {
    next = source.replace(INSPECTOR_FETCH_GUARD, INSPECTOR_FETCH_NORMALIZE);
  } else if (source.includes(INSPECTOR_FETCH_LEGACY)) {
    next = source.replace(INSPECTOR_FETCH_LEGACY, INSPECTOR_FETCH_NORMALIZE);
  } else if (source.includes(INSPECTOR_FETCH_MARK)) {
    const refreshed = bumpRev(source);
    if (refreshed === source) {
      _trace(`[bun-preload] Patch 12: ${REV_MARK} 已就位 ${target}`);
    } else {
      writePatch(target, refreshed);
      _trace(`[bun-preload] Patch 12: ${REV_MARK} 指纹已刷新 ${target}`);
    }
    continue;
  } else {
    console.warn(`[bun-preload] Patch 12: 未找到上游 accessor 检查文本，跳过 ${target}（上游版本不符）`);
    continue;
  }
  // spread 修复独立判定：锚漂了只 warn，不连坐归一（#6 审查采纳项）。
  let spreadFixed = false;
  if (next.includes(INSPECTOR_FETCH_SPREAD_FROM)) {
    next = next.replace(INSPECTOR_FETCH_SPREAD_FROM, INSPECTOR_FETCH_SPREAD_TO);
    spreadFixed = true;
  } else {
    console.warn(`[bun-preload] Patch 12: 未找到上游 spread 定义文本，跳过 spread 修复 ${target}（上游版本不符）`);
  }
  writePatch(target, next);
  _trace(`[bun-preload] Patch 12: fetch 访问器归一 applied${spreadFixed ? '（含 spread 修复）' : ''} to ${target}`);
}

/** inspector CDP 桥两补丁共用：mark 命中（产物已是我们写的）→ 刷 rev 指纹，幂等不重打。 */
function refreshBridgeFingerprint(label, target, source) {
	const refreshed = bumpRev(source);
	if (refreshed === source) {
		_trace(`[bun-preload] ${label}: ${REV_MARK} 已就位 ${target}`);
		return;
	}
	writePatch(target, refreshed);
	_trace(`[bun-preload] ${label}: ${REV_MARK} 指纹已刷新 ${target}`);
}

// ── Patch 13: inspector worker 的宿主 CDP 桥（#61：Bun 下「NodeJS 诊断」面板全白）──
// Bun 的 node:inspector CDP 面太窄（官方兼容表 🟡）：Runtime.evaluate、HeapProfiler.*
// 等命令一律 -32601 wasn't found ⇒ DevTools 前端拿不到求值结果 ⇒ 面板整块空白。
// HostInspectorSession.request() 是五条宿主后端（Runtime/Console/Sources/Debugger/
// nativeDomains）共用的唯一 session.post 落点：命中桥方法时不碰 session.post，改经既有
// hostSourcePort 把请求转给主线程执行（Patch 14 的服务端）；堆快照以合成事件
// HeapProfiler.addHeapSnapshotChunk 经 session.listeners 推回客户端（nativeDomains 的
// 转发管道天然放行）。未命中的方法照旧走原生——Bun 报什么就透什么，不掩盖上游缺口。
// 运行时以 typeof Bun 守卫：同一份 bundle 被 Node 跑时零变化。worker 入口的
// hostSourcePort.on("message") 先认领桥响应帧，防止未知帧落进 sources.receive 把
// Host source 误判断连。
const INSPECTOR_WORKER_BRIDGE_MARK = 'bun-preload: inspector CDP 桥（worker 侧）';
const INSPECTOR_WORKER_REQUEST_FROM = [
	'\trequest(method, params) {',
	'\t\tconst failure = this.connect();',
].join('\n');
const INSPECTOR_WORKER_REQUEST_TO = [
	`\trequest(method, params) { // ${REV_MARK} ${INSPECTOR_WORKER_BRIDGE_MARK}`,
	'\t\tif (typeof Bun !== "undefined") {',
	'\t\t\tconst bridged = __dshInspectorCdpBridge(this, method, params);',
	'\t\t\tif (bridged !== void 0) return bridged;',
	'\t\t}',
	'\t\tconst failure = this.connect();',
].join('\n');
const INSPECTOR_WORKER_ENTRY_FROM =
	'\t\tif (!hostQueries.receive(value)) sources.receive(hostConnection, value);';
const INSPECTOR_WORKER_ENTRY_TO = [
	`\t\tif (__dshCdpBridgeReceive(value)) return; // ${REV_MARK} ${INSPECTOR_WORKER_BRIDGE_MARK}`,
	'\t\tif (!hostQueries.receive(value)) sources.receive(hostConnection, value);',
].join('\n');
const INSPECTOR_WORKER_BRIDGE_SOURCE = [
	`// ${REV_MARK} ${INSPECTOR_WORKER_BRIDGE_MARK}`,
	'// 初始化顺序说明：worker 入口在模块求值中途就会收到主线程的 source/open 帧，',
	'// 桥全用 function/var（可提升）+ typeof 守卫，模块初始化完成前一律不接管、放行原流。',
	'var DSH_CDP_BRIDGE_REQUEST = "dsh-cdp/request";',
	'var DSH_CDP_BRIDGE_RESPONSE = "dsh-cdp/response";',
	'var DSH_CDP_BRIDGE_METHODS = new Set([',
	'\t"Runtime.evaluate",',
	'\t"Runtime.callFunctionOn",',
	'\t"Runtime.awaitPromise",',
	'\t"Runtime.getProperties",',
	'\t"Runtime.globalLexicalScopeNames",',
	'\t"Runtime.releaseObject",',
	'\t"Runtime.releaseObjectGroup"',
	']);',
	'var DSH_CDP_BRIDGE_PENDING = new Map();',
	'var DSH_CDP_BRIDGE_SEQ = 0;',
	'function __dshCdpBridgeReceive(value) {',
	'\tif (typeof DSH_CDP_BRIDGE_RESPONSE === "undefined") return false;',
	'\tif (typeof value !== "object" || value === null || value.t !== DSH_CDP_BRIDGE_RESPONSE) return false;',
	'\tif (!DSH_CDP_BRIDGE_PENDING) return true;',
	'\tconst pending = DSH_CDP_BRIDGE_PENDING.get(value.requestId);',
	'\tif (pending === void 0) return true;',
	'\tDSH_CDP_BRIDGE_PENDING.delete(value.requestId);',
	'\tif (value.ok) pending.resolve(value.payload === void 0 ? {} : value.payload);',
	'\telse pending.reject(new Error(`inspector host bridge: ${value.error ?? "unknown error"}`));',
	'\treturn true;',
	'}',
	'function __dshCdpBridgeCall(op, params) {',
	'\tif (!DSH_CDP_BRIDGE_PENDING) return Promise.reject(new Error("inspector host bridge: not ready"));',
	'\treturn new Promise((resolve, reject) => {',
	'\t\tconst requestId = `dsh-cdp-bridge-${++DSH_CDP_BRIDGE_SEQ}`;',
	'\t\tconst timer = setTimeout(() => { DSH_CDP_BRIDGE_PENDING.delete(requestId); reject(new Error(`inspector host bridge: ${op} timed out after 30000ms`)); }, 30000);',
	'\t\tDSH_CDP_BRIDGE_PENDING.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });',
	'\t\tboot.hostSourcePort.postMessage({ v: 0, t: DSH_CDP_BRIDGE_REQUEST, requestId, op, params: params ?? {} });',
	'\t});',
	'}',
	'async function __dshInspectorCdpBridge(session, method, params) {',
	'\tif (typeof DSH_CDP_BRIDGE_METHODS === "undefined") return void 0;',
	'\tif (DSH_CDP_BRIDGE_METHODS.has(method)) return __dshCdpBridgeCall(method.slice("Runtime.".length), params);',
	'\tif (method === "HeapProfiler.enable" || method === "HeapProfiler.disable") return {};',
	'\tif (method === "HeapProfiler.takeHeapSnapshot" || method === "HeapProfiler.getHeapSnapshot") {',
	'\t\tconst response = await __dshCdpBridgeCall("takeHeapSnapshot", {});',
	'\t\tfor (const chunk of response.chunks ?? []) {',
	'\t\t\tconst notification = { method: "HeapProfiler.addHeapSnapshotChunk", params: { chunk } };',
	'\t\t\tfor (const listener of [...session.listeners]) { try { listener(notification); } catch {} }',
	'\t\t}',
	'\t\treturn {};',
	'\t}',
	'\tif (method === "HeapProfiler.collectGarbage") { try { globalThis.gc?.(); } catch {} return {}; }',
	'\treturn void 0;',
	'}',
	''
].join('\n');
for (const target of packageTargets('@deepseek-ai/dsh-experimental-inspector/lib/worker.js')) {
	if (hasCurrentRev(target)) {
		_trace(`[bun-preload] Patch 13: ${REV_MARK} 已就位 ${target}`);
		continue;
	}
	const source = readFileSync(target, 'utf8');
	// 已是我们写过的产物（rev 指纹陈旧）：刷指纹，不重打。
	if (source.includes(INSPECTOR_WORKER_BRIDGE_MARK)) {
		refreshBridgeFingerprint('Patch 13', target, source);
		continue;
	}
	if (!source.includes(INSPECTOR_WORKER_REQUEST_FROM) || !source.includes(INSPECTOR_WORKER_ENTRY_FROM)) {
		console.warn(`[bun-preload] Patch 13: 未找到上游 request/worker-entry 文本，跳过 ${target}（上游版本不符）`);
		continue;
	}
	const next = source
		.replace(INSPECTOR_WORKER_REQUEST_FROM, INSPECTOR_WORKER_REQUEST_TO)
		.replace(INSPECTOR_WORKER_ENTRY_FROM, INSPECTOR_WORKER_ENTRY_TO);
	writePatch(target, `${next}\n${INSPECTOR_WORKER_BRIDGE_SOURCE}`);
	_trace(`[bun-preload] Patch 13: inspector CDP 桥（worker 侧）applied to ${target}`);
}

// ── Patch 14: inspector 主线程的 CDP 桥服务端（#61，与 Patch 13 配对）──
// HostInspectorSource 的 port1 消息泵在 queries.receive 之前认领桥请求帧。服务端在主线程
// 用 node:vm.runInThisContext 把 expression 直接当 script 跑（script 完成值=最后一个
// 表达式的值，与 Chrome CDP 原始语义一致；不能包 IIFE——函数体裸表达式语句不产生
// 返回值）；thenable 且请求带 awaitPromise 时由服务端补 await（30s 封顶）。
// 预览用 util.inspect 有界序列化；堆快照用 v8.getHeapSnapshot() 读成 UTF-8 分块数组一次
// 回传，由 Patch 13 在 worker 侧转成 addHeapSnapshotChunk 事件流。
// 同文件多补丁：Patch 12 先写过 index.js，文件里已有 rev 指纹，所以这里只认自己的 mark，
// 不用 hasCurrentRev 判幂等（否则被 Patch 12 的指纹短路，永远打不上）。
const INSPECTOR_HOST_BRIDGE_MARK = 'bun-preload: inspector CDP 桥（主线程侧）';
const INSPECTOR_HOST_DISPATCH_FROM = '\t\t\t\tif (this.queries.receive(value)) return;';
const INSPECTOR_HOST_DISPATCH_TO = [
	`\t\t\t\tif (__dshInspectorCdpBridgeServe(value, this)) return; // ${REV_MARK} ${INSPECTOR_HOST_BRIDGE_MARK}`,
	'\t\t\t\tif (this.queries.receive(value)) return;',
].join('\n');
const INSPECTOR_HOST_BRIDGE_SOURCE = [
	`// ${REV_MARK} ${INSPECTOR_HOST_BRIDGE_MARK}`,
	'const DSH_CDP_BRIDGE_HOST = {',
	'\tframeRequest: "dsh-cdp/request",',
	'\tframeResponse: "dsh-cdp/response",',
	'\tobjects: new Map(),',
	'\tgroups: new Map(),',
	'\tseq: 0,',
	'\tvmModule: void 0,',
	'\tutilModule: void 0,',
	'\treceive(value, source) {',
	'\t\tif (typeof value !== "object" || value === null || value.t !== this.frameRequest) return false;',
	'\t\tthis.serve(value).then(',
	'\t\t\t(payload) => source.port.postMessage({ v: 0, t: this.frameResponse, requestId: value.requestId, ok: true, payload }),',
	'\t\t\t(error) => source.port.postMessage({ v: 0, t: this.frameResponse, requestId: value.requestId, ok: false, error: error instanceof Error ? error.message : String(error) })',
	'\t\t);',
	'\t\treturn true;',
	'\t},',
	'\tasync serve(request) {',
	'\t\tconst params = request.params ?? {};',
	'\t\tswitch (request.op) {',
	'\t\t\tcase "evaluate": return await this.evaluate(params);',
	'\t\t\tcase "callFunctionOn": return await this.callFunctionOn(params);',
	'\t\t\tcase "awaitPromise": return await this.awaitPromise(params);',
	'\t\t\tcase "getProperties": return this.getProperties(params);',
	'\t\t\tcase "globalLexicalScopeNames": return { result: [] };',
	'\t\t\tcase "releaseObject":',
	'\t\t\t\tthis.objects.delete(params.objectId);',
	'\t\t\t\treturn {};',
	'\t\t\tcase "releaseObjectGroup": {',
	'\t\t\t\tconst bucket = this.groups.get(params.objectGroup);',
	'\t\t\t\tif (bucket !== void 0) { this.groups.delete(params.objectGroup); for (const objectId of bucket) this.objects.delete(objectId); }',
	'\t\t\t\treturn {};',
	'\t\t\t}',
	'\t\t\tcase "takeHeapSnapshot": return await this.takeHeapSnapshot();',
	'\t\t\tdefault: throw new Error(`unsupported bridge op: ${request.op}`);',
	'\t\t}',
	'\t},',
	'\tasync load(name) {',
	'\t\tif (name === "vm") return this.vmModule ??= await import("node:vm");',
	'\t\tif (name === "util") return this.utilModule ??= await import("node:util");',
	'\t\tif (name === "v8") return await import("node:v8");',
	'\t\tthrow new Error(`bridge module: ${name}`);',
	'\t},',
	'\tasync withTimeout(task, ms, label) {',
	'\t\tlet timer;',
	'\t\ttry {',
	'\t\t\treturn await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); })]);',
	'\t\t} finally { clearTimeout(timer); }',
	'\t},',
	'\tasync evaluate(params) {',
	'\t\tconst expression = typeof params.expression === "string" ? params.expression : "";',
	'\t\tif (expression === "") throw new Error("bridge evaluate: expression is required");',
	'\t\tlet task;',
	'\t\ttry {',
	'\t\t\tconst vm = await this.load("vm");',
	'\t\t\t// 直接当 script 跑：script 完成值=最后一个表达式的值，与 Chrome CDP 原始语义一致；',
	'\t\t\t// 不能包 IIFE——函数体里的裸表达式语句不产生返回值（曾误诊为 Bun vm 丢值）。',
	'\t\t\ttask = vm.runInThisContext(expression, { timeout: 4000 });',
	'\t\t} catch (error) {',
	'\t\t\treturn this.thrown(error);',
	'\t\t}',
	'\t\ttry {',
	'\t\t\tconst thenable = task !== void 0 && task !== null && typeof task.then === "function";',
	'\t\t\tconst value = thenable && params.awaitPromise === true ? await this.withTimeout(task, 30000, "bridge evaluate") : task;',
	'\t\t\tconst result = { result: this.remoteObject(value) };',
	'\t\t\tif (params.generatePreview === true && result.result.type === "object") {',
	'\t\t\t\tconst inner = this.lookup(result.result.objectId);',
	'\t\t\t\tif (inner !== void 0) result.result.preview = this.preview(inner);',
	'\t\t\t}',
	'\t\t\treturn result;',
	'\t\t} catch (error) {',
	'\t\t\treturn this.thrown(error);',
	'\t\t}',
	'\t},',
	'\tasync callFunctionOn(params) {',
	'\t\tconst declaration = typeof params.functionDeclaration === "string" ? params.functionDeclaration : "";',
	'\t\tif (declaration === "") throw new Error("bridge callFunctionOn: functionDeclaration is required");',
	'\t\tconst receiver = this.lookup(params.objectId);',
	'\t\tif (receiver === void 0) throw new Error("bridge callFunctionOn: unknown objectId");',
	'\t\tlet fn;',
	'\t\ttry {',
	'\t\t\tconst vm = await this.load("vm");',
	'\t\t\tfn = vm.runInThisContext(`(${declaration})`, { timeout: 4000 });',
	'\t\t} catch (error) {',
	'\t\t\treturn this.thrown(error);',
	'\t\t}',
	'\t\tif (typeof fn !== "function") return this.thrown(new Error("bridge callFunctionOn: declaration is not a function"));',
	'\t\ttry {',
	'\t\t\tconst args = (Array.isArray(params.arguments) ? params.arguments : []).map((argument) => this.argumentValue(argument));',
	'\t\t\tconst value = await this.withTimeout(Promise.resolve(fn.apply(receiver, args)), 30000, "bridge callFunctionOn");',
	'\t\t\treturn { result: params.returnByValue === true ? this.byValue(value) : this.remoteObject(value) };',
	'\t\t} catch (error) {',
	'\t\t\treturn this.thrown(error);',
	'\t\t}',
	'\t},',
	'\tasync awaitPromise(params) {',
	'\t\tconst target = this.lookup(params.promiseObjectId);',
	'\t\tif (target === void 0) throw new Error("bridge awaitPromise: unknown objectId");',
	'\t\ttry {',
	'\t\t\tconst value = await this.withTimeout(Promise.resolve(target), 30000, "bridge awaitPromise");',
	'\t\t\treturn { result: params.returnByValue === true ? this.byValue(value) : this.remoteObject(value) };',
	'\t\t} catch (error) {',
	'\t\t\treturn this.thrown(error);',
	'\t\t}',
	'\t},',
	'\tgetProperties(params) {',
	'\t\tconst target = this.lookup(params.objectId);',
	'\t\t// 已回收/未知句柄报错而不是伪装空对象，让 DevTools 刷新它的句柄表。',
	'\t\tif (target === void 0) throw new Error("bridge getProperties: unknown objectId");',
	'\t\tconst accessorsOnly = params.accessorPropertiesOnly === true;',
	'\t\tconst records = [];',
	'\t\tfor (const name of Reflect.ownKeys(target)) {',
	'\t\t\tlet descriptor;',
	'\t\t\ttry { descriptor = Reflect.getOwnPropertyDescriptor(target, name); } catch { continue; }',
	'\t\t\tif (descriptor === void 0) continue;',
	'\t\t\tconst isAccessor = descriptor.get !== void 0 || descriptor.set !== void 0;',
	'\t\t\tif (accessorsOnly && !isAccessor) continue;',
	'\t\t\tconst record = {',
	'\t\t\t\tname: typeof name === "symbol" ? name.description ?? "" : String(name),',
	'\t\t\t\tconfigurable: descriptor.configurable === true,',
	'\t\t\t\tenumerable: descriptor.enumerable === true',
	'\t\t\t};',
	'\t\t\tif (!isAccessor) record.value = this.remoteObject(descriptor.value);',
	'\t\t\tif (descriptor.get !== void 0) record.get = this.remoteObject(descriptor.get);',
	'\t\t\tif (descriptor.set !== void 0) record.set = this.remoteObject(descriptor.set);',
	'\t\t\tif (typeof name === "symbol") record.symbol = this.remoteObject(name);',
	'\t\t\tif (params.generatePreview === true && record.value?.type === "object") {',
	'\t\t\t\tconst inner = this.lookup(record.value.objectId);',
	'\t\t\t\tif (inner !== void 0) record.value.preview = this.preview(inner);',
	'\t\t\t}',
	'\t\t\trecords.push(record);',
	'\t\t}',
	'\t\treturn { result: records };',
	'\t},',
	'\tasync takeHeapSnapshot() {',
	'\t\tconst v8 = await this.load("v8");',
	'\t\tconst chunks = [];',
	'\t\tfor await (const chunk of v8.getHeapSnapshot()) chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));',
	'\t\treturn { chunks };',
	'\t},',
	'\targumentValue(argument) {',
	'\t\tif (argument === void 0 || argument === null) return void 0;',
	'\t\tif (typeof argument.objectId === "string") {',
	'\t\t\tconst target = this.lookup(argument.objectId);',
	'\t\t\tif (target === void 0) throw new Error(`bridge argument: unknown objectId ${argument.objectId}`);',
	'\t\t\treturn target;',
	'\t\t}',
	'\t\treturn argument.value;',
	'\t},',
	'\tregister(value, group) {',
	'\t\tif (this.objects.size >= 4096) {',
	'\t\t\t// 上界清扫：先剔死引用，仍超限则按插入序逐出最老句柄（长会话防无界增长）。',
	'\t\t\tfor (const [objectId, entry] of this.objects) { if (entry.ref.deref() === void 0) this.objects.delete(objectId); }',
	'\t\t\tfor (const objectId of this.objects.keys()) { if (this.objects.size < 4096) break; this.objects.delete(objectId); }',
	'\t\t}',
	'\t\tconst objectId = `dsh-bridge-object-${++this.seq}`;',
	'\t\tthis.objects.set(objectId, { ref: new WeakRef(value), group: typeof group === "string" ? group : void 0 });',
	'\t\tif (typeof group === "string") {',
	'\t\t\tlet bucket = this.groups.get(group);',
	'\t\t\tif (bucket === void 0) this.groups.set(group, bucket = new Set());',
	'\t\t\tbucket.add(objectId);',
	'\t\t}',
	'\t\treturn objectId;',
	'\t},',
	'\tlookup(objectId) {',
	'\t\tif (typeof objectId !== "string") return void 0;',
	'\t\tconst entry = this.objects.get(objectId);',
	'\t\tif (entry === void 0) return void 0;',
	'\t\tconst target = entry.ref.deref();',
	'\t\tif (target === void 0) { this.objects.delete(objectId); return void 0; }',
	'\t\treturn target;',
	'\t},',
	'\tremoteObject(value) {',
	'\t\tif (value === void 0) return { type: "undefined" };',
	'\t\tif (value === null) return { type: "object", subtype: "null", value: null };',
	'\t\tswitch (typeof value) {',
	'\t\t\tcase "string": return { type: "string", value, description: value.length > 200 ? `${value.slice(0, 200)}…` : value };',
	'\t\t\tcase "number": return { type: "number", value, description: String(value) };',
	'\t\t\tcase "boolean": return { type: "boolean", value, description: String(value) };',
	'\t\t\tcase "bigint": return { type: "bigint", value: value.toString(), unserializableValue: `${value}n`, description: `${value}n` };',
	'\t\t\tcase "symbol": return { type: "symbol", description: value.toString() };',
	'\t\t\tcase "function": return { type: "function", objectId: this.register(value), className: "Function", description: String(value).slice(0, 200) };',
	'\t\t\tdefault: {',
	'\t\t\t\tconst record = { type: "object", objectId: this.register(value), className: this.className(value), description: this.describe(value) };',
	'\t\t\t\tif (Array.isArray(value)) record.subtype = "array";',
	'\t\t\t\tif (value instanceof Error) record.subtype = "error";',
	'\t\t\t\treturn record;',
	'\t\t\t}',
	'\t\t}',
	'\t},',
	'\tpreview(target) {',
	'\t\tlet names;',
	'\t\ttry { names = Reflect.ownKeys(target); } catch { names = []; }',
	'\t\tconst properties = [];',
	'\t\tlet overflow = false;',
	'\t\tfor (const name of names) {',
	'\t\t\tif (properties.length >= 50) { overflow = true; break; }',
	'\t\t\tlet descriptor;',
	'\t\t\ttry { descriptor = Reflect.getOwnPropertyDescriptor(target, name); } catch { continue; }',
	'\t\t\tif (descriptor === void 0 || descriptor.enumerable !== true) continue;',
	'\t\t\tif ("value" in descriptor) {',
	'\t\t\t\tconst item = this.remoteObject(descriptor.value);',
	'\t\t\t\tconst slot = { name: String(name), type: item.type };',
	'\t\t\t\tif (item.subtype !== void 0) slot.subtype = item.subtype;',
	'\t\t\t\tif (item.className !== void 0) slot.className = item.className;',
	'\t\t\t\tif (item.description !== void 0) slot.description = item.description;',
	'\t\t\t\tproperties.push(slot);',
	'\t\t\t} else {',
	'\t\t\t\tproperties.push({ name: String(name), type: "accessor" });',
	'\t\t\t}',
	'\t\t}',
	'\t\treturn { type: "object", description: this.describe(target), overflow, properties };',
	'\t},',
	'\tbyValue(value) {',
	'\t\tconst record = this.remoteObject(value);',
	'\t\tif (record.type === "object" && record.subtype !== "null" && record.subtype !== "error") {',
	'\t\t\ttry { record.value = JSON.parse(JSON.stringify(value)); } catch {}',
	'\t\t}',
	'\t\treturn record;',
	'\t},',
	'\tthrown(error) {',
	'\t\treturn { result: { type: "undefined" }, exceptionDetails: { exceptionId: 1, text: "Uncaught", lineNumber: 0, columnNumber: 0, exception: this.remoteObject(error) } };',
	'\t},',
	'\tclassName(value) {',
	'\t\tif (Array.isArray(value)) return "Array";',
	'\t\tconst constructor = value.constructor;',
	'\t\treturn typeof constructor === "function" && constructor.name !== "" ? constructor.name : "Object";',
	'\t},',
	'\tdescribe(value) {',
	'\t\ttry { return this.utilModule.inspect(value, { depth: 1, maxArrayLength: 40, breakLength: 120, getters: false }); } catch {}',
	'\t\ttry { return String(value); } catch {}',
	'\t\treturn Object.prototype.toString.call(value);',
	'\t}',
	'};',
	'let __dshInspectorCdpBridgeReady = void 0;',
	'function __dshInspectorCdpBridgeServe(value, source) {',
	'\tif (typeof Bun === "undefined") return false;',
	'\t// 只认领桥请求帧：worker 的 query 应答与 source 帧必须原样放行给原消息泵。',
	'\tif (typeof value !== "object" || value === null || value.t !== DSH_CDP_BRIDGE_HOST.frameRequest) return false;',
	'\t__dshInspectorCdpBridgeReady ??= Promise.all([DSH_CDP_BRIDGE_HOST.load("vm"), DSH_CDP_BRIDGE_HOST.load("util")]).then(() => void 0);',
	'\t__dshInspectorCdpBridgeReady.then(() => { DSH_CDP_BRIDGE_HOST.receive(value, source); });',
	'\treturn true;',
	'}',
	''
].join('\n');
for (const target of packageTargets('@deepseek-ai/dsh-experimental-inspector/lib/index.js')) {
	const source = readFileSync(target, 'utf8');
	if (source.includes(INSPECTOR_HOST_BRIDGE_MARK)) {
		refreshBridgeFingerprint('Patch 14', target, source);
		continue;
	}
	if (!source.includes(INSPECTOR_HOST_DISPATCH_FROM)) {
		console.warn(`[bun-preload] Patch 14: 未找到上游 port1 消息泵文本，跳过 ${target}（上游版本不符）`);
		continue;
	}
	writePatch(target, `${source.replace(INSPECTOR_HOST_DISPATCH_FROM, INSPECTOR_HOST_DISPATCH_TO)}\n${INSPECTOR_HOST_BRIDGE_SOURCE}`);
	_trace(`[bun-preload] Patch 14: inspector CDP 桥（主线程侧）applied to ${target}`);
}

// ── Patch 15: PTC worker 继承控制通道（Bun fd 7）──
// Bun 的 net.Socket({ fd }) 不能接管继承的已连接 socket fd：构造时 fd 被关掉，
// 第一次写 ready 帧就在 uncork() 抛 ERR_SOCKET_CLOSED（Bun 1.3.14/1.4.0 实测）。
// PTC worker 由宿主 executable 启动；桌面壳宿主是 Bun 时 worker 也是 Bun，必中。
// Node 保持原 net.Socket 路径；Bun（非 Windows）用 fs.read/fs.write/fs.close 包一个 Duplex。
const PTC_CONTROL_MARK = 'bun-preload: PTC worker 控制通道（Bun fd 7）';
const PTC_CONTROL_ANCHOR = /return new Socket\(\{\s+fd: 7,\s+readable: true,\s+writable: true,\s+allowHalfOpen: true\s+\}\);/;
const PTC_CONTROL_GUARD = [
  `  // ${REV_MARK} ${PTC_CONTROL_MARK}`,
  '  // Windows 的 fd 7 继承通道行为未验证，先保留上游 net.Socket；',
  '  if (typeof Bun !== "undefined" && process.platform !== "win32") return __dshOpenBunInheritedControlChannel();',
  '  return new Socket({',
  '    fd: 7,',
  '    readable: true,',
  '    writable: true,',
  '    allowHalfOpen: true',
  '  });',
].join('\n');
const PTC_CONTROL_IMPORT_ANCHOR = 'import { Socket } from "node:net";';
const PTC_CONTROL_IMPORTS = [
  'import { Duplex as __dshBunDuplex } from "node:stream";',
  'import { read as __dshBunFsRead, write as __dshBunFsWrite, close as __dshBunFsClose } from "node:fs";',
].join('\n');
const PTC_CONTROL_HELPER = [
  `// ${REV_MARK} ${PTC_CONTROL_MARK}`,
  '// Bun 的 net.Socket({fd}) 不能接管继承的已连接 socket fd（构造时 fd 被关掉，',
  '// 首次写 ready 帧即 ERR_SOCKET_CLOSED）。用 fs.read/write/close 包一个 Duplex，',
  '// 保留 write(callback)/cork()/uncork()/data/end/error/off()/destroy() 语义。',
  'function __dshBunIsWouldBlock(error) { return error.code === "EAGAIN" || error.code === "EWOULDBLOCK"; }',
  'function __dshOpenBunInheritedControlChannel() {',
  '  const stream = new __dshBunDuplex({',
  '    allowHalfOpen: true,',
  '    read() {',
  '      if (this.__dshreading || this.destroyed) return;',
  '      this.__dshreading = true;',
  '      const buffer = Buffer.allocUnsafe(65536);',
  '      __dshBunFsRead(this.__dshfd, buffer, 0, buffer.length, null, (error, bytes) => {',
  '        this.__dshreading = false;',
  '        if (this.destroyed) return;',
  '        if (error) {',
  '          if (__dshBunIsWouldBlock(error)) { setTimeout(() => this.read(), 5); return; }',
  '          this.destroy(error);',
  '          return;',
  '        }',
  '        if (bytes === 0) { this.push(null); return; }',
  '        this.push(buffer.subarray(0, bytes));',
  '      });',
  '    },',
  '    write(chunk, _encoding, callback) {',
  '      let offset = 0;',
  '      const step = () => {',
  '        if (offset >= chunk.length) { callback(); return; }',
  '        __dshBunFsWrite(this.__dshfd, chunk, offset, chunk.length - offset, null, (error, bytes) => {',
  '          if (error) {',
  '            if (__dshBunIsWouldBlock(error)) { setTimeout(step, 5); return; }',
  '            callback(error);',
  '            return;',
  '          }',
  '          if (bytes === 0) { callback(new Error("PTC control channel: write returned 0 bytes")); return; }',
  '          offset += bytes;',
  '          step();',
  '        });',
  '      };',
  '      step();',
  '    },',
  '    destroy(error, callback) {',
  '      if (this.__dshclosed) { callback(error); return; }',
  '      this.__dshclosed = true;',
  '      __dshBunFsClose(this.__dshfd, () => callback(error));',
  '    },',
  '  });',
  '  stream.__dshfd = 7;',
  '  stream.__dshreading = false;',
  '  stream.__dshclosed = false;',
  '  return stream;',
  '}',
  '',
].join('\n');
function patchPtcControlEntry(relativePath) {
  for (const target of packageTargets(relativePath)) {
    const source = readFileSync(target, 'utf8');
    if (source.includes(PTC_CONTROL_MARK)) {
      refreshBridgeFingerprint('Patch 15', target, source);
      continue;
    }
    if (!PTC_CONTROL_ANCHOR.test(source) || !source.includes(PTC_CONTROL_IMPORT_ANCHOR)) {
      console.warn(`[bun-preload] Patch 15: 未找到上游 PTC 控制通道的 net.Socket 文本，跳过 ${target}（上游版本不符）`);
      continue;
    }
    const guarded = source
      .replace(PTC_CONTROL_IMPORT_ANCHOR, `${PTC_CONTROL_IMPORT_ANCHOR}\n${PTC_CONTROL_IMPORTS}`)
      .replace(PTC_CONTROL_ANCHOR, PTC_CONTROL_GUARD);
    writePatch(target, `${guarded}\n${PTC_CONTROL_HELPER}`);
    _trace(`[bun-preload] Patch 15: PTC worker 控制通道（Bun fd 7）applied to ${target}`);
  }
}
patchPtcControlEntry('@deepseek-ai/dsh-ptc-runtime-node/lib/process.js');
patchPtcControlEntry('@deepseek-ai/dsh-ptc-runtime-node/lib/persistent-process.js');

// ── Patch 16: inspector Client bootstrap 有界退避重试 + F7 可观测性（#68）──
// 缘起：#68 首载快捷键静默失效。alpha.2 宿主把 bootstrap 路由排在 startInspector()
// 之后，Worker 起得慢时首载 fetch 拿到 404；客户端 readBootstrap() 仅 warn 一次、
// 无重试，唯一补发机会是 connection/reset（rc.2 已修宿主侧，此处兜客户端）。
// 另：replace() 里 ctx.inject 的注册回调没有被 await（F7），失败时一行日志都不留，
// 面板与快捷键纯静默失效；这里补一条 warn。上游文本没命中只警告，不报错。
const INSPECTOR_BOOTSTRAP_RETRY_MARK = 'bun-preload: bootstrap 有界退避重试';
const INSPECTOR_BOOTSTRAP_RETRY_DELAYS = [250, 500, 1000, 2000, 4000, 8000];
const INSPECTOR_BOOTSTRAP_FETCH_FROM = [
  '\t\t\t\t\tresponse = await fetch(INSPECTOR_BOOTSTRAP_ROUTE, { signal: this.lifetime.signal });',
  '\t\t\t\t} catch (error) {',
  '\t\t\t\t\tthis.connectionFailed(error);',
  '\t\t\t\t\treturn;',
  '\t\t\t\t}',
].join('\n');
const INSPECTOR_BOOTSTRAP_FETCH_TO = [
  '\t\t\t\t\tresponse = await fetch(INSPECTOR_BOOTSTRAP_ROUTE, { signal: this.lifetime.signal });',
  '\t\t\t\t} catch (error) {',
  '\t\t\t\t\tawait this.retryBootstrap(error);',
  '\t\t\t\t\treturn;',
  '\t\t\t\t}',
].join('\n');
const INSPECTOR_BOOTSTRAP_NOT_OK_FROM = [
  '\t\t\t\tif (!response.ok) {',
  '\t\t\t\t\tthis.connectionFailed(/* @__PURE__ */ new Error(`Inspector bootstrap failed: HTTP ${response.status}`));',
  '\t\t\t\t\treturn;',
  '\t\t\t\t}',
].join('\n');
const INSPECTOR_BOOTSTRAP_NOT_OK_TO = [
  '\t\t\t\tif (!response.ok) {',
  '\t\t\t\t\tawait this.retryBootstrap(/* @__PURE__ */ new Error(`Inspector bootstrap failed: HTTP ${response.status}`));',
  '\t\t\t\t\treturn;',
  '\t\t\t\t}',
].join('\n');
const INSPECTOR_BOOTSTRAP_INJECT_FROM = [
  '\t\t\t\t\t\tconst { registerInspectorPage } = await require.async("./client.page.js");',
  '\t\t\t\t\t\tregisterInspectorPage(ctx, source.sourceId);',
].join('\n');
const INSPECTOR_BOOTSTRAP_INJECT_TO = [
  '\t\t\t\t\t\ttry {',
  '\t\t\t\t\t\t\tconst { registerInspectorPage } = await require.async("./client.page.js");',
  '\t\t\t\t\t\t\tregisterInspectorPage(ctx, source.sourceId);',
  '\t\t\t\t\t\t} catch (error) {',
  '\t\t\t\t\t\t\tthis.ctx.logger.warn("experimental-inspector: Client page registration failed; inspector panel and shortcut are unavailable", error);',
  '\t\t\t\t\t\t\tthrow error;',
  '\t\t\t\t\t\t}',
].join('\n');
const INSPECTOR_CONNECTION_FAILED_ANCHOR = '\t\t\tconnectionFailed(error) {';
const INSPECTOR_BOOTSTRAP_RETRY_METHOD = [
  `\t\t\t// ${REV_MARK} ${INSPECTOR_BOOTSTRAP_RETRY_MARK}（#68：首载 bootstrap 失败时补齐补发机会）`,
  '\t\t\tasync retryBootstrap(lastError) {',
  `\t\t\t\tconst delays = ${JSON.stringify(INSPECTOR_BOOTSTRAP_RETRY_DELAYS)};`,
  '\t\t\t\tfor (const delay of delays) {',
  '\t\t\t\t\tif (this.lifetime.signal.aborted) return;',
  '\t\t\t\t\tawait new Promise((resolve) => setTimeout(resolve, delay));',
  '\t\t\t\t\tif (this.lifetime.signal.aborted) return;',
  '\t\t\t\t\ttry {',
  '\t\t\t\t\t\tconst response = await fetch(INSPECTOR_BOOTSTRAP_ROUTE, { signal: this.lifetime.signal });',
  '\t\t\t\t\t\tif (!response.ok) {',
  '\t\t\t\t\t\t\tlastError = /* @__PURE__ */ new Error(`Inspector bootstrap failed: HTTP ${response.status}`);',
  '\t\t\t\t\t\t\tcontinue;',
  '\t\t\t\t\t\t}',
  '\t\t\t\t\t\tconst value = await response.json();',
  '\t\t\t\t\t\tawait this.replace(parseInspectorClientBootstrap(value));',
  '\t\t\t\t\t\treturn;',
  '\t\t\t\t\t} catch (error) {',
  '\t\t\t\t\t\tif (this.lifetime.signal.aborted) return;',
  '\t\t\t\t\t\tlastError = error;',
  '\t\t\t\t\t}',
  '\t\t\t\t}',
  '\t\t\t\tif (this.lifetime.signal.aborted) return;',
  '\t\t\t\tthis.ctx.logger.warn(`experimental-inspector: Client connection failed after ${delays.length + 1} attempts; reconnect or reload the page to retry`, lastError);',
  '\t\t\t}',
].join('\n');
function patchInspectorBootstrapRetry() {
  for (const target of packageTargets('@deepseek-ai/dsh-experimental-inspector/lib/client.js')) {
    const source = readFileSync(target, 'utf8');
    if (source.includes(INSPECTOR_BOOTSTRAP_RETRY_MARK)) {
      refreshBridgeFingerprint('Patch 16', target, source);
      continue;
    }
    if (
      !source.includes(INSPECTOR_BOOTSTRAP_FETCH_FROM) ||
      !source.includes(INSPECTOR_BOOTSTRAP_NOT_OK_FROM) ||
      !source.includes(INSPECTOR_BOOTSTRAP_INJECT_FROM) ||
      !source.includes(INSPECTOR_CONNECTION_FAILED_ANCHOR)
    ) {
      console.warn(`[bun-preload] Patch 16: 未找到上游 Client bootstrap 失败分支文本，跳过 ${target}（上游版本不符）`);
      continue;
    }
    const patched = source
      .replace(INSPECTOR_BOOTSTRAP_FETCH_FROM, INSPECTOR_BOOTSTRAP_FETCH_TO)
      .replace(INSPECTOR_BOOTSTRAP_NOT_OK_FROM, INSPECTOR_BOOTSTRAP_NOT_OK_TO)
      .replace(INSPECTOR_BOOTSTRAP_INJECT_FROM, INSPECTOR_BOOTSTRAP_INJECT_TO)
      .replace(INSPECTOR_CONNECTION_FAILED_ANCHOR, `${INSPECTOR_BOOTSTRAP_RETRY_METHOD}\n${INSPECTOR_CONNECTION_FAILED_ANCHOR}`);
    writePatch(target, patched);
    _trace(`[bun-preload] Patch 16: inspector Client bootstrap 退避重试（${INSPECTOR_BOOTSTRAP_RETRY_DELAYS.length} 次）applied to ${target}`);
  }
}
patchInspectorBootstrapRetry();

_trace(`[bun-preload] ${REV_MARK} 应用完成：stripTypeScriptTypes / node-addon-require-builtin 桩 / HMR 关闭 / Bun.Terminal PTY / xterm 同步写 / 插件展示元数据解析 / 插件说明符 baseUrl 解析 / inspector fetch 归一+spread 修复 / inspector CDP 桥 / PTC worker 控制通道 / inspector Client bootstrap 退避重试 + F7 可观测性（不还原）`);
