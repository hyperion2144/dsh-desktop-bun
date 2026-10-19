// 单实例 + 启动界面（缝 ② 纯逻辑 + /__shell__/activate 的真 HTTP 用例）。
//
// 守的是什么：
//   1. 第二个壳不能再起一份宿主（旧 Tauri 壳有 tauri-plugin-single-instance，Electrobun 没有）
//      ⇒ 锁文件 + 「激活已有实例后自己退出」；锁文件里还留着死进程的 pid 时必须能接管。
//   2. 启动那 10–60 秒里要有可见进度，失败要留在屏幕上给出原因，别只转圈或干脆白屏。

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startShellServer } from '../src/bun/net/shell-server.ts'
import {
  ACTIVATE_PATH,
  acquireInstance,
  activateUrl,
  parseInstanceRecord,
  readInstance,
  releaseInstance,
  updateInstance,
  defaultIsOurProcess,
  firstArgOfPsArgs,
  imageFromTasklist,
  pathMatches,
  readBootId,
  writeInstance,
  type InstanceRecord,
} from '../src/bun/platform/single-instance.ts'
import { SPLASH_HEIGHT, SPLASH_WIDTH, splashFailScript, splashHtml, splashStageScript } from '../src/bun/windows/splash.ts'
import { DIALOG_CLOSE_ATTR, DIALOG_TITLEBAR_HEIGHT, dialogTitlebarFrameHeight } from '../src/bun/windows/dialog-titlebar.ts'
import { FAILED_LABEL, SHELL_STAGES, stageLabel, stagePercent } from '../src/bun/platform/stages.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-instance-'))
}

function record(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    pid: 4242,
    origin: 'http://127.0.0.1:6390',
    pageUrl: 'http://127.0.0.1:6390/tok/',
    profile: 'desktop',
    startedAt: '2026-10-11T00:00:00.000Z',
    bootId: '',
    exePath: overrides.exePath ?? '',
    ...overrides,
  }
}

describe('单实例锁', () => {
  test('没有锁文件时直接接管并写下自己', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    const result = acquireInstance(file, 'desktop', { identity: { pid: 111, startedAt: 'now' } })
    expect(result.acquired).toBe(true)
    expect(result.previous).toBeNull()
    expect(readInstance(file)?.pid).toBe(111)
    // 刚接管时还没起服务面：origin 为空，第二个实例这时只能提示「正在启动」
    expect(readInstance(file)?.origin).toBe('')
    rmSync(dir, { recursive: true, force: true })
  })

  test('#202 tasklist CSV 行取镜像名（win32 身份判定的解析层）', () => {
    expect(imageFromTasklist('"launcher.exe","1234","Console","1","45,678 K"')).toBe('launcher.exe')
    expect(imageFromTasklist('"bun.exe","5678","Console","1","12,345 K"')).toBe('bun.exe')
    expect(imageFromTasklist('INFO: No tasks are running which match the specified criteria.')).toBe('')
    expect(imageFromTasklist('')).toBe('')
  })
  test('已有活着的实例 ⇒ 放弃并把它带回来', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, JSON.stringify(record()))
    const result = acquireInstance(file, 'desktop', {
      isAlive: (pid) => pid === 4242,
      isOurProcess: () => true,
      identity: { pid: 999 },
    })
    expect(result.acquired).toBe(false)
    expect(result.previous?.pid).toBe(4242)
    expect(activateUrl(result.previous as InstanceRecord)).toBe(`http://127.0.0.1:6390${ACTIVATE_PATH}`)
    // 锁文件不能被第二个实例覆盖
    expect(readInstance(file)?.pid).toBe(4242)
    rmSync(dir, { recursive: true, force: true })
  })

  test('上次崩了留下的死 pid 能被接管（否则永远起不来）', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, JSON.stringify(record({ pid: 4242 })))
    const result = acquireInstance(file, 'desktop', {
      isAlive: () => false,
      identity: { pid: 777 },
    })
    expect(result.acquired).toBe(true)
    expect(result.previous?.pid).toBe(4242)
    expect(readInstance(file)?.pid).toBe(777)
    rmSync(dir, { recursive: true, force: true })
  })

  test('pid 就是自己 ⇒ 视为自己的锁（restart 路径）', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, JSON.stringify(record({ pid: 555 })))
    const result = acquireInstance(file, 'desktop', { isAlive: () => true, identity: { pid: 555 } })
    expect(result.acquired).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('就绪后回填 origin/pageUrl，只有持有者能改', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, JSON.stringify(record({ pid: 10, origin: '', pageUrl: null })))
    updateInstance(file, 10, { origin: 'http://127.0.0.1:6390', pageUrl: 'http://127.0.0.1:6390/t/' })
    expect(readInstance(file)?.origin).toBe('http://127.0.0.1:6390')
    // 别的进程（比如已经接管的）不许改
    updateInstance(file, 11, { origin: 'http://127.0.0.1:9999' })
    expect(readInstance(file)?.origin).toBe('http://127.0.0.1:6390')
    rmSync(dir, { recursive: true, force: true })
  })

  test('退出清位后，下一个实例能正常接管', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, JSON.stringify(record({ pid: 10 })))
    releaseInstance(file, 10)
    // 清位就是删文件：锁文件的语义是「有文件 = 有实例」，不留假记录
    expect(readInstance(file)).toBeNull()
    const result = acquireInstance(file, 'desktop', { identity: { pid: 12 } })
    expect(result.acquired).toBe(true)
    expect(result.previous).toBeNull()
    expect(readInstance(file)?.pid).toBe(12)
    // 不是自己的记录就不许清（新实例的锁不能被旧进程顺手删掉）
    releaseInstance(file, 10)
    expect(readInstance(file)?.pid).toBe(12)
    rmSync(dir, { recursive: true, force: true })
  })

  test('锁文件已被清掉时 release 是安全的 no-op', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    releaseInstance(file, 10)
    expect(readInstance(file)).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  test('坏文件/非法 pid 当没有锁（不能因为一个坏 json 起不来）', () => {
    expect(parseInstanceRecord('{ not json')).toBeNull()
    expect(parseInstanceRecord('null')).toBeNull()
    expect(parseInstanceRecord('[]')).toBeNull()
    expect(parseInstanceRecord('{"pid":0}')).toBeNull()
    expect(parseInstanceRecord('{"pid":-3}')).toBeNull()
    expect(parseInstanceRecord('{"pid":1.5}')).toBeNull()
    expect(parseInstanceRecord('{"pid":7}')?.profile).toBe('desktop')
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, '{ not json')
    expect(acquireInstance(file, 'web', { identity: { pid: 8 } }).acquired).toBe(true)
    expect(readInstance(file)?.profile).toBe('web')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('#123 锁写不下去时不再谎报持有锁', () => {
  test('锁目录不存在时把它建出来并写成（干净机器首次启动的老坑）', () => {
    const root = tempDir()
    const dir = join(root, 'appsupport', 'nested')
    const file = join(dir, 'shell-instance.json')
    expect(existsSync(dir)).toBe(false)

    const result = acquireInstance(file, 'desktop', { identity: { pid: 111, startedAt: 'now' } })

    expect(existsSync(dir)).toBe(true)
    expect(result.acquired).toBe(true)
    expect(result.lockError).toBeNull()
    expect(readInstance(file)?.pid).toBe(111)
    rmSync(root, { recursive: true, force: true })
  })

  test('真写不进去时 lockError 带上原因，且 acquired 不变 false（不能去激活一个不存在的实例）', () => {
    const root = tempDir()
    // 父路径是一个**普通文件** ⇒ mkdir 必然失败 ⇒ 模拟权限/磁盘满这类真 IO 失败
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const file = join(blocker, 'shell-instance.json')

    const result = acquireInstance(file, 'desktop', { identity: { pid: 222, startedAt: 'now' } })

    expect(result.lockError).not.toBeNull()
    expect(result.lockError).toMatch(/ENOTDIR|EEXIST|not a directory/i)
    // acquired 说的是「有没有另一个活实例」，与「锁写没写成」正交——写失败时仍是 true
    expect(result.acquired).toBe(true)
    expect(result.previous).toBeNull()
    expect(readInstance(file)).toBeNull()
    rmSync(root, { recursive: true, force: true })
  })

  test('writeInstance 直接调：目录不存在则 mkdir；写不成则 ok:false 且有原因', () => {
    const root = tempDir()
    const nested = join(root, 'a', 'b')
    const good = writeInstance(join(nested, 'shell-instance.json'), record({ pid: 333 }))
    expect(good).toEqual({ ok: true, error: null })
    expect(existsSync(nested)).toBe(true)

    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const bad = writeInstance(join(blocker, 'shell-instance.json'), record({ pid: 444 }))
    expect(bad.ok).toBe(false)
    expect(bad.error).toBeTruthy()
    rmSync(root, { recursive: true, force: true })
  })

  test('目录后来才被建出来时，回填 origin 能补上（#123 的连带那条也顺带治好）', () => {
    const root = tempDir()
    const dir = join(root, 'appsupport')
    const file = join(dir, 'shell-instance.json')
    acquireInstance(file, 'desktop', { identity: { pid: 555, startedAt: 'now' } })
    updateInstance(file, 555, { origin: 'http://127.0.0.1:6390', pageUrl: 'http://127.0.0.1:6390/t/' })
    expect(readInstance(file)?.origin).toBe('http://127.0.0.1:6390')
    rmSync(root, { recursive: true, force: true })
  })

  test('已有活实例时 lockError 为 null（让位的路径本来就没写过）', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, JSON.stringify(record({ pid: 4242 })))
    const result = acquireInstance(file, 'desktop', {
      isAlive: (pid) => pid === 4242,
      isOurProcess: () => true,
      identity: { pid: 999 },
    })
    expect(result.acquired).toBe(false)
    expect(result.lockError).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('/__shell__/activate 端点', () => {
  /** 真 HTTP：壳自答端点不要求 token，但必须是 POST。 */
  async function withServer(
    onActivate: (() => void) | undefined,
    run: (origin: string) => Promise<void>,
  ): Promise<void> {
    const dist = tempDir()
    // #168：端口交给系统分配，句柄里的 origin 就是真实端口（不再「先占后放」挑端口，那个窗口会被抢）。
    const server = startShellServer({
      distDir: dist,
      token: 'tok',
      cookie: 'dsh-auth-x=v1.y',
      // #168：上游只是占位（这个 harness 不反代任何东西），固定一个没人听的端口即可，不需要先占后放。
      upstreamOrigin: 'http://127.0.0.1:1',
      port: 0,
      bootPayload: () => null,
      ...(onActivate === undefined ? {} : { onActivate }),
    })
    try {
      await run(server.origin)
    } finally {
      server.stop()
      rmSync(dist, { recursive: true, force: true })
    }
  }

  test('POST ⇒ 204 且回调被调用一次', async () => {
    let calls = 0
    await withServer(
      () => {
        calls += 1
      },
      async (origin) => {
        const response = await fetch(`${origin}${ACTIVATE_PATH}`, { method: 'POST' })
        expect(response.status).toBe(204)
        expect(calls).toBe(1)
      },
    )
  })

  test('GET ⇒ 405（别让 <img>/预取之类误触发）', async () => {
    let calls = 0
    await withServer(
      () => {
        calls += 1
      },
      async (origin) => {
        const response = await fetch(`${origin}${ACTIVATE_PATH}`)
        expect(response.status).toBe(405)
        expect(calls).toBe(0)
      },
    )
  })

  test('无窗口宿主（serve.ts）⇒ 501', async () => {
    await withServer(undefined, async (origin) => {
      const response = await fetch(`${origin}${ACTIVATE_PATH}`, { method: 'POST' })
      expect(response.status).toBe(501)
    })
  })
})

describe('启动阶段与启动界面', () => {
  test('阶段表顺序即进度，ready 是 100', () => {
    expect(SHELL_STAGES.map((entry) => entry.stage)).toEqual([
      'instance',
      'layout',
      'ports',
      'host',
      'cookie',
      'server',
      'ready',
    ])
    expect(stagePercent('ready')).toBe(100)
    expect(stagePercent('instance')).toBe(14)
    expect(stageLabel('host')).toBe('启动 dsh 宿主')
    expect(FAILED_LABEL).toBe('启动失败')
    // 单调递增：不能出现「进度条倒退」
    const percents = SHELL_STAGES.map((entry) => stagePercent(entry.stage))
    for (let index = 1; index < percents.length; index += 1) {
      expect(percents[index] as number).toBeGreaterThan(percents[index - 1] as number)
    }
  })

  test('推阶段/失败的脚本是合法 JS 字面量（引号与换行都得转义）', () => {
    expect(splashStageScript('ready')).toBe(
      'window.__dshSplash && window.__dshSplash.stage("就绪", 100)',
    )
    const tricky = 'bad "quote"\nnewline'
    expect(splashFailScript(tricky)).toBe(
      `window.__dshSplash && window.__dshSplash.fail(${JSON.stringify(tricky)})`,
    )
  })

  test('启动界面 HTML 自带进度与失败出口', () => {
    const html = splashHtml()
    expect(html).toContain('window.__dshSplash')
    expect(html).toContain('id="stage"')
    expect(html).toContain('id="bar"')
    expect(html).toContain('id="error"')
    expect(html).toContain('~/.dsh/shell.log')
    // 失败时把进度条藏掉、红字露出来（纯 CSS，不依赖执行时机）
    expect(html).toContain('body.failed .error')
    expect(SPLASH_WIDTH).toBe(420)
    expect(SPLASH_HEIGHT).toBe(236)
    // 启动界面完全离线：不许有外部资源（起不来时就该只依赖本地）
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')
  })
})

// 系统重启后 pid 会被复用（实测：pid 546 变成了 mobiletimerd）——锁文件里只有 pid 时，
// 误判「已有实例在跑」会让 App 点开就退出，用户看到的是「点了没反应」。
describe('单实例锁：重启 / pid 复用', () => {
  test('锁记录来自上一次开机（bootId 不同）时接管，不误判', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, `${JSON.stringify(record({ pid: 546, bootId: '1759' }))}\n`)
    const result = acquireInstance(file, 'desktop', {
      isAlive: () => true, // 546 这个 pid 现在确实被别家进程占着
      isOurProcess: () => true, // 即使进程身份也像
      bootId: '1800', // 但是另一次开机了
      identity: { pid: 111, startedAt: 'now' },
    })
    expect(result.acquired).toBe(true)
    expect(result.record.bootId).toBe('1800')
    expect(readInstance(file)?.pid).toBe(111)
  })

  test('同一次开机但那个 pid 不是我们的壳进程 ⇒ 接管', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, `${JSON.stringify(record({ pid: 546, bootId: '1759' }))}\n`)
    const result = acquireInstance(file, 'desktop', {
      isAlive: () => true,
      isOurProcess: () => false, // ps 看到的 comm 是 mobiletimerd
      bootId: '1759',
      identity: { pid: 111, startedAt: 'now' },
    })
    expect(result.acquired).toBe(true)
  })

  test('同一次开机 + 确实是我们的壳进程 ⇒ 不接管（原有行为不变）', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, `${JSON.stringify(record({ pid: 546, bootId: '1759' }))}\n`)
    const result = acquireInstance(file, 'desktop', {
      isAlive: () => true,
      isOurProcess: () => true,
      bootId: '1759',
      identity: { pid: 111, startedAt: 'now' },
    })
    expect(result.acquired).toBe(false)
    expect(result.previous?.pid).toBe(546)
  })

  test('老记录（没有 bootId）靠进程身份兜底', () => {
    const dir = tempDir()
    const file = join(dir, 'shell-instance.json')
    writeFileSync(file, `${JSON.stringify(record({ pid: 546 }))}\n`)
    expect(readInstance(file)?.bootId).toBe('')
    const ours = acquireInstance(file, 'desktop', { isAlive: () => true, isOurProcess: () => true, bootId: '1759' })
    expect(ours.acquired).toBe(false)
    const foreign = acquireInstance(file, 'desktop', { isAlive: () => true, isOurProcess: () => false, bootId: '1759' })
    expect(foreign.acquired).toBe(true)
  })

  test('readBootId / defaultIsOurProcess 在异常输入下不抛', () => {
    const bootId = readBootId()
    expect(typeof bootId).toBe('string')
    if (process.platform !== 'darwin') expect(bootId).toBe('')
    // 不存在的 pid ⇒ false（而不是抛）
    expect(defaultIsOurProcess(999_999_999)).toBe(false)
  })
})

describe('/__shell__/window 端点（A5 自绘窗口控制）', () => {
  function withWindowServer(
    onWindowControl: (action: 'minimize' | 'toggle-maximize' | 'close') => void,
    run: (origin: string) => Promise<void>,
    onWindowState?: () => { maximized: boolean },
  ): Promise<void> {
    const dist = tempDir()
    // #168：端口交给系统分配，句柄里的 origin 就是真实端口（不再「先占后放」挑端口，那个窗口会被抢）。
    const server = startShellServer({
      distDir: dist,
      token: 'tok',
      cookie: 'dsh-auth-x=v1.y',
      // #168：上游只是占位（这个 harness 不反代任何东西），固定一个没人听的端口即可，不需要先占后放。
      upstreamOrigin: 'http://127.0.0.1:1',
      port: 0,
      bootPayload: () => null,
      onWindowControl,
      onWindowState,
    })
    try {
      return run(server.origin).finally(() => server.stop())
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  }

  test('POST minimize/toggle-maximize/close ⇒ 204 且动作逐次送达', async () => {
    const seen: string[] = []
    await withWindowServer((action) => void seen.push(action), async (origin) => {
      for (const action of ['minimize', 'toggle-maximize', 'close'] as const) {
        const response = await fetch(`${origin}/__shell__/window`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        expect(response.status).toBe(204)
      }
      expect(seen).toEqual(['minimize', 'toggle-maximize', 'close'])
    })
  })

  test('未知动作 ⇒ 400', async () => {
    await withWindowServer(() => undefined, async (origin) => {
      const response = await fetch(`${origin}/__shell__/window`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'explode' }),
      })
      expect(response.status).toBe(400)
    })
  })

  test('GET ⇒ 405', async () => {
    await withWindowServer(() => undefined, async (origin) => {
      const response = await fetch(`${origin}/__shell__/window`)
      expect(response.status).toBe(405)
    })
  })

  test('GET + onWindowState ⇒ 200 {maximized}（#112 标题栏带图标查询）', async () => {
    let calls = 0
    await withWindowServer(
      () => undefined,
      async (origin) => {
        const response = await fetch(`${origin}/__shell__/window`)
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toEqual({ maximized: true })
        expect(calls).toBe(1)
      },
      () => {
        calls += 1
        return { maximized: true }
      },
    )
  })
})

// #164：splash 也是 hiddenInset 窗，win32/linux 上拖不动。给它一条**只有拖拽、没有关闭键**的
// 标题带：它自动关，给个 ✕ 是给假承诺（点了也不该由用户决定）。
describe('启动界面的标题带（#164）', () => {
  test('darwin 不画带（系统红绿灯现成），带的高度也不占', () => {
    const html = splashHtml('dark', 'darwin')
    expect(html).not.toContain('dlg-titlebar')
    expect(html).toContain('<body>')
    expect(dialogTitlebarFrameHeight(SPLASH_HEIGHT, 'darwin')).toBe(SPLASH_HEIGHT)
  })

  test('win32 / linux 画拖拽带，但不给关闭键', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const html = splashHtml('dark', platform)
      expect(html).toContain('<body class="dlg-with-titlebar">')
      expect(html).toContain('electrobun-webkit-app-region-drag')
      expect(html).toContain('body { position: relative; padding-top: 32px; }')
      // 自动关的窗不给关闭键
      expect(html).not.toContain(DIALOG_CLOSE_ATTR)
      expect(dialogTitlebarFrameHeight(SPLASH_HEIGHT, platform)).toBe(SPLASH_HEIGHT + DIALOG_TITLEBAR_HEIGHT)
    }
  })
})

describe('#202 加固：锁里存 exePath 深验证（防同开机 pid 复用给同名进程误判）', () => {
  const realSpawnSync = Bun.spawnSync
  afterEach(() => {
    ;(Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = realSpawnSync
  })

  /** 按「argv 拼串」键返回假 stdout；未命中键返回空输出（进程不存在/读不到）。 */
  function fakeSpawn(outputs: Record<string, string>): void {
    ;(Bun as { spawnSync: unknown }).spawnSync = ((cmd: readonly string[]) => {
      const stdout = outputs[cmd.join(' ')] ?? ''
      return { stdout: new TextEncoder().encode(stdout) }
    }) as unknown as typeof Bun.spawnSync
  }

  const OURS = '/app/DeepSeekHarnessDesktopBUN/App/bin/bun.exe'

  test('pid 复用给用户自己的 bun（同名不同路径）→ 不认，接管锁', () => {
    fakeSpawn({
      'tasklist /FI PID eq 4242 /FO CSV /NH': '"bun.exe","4242","Console","1","4,096"',
      'ps -p 4242 -o comm=': 'bun',
      'ps -p 4242 -o args=': '/Users/someone/.bun/bin/bun run unrelated-script.js',
    })
    expect(defaultIsOurProcess(4242, OURS)).toBe(false)
  })

  test('可执行路径与锁里一致（大小写/引号差异归一）→ 认', () => {
    fakeSpawn({
      'tasklist /FI PID eq 4242 /FO CSV /NH': '"bun.exe","4242","Console","1","4,096"',
      'ps -p 4242 -o comm=': 'bun',
      'ps -p 4242 -o args=': '"/APP/deepseekharnessdesktopbun/APP/BIN/bun.exe" index.js',
      // Windows 深验证走 PowerShell（键 = argv 拼串）；mac 上不会查到这个键
      "powershell -NoProfile -Command (Get-CimInstance Win32_Process -Filter 'ProcessId = 4242').ExecutablePath": '"/APP/deepseekharnessdesktopbun/APP/BIN/bun.exe"',
    })
    expect(defaultIsOurProcess(4242, OURS)).toBe(true)
  })

  test('深验证读不到路径（进程刚退/权限）→ 不认', () => {
    fakeSpawn({
      'tasklist /FI PID eq 4242 /FO CSV /NH': '"bun.exe","4242","Console","1","4,096"',
      'ps -p 4242 -o comm=': 'bun',
    })
    expect(defaultIsOurProcess(4242, OURS)).toBe(false)
  })

  test('旧锁没有 exePath（升级兼容）→ 回退镜像名粗筛结果', () => {
    fakeSpawn({
      'tasklist /FI PID eq 4242 /FO CSV /NH': '"bun.exe","4242","Console","1","4,096"',
      'ps -p 4242 -o comm=': 'bun',
    })
    expect(defaultIsOurProcess(4242)).toBe(true)
  })

  test('pathMatches：去引号 + 大小写归一后全等', () => {
    expect(pathMatches('"/App/Bin/bun.exe"', '/app/bin/bun.exe')).toBe(true)
    expect(pathMatches('/app/bin/bun.exe', '/other/bun.exe')).toBe(false)
    expect(pathMatches('  ', '')).toBe(false)
  })

  test('firstArgOfPsArgs：取 argv[0]，引号包裹取引号内', () => {
    expect(firstArgOfPsArgs('/usr/bin/bun run x.js')).toBe('/usr/bin/bun')
    expect(firstArgOfPsArgs('"/path with space/bun" --flag')).toBe('/path with space/bun')
    expect(firstArgOfPsArgs('')).toBe('')
  })
})
