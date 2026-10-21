// dsh 系统命令注册：纯逻辑 + IO 外壳（旧壳 `desktop/src-tauri/src/register/` 的等价物）。
// IO 侧全部注入（run / 文件读写 / realpath），所以这里不 spawn 真 shell、不碰真实 PATH。
import { describe, expect, test } from 'bun:test'
import {
  CACHE_TTL_MS,
  CONFLICT_MARKER,
  REGISTER_TARGET,
  classifyResolution,
  classifyShim,
  extractLastNonEmptyLine,
  parseUserShell,
  registerTrayLabel,
  registrationScript,
  samePath,
  shellQuote,
  shellRcPathFix,
  linuxRegistrationScript,
  linuxRegistrationTarget,
  parseWindowsPathRegQuery,
  windowsPathHasEntry,
  windowsUserPathEntries,
  windowsUserPathWrite,
  shimFileName,
  shimPathOf,
  shimScript,
  stripAnsi,
  type RegisterState,
} from '../src/shared/app/register-cli.ts'
import { collectingLogger } from './helpers/test-logger.ts'
import { createRegisterCli, type RunResult } from '../src/bun/commands/register-cli.ts'

describe('shim：位置 / 内容 / 判词', () => {
  test('文件名与路径按平台', () => {
    expect(shimFileName('darwin')).toBe('dsh')
    expect(shimFileName('win32')).toBe('dsh.cmd')
    expect(shimPathOf('/tmp/app', 'darwin')).toBe('/tmp/app/runtime/bin-dsh/dsh')
    expect(shimPathOf('/tmp/app/', 'win32')).toBe('/tmp/app/runtime/bin-dsh/dsh.cmd')
  })

  test('unix shim 是一条 exec 转发，参数带引号，指向当前运行时的启动命令', () => {
    const text = shimScript('darwin', ['/bun', '--no-install', '--preload', "/tmp/a b/p.mjs", '/lib/bin.js'])
    expect(text.startsWith('#!/bin/sh\n')).toBe(true)
    expect(text).toContain("exec '/bun' '--no-install' '--preload' '/tmp/a b/p.mjs' '/lib/bin.js' \"$@\"")
    expect(text).toContain('由 dsh 桌面壳维护')
  })

  test('windows shim 是 .cmd，参数用双引号', () => {
    const text = shimScript('win32', ['C:\\bun.exe', '--no-install', 'C:\\lib\\bin.js'])
    expect(text).toBe(
      '@echo off\r\nrem 由 dsh 桌面壳维护：指向当前运行时的 dsh 入口\r\n"C:\\bun.exe" "--no-install" "C:\\lib\\bin.js" %*\r\n',
    )
  })

  test('判词：absent / ours / stale / foreign（别人放的不覆盖）', () => {
    const expected = shimScript('darwin', ['/bun', '/lib/bin.js'])
    expect(classifyShim(null, expected)).toBe('absent')
    expect(classifyShim(expected, expected)).toBe('ours')
    expect(classifyShim(shimScript('darwin', ['/other', '/lib/bin.js']), expected)).toBe('stale')
    expect(classifyShim('#!/bin/sh\nexec /usr/local/bin/dsh-old "$@"\n', expected)).toBe('foreign')
  })
})

describe('探测输出清洗', () => {
  test('取末行非空并剥 ANSI（rc 横幅在前）', () => {
    const text = '\u001b[1m欢迎\u001b[0m\n\n/usr/local/bin/dsh\n'
    expect(extractLastNonEmptyLine(text)).toBe('/usr/local/bin/dsh')
    expect(stripAnsi('\u001b[31m红\u001b[0m')).toBe('红')
    expect(extractLastNonEmptyLine('\n\n')).toBeNull()
  })

  test('dscl 的 UserShell 解析，失败回 null', () => {
    expect(parseUserShell('UserShell: /bin/zsh\n')).toBe('/bin/zsh')
    expect(parseUserShell('No such key')).toBeNull()
  })
})

describe('三态判定', () => {
  const base = { shimPath: '/app/runtime/bin-dsh/dsh', shimReady: true, platform: 'darwin' }

  test('解析不到 → 未注册；shim 没物化 → 也是未注册', () => {
    expect(classifyResolution({ ...base, resolved: null })).toBe('missing')
    expect(classifyResolution({ ...base, shimReady: false, resolved: '/usr/local/bin/dsh' })).toBe('missing')
  })

  test('命中本壳 → 已注册；别的路径 → 冲突', () => {
    expect(classifyResolution({ ...base, resolved: '/app/runtime/bin-dsh/dsh' })).toBe('registered')
    expect(classifyResolution({ ...base, resolved: '/opt/homebrew/bin/dsh' })).toBe('conflict')
  })

  test('路径比较：尾斜杠、Windows 大小写与斜杠', () => {
    expect(samePath('/a/b/', '/a/b', 'darwin')).toBe(true)
    expect(samePath('C:\\App\\dsh.cmd', 'c:/app/dsh.cmd', 'win32')).toBe(true)
    expect(samePath('/a/b', '/a/c', 'darwin')).toBe(false)
  })

  test('托盘文案：已注册/未探出不显示，未注册/冲突给对应文案', () => {
    const state = (kind: RegisterState['kind'], resolved: string | null = null): RegisterState => ({
      kind,
      resolved,
      shimReady: true,
      at: 0,
    })
    expect(registerTrayLabel(state('registered'))).toBeNull()
    expect(registerTrayLabel(state('unknown'))).toBeNull()
    expect(registerTrayLabel(state('missing'))).toBe('注册 dsh 为系统命令')
    expect(registerTrayLabel(state('conflict', '/opt/homebrew/bin/dsh'))).toContain('/opt/homebrew/bin/dsh')
  })
})

describe('提权脚本与 rc 修正', () => {
  test('脚本：幂等（已是我们 exit 0）、冲突标记、force 备份、ln -sfn', () => {
    const script = registrationScript({ shim: '/app/runtime/bin-dsh/dsh', force: false })
    expect(script).toContain('/bin/mkdir -p \'/usr/local/bin\'')
    expect(script).toContain(`t='${REGISTER_TARGET}'`)
    expect(script).toContain('exit 0')
    expect(script).toContain(`echo '${CONFLICT_MARKER}' >&2`)
    expect(script).toContain("/bin/ln -sfn '/app/runtime/bin-dsh/dsh' \"$t\"")
    expect(registrationScript({ shim: '/x', force: true })).toContain("/bin/mv \"$t\" \"$t.bak.")
  })

  test('shell 单引号转义', () => {
    expect(shellQuote("/a b'c")).toBe("'/a b'\\''c'")
  })

  test('rc 修正：zsh 走 .zshrc，fish 用 fish_add_path，bash 不遮蔽已有 .profile', () => {
    expect(shellRcPathFix({ shell: '/bin/zsh', home: '/Users/x', exists: () => false })).toEqual({
      file: '/Users/x/.zshrc',
      line: 'export PATH="/usr/local/bin:$PATH"',
    })
    expect(shellRcPathFix({ shell: '/opt/homebrew/bin/fish', home: '/Users/x', exists: () => false })).toEqual({
      file: '/Users/x/.config/fish/config.fish',
      line: 'fish_add_path /usr/local/bin',
    })
    // .bash_profile 存在 → 用它
    expect(
      shellRcPathFix({ shell: '/bin/bash', home: '/Users/x', exists: (p) => p.endsWith('.bash_profile') }).file,
    ).toBe('/Users/x/.bash_profile')
    // 不存在但 .profile 在 → 退回 .profile（新建 .bash_profile 会遮蔽它）
    expect(shellRcPathFix({ shell: '/bin/bash', home: '/Users/x', exists: (p) => p.endsWith('.profile') }).file).toBe(
      '/Users/x/.profile',
    )
    // 两个都没有 → 新建 .bash_profile
    expect(shellRcPathFix({ shell: '/bin/bash', home: '/Users/x', exists: () => false }).file).toBe(
      '/Users/x/.bash_profile',
    )
  })
})

/** 注入件：内存文件系统 + 可编排的 run（记下跑过什么）。 */
function harness(options: {

  files?: Record<string, string>
  dshResolved?: string | null
  /** 系统入口（/usr/local/bin/dsh、~/.local/bin/dsh）当前指向哪（快探测用；null = 入口不存在） */
  linkTo?: string | null
  runStatus?: number
  whereResolved?: string | null
  runStderr?: string
  platform?: string
  regStatus?: number
  regStdout?: string
  psStatus?: number
  psStderr?: string
  home?: string
}) {
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  const calls: string[][] = []
  const logs: string[] = []
  const run = (argv: string[]): RunResult => {
    calls.push(argv)
    if (argv[0] === '/usr/bin/dscl') return { status: 0, stdout: 'UserShell: /bin/zsh\n', stderr: '' }
    if (argv.includes('-ilc')) {
      const resolved = options.dshResolved === undefined ? null : options.dshResolved
      return { status: resolved === null ? 1 : 0, stdout: resolved === null ? '' : `${resolved}\n`, stderr: '' }
    }
    if (argv[0] === 'reg') return { status: options.regStatus ?? 0, stdout: options.regStdout ?? '', stderr: '' }
    if (argv[0] === 'where') {
      const resolved = options.whereResolved
      if (resolved === undefined) return { status: 0, stdout: '', stderr: '' }
      return resolved === null
        ? { status: 1, stdout: '', stderr: '' }
        : { status: 0, stdout: `${resolved}\r\n`, stderr: '' }
    }
    if (argv[0] === 'powershell') return { status: options.psStatus ?? 0, stdout: '', stderr: options.psStderr ?? '' }
    return { status: options.runStatus ?? 0, stdout: '', stderr: options.runStderr ?? '' }
  }
  const cli = createRegisterCli({
      log: collectingLogger(logs),
    appSupport: '/app-support',
    platform: options.platform ?? 'darwin',
    shellCommand: () => ['/bun', '/lib/bin.js'],
    run,
    readText: (path) => files.get(path) ?? null,
    writeText: (path, text) => void files.set(path, text),
    exists: (path) => files.has(path),
    realpath: (path) => path,
    env: { USER: 'tester', SHELL: '/bin/zsh' },
    home: options.home ?? '/home/tester',
    readlink: (path) => (options.linkTo !== undefined && path.endsWith('/dsh') ? options.linkTo : null),
  })
  return { cli, files, calls, logs }
}

describe('createRegisterCli（IO 外壳，全部注入）', () => {
  test('ensureShim 写入并带 exec 位；已是我们就不重写', () => {
    const { cli, files, logs } = harness({})
    const first = cli.ensureShim()
    expect(first.verdict).toBe('ours')
    expect(files.get('/app-support/runtime/bin-dsh/dsh')).toContain("exec '/bun' '/lib/bin.js'")
    const second = cli.ensureShim()
    expect(second.verdict).toBe('ours')
    expect(logs.filter((line) => line.includes('shim 已写入')).length).toBe(1)
  })

  test('foreign 内容也回收重写——shim 在本壳私有目录里（#62 PR 实测：旧坏内容没标记注释）', () => {
    const { cli, files, logs } = harness({ files: { '/app-support/runtime/bin-dsh/dsh': '#!/bin/sh\nexec /other\n' } })
    expect(cli.ensureShim().verdict).toBe('ours')
    expect(files.get('/app-support/runtime/bin-dsh/dsh') ?? '').toContain('由 dsh 桌面壳维护')
    expect(logs.some((line) => line.includes('回收重写'))).toBe(true)
  })

  test('refresh：未注册 / 已注册 / 冲突三态 + 缓存 TTL', async () => {
    const missing = harness({ dshResolved: null })
    expect((await missing.cli.refresh()).kind).toBe('missing')

    const registered = harness({ dshResolved: '/app-support/runtime/bin-dsh/dsh' })
    const state = await registered.cli.refresh()
    expect(state.kind).toBe('registered')
    expect(registered.cli.cached().kind).toBe('registered')
    expect(CACHE_TTL_MS).toBeGreaterThan(0)

    const conflict = harness({ dshResolved: '/opt/homebrew/bin/dsh' })
    expect((await conflict.cli.refresh()).kind).toBe('conflict')
    expect(conflict.cli.describe()).toContain('/opt/homebrew/bin/dsh')
  })

  test('探测走用户真实登录 shell（-ilc + DISABLE_AUTO_UPDATE）', async () => {
    const { cli, calls } = harness({ dshResolved: null })
    await cli.refresh()
    const detect = calls.find((argv) => argv.includes('-ilc'))
    expect(detect?.[0]).toBe('/bin/zsh')
    expect(detect?.[2]).toBe('command -v dsh')
  })

  test('register：macOS 走 osascript 提权；取消 / 冲突 / 成功三种收场', async () => {
    const ok = harness({ dshResolved: null, runStatus: 0 })
    const done = await ok.cli.register()
    expect(done.ok).toBe(true)
    const script = ok.calls.find((argv) => argv[0] === '/usr/bin/osascript')?.join(' ') ?? ''
    expect(script).toContain('with administrator privileges')

    const canceled = harness({ dshResolved: null, runStatus: 1, runStderr: 'execution error: 用户已取消 (-128)' })
    expect((await canceled.cli.register()).code).toBe('canceled')

    const conflict = harness({
      dshResolved: null,
      runStatus: 3,
      runStderr: `sh: ${CONFLICT_MARKER}`,
    })
    const conflicted = await conflict.cli.register()
    expect(conflicted.code).toBe('conflict')
    expect(conflicted.message).toContain('强制覆盖')
  })

  test('linux：~/.local/bin symlink 成功；冲突要 force；force 后放行', async () => {
    const ok = harness({ platform: 'linux', dshResolved: null })
    const result = await ok.cli.register()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('/home/tester/.local/bin/dsh')
    const script = ok.calls.find((argv) => argv[0] === '/bin/sh')?.[2] ?? ''
    expect(script).toContain("mkdir -p '/home/tester/.local/bin'")
    expect(script).toContain("ln -sfn '/app-support/runtime/bin-dsh/dsh'")

    const conflict = harness({ platform: 'linux', dshResolved: null, runStatus: 3, runStderr: `sh: ${CONFLICT_MARKER}` })
    expect((await conflict.cli.register()).code).toBe('conflict')

    const forced = harness({ platform: 'linux', dshResolved: null })
    expect((await forced.cli.register({ force: true })).ok).toBe(true)
    expect(forced.calls.find((argv) => argv[0] === '/bin/sh')?.[2] ?? '').toContain("if [ '1' = '1' ]")
  })

  test('win32：读注册表 → EncodedCommand 写回；已含 shim 目录就幂等；force 前置', async () => {
    const raw = 'HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;C:\\other\r\n'
    const appended = harness({ platform: 'win32', dshResolved: null, regStdout: raw })
    const result = await appended.cli.register()
    expect(result.ok).toBe(true)
    const ps = appended.calls.find((argv) => argv[0] === 'powershell') ?? []
    const script = Buffer.from(ps[ps.indexOf('-EncodedCommand') + 1] ?? '', 'base64').toString('utf16le')
    expect(script).toContain('%SystemRoot%\\system32;C:\\other')
    const value = /-Value '([^']*)'/.exec(script)?.[1] ?? ''
    expect(value).toBe('%SystemRoot%\\system32;C:\\other;/app-support/runtime/bin-dsh')
    expect(script).toContain('-Type ExpandString')
    expect(script).toContain('0x001A')

    const idempotent = harness({
      platform: 'win32',
      dshResolved: null,
      regStdout: 'Path    REG_SZ    /app-support/runtime/bin-dsh\r\n',
    })
    expect((await idempotent.cli.register()).ok).toBe(true)
    expect(idempotent.calls.some((argv) => argv[0] === 'powershell')).toBe(false)

    const forced = harness({ platform: 'win32', dshResolved: null, regStdout: raw })
    expect((await forced.cli.register({ force: true })).ok).toBe(true)
    const fscript = Buffer.from(
      (forced.calls.find((argv) => argv[0] === 'powershell') ?? []).at(-1) ?? '',
      'base64',
    ).toString('utf16le')
    expect(fscript.startsWith("Set-ItemProperty -Path 'HKCU:\\Environment' -Name 'Path' -Value '/app-support/runtime/bin-dsh;")).toBe(
      true,
    )
  })

  test('win32：注册表里有本壳入口就是已注册（权威；where 快照不再参与）', async () => {
    const justRegistered = harness({
      platform: 'win32',
      whereResolved: null,
      regStdout: 'Path    REG_SZ    /app-support/runtime/bin-dsh\r\n',
    })
    expect((await justRegistered.cli.refresh()).kind).toBe('registered')
    expect(justRegistered.calls.some((argv) => argv[0] === 'where')).toBe(false)
  })

  test('win32：注册表没有本壳入口、where 解析到别人 → 冲突（带日志）', async () => {
    const foreign = harness({
      platform: 'win32',
      whereResolved: 'C:\\opt\\other\\dsh.cmd',
      regStdout: 'Path    REG_SZ    C:\\other\r\n',
    })
    expect((await foreign.cli.refresh()).kind).toBe('conflict')
    expect(foreign.logs.some((line) => line.includes('where dsh'))).toBe(true)
  })

  test('win32：注册表里也没有 shim 目录就是未注册', async () => {
    const absent = harness({ platform: 'win32', whereResolved: null, regStdout: 'Path    REG_SZ    C:\\other\r\n' })
    expect((await absent.cli.refresh()).kind).toBe('missing')
  })

  test('win32：注册表读取失败且 where 落空 → 未注册（带日志）', async () => {
    const broken = harness({ platform: 'win32', whereResolved: null, regStatus: 1 })
    expect((await broken.cli.refresh()).kind).toBe('missing')
    expect(broken.logs.some((line) => line.includes('注册表用户 PATH 读取失败'))).toBe(true)
  })

  test('win32：注册时清掉本壳旧安装的幽灵入口（只动自己的 bin-dsh 目录）', async () => {
    const ghost = 'C:\\Users\\u\\AppData\\Local\\com.hyperion.dsh-desktop-bun\\stable\\runtime\\bin-dsh'
    const raw = `HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    ${ghost};C:\\other\r\n`
    const cleanup = harness({ platform: 'win32', dshResolved: null, regStdout: raw })
    expect((await cleanup.cli.register()).ok).toBe(true)
    const ps = cleanup.calls.find((argv) => argv[0] === 'powershell') ?? []
    const script = Buffer.from(ps[ps.indexOf('-EncodedCommand') + 1] ?? '', 'base64').toString('utf16le')
    const value = /-Value '([^']*)'/.exec(script)?.[1] ?? ''
    expect(value).toBe('C:\\other;/app-support/runtime/bin-dsh')
  })

  test('刷新闩锁：连着两次强制刷新各自实测（不得拿第一次那个已兑现的 Promise 糊弄）', async () => {
    const opts: { platform: string; dshResolved: string | null } = { platform: 'darwin', dshResolved: null }
    const wired = harness(opts)
    expect((await wired.cli.refresh({ force: true })).kind).toBe('missing')
    // 环境变了：同一条注入跑第二次必须重新实测，而不是复述第一次的结论
    opts.dshResolved = '/app-support/runtime/bin-dsh/dsh'
    expect((await wired.cli.refresh({ force: true })).kind).toBe('registered')
  })

  test('保鲜快探测：系统入口指向本壳 shim 就算已注册，不 spawn 登录 shell', async () => {
    const spawned: string[][] = []
    const probe = harness({
      platform: 'darwin',
      dshResolved: null,
      linkTo: '/app-support/runtime/bin-dsh/dsh',
    })
    expect(probe.cli.poll().kind).toBe('registered')
    expect(spawned).toEqual([])
    expect(probe.calls.some((argv) => argv.includes('-ilc'))).toBe(false)
  })

  test('保鲜快探测：入口不存在时判不出来（交给慢路径），不误报', () => {
    const none = harness({ platform: 'darwin', dshResolved: null })
    expect(none.cli.poll().kind).toBe('unknown')
  })

  test('win32：写回成功即乐观置已注册（TTL 内不被重测打回）', async () => {
    // regStdout 始终不含本壳入口：即便随后的探测读不到刚写进的注册表，也不许把菜单打回未注册
    const flaky = harness({
      platform: 'win32',
      whereResolved: null,
      regStdout: 'Path    REG_SZ    C:\\other\r\n',
    })
    expect((await flaky.cli.register()).ok).toBe(true)
    expect(flaky.cli.cached().kind).toBe('registered')
    await flaky.cli.refresh()
    expect(flaky.cli.cached().kind).toBe('registered')
    expect(flaky.logs.some((line) => line.includes('乐观置位'))).toBe(true)
  })

  test('shim 内容过期（旧版本写坏的入口、无标记注释）也重写——私有目录不认「别人」', async () => {
    const stale = harness({
      platform: 'win32',
      dshResolved: null,
      regStdout: 'Path    REG_SZ    /app-support/runtime/bin-dsh\r\n',
      files: { '/app-support/runtime/bin-dsh/dsh.cmd': '@echo off\r\n"C:\\old\\bun.exe" %*\r\n' },
    })
    await stale.cli.refresh()
    expect(stale.files.get('/app-support/runtime/bin-dsh/dsh.cmd') ?? '').toContain('由 dsh 桌面壳维护')
    expect(stale.logs.some((line) => line.includes('回收重写'))).toBe(true)
  })
})

describe('Windows PATH 纯逻辑 / Linux 脚本', () => {
  test('reg query 值行解析：类型 + 原始值，解析不了回 null', () => {
    expect(parseWindowsPathRegQuery('    Path    REG_SZ    C:\\a;C:\\b\r\n')?.raw).toBe('C:\\a;C:\\b')
    expect(parseWindowsPathRegQuery('    Path    REG_EXPAND_SZ    %SystemRoot%;C:\\b')?.type).toBe('REG_EXPAND_SZ')
    expect(parseWindowsPathRegQuery('系统找不到指定的注册表项或值')).toBeNull()
  })

  test('windowsUserPathWrite：本壳旧 bin-dsh 幽灵项清掉，别人的原样保留', () => {
    const ghost = 'C:\\x\\com.hyperion.dsh-desktop-bun\\stable\\runtime\\bin-dsh'
    const mine = 'C:\\x\\com.hyperion.dsh-desktop-bun\\dev\\runtime\\bin-dsh'
    const kept = windowsUserPathWrite(
      [ghost, 'C:\\Windows', mine],
      'C:\\y\\com.hyperion.dsh-desktop-bun\\v2\\runtime\\bin-dsh',
      false,
    )
    expect(kept).toBe('C:\\Windows;C:\\y\\com.hyperion.dsh-desktop-bun\\v2\\runtime\\bin-dsh')
    const forced = windowsUserPathWrite([ghost], 'C:\\y\\mine\\runtime\\bin-dsh', true)
    expect(forced).toBe('C:\\y\\mine\\runtime\\bin-dsh')
  })

  test('拆项/判含/写回：追加 vs force 前置，大小写与斜杠不敏感', () => {
    const entries = windowsUserPathEntries('C:\\A;;c:/b ')
    expect(entries).toEqual(['C:\\A', 'c:/b'])
    expect(windowsPathHasEntry(entries, 'c:\\a')).toBe(true)
    expect(windowsUserPathWrite(entries, 'D:\\x', false)).toBe('C:\\A;c:/b;D:\\x')
    expect(windowsUserPathWrite(entries, 'D:\\x', true)).toBe('D:\\x;C:\\A;c:/b')
  })

  test('linux 脚本结构与目标定位', () => {
    expect(linuxRegistrationTarget('/home/u/')).toBe('/home/u/.local/bin/dsh')
    const script = linuxRegistrationScript({ shim: '/app/runtime/bin-dsh/dsh', home: '/home/u', force: false })
    expect(script).toContain("mkdir -p '/home/u/.local/bin'")
    expect(script).toContain(CONFLICT_MARKER)
  })
})
