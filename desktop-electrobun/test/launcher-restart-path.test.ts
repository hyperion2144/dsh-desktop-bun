// #167 Windows 托盘「重启应用」第二次 launcher-unknown 的回归：
// 重启不能只依赖「现场用 ELECTROBUN_LAUNCHER_PID 反查」，冷启动成功解析到的路径要能兜底；
// 所有候选都必须经过存在性校验，全失败仍保持 launcher-unknown。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  layout,
  rememberLauncherExecutablePath,
  resolveLauncherForRelaunch,
} from '../src/bun/runtime/runtime.ts'

let tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-launcher-path-'))
  tempDirs.push(dir)
  return dir
}

function touch(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  return path
}

beforeEach(() => {
  rememberLauncherExecutablePath(null)
})

afterEach(() => {
  rememberLauncherExecutablePath(null)
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

describe('resolveLauncherForRelaunch：重启入口的 launcher 路径兜底', () => {
  test('win32 PID 查询成功：用现场解析结果，并在尝试记录里留下命令/status/stdout', () => {
    const launcher = '/virtual/App/bin/launcher.exe'
    const result = resolveLauncherForRelaunch({
      env: { ELECTROBUN_LAUNCHER_PID: '4242' },
      ppid: 0,
      platform: 'win32',
      run: () => ({ status: 0, stdout: `${launcher}\r\n`, stderr: '' }),
      exists: (path) => path === launcher,
      execPath: '/virtual/App/bin/bun.exe',
    })

    expect(result.launcherExe).toBe(launcher)
    expect(result.source).toBe('pid')
    const attempts = result.attempts.join('\n')
    expect(attempts).toContain('ProcessId=4242')
    expect(attempts).toContain('status=0')
  })

  test('win32 PID 查询为空输出（#167 失败模式）⇒ 回退冷启动缓存，不停在 launcher-unknown', () => {
    const launcher = touch(join(tempDir(), 'bin', 'launcher.exe'))
    const result = resolveLauncherForRelaunch({
      env: { ELECTROBUN_LAUNCHER_PID: '99' },
      ppid: 0,
      platform: 'win32',
      run: () => ({ status: 0, stdout: '', stderr: '' }),
      exists: (path) => path === launcher,
      cached: launcher,
      execPath: '/virtual/App/bin/bun.exe',
    })

    expect(result.launcherExe).toBe(launcher)
    expect(result.source).toBe('cache')
    expect(result.attempts.join('\n')).toContain('status=0')
  })

  test('缓存路径已不存在 ⇒ 回退同目录 launcher.exe（Windows bun.exe 的 sibling）', () => {
    const dir = tempDir()
    const execPath = touch(join(dir, 'bin', 'bun.exe'))
    const launcher = touch(join(dir, 'bin', 'launcher.exe'))
    const result = resolveLauncherForRelaunch({
      env: {},
      ppid: 0,
      platform: 'win32',
      execPath,
      cached: join(dir, 'gone', 'launcher.exe'),
      exists: (path) => path === launcher,
    })

    expect(result.launcherExe).toBe(launcher)
    expect(result.source).toBe('sibling')
  })

  test('显式 DSH_SHELL_LAUNCHER 覆盖可救回；不存在的候选不采用', () => {
    const launcher = touch(join(tempDir(), 'bin', 'launcher.exe'))
    const result = resolveLauncherForRelaunch({
      env: { DSH_SHELL_LAUNCHER: launcher },
      ppid: 0,
      platform: 'darwin',
      run: () => ({ status: 1, stdout: '' }),
      readlink: () => null,
      exists: (path) => path === launcher,
      cached: null,
    })

    expect(result.launcherExe).toBe(launcher)
    expect(result.source).toBe('env')
  })

    test('所有候选都不存在 ⇒ null，且尝试记录非空', () => {
        const result = resolveLauncherForRelaunch({
            env: {},
            ppid: 0,
            platform: 'linux',
            readlink: () => null,
            exists: () => false,
            cached: '/missing/launcher',
        })

        expect(result.launcherExe).toBeNull()
        expect(result.source).toBeNull()
        expect(result.attempts.length).toBeGreaterThan(0)
    })

  test('layout() 冷启动解析成功的 launcher 会进入缓存，供后续重启使用', () => {
    const dir = tempDir()
    const launcher = touch(join(dir, 'App', 'bin', 'launcher.exe'))
    layout({
      env: {
        ...process.env,
        DSH_HOME: join(dir, 'home'),
        DSH_SHELL_PROJECT: join(dir, 'project'),
      },
      launcherPath: launcher,
      execPath: join(dir, 'App', 'bin', 'bun.exe'),
    })

    const result = resolveLauncherForRelaunch({
      env: {},
      ppid: 0,
      platform: 'darwin',
      run: () => ({ status: 1, stdout: '' }),
      readlink: () => null,
      exists: (path) => path === launcher,
    })

    expect(result.launcherExe).toBe(launcher)
    expect(result.source).toBe('cache')
  })

  test('layout() 优先采用 DSH_SHELL_LAUNCHER（macOS exec shim）', () => {
    const dir = tempDir()
    const launcher = touch(join(dir, 'App', 'bin', 'launcher'))
    const result = layout({
      env: {
        ...process.env,
        DSH_HOME: join(dir, 'home'),
        DSH_SHELL_PROJECT: join(dir, 'project'),
        DSH_SHELL_LAUNCHER: launcher,
      },
      execPath: join(dir, 'App', 'bin', 'bun'),
    })

    expect(result.launcherPath).toBe(launcher)
  })
})
