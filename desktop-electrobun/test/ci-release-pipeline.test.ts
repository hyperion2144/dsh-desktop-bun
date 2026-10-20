import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extractReleaseNotesFromChangelog } from '../../scripts/lib/release-notes.mjs'

// #213：CI 发布链路（tag → GitHub Release 资产）。
//
// 背景：桌面自动更新的清单与整包都从 `releases/latest/download/` 取，而 CI 只产 CI artifact
// （GitHub 会把 artifact 包一层 zip），发布物从来没进过 Releases ⇒ 自动更新永远 404、
// README 承诺的下载链接也全是 404。这票把「tag push ⇒ 发 Release」接上：
//   - 桌面：tag `desktop/v*` ⇒ 清单 + 整包 + 安装包进同一个 release，桌面 stable 独占 latest；
//   - 移动端：tag `mobile/v*` ⇒ apk/ipa 进 prerelease release，且显式不夺 latest。
//
// 这里的断言把「发布结构」钉成不变量：发布步骤必须只在 tag 上跑（dispatch / 定时兜底只构建、
// 不发版）、发 release 的作业必须带 contents: write、latest 归属必须分开、清单与整包必须同 release。
// 另外用 `check` 子命令做功能断言：tag 版本必须等于版本文件版本、资产集合必须由清单驱动。

// Bun 1.4 内置 YAML 解析；@types/bun（1.4.x）尚未收录 Bun.YAML，这里补一个窄类型。
const bunYaml = (Bun as unknown as { YAML: { parse: (text: string) => unknown } }).YAML

type Step = {
  name?: string
  uses?: string
  run?: string
  if?: string
  shell?: string
  with?: { name?: string }
}

type Job = {
  name?: string
  if?: string
  needs?: string | string[]
  permissions?: { contents?: string }
  steps?: Step[]
}

type Workflow = {
  name?: string
  on?: {
    workflow_dispatch?: unknown
    push?: { tags?: string[]; paths?: string[]; branches?: string[] }
    pull_request?: { paths?: string[] }
    schedule?: Array<{ cron: string }>
    release?: unknown
  }
  jobs?: Record<string, Job>
}

const repoRoot = resolve(import.meta.dir, '..', '..')
const scriptPath = resolve(repoRoot, 'scripts/release-publish.mjs')

const readWorkflow = (file: string): Workflow =>
  bunYaml.parse(readFileSync(resolve(repoRoot, '.github/workflows', file), 'utf8')) as Workflow

const jobOf = (workflow: Workflow, id: string): Job | undefined => workflow.jobs?.[id]

const stepsOf = (workflow: Workflow, id: string): Step[] => jobOf(workflow, id)?.steps ?? []

/** 所有会调发布脚本的步骤（上传 / 发布两步）。effectiveIf = 步骤自己的 if，没有就继承作业的 if。 */
const publishSteps = (
  workflow: Workflow,
): Array<{ job: string; step: Step; effectiveIf: string }> =>
  Object.entries(workflow.jobs ?? {}).flatMap(([id, job]) =>
    (job.steps ?? [])
      .filter((step) => (step.run ?? '').includes('release-publish.mjs'))
      .map((step) => ({ job: id, step, effectiveIf: step.if ?? job.if ?? '' })),
  )

const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true })
})

/** 造一个「假的仓根」：版本文件 + 产物目录，供 `check` 子命令做功能断言。 */
const makeFixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-fixture-'))
  fixtureRoots.push(root)
  mkdirSync(join(root, 'desktop-electrobun/artifacts'), { recursive: true })
  mkdirSync(join(root, 'mobile/expo-app'), { recursive: true })
  writeFileSync(
    join(root, 'desktop-electrobun/electrobun.config.ts'),
    "export const config = {\n  app: {\n    version: '1.2.3',\n  },\n}\n",
  )
  writeFileSync(
    join(root, 'mobile/expo-app/app.json'),
    `${JSON.stringify({ expo: { version: '1.2.3' } }, null, 2)}\n`,
  )
  return root
}

/** 桌面产物：清单 + 整包 + 安装包（清单决定整包名，装机包按清单里的 platform 选）。 */
const writeDesktopArtifacts = (
  root: string,
  options: { bundleName?: string; omitBundle?: boolean; alsoWin?: boolean } = {},
): void => {
  const dir = join(root, 'desktop-electrobun/artifacts')
  const prefix = 'stable-macos-arm64'
  const bundle = options.bundleName ?? `${prefix}-DeepSeekHarnessDesktopBUN.app.tar.zst`
  writeFileSync(
    join(dir, `${prefix}-update.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        identifier: 'com.hyperion.dsh-desktop-bun',
        channel: 'stable',
        version: '1.2.3',
        hash: 'hash0123456789',
        platform: 'macos',
        arch: 'arm64',
        artifact: { file: bundle },
      },
      null,
      2,
    )}\n`,
  )
  if (options.omitBundle !== true) writeFileSync(join(dir, bundle), 'bundle-bytes')
  writeFileSync(join(dir, 'macos-arm64-DeepSeekHarnessDesktopBUN.dmg'), 'dmg-bytes')
  if (options.alsoWin === true) {
    // Windows 的 Electrobun os 词元是 `win`（run 39431630319 实证：清单 stable-win-x64-update.json）
    const winPrefix = 'stable-win-x64'
    const winBundle = `${winPrefix}-DeepSeekHarnessDesktopBUN.app.tar.zst`
    writeFileSync(
      join(dir, `${winPrefix}-update.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          identifier: 'com.hyperion.dsh-desktop-bun',
          channel: 'stable',
          version: '1.2.3',
          hash: 'hash0123456789',
          platform: 'win',
          arch: 'x64',
          artifact: { file: winBundle },
        },
        null,
        2,
      )}\n`,
    )
    writeFileSync(join(dir, winBundle), 'bundle-bytes')
    writeFileSync(join(dir, 'win-x64-DeepSeekHarnessDesktopBUN-setup.exe'), 'setup-bytes')
  }
}

const runScript = (args: string[]): { code: number; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** 找一个「真 Node」（不是 Bun 假扮的）：CI runner 上的 node 就是真 Node。 */
const REAL_NODE_CANDIDATES = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']
const findRealNode = (): string | null => {
  for (const candidate of REAL_NODE_CANDIDATES) {
    if (!existsSync(candidate)) continue
    const probe = spawnSync(candidate, ['-p', 'String(Boolean(process.versions.bun))'], { encoding: 'utf8' })
    if (probe.status === 0 && probe.stdout.trim() === 'false') return candidate
  }
  return null
}

const realNode = findRealNode()

describe('CI 发布链路（#213）', () => {
  test('发布脚本在仓根 scripts/ 下，且被工作流引用', () => {
    expect(existsSync(scriptPath)).toBe(true)
    const desktop = readWorkflow('build.yml')
    const mobile = readWorkflow('mobile.yml')
    const referenced = [...publishSteps(desktop), ...publishSteps(mobile)]
    expect(referenced.length).toBeGreaterThan(0)
    for (const { step } of referenced) expect(step.run).toContain('scripts/release-publish.mjs')
  })

  test('发版作业必须带 contents: write（仓库默认权限是 read-only）', () => {
    const desktop = readWorkflow('build.yml')
    const mobile = readWorkflow('mobile.yml')
    expect(jobOf(desktop, 'build')?.permissions?.contents).toBe('write')
    expect(jobOf(desktop, 'release')?.permissions?.contents).toBe('write')
    expect(jobOf(mobile, 'build-mobile')?.permissions?.contents).toBe('write')
    expect(jobOf(mobile, 'build-harmony')?.permissions?.contents).toBe('write')
    expect(jobOf(mobile, 'release')?.permissions?.contents).toBe('write')
  })

  test('发布步骤只在 tag 上跑：dispatch / 每日兜底只构建、不发版', () => {
    const desktop = readWorkflow('build.yml')
    const mobile = readWorkflow('mobile.yml')
    const steps = [...publishSteps(desktop), ...publishSteps(mobile)]
    expect(steps.length).toBeGreaterThan(0)
    for (const { effectiveIf } of steps) {
      expect(effectiveIf).toContain('refs/tags/')
    }
    // 桌面发布步骤认 desktop/v*，移动端认 mobile/v*：命名空间不串。
    const desktopGates = publishSteps(desktop).map(({ effectiveIf }) => effectiveIf).join('\n')
    const mobileGates = publishSteps(mobile).map(({ effectiveIf }) => effectiveIf).join('\n')
    expect(desktopGates).toContain('refs/tags/desktop/v')
    expect(desktopGates).not.toContain('refs/tags/mobile/v')
    expect(mobileGates).toContain('refs/tags/mobile/v')
    expect(mobileGates).not.toContain('refs/tags/desktop/v')
    // 脚本调用也不许串通道。
    const desktopRuns = publishSteps(desktop).map(({ step }) => step.run ?? '').join('\n')
    const mobileRuns = publishSteps(mobile).map(({ step }) => step.run ?? '').join('\n')
    expect(desktopRuns).toContain('--kind desktop')
    expect(desktopRuns).not.toContain('--kind mobile')
    expect(mobileRuns).toContain('--kind mobile')
    expect(mobileRuns).not.toContain('--kind desktop')
  })

  test('桌面：上传与发布分开——三平台矩阵并发上传，等齐了才把 draft 翻成 published', () => {
    const desktop = readWorkflow('build.yml')
    const releaseJob = jobOf(desktop, 'release')
    expect(releaseJob?.needs).toBe('build')
    expect(releaseJob?.if ?? '').toContain("startsWith(github.ref, 'refs/tags/desktop/v')")
    const buildRuns = stepsOf(desktop, 'build')
      .map((step) => step.run ?? '')
      .join('\n')
    expect(buildRuns).toContain('release-publish.mjs upload --kind desktop')
    const releaseRuns = stepsOf(desktop, 'release')
      .map((step) => step.run ?? '')
      .join('\n')
    expect(releaseRuns).toContain('release-publish.mjs publish --kind desktop')
    // upload 必须在 build 里（矩阵并发上传），publish 只能在 release 里（串行收口）。
    expect(releaseRuns).not.toContain('upload --kind desktop')
  })

  test('移动端：上传在出包作业里，发布等出包齐了再发（鸿蒙默认跳过不卡发布）', () => {
    const mobile = readWorkflow('mobile.yml')
    const releaseJob = jobOf(mobile, 'release')
    const needs = Array.isArray(releaseJob?.needs) ? releaseJob?.needs ?? [] : [releaseJob?.needs]
    expect(needs).toContain('build-mobile')
    expect(needs).toContain('build-harmony')
    const condition = releaseJob?.if ?? ''
    expect(condition).toContain('always()')
    expect(condition).toContain("needs.build-mobile.result == 'success'")
    expect(condition).toContain("needs.build-harmony.result == 'skipped'")
    const buildRuns = stepsOf(mobile, 'build-mobile')
      .map((step) => step.run ?? '')
      .join('\n')
    expect(buildRuns).toContain('release-publish.mjs upload --kind mobile')
    const releaseRuns = stepsOf(mobile, 'release')
      .map((step) => step.run ?? '')
      .join('\n')
    expect(releaseRuns).toContain('release-publish.mjs publish --kind mobile')
  })

  test('不用 release 事件当触发点：GITHUB_TOKEN 建的 release 不会触发新 run', () => {
    const desktop = readWorkflow('build.yml')
    const mobile = readWorkflow('mobile.yml')
    expect(desktop.on?.release).toBeUndefined()
    expect(mobile.on?.release).toBeUndefined()
  })

  test('check.yml 的 paths 覆盖到发布脚本目录（脚本改动要过门禁）', () => {
    const check = readWorkflow('check.yml')
    const paths = [...(check.on?.push?.paths ?? []), ...(check.on?.pull_request?.paths ?? [])]
    expect(paths).toContain('scripts/**')
    expect(paths).toContain('.github/workflows/build.yml')
    expect(paths).toContain('.github/workflows/mobile.yml')
  })

  test('check 子命令：Windows 的 Electrobun os 词元是 win（stable-win-x64 清单照样收）', () => {
    const root = makeFixture()
    writeDesktopArtifacts(root, { alsoWin: true })
    const result = runScript(['check', '--kind', 'desktop', '--tag', 'desktop/v1.2.3', '--root', root])
    expect(result.code).toBe(0)
    const summary = JSON.parse(result.stdout) as { assets: Array<{ name: string }> }
    const names = summary.assets.map((asset) => asset.name)
    expect(names).toContain('stable-win-x64-update.json')
    expect(names).toContain('win-x64-DeepSeekHarnessDesktopBUN-setup.exe')
  })

  test('check 子命令：桌面资产集合由更新链清单驱动（清单 + 整包 + 安装包）', () => {
    const root = makeFixture()
    writeDesktopArtifacts(root)
    const result = runScript(['check', '--kind', 'desktop', '--tag', 'desktop/v1.2.3', '--root', root])
    expect(result.code).toBe(0)
    const summary = JSON.parse(result.stdout) as {
      version: string
      assets: Array<{ name: string; role: string }>
    }
    expect(summary.version).toBe('1.2.3')
    const names = summary.assets.map((asset) => asset.name)
    expect(names).toContain('stable-macos-arm64-update.json')
    expect(names).toContain('stable-macos-arm64-DeepSeekHarnessDesktopBUN.app.tar.zst')
    expect(names).toContain('macos-arm64-DeepSeekHarnessDesktopBUN.dmg')
    expect(summary.assets.find((asset) => asset.name.endsWith('-update.json'))?.role).toBe('manifest')
  })

  test('tag 版本必须等于版本文件版本：漂了就拒绝发版', () => {
    const root = makeFixture()
    writeDesktopArtifacts(root)
    const result = runScript(['check', '--kind', 'desktop', '--tag', 'desktop/v9.9.9', '--root', root])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('版本文件版本')
  })

  test('tag 命名空间不对直接拒绝（桌面 / 移动端不许串）', () => {
    const root = makeFixture()
    writeDesktopArtifacts(root)
    const result = runScript(['check', '--kind', 'desktop', '--tag', 'mobile/v1.2.3', '--root', root])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('tag 命名空间不对')
  })

  test('清单指向的整包不在产物目录就拒绝（清单 + 整包必须同时在）', () => {
    const root = makeFixture()
    writeDesktopArtifacts(root, { omitBundle: true })
    const result = runScript(['check', '--kind', 'desktop', '--tag', 'desktop/v1.2.3', '--root', root])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('不在产物目录里')
  })

  test('清单的 artifact.file 必须以 <prefix>- 开头（Updater 的硬校验）', () => {
    const root = makeFixture()
    writeDesktopArtifacts(root, { bundleName: 'DeepSeekHarnessDesktopBUN.app.tar.zst' })
    const result = runScript(['check', '--kind', 'desktop', '--tag', 'desktop/v1.2.3', '--root', root])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('没有以 stable-macos-arm64- 开头')
  })

  test('移动端资产按扩展名认平台，并改名带上版本', () => {
    const root = makeFixture()
    const apk = join(root, 'app-debug.apk')
    writeFileSync(apk, 'apk-bytes')
    const result = runScript([
      'check',
      '--kind',
      'mobile',
      '--tag',
      'mobile/v1.2.3',
      '--root',
      root,
      '--asset',
      apk,
    ])
    expect(result.code).toBe(0)
    const summary = JSON.parse(result.stdout) as { assets: Array<{ name: string }> }
    expect(summary.assets.map((asset) => asset.name)).toEqual(['dsh-mobile-android-v1.2.3.apk'])
  })

  test('发布脚本只用 Node 与 Bun 都有的 API', () => {
    // `import.meta.dir` 只有 Bun 有：CI runner 上的 node 是真 Node，用了就在 runner 上直接崩。
    // 只看代码行：注释里提到这个名字不算。
    const code = readFileSync(scriptPath, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n')
    expect(code).not.toContain('import.meta.dir')
    expect(code).toContain('fileURLToPath')
  })

  test.skipIf(realNode === null)('真实 Node（不是 Bun）也能跑发布脚本', () => {
    const root = makeFixture()
    writeDesktopArtifacts(root)
    const result = spawnSync(
      realNode as string,
      [scriptPath, 'check', '--kind', 'desktop', '--tag', 'desktop/v1.2.3', '--root', root],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('stable-macos-arm64-update.json')
  })

    // 桌面与移动端各自一本 changelog（CHANGELOG.md / CHANGELOG-mobile.md），提取只认版本段。
    const SAMPLE_DESKTOP_CHANGELOG = [
        '# Changelog',
        '',
        '## [1.2.3] - 2026-10-20',
        '',
        '首个版本：介绍一句。',
        '',
        '- 桌面能力 A。',
        '',
        '### 工程与交付',
        '',
        '- CI 能力 B。',
        '',
        '## [1.2.2] - 2026-09-01',
        '',
        '旧版本说明。',
    ].join('\n')

    const SAMPLE_MOBILE_CHANGELOG = [
        '# Changelog（移动端）',
        '',
        '## [1.2.3] - 2026-10-20',
        '',
        '- 移动能力 C。',
    ].join('\n')

    test('发布步骤显式 shell: bash——Windows 默认 pwsh 会把 "$TAG" 当 PowerShell 变量展开成空（run 39425440773 实证）', () => {
        const desktop = readWorkflow('build.yml')
        const mobile = readWorkflow('mobile.yml')
        const steps = [...publishSteps(desktop), ...publishSteps(mobile)]
        expect(steps.length).toBeGreaterThan(0)
        for (const { step } of steps) expect(step.shell).toBe('bash')
    })

    test('CHANGELOG 发布正文提取：取 [版本] 整段，到下一个 ## 止（不吞其他版本）', () => {
        const notes = extractReleaseNotesFromChangelog(SAMPLE_DESKTOP_CHANGELOG, '1.2.3')
        expect(notes).toContain('首个版本：介绍一句。')
        expect(notes).toContain('- 桌面能力 A。')
        expect(notes).toContain('- CI 能力 B。')
        expect(notes).not.toContain('# Changelog')
        expect(notes).not.toContain('旧版本说明')
    })

    test('移动端 changelog 用同一个提取函数：各文件各取各段，互不串', () => {
        const mobile = extractReleaseNotesFromChangelog(SAMPLE_MOBILE_CHANGELOG, '1.2.3')
        expect(mobile).toContain('- 移动能力 C。')
        expect(mobile).not.toContain('桌面能力')
    })

    test('CHANGELOG 没有对应版本段 → null（脚本回落内置一句话）', () => {
        expect(extractReleaseNotesFromChangelog(SAMPLE_DESKTOP_CHANGELOG, '9.9.9')).toBeNull()
        expect(extractReleaseNotesFromChangelog(SAMPLE_MOBILE_CHANGELOG, '9.9.9')).toBeNull()
    })
})
