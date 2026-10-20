import { describe, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'

// #90 端到端集成：把「品牌图 → NSIS 脚本 → makensis → 产物断言」整条链跑一遍。
//
// 为什么要复制出一棵临时工程树：`build-windows-installer.mjs` 用 `resolve(import.meta.dir, '..')`
// 定 projectRoot，直接在本仓跑会去啃 CI/本机真实的 build/ 产物（几百 MB、要真 makensis）。
// 复制成隔离树 + 假 makensis 之后，这条测试在 macOS/Linux/Windows 上都能跑，
// 且只断言「接线对不对」——真正的 NSIS 编译留给 CI 的 Windows job（build.yml）。
//
// 真 makensis 编译覆盖不到的接线错误（守卫缺失、include 顺序、页面少一页、占位符没替换）
// 恰好是这套断言的重点。

const projectRoot = join(import.meta.dir, '..')

// Windows runner 上品牌图生成 + 子进程启动会偶发超过 Bun 默认 5s；端到端链路给它更宽预算。
const INSTALLER_E2E_TIMEOUT_MS = 30_000

/** 假 makensis：按脚本里的 OutFile 写出一份给定大小的产物，模拟编译成功。 */
const fakeMakensisSource = `#!/usr/bin/env bun
const args = process.argv.slice(2)
const script = args[args.length - 1]
const text = await Bun.file(script).text()
const hit = /OutFile\\s+"([^"]+)"/.exec(text)
if (hit === null) {
  console.error('fake makensis: 脚本里找不到 OutFile')
  process.exit(1)
}
const size = Number(process.env.DSH_FAKE_MAKENSIS_SIZE ?? '2000000')
await Bun.write(hit[1], new Uint8Array(size))
console.log('fake makensis: 写出 ' + hit[1] + '（' + String(size) + ' B）')
`

interface Harness {
  root: string
  scriptPath: string
  nsiPath: string
  artifactPath: string
  binDir: string
  env: Record<string, string | undefined>
}

/** 搭一棵隔离工程树：脚本 + installer/（ui.nsh、strings.nsh、品牌图）+ stub 构建树 + 假 makensis。 */
function makeHarness(prefix = 'dsh-installer-build-'): Harness {
  // realpath：macOS 的 tmpdir 是 /var/... 符号链接，而生成器用 resolve() 拿到 /private/var/...，
  // 不归一化的话下面按路径比 !include 会假失败。
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'resources'), { recursive: true })
  cpSync(join(projectRoot, 'scripts', 'build-windows-installer.mjs'), join(root, 'scripts', 'build-windows-installer.mjs'))
  // #103：安装界面拆成六个 .nsh（strings/theme/drawing/pages/preview/ui）+ tools 里的位图编码器，
  // 整棵 installer/ 一起拷（只拷 ui.nsh + strings.nsh 的时代结束了）
  cpSync(join(projectRoot, 'installer'), join(root, 'installer'), { recursive: true })
  cpSync(join(projectRoot, 'resources', 'app-icon.ico'), join(root, 'resources', 'app-icon.ico'))
  // 品牌图是构建物（.gitignore 掉了），这里用真生成器现场产出，不依赖本机是否跑过 prepare:installer-assets。
  cpSync(join(projectRoot, 'scripts', 'prepare-installer-assets.mjs'), join(root, 'scripts', 'prepare-installer-assets.mjs'))
  const assets = spawnSync(process.execPath, [join(root, 'scripts', 'prepare-installer-assets.mjs')], { encoding: 'utf8' })
  if (assets.status !== 0) throw new Error(`品牌图生成失败：${assets.stderr || assets.stdout}`)

  // stub 构建树：Electrobun 的 Windows 产物长这样（bin/launcher.exe），不带 *.tar.zst
  // ⇒ 走「跳过自解压重命名」分支，不会去下载 zstd。
  const buildDir = join(root, 'build', 'stable-windows-x64', 'DeepSeekHarnessDesktopBUN')
  mkdirSync(join(buildDir, 'bin'), { recursive: true })
  mkdirSync(join(buildDir, 'Resources'), { recursive: true })
  writeFileSync(join(buildDir, 'bin', 'launcher.exe'), 'stub launcher')
  writeFileSync(join(buildDir, 'Resources', 'app.asar'), 'stub payload')

  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'makensis'), fakeMakensisSource)
  chmodSync(join(binDir, 'makensis'), 0o755)
  writeFileSync(join(binDir, 'makensis.cmd'), '@bun "%~dp0makensis" %*\r\n')
/** 假 rcedit：把参数记到 fake-rcedit.log，模拟补丁成功（接线验证）。 */
const fakeRceditSource = `import { writeFileSync } from 'node:fs'
writeFileSync('fake-rcedit.log', process.argv.slice(2).join(' ') + '\\n')
console.log('fake rcedit: 补丁完成（假工具）')
`
  // 假 rcedit：真 rcedit 对占位 launcher.exe（非 PE）会拒载，集成测试用它验证 rcedit 段接线；
  // 真 rcedit 链由快验 CI 的「安装器构建」step（notepad.exe 真替身）负责验证。
  writeFileSync(join(binDir, 'fake-rcedit.mjs'), fakeRceditSource)
  chmodSync(join(binDir, 'fake-rcedit.mjs'), 0o755)
  writeFileSync(join(binDir, 'fake-rcedit.cmd'), '@bun "%~dp0fake-rcedit.mjs" %*\r\n')

  return {
    root,
    scriptPath: join(root, 'scripts', 'build-windows-installer.mjs'),
    nsiPath: join(root, 'build', 'installer-windows.nsi'),
    artifactPath: join(root, 'artifacts', 'windows-x64-DeepSeekHarnessDesktopBUN-setup.exe'),
    binDir,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      DSH_INSTALLER_RCEDIT: join(binDir, process.platform === 'win32' ? 'fake-rcedit.cmd' : 'fake-rcedit.mjs'),
    },
  }
}

function runGenerator(h: Harness, extraEnv: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [h.scriptPath], {
    cwd: h.root,
    env: { ...h.env, ...extraEnv },
    encoding: 'utf8',
  })
}

describe('#90 安装器构建链端到端集成', () => {
  test('整条链跑通：品牌图 → .nsi（五块能力齐全）→ makensis → 产物存在', () => {
    const h = makeHarness()
    try {
      const run = runGenerator(h)
      expect(run.stderr).not.toContain('缺品牌图')
      expect(run.status).toBe(0)

      // 生成的脚本：BOM + 五块能力（事务安装 / 品牌图 / 自定义 UI 三页 / 主题 / 压缩 + 双语）
      const script = readFileSync(h.nsiPath, 'utf8')
      expect(script.charCodeAt(0)).toBe(0xfeff)
      expect(script).not.toContain('SetCompressor /FINAL /SOLID lzma')   // 压缩回退 zlib 默认（真机拍板解压速度优先）
       // #103：界面拆成四个脚本，include 顺序 = 文案 → 主题 → 绘制 → 交互（依赖方向）
       // 比 include 语句本身：注释里也会提到这些文件名，不能拿裸文件名比先后
       // 路径用正则比：Windows 临时目录可能是 8.3 短名（RUNNER~1），与子进程解析出的长名不一致
       const includeOrder = ['strings.nsh', 'theme.nsh', 'drawing.nsh', 'ui.nsh']
      const includeAt = includeOrder.map((name) => script.search(new RegExp(`!include "[^"]*installer[\\\\/]${name.replace('.', '\\.')}"`)))
      for (const at of includeAt) expect(at).toBeGreaterThan(-1)
      expect(includeAt).toEqual([...includeAt].sort((a, b) => a - b))
      expect(script).toContain('Page custom DshWelcomeCreate DshWelcomeLeave')
      expect(script).toContain('Page instfiles "" DshProgressShow')
      expect(script).toContain('Page custom DshFinishCreate DshFinishLeave')
      expect(script).toContain('Call DshPromoteDirectories') // 事务性安装的提交点
      expect(script).toContain('Function DshRollbackDirectories')
      expect(script).toContain('Function un.DshRemoveAppTree')
      expect(script).toContain('Call DshResolveLanguage') // 语言在 .onInit 里定
      // 品牌图由 ui.nsh 的 DshReleaseBrandFiles 宏在编译期展开，文本不在 .nsi 里；
      // 集成链上能验的是：宏拿到的目录 define 正确，且生成器真把十七张图都写出来了。
      expect(script).toMatch(/!define DSH_INSTALLER_ASSETS "[^"]*installer[\\/]assets"/)
      const brandAssets = [
        'brand.bmp',
        'brand-2x.bmp',
        'brand-dark.bmp',
        'brand-dark-2x.bmp',
        'uninstaller-sidebar.bmp',
        'whale.bmp',
        'whale-2x.bmp',
        'whale-dark.bmp',
        'whale-dark-2x.bmp',
        'card.bmp',
        'card-2x.bmp',
        'card-dark.bmp',
        'card-dark-2x.bmp',
        'check-circle.bmp',
        'check-circle-2x.bmp',
        'check-circle-dark.bmp',
        'check-circle-dark-2x.bmp',
      ]
      for (const name of brandAssets) {
        expect(existsSync(join(h.root, 'installer', 'assets', name))).toBe(true)
      }
      // #103：UI 解包清单覆盖全部贴图（ui.nsh 的 File /oname 是唯一消费者），少一张真机就是空窗
      const uiNshText = readFileSync(join(h.root, 'installer', 'ui.nsh'), 'utf8')
      for (const name of ['whale.bmp', 'whale-dark.bmp', 'whale-2x.bmp', 'whale-dark-2x.bmp', 'card.bmp', 'card-dark.bmp', 'card-2x.bmp', 'card-dark-2x.bmp', 'check-circle.bmp', 'check-circle-dark.bmp', 'check-circle-2x.bmp', 'check-circle-dark-2x.bmp']) {
        expect(uiNshText).toContain(`File "/oname=$PLUGINSDIR\\${name}" "\${DSH_INSTALLER_ASSETS}\\${name}"`)
      }
      // 模板里的 @@占位符必须全部被替换掉（漏一个就是编译期才会炸的错）
      expect(script).not.toContain('@@')

      // 假 makensis 写出的产物 ≥ 生成器的最小体积门限
      expect(existsSync(h.artifactPath)).toBe(true)
      expect(statSync(h.artifactPath).size).toBeGreaterThanOrEqual(1_000_000)
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  }, INSTALLER_E2E_TIMEOUT_MS)

  test('产物小到不可能是安装器时，生成器按退出码 1 拦住', () => {
    const h = makeHarness()
    try {
      const run = runGenerator(h, { DSH_FAKE_MAKENSIS_SIZE: '1024' })
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('产物异常地小')
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  }, INSTALLER_E2E_TIMEOUT_MS)

  test('缺品牌图时给出可执行的下一步（#92 守卫在集成链上仍然生效）', () => {
    const h = makeHarness()
    try {
      rmSync(join(h.root, 'installer', 'assets', 'brand-dark-2x.bmp'), { force: true })
      // ⚠️ 这里删的是 brandAssets 守卫清单里的图；该清单没包含四个 whale*.bmp，而编译期真正被
      // ui.nsh 消费的正是它们（见报告「产品缺陷」）——按现状只验 brand 系列的守卫仍然生效。
      const run = runGenerator(h)
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('缺品牌图')
      expect(run.stderr).toContain('bun run prepare:installer-assets')
    } finally {
      rmSync(h.root, { recursive: true, force: true })
    }
  }, INSTALLER_E2E_TIMEOUT_MS)
})
