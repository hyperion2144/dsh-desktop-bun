// macOS 主进程 handoff shim 的行为回归：
// LaunchServices 启动的 launcher 必须 exec 成 bun（同 PID），并把自身路径作为 DSH_SHELL_LAUNCHER
// 交给运行时；否则 Tangrid 等按 AX 枚举应用的工具只看到没有窗口的 launcher。

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-macos-launcher-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('macOS launcher exec shim', () => {
  test.skipIf(process.platform !== 'darwin')('exec 成 bun，设置 DSH_SHELL_LAUNCHER 并清掉 ELECTROBUN_LAUNCHER_PID', () => {
    const root = tempDir()
    const app = join(root, 'Probe.app')
    const macos = join(app, 'Contents', 'MacOS')
    const resources = join(app, 'Contents', 'Resources')
    mkdirSync(macos, { recursive: true })
    mkdirSync(resources, { recursive: true })

    const launcher = join(macos, 'launcher')
    const shim = readFileSync(new URL('../scripts/macos-launcher.sh', import.meta.url), 'utf8')
    writeFileSync(launcher, shim)
    chmodSync(launcher, 0o755)

    const record = join(root, 'record.txt')
    const fakeBun = join(macos, 'bun')
    writeFileSync(
      fakeBun,
      `#!/bin/sh
{
  printf 'DSH_SHELL_LAUNCHER=%s\\n' "\${DSH_SHELL_LAUNCHER-}"
  printf 'ELECTROBUN_LAUNCHER_PID=%s\\n' "\${ELECTROBUN_LAUNCHER_PID-unset}"
  printf 'cwd=%s\\n' "$PWD"
  printf 'arg=%s\\n' "$@"
} > "$DSH_TEST_RECORD"
`,
    )
    chmodSync(fakeBun, 0o755)
    writeFileSync(join(resources, 'main.js'), '// main\n')

    const result = Bun.spawnSync({
      cmd: [launcher, '--probe'],
      env: {
        ...process.env,
        DSH_TEST_RECORD: record,
        ELECTROBUN_LAUNCHER_PID: '12345',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)

    const lines = readFileSync(record, 'utf8')
    expect(lines).toContain(`DSH_SHELL_LAUNCHER=${launcher}`)
    expect(lines).toContain('ELECTROBUN_LAUNCHER_PID=unset')
    expect(lines).toContain(`cwd=${resources}`)
    expect(lines).toContain(`arg=${join(resources, 'main.js')}`)
    expect(lines).toContain('arg=--probe')
  })
})
