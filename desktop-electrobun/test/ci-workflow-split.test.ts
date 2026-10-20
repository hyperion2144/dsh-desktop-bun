import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// #212：桌面与移动端必须跑在两条独立流水线上。
//
// 背景：原先一份 build.yml 同时装着桌面三平台矩阵与移动端出包（Android / iOS / 鸿蒙），
// 任一触发面（手动 dispatch / tag push / 每日定时兜底）都会 fan-out 出全套作业——手机端
// 代码一行没改也照打一遍 apk/ipa（约 13–14 runner-分钟，占整条流水线三分之一）。
// 拆开后（#212）：
//   - build.yml（桌面）：tag 只认 desktop/v*
//   - mobile.yml（移动端）：tag 只认 mobile/v*
//
// 这里的断言把「拆分结构」钉成不变量：作业与产物的归属、tag 命名空间互斥、两条 cron
// 各自独立（错峰）、桌面那条的 shots-only 快车道没被拆丢、check.yml 覆盖到新工作流文件。

// Bun 1.4 内置 YAML 解析；@types/bun（1.4.x）尚未收录 Bun.YAML，这里补一个窄类型。
const bunYaml = (Bun as unknown as { YAML: { parse: (text: string) => unknown } }).YAML

type Step = {
  name?: string
  uses?: string
  with?: { name?: string }
}

type Job = {
  name?: string
  if?: string
  steps?: Step[]
}

type Workflow = {
  name?: string
  on?: {
    workflow_dispatch?: unknown
    push?: { tags?: string[]; paths?: string[]; branches?: string[] }
    pull_request?: { paths?: string[] }
    schedule?: Array<{ cron: string }>
  }
  jobs?: Record<string, Job>
}

const repoRoot = resolve(import.meta.dir, '..', '..')

const readWorkflow = (file: string): Workflow =>
  bunYaml.parse(readFileSync(resolve(repoRoot, '.github/workflows', file), 'utf8')) as Workflow

const jobIds = (workflow: Workflow): string[] => Object.keys(workflow.jobs ?? {})

const artifactNames = (workflow: Workflow): string[] =>
  Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => (step.uses ?? '').startsWith('actions/upload-artifact'))
    .map((step) => step.with?.name)
    .filter((name): name is string => typeof name === 'string')

describe('CI 桌面 / 移动端流水线拆分（#212）', () => {
  test('两份工作流都能解析出触发面与作业', () => {
    const desktop = readWorkflow('build.yml')
    const mobile = readWorkflow('mobile.yml')
    expect(desktop.on).toBeDefined()
    expect(mobile.on).toBeDefined()
    expect(jobIds(desktop)).toContain('build')
    expect(jobIds(mobile)).toContain('build-mobile')
  })

  test('桌面流水线不再带移动端出包作业与产物', () => {
    const desktop = readWorkflow('build.yml')
    expect(jobIds(desktop)).not.toContain('build-mobile')
    expect(jobIds(desktop)).not.toContain('build-harmony')
    const artifacts = artifactNames(desktop)
    expect(artifacts).not.toContain('dsh-mobile-android-apk')
    expect(artifacts).not.toContain('dsh-mobile-ios-ipa')
    expect(artifacts).not.toContain('dsh-mobile-harmony-hap')
  })

  test('桌面流水线的 shots-only 快车道仍在（#103 不能被拆丢）', () => {
    expect(jobIds(readWorkflow('build.yml'))).toContain('installer-ui-shots')
  })

  test('移动端出包作业与产物都归 mobile.yml', () => {
    const mobile = readWorkflow('mobile.yml')
    expect(jobIds(mobile)).toContain('build-mobile')
    expect(jobIds(mobile)).toContain('build-harmony')
    const artifacts = artifactNames(mobile)
    expect(artifacts).toContain('dsh-mobile-android-apk')
    expect(artifacts).toContain('dsh-mobile-ios-ipa')
    expect(artifacts).toContain('dsh-mobile-harmony-hap')
    // 桌面产物不出现在移动端流水线里
    expect(artifacts.filter((name) => name.startsWith('dsh-desktop-shell-'))).toEqual([])
  })

  test('tag 命名空间互斥：桌面只认 desktop/v*，移动端只认 mobile/v*', () => {
    const desktopTags = readWorkflow('build.yml').on?.push?.tags ?? []
    const mobileTags = readWorkflow('mobile.yml').on?.push?.tags ?? []
    expect(desktopTags).toEqual(['desktop/v*'])
    expect(mobileTags).toEqual(['mobile/v*'])
    expect(desktopTags.filter((tag) => mobileTags.includes(tag))).toEqual([])
    // 旧的全匹配 '**' 会把两端 tag 一起吃掉（#212 的根因之一），必须消失
    expect(desktopTags).not.toContain('**')
    expect(mobileTags).not.toContain('**')
  })

  test('两端各留一条互不相同的定时兜底（错峰不抢 runner）', () => {
    const desktopCron = (readWorkflow('build.yml').on?.schedule ?? []).map((entry) => entry.cron)
    const mobileCron = (readWorkflow('mobile.yml').on?.schedule ?? []).map((entry) => entry.cron)
    expect(desktopCron).toEqual(['30 18 * * *'])
    expect(mobileCron).toEqual(['0 19 * * *'])
    expect(desktopCron.filter((cron) => mobileCron.includes(cron))).toEqual([])
  })

  test('check.yml 的 paths 覆盖到新拆出的移动端工作流', () => {
    const check = readWorkflow('check.yml')
    const paths = [...(check.on?.push?.paths ?? []), ...(check.on?.pull_request?.paths ?? [])]
    expect(paths).toContain('.github/workflows/build.yml')
    expect(paths).toContain('.github/workflows/check.yml')
    expect(paths).toContain('.github/workflows/mobile.yml')
  })
})
