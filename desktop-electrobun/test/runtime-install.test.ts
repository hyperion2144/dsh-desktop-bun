// 运行时下载安装的单测：进度解析、错误尾巴、pnpm.cjs 定位、node 垫片、装树流程与单飞状态机。
//
// 装树流程用假 spawn 驱动（不真跑 pnpm）：假 spawn 负责「写出一棵合法的运行时树 + 打进度行 + 退出」，
// 于是这条链上的每个判定（工作区文件内容、进度、失败清理、成功判据、超时）都能在毫秒级验到。

import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  OUTPUT_TAIL_LINES,
  createRuntimeDownloader,
  ensureNodeShim,
  ensureShimDir,
  installRuntime,
  RuntimeInstallCancelledError,
  nodeShimScript,
  parsePnpmProgress,
  pickInstallerErrorTail,
  pnpmShimScript,
  resolvePnpmCjs,
  shimCmdScript,
  tailLines,
  withRuntimeDownloadNotify,
} from '../src/bun/runtime-install.ts'
import { runtimeDirOf } from '../src/bun/runtime-store.ts'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-rt-install-')))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/** 在 appSupport 下造一棵合法的运行时树（真判据：node_modules/@deepseek-ai/dsh/lib/bin.js 是文件） */
function writeRuntimeTree(dir: string): void {
  const bin = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'bin.js'), '// stub\n')
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>
}

interface FakeSpawnResult {
  calls: Array<{ command: string[]; options: Record<string, unknown> }>
  spawnImpl: (command: string[], options: Record<string, unknown>) => {
    exited: Promise<number>
    stdout?: ReadableStream<Uint8Array> | null
    stderr?: ReadableStream<Uint8Array> | null
    kill?: () => void
  }
}

/**
 * 假 spawn：按脚本回调模拟 pnpm。
 * `onRun` 能在退出前写文件/记账；返回的 exit code 就是 `exited` 的结果。
 */
function fakeSpawn(onRun: (input: { dir: string; command: string[]; env: Record<string, string> }) => { code: number; stdout?: string; stderr?: string }): FakeSpawnResult {
  const calls: FakeSpawnResult['calls'] = []
  return {
    calls,
    spawnImpl: (command, options) => {
      calls.push({ command, options })
      const cwd = String(options.cwd ?? '')
      const env = (options.env ?? {}) as Record<string, string>
      const result = onRun({ dir: cwd, command, env })
      return {
        exited: Promise.resolve(result.code),
        stdout: streamOf(result.stdout ?? ''),
        stderr: streamOf(result.stderr ?? ''),
      }
    },
  }
}

describe('parsePnpmProgress', () => {
  test('标准进度行与千分位逗号', () => {
    expect(parsePnpmProgress('Progress: resolved 1,234, downloaded 56, added 7')).toEqual({
      resolved: 1234,
      downloaded: 56,
      added: 7,
    })
  })

  test('pnpm 11 的格式（多一段 reused）也认，尾部 done 不影响', () => {
    expect(parsePnpmProgress('Progress: resolved 1, reused 0, downloaded 1, added 1, done')).toEqual({
      resolved: 1,
      downloaded: 1,
      added: 1,
    })
    expect(parsePnpmProgress('Progress: resolved 1,234, reused 900, downloaded 56, added 7')?.downloaded).toBe(56)
  })

  test('非进度行回 null（包括 pnpm 的错误行与空行）', () => {
    expect(parsePnpmProgress('ERR_PNPM_NO_MATCHING_VERSION')).toBeNull()
    expect(parsePnpmProgress('')).toBeNull()
    expect(parsePnpmProgress('Progress: resolved 1, downloaded 0')).toBeNull()
  })

  test('行尾还有别的内容也认得（非 TTY 下 pnpm 会拼在同一行）', () => {
    expect(parsePnpmProgress('Progress: resolved 12, downloaded 3, added 1 done')?.added).toBe(1)
  })
})

describe('错误尾巴', () => {
  test('去噪：node 的 TLS 告警与 (node:N) Warning 行不算内容', () => {
    const stderr = "(node:1) Warning: NODE_TLS_REJECT_UNAUTHORIZED set to 0\nERR_PNPM_UNEXPECTED_STORE store mismatch"
    expect(tailLines(stderr)).toBe('ERR_PNPM_UNEXPECTED_STORE store mismatch')
  })

  test('去噪：pnpm default reporter 的 ANSI 光标码也从报错里剔掉', () => {
    const stderr = '\u001b[1A\u001b[KERR_PNPM_UNEXPECTED_STORE store mismatch\u001b[0J'
    expect(tailLines(stderr)).toBe('ERR_PNPM_UNEXPECTED_STORE store mismatch')
  })

  test('stderr 有真东西优先用它；只有噪声时回退 stdout（旧壳 #95 Bug 1）', () => {
    expect(pickInstallerErrorTail('ERR_PNPM_UNEXPECTED_STORE', 'whatever')).toContain('UNEXPECTED_STORE')
    const noisyStderr = '(node:1) Warning: NODE_TLS_REJECT_UNAUTHORIZED set to 0'
    // stdout 里真正的进度行由 installRuntime 自己吞掉，这里只验「噪声 stderr 不挡 stdout 尾巴」
    const fallback = pickInstallerErrorTail(
      noisyStderr,
      'Progress: resolved 1, downloaded 0, added 0\nERR_PNPM_NO_MATCHING_VERSION',
    )
    expect(fallback).toContain('ERR_PNPM_NO_MATCHING_VERSION')
  })

  test('只留尾部 N 行（默认 12）', () => {
    const text = Array.from({ length: 30 }, (_, index) => `line-${String(index)}`).join('\n')
    const tail = tailLines(text)
    expect(tail.split('\n')).toHaveLength(OUTPUT_TAIL_LINES)
    expect(tail.startsWith('line-18')).toBe(true)
    expect(tail.endsWith('line-29')).toBe(true)
  })
})

describe('node 垫片', () => {
  test('系统里有 node 就不插手', () => {
    expect(ensureNodeShim({ appSupport: tempDir(), bunPath: '/bin/bun', hasNode: true })).toBeNull()
  })

  test('没有 node 时写一个可执行的 node → Bun 垫片', () => {
    const appSupport = tempDir()
    const dir = ensureNodeShim({ appSupport, bunPath: '/opt/bun', hasNode: false })
    expect(dir).toBe(join(appSupport, 'runtimes', '.node-shim'))
    expect(readFileSync(join(dir as string, 'node'), 'utf8')).toBe(nodeShimScript('/opt/bun'))
    expect(nodeShimScript('/opt/bun')).toStartWith('#!/bin/sh\nexec "/opt/bun" "$@"')
  })
})

describe('宿主 PATH 垫片（#70）', () => {
  test('pnpm 垫片脚本：POSIX 形态 exec bun pnpm.cjs "$@"', () => {
    expect(pnpmShimScript('/bin/bun', '/x/pnpm.cjs')).toBe('#!/bin/sh\nexec "/bin/bun" "/x/pnpm.cjs" "$@"\n')
  })

  test('cmd 垫片脚本：node 与 pnpm 两形态（Windows 的 execa 经 cmd.exe 找 .cmd）', () => {
    expect(shimCmdScript('/bin/bun')).toBe('@"/bin/bun" %*\r\n@exit /b %ERRORLEVEL%\r\n')
    expect(shimCmdScript('/bin/bun', '/x/pnpm.cjs')).toBe('@"/bin/bun" "/x/pnpm.cjs" %*\r\n@exit /b %ERRORLEVEL%\r\n')
  })

  test('ensureShimDir：有 node 也写 pnpm 垫片（宿主要解析到内置 pnpm），node 垫片不插手', () => {
    const appSupport = tempDir()
    const dir = ensureShimDir({ appSupport, bunPath: '/bin/bun', hasNode: true, pnpmCjs: '/x/pnpm.cjs' })
    expect(dir).toBe(join(appSupport, 'runtimes', '.node-shim'))
    expect(readFileSync(join(dir as string, 'pnpm'), 'utf8')).toBe(pnpmShimScript('/bin/bun', '/x/pnpm.cjs'))
    expect(readFileSync(join(dir as string, 'pnpm.cmd'), 'utf8')).toBe(shimCmdScript('/bin/bun', '/x/pnpm.cjs'))
    expect(existsSync(join(dir as string, 'node'))).toBe(false)
  })

  test('ensureShimDir：没 node 时 node 垫片落盘并补 .cmd 形态（Windows 构建脚本也找得到）', () => {
    const appSupport = tempDir()
    const dir = ensureShimDir({ appSupport, bunPath: '/bin/bun', hasNode: false, pnpmCjs: null })
    expect(readFileSync(join(dir as string, 'node'), 'utf8')).toBe(nodeShimScript('/bin/bun'))
    expect(readFileSync(join(dir as string, 'node.cmd'), 'utf8')).toBe(shimCmdScript('/bin/bun'))
    expect(existsSync(join(dir as string, 'pnpm'))).toBe(false)
  })

  test('ensureShimDir：宿主通道 pnpm.cjs 解析不到（null）→ 清掉陈旧 pnpm 垫片（不留死垫片）', () => {
    const appSupport = tempDir()
    const dir = ensureShimDir({ appSupport, bunPath: '/bin/bun', hasNode: true, pnpmCjs: '/x/old.cjs' }) as string
    expect(existsSync(join(dir, 'pnpm'))).toBe(true)
    // 切运行时/删树后解析不到：陈旧垫片必须从盘上消失，否则宿主 PATH 踩到指向已删 pnpm.cjs 的死垫片
    expect(ensureShimDir({ appSupport, bunPath: '/bin/bun', hasNode: true, pnpmCjs: null })).toBeNull()
    expect(existsSync(join(dir, 'pnpm'))).toBe(false)
    expect(existsSync(join(dir, 'pnpm.cmd'))).toBe(false)
  })

  test('ensureShimDir：旧通道（pnpmCjs 缺省）不写也不删 pnpm 垫片（#70 前行为不变）', () => {
    const appSupport = tempDir()
    const dir = ensureShimDir({ appSupport, bunPath: '/bin/bun', hasNode: true, pnpmCjs: '/x/pnpm.cjs' }) as string
    expect(ensureShimDir({ appSupport, bunPath: '/bin/bun', hasNode: true })).toBeNull()
    expect(readFileSync(join(dir, 'pnpm'), 'utf8')).toBe(pnpmShimScript('/bin/bun', '/x/pnpm.cjs'))
  })

  test('pnpm 垫片可执行且参数透传（POSIX：用 /bin/echo 当解释器验证，不依赖真 bun/pnpm）', () => {
    if (process.platform === 'win32') return
    const appSupport = tempDir()
    const dir = ensureShimDir({ appSupport, bunPath: '/bin/echo', hasNode: true, pnpmCjs: '/fake/pnpm.cjs' })
    const proc = Bun.spawnSync([join(dir as string, 'pnpm'), '--version'])
    expect(proc.stdout.toString().trim()).toBe('/fake/pnpm.cjs --version')
  })

  test('.cmd 垫片真机链路：cmd /c pnpm 解析到垫片，参数与退出码都透传（仅 Windows）', () => {
    if (process.platform !== 'win32') return
    const root = tempDir()
    const fixture = join(root, 'fixture-pnpm.cjs')
    writeFileSync(fixture, "if (process.argv[2] === 'fail') process.exit(3)\nconsole.log('SHIM-OK', process.argv.slice(2).join(','))\n")
    const dir = ensureShimDir({ appSupport: root, bunPath: process.execPath, hasNode: true, pnpmCjs: fixture }) as string
    const env = { PATH: `${dir};${process.env.PATH ?? ''}`, SYSTEMROOT: process.env.SYSTEMROOT ?? 'C:\\Windows' }
    const ok = Bun.spawnSync(['cmd', '/c', 'pnpm', 'a', 'b'], { env })
    expect(ok.stdout.toString().trim()).toBe('SHIM-OK a,b')
    expect(ok.exitCode).toBe(0)
    const bad = Bun.spawnSync(['cmd', '/c', 'pnpm', 'fail'], { env })
    expect(bad.exitCode).toBe(3)
  })
})
describe('resolvePnpmCjs', () => {
  test('优先级：显式 env > 当前运行时树 > 内置树 > 任一已下载树', () => {
    const appSupport = tempDir()
    const runtimeRoot = join(tempDir(), 'rt')
    const builtinDir = join(tempDir(), 'builtin')
    const installed = join(appSupport, 'runtimes', '1.2.3')
    for (const root of [runtimeRoot, builtinDir, installed]) {
      mkdirSync(join(root, 'node_modules', 'pnpm', 'bin'), { recursive: true })
      writeFileSync(join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '// pnpm\n')
    }
    const explicit = join(tempDir(), 'mine.cjs')
    writeFileSync(explicit, '// mine\n')

    expect(resolvePnpmCjs({ env: { DSH_SHELL_PNPM: explicit }, runtimeRoot, builtinDir, appSupport })).toBe(explicit)
    expect(resolvePnpmCjs({ env: {}, runtimeRoot, builtinDir, appSupport })).toBe(join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
    expect(resolvePnpmCjs({ env: {}, runtimeRoot: null, builtinDir, appSupport })).toBe(join(builtinDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
    expect(resolvePnpmCjs({ env: {}, runtimeRoot: null, builtinDir: null, appSupport })).toBe(
      join(installed, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    )
    expect(resolvePnpmCjs({ env: {}, runtimeRoot: null, builtinDir: null, appSupport: tempDir() })).toBeNull()
  })

  test('显式 env 指向不存在的文件时不算数（继续往下找）', () => {
    const appSupport = tempDir()
    const builtinDir = join(tempDir(), 'builtin')
    mkdirSync(join(builtinDir, 'node_modules', 'pnpm', 'bin'), { recursive: true })
    writeFileSync(join(builtinDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '// pnpm\n')
    expect(resolvePnpmCjs({ env: { DSH_SHELL_PNPM: '/nope/pnpm.cjs' }, runtimeRoot: null, builtinDir, appSupport })).toBe(
      join(builtinDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    )
  })
})

describe('installRuntime', () => {
  test('版本号不合法直接拒绝', async () => {
    await expect(
      installRuntime({ appSupport: tempDir(), version: 'not-a-version', bunPath: '/bin/bun', pnpmCjs: '/p/pnpm.cjs' }),
    ).rejects.toThrow('版本号不合法')
  })

  test('已装好的版本不重复装', async () => {
    const appSupport = tempDir()
    writeRuntimeTree(join(appSupport, 'runtimes', '0.2.1-alpha.2'))
    await expect(
      installRuntime({ appSupport, version: '0.2.1-alpha.2', bunPath: '/bin/bun', pnpmCjs: '/p/pnpm.cjs' }),
    ).rejects.toThrow('已经装好了')
  })

  test('工作区文件与命令形态：独立 store + packages: [] + hoisted + Bun 跑 pnpm.cjs', async () => {
    const appSupport = tempDir()
    const fake = fakeSpawn(({ dir }) => {
      writeRuntimeTree(dir)
      return { code: 0 }
    })
    await installRuntime({
      appSupport,
      version: '9.9.9',
      bunPath: '/opt/bun',
      pnpmCjs: '/builtin/node_modules/pnpm/bin/pnpm.cjs',
      nodeShimDir: '/shim',
      env: { FOO: 'bar' },
      spawnImpl: fake.spawnImpl,
    })
    const dir = join(appSupport, 'runtimes', '9.9.9')
    const workspace = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace.startsWith('packages: []\n')).toBe(true)
    expect(workspace).toContain('nodeLinker: hoisted')
    // 产物把 storeDir 归一成正斜杠（pnpm 友好），断言跟着归一，Windows 上才对得上
    expect(workspace).toContain(`storeDir: ${join(appSupport, 'runtimes', '.pnpm-store').replace(/\\/g, '/')}`)
    expect(workspace).toContain('allowBuilds:')
    expect(workspace).toContain('node-pty: true')
    expect(readFileSync(join(dir, '.npmrc'), 'utf8')).toBe(
      `node-linker=hoisted\nstore-dir=${join(appSupport, 'runtimes', '.pnpm-store').replace(/\\/g, '/')}\n`,
    )
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual({ name: 'dsh-runtime-9.9.9', private: true })

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.command).toEqual([
      '/opt/bun',
      '/builtin/node_modules/pnpm/bin/pnpm.cjs',
      'add',
      '--reporter=default',
      '@deepseek-ai/dsh@9.9.9',
    ])
    const options = fake.calls[0]?.options ?? {}
    expect(options.cwd).toBe(dir)
    const env = options.env as Record<string, string>
    // 垫片目录接在 PATH 最前，分隔符按平台（Windows 是 `;`）
    expect(env.PATH?.startsWith(`/shim${delimiter}`)).toBe(true)
    expect(env.FOO).toBe('bar')
  })

  test('进度行回调带三个数字（非进度行不进回调）', async () => {
    const appSupport = tempDir()
    const seen: number[] = []
    const fake = fakeSpawn(({ dir }) => {
      writeRuntimeTree(dir)
      return {
        code: 0,
        stdout: 'Progress: resolved 10, downloaded 0, added 0\nsome other line\nProgress: resolved 1,234, downloaded 56, added 7\n',
      }
    })
    await installRuntime({
      appSupport,
      version: '9.9.9',
      bunPath: '/bin/bun',
      pnpmCjs: '/p/pnpm.cjs',
      onProgress: (progress) => seen.push(progress.resolved),
      spawnImpl: fake.spawnImpl,
    })
    expect(seen).toEqual([10, 1234])
  })

  test('失败：带错误尾巴、半成品目录被清掉', async () => {
    const appSupport = tempDir()
    const fake = fakeSpawn(() => ({ code: 1, stderr: 'ERR_PNPM_UNEXPECTED_STORE store mismatch\nsecond line' }))
    await expect(
      installRuntime({ appSupport, version: '9.9.9', bunPath: '/bin/bun', pnpmCjs: '/p/pnpm.cjs', spawnImpl: fake.spawnImpl }),
    ).rejects.toThrow('ERR_PNPM_UNEXPECTED_STORE')
    expect(() => readFileSync(join(appSupport, 'runtimes', '9.9.9', 'package.json'))).toThrow()
  })

  test('退出码 0 但树不完整也算失败（判据是 isRuntimeTreeValid）', async () => {
    const appSupport = tempDir()
    const fake = fakeSpawn(() => ({ code: 0 }))
    await expect(
      installRuntime({ appSupport, version: '9.9.9', bunPath: '/bin/bun', pnpmCjs: '/p/pnpm.cjs', spawnImpl: fake.spawnImpl }),
    ).rejects.toThrow('运行时树不完整')
    expect(() => readFileSync(join(appSupport, 'runtimes', '9.9.9', 'package.json'))).toThrow()
  })

  test('超时：kill 掉子进程并报超时（消息带秒数）', async () => {
    const appSupport = tempDir()
    let killed = false
    const spawnImpl = (): {
      exited: Promise<number>
      stdout?: ReadableStream<Uint8Array> | null
      stderr?: ReadableStream<Uint8Array> | null
      kill?: () => void
    } => {
      let resolveExit: (code: number) => void = () => {}
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve
      })
      return {
        exited,
        kill: () => {
          killed = true
          resolveExit(143)
        },
      }
    }
    await expect(
      installRuntime({ appSupport, version: '9.9.9', bunPath: '/bin/bun', pnpmCjs: '/p/pnpm.cjs', timeoutMs: 30, spawnImpl }),
    ).rejects.toThrow('安装超时')
    expect(killed).toBe(true)
  })
})

describe('createRuntimeDownloader', () => {
  test('成功：进度进状态、装完记账、状态复位但保留数字', async () => {
    const recorded: Array<{ version: string; source: string }> = []
    const downloader = createRuntimeDownloader({
      install: async (_version, onProgress) => {
        onProgress({ resolved: 5, downloaded: 4, added: 3 })
      },
      record: (version, source) => recorded.push({ version, source }),
    })
    // 终态不完美也无妨：面板只在 active 期间读进度；装完后 downloaded 会对齐 resolved（#79）
    expect(downloader.status()).toEqual({ active: false, version: '', resolved: 0, downloaded: 0, added: 0, error: '', cancelled: false })
    const seenDuringRun: boolean[] = []
    const pending = downloader.start('9.9.9', 'npm')
    seenDuringRun.push(downloader.status().active)
    await expect(pending).resolves.toEqual({ ok: true, version: '9.9.9' })
    expect(seenDuringRun).toEqual([true])
    expect(recorded).toEqual([{ version: '9.9.9', source: 'npm' }])
    // #79：成功终态 downloaded 对齐 resolved（上次进度快照停在 538/625=86% 定格的假活就是这么来的）
    expect(downloader.status()).toEqual({ active: false, version: '9.9.9', resolved: 5, downloaded: 5, added: 3, error: '', cancelled: false })
  })

  test('成功终态：最后一条进度停在中间（如 538/625）也归一到 100%', async () => {
    const downloader = createRuntimeDownloader({
      install: async (_version, onProgress) => {
        onProgress({ resolved: 625, downloaded: 538, added: 520 })
        // pnpm default reporter 在下载阶段结束后不再打 Progress 行（linking 无进度可读），
        // 现实里最后一条快照就停在这里
      },
      record: () => {},
    })
    await downloader.start('0.2.1-alpha.3', 'github')
    const status = downloader.status()
    expect(status.downloaded).toBe(625)
    expect(status.resolved).toBe(625)
    expect(status.added).toBe(520)
    expect(status.error).toBe('')
  })


  test('单飞：已有任务在跑时第二次 start 抛「已有运行时下载任务」', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const downloader = createRuntimeDownloader({
      install: async () => {
        await gate
      },
      record: () => {},
    })
    const first = downloader.start('1.0.0', 'github')
    await expect(downloader.start('2.0.0', 'github')).rejects.toThrow('已有运行时下载任务')
    release()
    await first
    // 跑完就能再下一个
    await expect(downloader.start('2.0.0', 'github')).resolves.toEqual({ ok: true, version: '2.0.0' })
  })

  test('失败：错误进状态、不记账、active 复位（面板靠 error 判定成败）', async () => {
    const recorded: string[] = []
    const downloader = createRuntimeDownloader({
      install: async () => {
        throw new Error('dsh 9.9.9 安装失败（exit 1）：ERR_PNPM_NO_MATCHING_VERSION')
      },
      record: (version) => recorded.push(version),
    })
    await expect(downloader.start('9.9.9', 'github')).rejects.toThrow('ERR_PNPM_NO_MATCHING_VERSION')
    expect(recorded).toEqual([])
    const status = downloader.status()
    expect(status.active).toBe(false)
    expect(status.error).toContain('ERR_PNPM_NO_MATCHING_VERSION')
    expect(status.version).toBe('9.9.9')
  })

  test('失败终态：保留最后进度快照与 error（面板拿它显示失败与已下载数，#79）', async () => {
    const downloader = createRuntimeDownloader({
      install: async (_version, onProgress) => {
        onProgress({ resolved: 625, downloaded: 538, added: 520 })
        throw new Error('dsh 0.2.1-alpha.3 安装失败（exit 1）：ETIMEDOUT')
      },
      record: () => {},
    })
    await downloader.start('0.2.1-alpha.3', 'github').catch(() => {})
    const status = downloader.status()
    expect(status.active).toBe(false)
    expect(status.downloaded).toBe(538)
    expect(status.resolved).toBe(625)
    expect(status.error).toContain('ETIMEDOUT')
  })

  test('取消（#97）：abort 走树级停止 + 清半成品，以取消终态收场（不是失败）', async () => {
    const appSupport = tempDir()
    const stopped: number[] = []
    const killedDirectly: boolean[] = []
    let resolveExit: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve
    })
    const controller = new AbortController()
    const spawnImpl = (): {
      exited: Promise<number>
      stdout?: ReadableStream<Uint8Array> | null
      stderr?: ReadableStream<Uint8Array> | null
      kill?: () => void
      pid?: number
    } => ({
      exited,
      stdout: streamOf(''),
      stderr: streamOf(''),
      kill: () => {
        killedDirectly.push(true)
      },
      pid: 4242,
    })
    const pending = installRuntime({
      appSupport,
      version: '9.9.9',
      bunPath: '/bin/bun',
      pnpmCjs: '/p/pnpm.cjs',
      signal: controller.signal,
      spawnImpl,
      stopTree: async ({ rootPid }) => {
        stopped.push(rootPid)
        resolveExit(143)
      },
    })
    controller.abort()
    await expect(pending).rejects.toThrow('安装已取消')
    // 树级停止用的是安装进程的 pid；只 kill 直接子进程的话 pnpm 的构建孙进程还活着，
    // 管道写端不关，installRuntime 永远不 settle（面板进度条永久转圈的病根）
    expect(stopped).toEqual([4242])
    expect(killedDirectly).toEqual([])
    // 半成品目录必须清掉：pnpm linking 阶段就写出 bin.js，留着会被已装扫描误判成「装好了」
    expect(existsSync(runtimeDirOf(appSupport, '9.9.9'))).toBe(false)
  })

  test('超时（#97）：看门狗同样走树级停止，而不是只 kill 直接子进程', async () => {
    const appSupport = tempDir()
    const stopped: number[] = []
    let resolveExit: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve
    })
    const spawnImpl = (): {
      exited: Promise<number>
      stdout?: ReadableStream<Uint8Array> | null
      stderr?: ReadableStream<Uint8Array> | null
      kill?: () => void
      pid?: number
    } => ({
      exited,
      stdout: streamOf(''),
      stderr: streamOf(''),
      kill: () => {
        resolveExit(143)
      },
      pid: 777,
    })
    await expect(
      installRuntime({
        appSupport,
        version: '9.9.9',
        bunPath: '/bin/bun',
        pnpmCjs: '/p/pnpm.cjs',
        timeoutMs: 20,
        spawnImpl,
        stopTree: async ({ rootPid }) => {
          stopped.push(rootPid)
          resolveExit(143)
        },
      }),
    ).rejects.toThrow('安装超时')
    expect(stopped).toEqual([777])
  })

  test('取消（#97）：cancel 中止安装、落 cancelled 终态、不报错也不记账', async () => {
    const recorded: string[] = []
    let abortedSeen = false
    const downloader = createRuntimeDownloader({
      install: async (version, _onProgress, signal) => {
        await new Promise<never>((_resolve, reject) => {
          // cancel() 必须 abort 传进来的那个 signal（面板点的取消要真的传到安装里）
          signal.addEventListener('abort', () => {
            abortedSeen = true
            reject(new RuntimeInstallCancelledError(version))
          })
        })
      },
      record: (version) => recorded.push(version),
    })
    const pending = downloader.start('0.2.1-alpha.3', 'github')
    const settled = pending.then(
      () => 'resolved',
      (error: unknown) => error,
    )
    expect(downloader.status().active).toBe(true)
    await expect(downloader.cancel()).resolves.toEqual({ cancelled: true, version: '0.2.1-alpha.3' })
    expect(await settled).toBeInstanceOf(RuntimeInstallCancelledError)
    const status = downloader.status()
    expect(status.active).toBe(false)
    expect(status.cancelled).toBe(true)
    // 取消不是失败：error 必须空着，面板才不会弹红色失败文案
    expect(status.error).toBe('')
    expect(recorded).toEqual([])
    expect(abortedSeen).toBe(true)
    // 幂等：没有任务时再点一次取消是 no-op（面板连点两次不报错）
    await expect(downloader.cancel()).resolves.toEqual({ cancelled: false, version: '' })
  })

  test('取消（#97）：取消后单飞状态复位，同版本可以立刻重下', async () => {
    let attempt = 0
    const downloader = createRuntimeDownloader({
      install: async (_version, _onProgress, signal) => {
        attempt += 1
        if (attempt > 1) return
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new RuntimeInstallCancelledError('0.2.1-alpha.3'))
          })
        })
      },
      record: () => {},
    })
    const first = downloader.start('0.2.1-alpha.3', 'github')
    const settled = first.then(
      () => 'resolved',
      (error: unknown) => error,
    )
    await downloader.cancel()
    expect(await settled).toBeInstanceOf(RuntimeInstallCancelledError)
    await expect(downloader.start('0.2.1-alpha.3', 'github')).resolves.toEqual({ ok: true, version: '0.2.1-alpha.3' })
    expect(attempt).toBe(2)
    expect(downloader.status().active).toBe(false)
    expect(downloader.status().cancelled).toBe(false)
  })
})

describe('withRuntimeDownloadNotify：下载入口的通知包装（#115）', () => {
  const recorder = () => {
    const notes: Array<[string, string]> = []
    return { notes, notify: (scenarioId: string, body: string) => void notes.push([scenarioId, body]) }
  }

  test('成功：发 runtime.download 完成通知并透传结果', async () => {
    const { notes, notify } = recorder()
    const wrapped = withRuntimeDownloadNotify(
      async (version: string) => ({ ok: true as const, version }),
      { notify, cancelled: () => false },
    )
    await expect(wrapped('0.2.1-alpha.4', 'github')).resolves.toEqual({ ok: true, version: '0.2.1-alpha.4' })
    expect(notes).toEqual([['runtime.download', '运行时安装完成：dsh 0.2.1-alpha.4']])
  })

  test('失败：发 runtime.download 失败通知（带原因）并原样上抛', async () => {
    const { notes, notify } = recorder()
    const boom = new Error('网络断了')
    const wrapped = withRuntimeDownloadNotify(
      async () => {
        throw boom
      },
      { notify, cancelled: () => false },
    )
    await expect(wrapped('0.2.1-alpha.4', 'github')).rejects.toBe(boom)
    expect(notes).toEqual([['runtime.download', '运行时安装失败：dsh 0.2.1-alpha.4 —— 网络断了']])
  })

  test('取消：cancelled() 为真时失败通知不出，仍上抛', async () => {
    const { notes, notify } = recorder()
    const wrapped = withRuntimeDownloadNotify(
      async () => {
        throw new Error('aborted')
      },
      { notify, cancelled: () => true },
    )
    await expect(wrapped('0.2.1-alpha.4', 'github')).rejects.toThrow('aborted')
    expect(notes).toEqual([])
  })
})
