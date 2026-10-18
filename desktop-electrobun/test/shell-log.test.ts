// shell-log：主进程 shell.log 落盘单例（#80 取证缺口）。
// 覆盖：路径解析口径（DSH_SHELL_LOG 优先 / dshHome 兜底）、行落盘 + 时间戳格式、
// stdout 镜像（dev 终端可见性）、单例身份。
// 注意：sink 是进程级单例，env 必须在本文件任何用例触达 sink 之前定死——
// shell-log.ts 对 env 是懒读取（调用时才解析），模块顶层赋值即可。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const logDir = mkdtempSync(join(tmpdir(), 'dsh-shell-log-'))
process.env.DSH_SHELL_LOG = join(logDir, 'shell.log')

import { installShellConsoleTee, resolveShellLogFile, shellLogLine, shellLogSink } from '../src/bun/shell-log.ts'

describe('shell-log：路径解析', () => {
  test('DSH_SHELL_LOG 优先', () => {
    expect(resolveShellLogFile({ DSH_SHELL_LOG: '/tmp/x/shell.log' })).toBe('/tmp/x/shell.log')
  })

  test('缺省兜 dshHome/shell.log（#1 口径）', () => {
    const resolved = resolveShellLogFile({})
    expect(resolved).toBe(join(homedir(), '.dsh', 'shell.log'))
  })
})

describe('shell-log：落盘与单例', () => {
  test('shellLogLine 写进文件且带时间戳前缀', () => {
    shellLogLine('[shell] #80 heal 检查（test）：落位正常，不干预')
    const content = readFileSync(process.env.DSH_SHELL_LOG!, 'utf8')
    expect(content).toContain('[shell] #80 heal 检查（test）：落位正常，不干预')
    // 本地时区时间戳（log-sink 的 formatLogLine 统一格式），行首非空
    const line = content.split('\n').find((row) => row.includes('#80 heal 检查'))!
    expect(line.startsWith('[')).toBe(false)
    expect(line.trim().length).toBeGreaterThan(0)
  })

  test('stdout 镜像：dev 终端仍能看到同一行', () => {
    const original = console.log
    const seen: string[] = []
    console.log = (line: unknown) => seen.push(String(line))
    try {
      shellLogLine('[shell] mirror-probe')
    } finally {
      console.log = original
    }
    expect(seen.some((row) => row.includes('[shell] mirror-probe'))).toBe(true)
  })

  test('console tee：installShellConsoleTee 后 console.log 同步进 shell.log', () => {
    installShellConsoleTee()
    console.log('[shell] tee-probe')
    const content = readFileSync(process.env.DSH_SHELL_LOG!, 'utf8')
    expect(content).toContain('[shell log] [shell] tee-probe')
  })

  test('单例身份：重复取同一实例（路径不会被二次初始化改写）', () => {
    expect(shellLogSink()).toBe(shellLogSink())
    expect(shellLogSink().path).toBe(process.env.DSH_SHELL_LOG!)
  })
})
