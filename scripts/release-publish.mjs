#!/usr/bin/env node
/**
 * CI 发布脚本（#213）：把构建产物发成 GitHub Release 资产。
 *
 * 为什么要有这个脚本，而不是在 workflow 里堆一串 `gh` 命令：
 *   · **版本校验必须先于发版**：tag 里的版本要和版本文件一致，不一致就不许发。
 *     tag 是人写的，版本文件也是人写的，两边漂了就会发出一个「清单说 0.1.0、tag 说 0.2.0」的
 *     release——用户点进去看到的版本对不上。
 *   · **资产集合必须以更新链清单为准**：Electrobun 的 Updater 先取
 *     `<channel>-<os>-<arch>-update.json`，再按清单里的 `artifact.file` 下载整包
 *     （`${baseUrl}/${encodeURIComponent(artifact.file)}`，与清单同源）。所以「清单 + 整包」
 *     必须在**同一个 release** 上，名字还要逐字一致（GitHub 会规整带特殊字符/首尾点的文件名）。
 *     硬编码整包文件名迟早漏传某个平台 ⇒ 这里从清单反查整包。
 *   · **latest 是仓库级单指针**：`releases/latest` 只解析到「显式标记为 latest 的那个 release，
 *     没有显式标记时才是最近的非 draft 非 prerelease」（官方 REST 文档）。桌面 stable / 桌面 canary /
 *     移动端三条通道抢同一个指针 ⇒ 桌面 stable 显式占 latest，其余显式不占。
 *   · **资产不能原地替换**：同名重传 REST 返 422，`--clobber` 是「先删后传」（传失败原资产就没了），
 *     PATCH 只能改 name/label 没有内容字段 ⇒ 同一个 tag 重发要删掉整个 release 重建或换新 tag。
 *     本脚本遇到「同名但大小不同」直接失败并说明，不偷偷覆盖。
 *
 * 三个子命令：
 *   check    只做本地校验（不联网、不发版）：tag 形状、版本一致性、清单与整包、资产存在。
 *   upload   校验 + 建/复用 draft release + 上传资产 + 回读断言。
 *   publish  draft → published（按通道决定 latest 归属）+ 资产完整性断言 + latest 指针回读。
 *
 * 为什么 upload 与 publish 分开：桌面三平台矩阵是并发跑的，各自上传自己那份资产；
 * 只有等三条腿都传完，才把 draft 翻成 published（官方推荐的 draft → 传完 → publish 顺序，
 * 也兼容将来的 immutable releases）。中途失败就停在 draft，对外看不见半成品。
 *
 * 用法：
 *   node scripts/release-publish.mjs check   --kind desktop --tag desktop/v0.1.0
 *   node scripts/release-publish.mjs upload  --kind desktop --tag desktop/v0.1.0
 *   node scripts/release-publish.mjs publish --kind mobile  --tag mobile/v0.1.0
 *
 * 凭据：GH_TOKEN 环境变量（CI 里是 job 级 `permissions: contents: write` 的 GITHUB_TOKEN）。
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓根 = 脚本所在目录的上一级。Node 与 Bun 都要能跑（`import.meta.dir` 只有 Bun 有）。 */
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

/** 两条通道的差异都在这张表里：tag 命名空间、版本真源、latest 归属。 */
const KINDS = {
  desktop: {
    tagPrefix: 'desktop/v',
    versionFile: 'desktop-electrobun/electrobun.config.ts',
    defaultArtifactDir: 'desktop-electrobun/artifacts',
    /** 桌面 stable 独占 latest：updater 的 baseUrl 写死 `releases/latest/download`。 */
    latest: true,
    prerelease: false,
    title: '桌面版',
    notes: '桌面版构建产物：安装包 + 自动更新清单（<platformPrefix>-update.json）+ 更新整包。',
  },
  mobile: {
    tagPrefix: 'mobile/v',
    versionFile: 'mobile/expo-app/app.json',
    defaultArtifactDir: null,
    /** 移动端不夺 latest：它跟桌面 stable 共用一个仓库级 latest 指针。 */
    latest: false,
    /** 再加一层保险：prerelease 永远不会被解析成 latest。 */
    prerelease: true,
    title: '手机访问版',
    notes: '手机访问版构建产物：Android debug 签名 APK / iOS 未签名 IPA（侧载用）。',
  },
}

/** 桌面各平台的「交给人的安装包」在产物目录里的形状。 */
const INSTALLER_PATTERNS = {
  macos: ['*.dmg'],
  windows: ['*-setup.exe'],
  linux: ['linux-*.tar.gz'],
}

/** 移动端资产扩展名 → 平台标签（决定发布出来的文件名）。 */
const MOBILE_PLATFORM_BY_EXT = {
  '.apk': 'android',
  '.ipa': 'ios',
  '.hap': 'harmony',
}

/** 桌面必须齐的三平台（build.yml 的矩阵）。 */
const DESKTOP_PLATFORMS = ['macos', 'windows', 'linux']

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function log(message) {
  console.log(`[release-publish] ${message}`)
}

function fail(message) {
  throw new Error(message)
}

/** 极简 glob 匹配（只支持 `*`，且不跨 `/`）。 */
function matchGlob(pattern, name) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`).test(name)
}

function listFiles(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// 领域层：tag / 版本 / 资产集合
// ---------------------------------------------------------------------------

/** tag → 版本号。命名空间不对就是错，别猜。 */
function parseTag(tag, kind) {
  const spec = KINDS[kind]
  if (!spec) fail(`未知的通道：${kind}`)
  if (!tag.startsWith(spec.tagPrefix)) {
    fail(`tag 命名空间不对：${tag} 不属于 ${kind} 通道（应以 ${spec.tagPrefix} 开头）`)
  }
  const version = tag.slice(spec.tagPrefix.length)
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`tag 里的版本号形状不对：${tag}（期望 x.y.z）`)
  }
  return version
}

/**
 * 版本真源（维护者 2026-10-20 拍板 Q4）：
 *   桌面 = electrobun.config.ts 的 app.version（更新链清单里的 version 也取自它）
 *   移动端 = mobile/expo-app/app.json 的 expo.version
 */
function expectedVersion(kind, root) {
  const spec = KINDS[kind]
  const file = join(root, spec.versionFile)
  if (!existsSync(file)) fail(`版本文件不存在：${file}`)
  if (kind === 'desktop') {
    const source = readFileSync(file, 'utf8')
    const appAt = source.indexOf('app: {')
    const scope = appAt >= 0 ? source.slice(appAt) : source
    const matched = scope.match(/\bversion:\s*['"`]([^'"`]+)['"`]/)
    if (!matched) fail(`读不出 app.version：${file}`)
    return matched[1]
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`版本文件解析失败：${file}：${String(error)}`)
  }
  const version = parsed?.expo?.version
  if (typeof version !== 'string' || version === '') fail(`读不出 expo.version：${file}`)
  return version
}

/**
 * 桌面资产集合：**清单驱动**。
 * 每份 `<platformPrefix>-update.json` 决定它那一平台的清单 + 整包；安装包按清单里的 platform 选。
 */
function collectDesktopAssets(artifactDir, version) {
  const names = listFiles(artifactDir)
  const manifestNames = names.filter((name) => name.endsWith('-update.json'))
  if (manifestNames.length === 0) {
    fail(`${artifactDir} 下没有 *-update.json（自动更新的清单）——构建没产出更新链？`)
  }
  const assets = []
  for (const name of manifestNames) {
    const prefix = name.slice(0, -'-update.json'.length)
    const manifestPath = join(artifactDir, name)
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      fail(`更新链清单解析失败：${name}：${String(error)}`)
    }
    const bundle = manifest?.artifact?.file
    if (typeof bundle !== 'string' || bundle === '') {
      fail(`更新链清单 ${name} 里没有 artifact.file`)
    }
    // Electrobun Updater 的两道校验：文件名以 <prefix>- 开头、以 .tar.zst 结尾。
    if (!bundle.startsWith(`${prefix}-`)) {
      fail(`更新链清单 ${name} 的 artifact.file 没有以 ${prefix}- 开头：${bundle}`)
    }
    if (!bundle.endsWith('.tar.zst')) {
      fail(`更新链清单 ${name} 的 artifact.file 不是 .tar.zst 结尾：${bundle}`)
    }
    if (!names.includes(bundle)) {
      fail(`更新链清单 ${name} 指向的整包不在产物目录里：${bundle}`)
    }
    if (typeof manifest.version === 'string' && manifest.version !== '' && manifest.version !== version) {
      fail(`更新链清单 ${name} 的 version=${manifest.version} ≠ tag 版本 ${version}`)
    }
    const platform = String(manifest.platform ?? '')
    const patterns = INSTALLER_PATTERNS[platform]
    if (!patterns) {
      fail(`更新链清单 ${name} 的平台不认识：${platform}（已知：${Object.keys(INSTALLER_PATTERNS).join(' / ')}）`)
    }
    const installers = patterns.flatMap((pattern) => names.filter((name2) => matchGlob(pattern, name2)))
    if (installers.length === 0) {
      fail(`产物目录里没有 ${platform} 的安装包（期望 ${patterns.join(' 或 ')}）`)
    }
    if (installers.length > 1) {
      fail(`产物目录里 ${platform} 的安装包不唯一：${installers.join('、')}（发布资产名会撞车）`)
    }
    assets.push({ path: manifestPath, name, role: 'manifest', platform })
    assets.push({ path: join(artifactDir, bundle), name: bundle, role: 'bundle', platform })
    assets.push({ path: join(artifactDir, installers[0]), name: installers[0], role: 'installer', platform })
  }
  return assets
}

/** 移动端资产：按扩展名认平台，发布名带版本（`dsh-mobile-android-v0.1.0.apk`）。 */
function collectMobileAssets(paths, version) {
  if (paths.length === 0) fail('移动端发布至少要给一个 --asset')
  return paths.map((path) => {
    const absolute = resolve(path)
    if (!existsSync(absolute)) fail(`移动端资产不存在：${path}`)
    const ext = extname(absolute).toLowerCase()
    const platform = MOBILE_PLATFORM_BY_EXT[ext]
    if (!platform) {
      fail(`不认识的移动端资产类型：${path}（支持 ${Object.keys(MOBILE_PLATFORM_BY_EXT).join(' / ')}）`)
    }
    return { path: absolute, name: `dsh-mobile-${platform}-v${version}${ext}`, role: 'mobile', platform }
  })
}

// ---------------------------------------------------------------------------
// gh 层
// ---------------------------------------------------------------------------

function gh(args, { allowFailure = false } = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8' })
  if (result.error) fail(`执行 gh 失败：${result.error.message}`)
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (result.status !== 0 && !allowFailure) {
    fail(`gh ${args.join(' ')} 失败（exit ${result.status}）：${stderr.trim() || stdout.trim()}`)
  }
  return { ok: result.status === 0, stdout, stderr, code: result.status }
}

function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY
  const result = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { allowFailure: true })
  if (!result.ok || result.stdout.trim() === '') {
    fail('拿不到仓库 slug：CI 里应有 GITHUB_REPOSITORY，本地要能在仓内运行 gh')
  }
  return result.stdout.trim()
}

/** release 现状（不存在返回 null）。 */
function releaseView(tag) {
  const result = gh(['release', 'view', tag, '--json', 'isDraft,isPrerelease,assets,id,tagName'], { allowFailure: true })
  if (!result.ok) return null
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    fail(`解析 release 信息失败：${String(error)}`)
  }
}

/** 仓库当前的 latest 指针（没有 release 时返回 null）。 */
function latestReleaseTag() {
  const result = gh(['api', `repos/${repoSlug()}/releases/latest`, '-q', '.tag_name'], { allowFailure: true })
  if (!result.ok) return null
  const tag = result.stdout.trim()
  return tag === '' ? null : tag
}

/** 建（幂等）或复用 draft release。 */
function ensureDraftRelease(tag, kind, dryRun) {
  const spec = KINDS[kind]
  const existing = releaseView(tag)
  if (existing) {
    if (!existing.isDraft) {
      fail(`${tag} 的 release 已经发布：资产不能原地替换，重发请删掉整个 release 重建，或换一个新 tag`)
    }
    return existing
  }
  const args = [
    'release',
    'create',
    tag,
    '--verify-tag', // 远端没有这个 tag 就 abort：绝不拿默认分支 HEAD 自动建 tag（可能发错提交）
    '--draft',
    '--title',
    `${spec.title} ${tag.slice(spec.tagPrefix.length)}`,
    '--notes',
    spec.notes,
  ]
  if (spec.prerelease) args.push('--prerelease')
  if (dryRun) {
    log(`dry-run: gh ${args.join(' ')}`)
    return { isDraft: true, assets: [] }
  }
  const result = gh(args, { allowFailure: true })
  if (!result.ok) {
    // 并发：桌面三平台矩阵同时建，同一个 tag 只应有一个建成功。
    const again = releaseView(tag)
    if (again) return again
    fail(`建 release 失败：${result.stderr.trim() || result.stdout.trim()}`)
  }
  return releaseView(tag)
}

/** 上传资产（同名同大小视为已传；同名不同大小直接失败，不覆盖）。 */
function uploadAssets(tag, assets, dryRun) {
  const view = releaseView(tag)
  const existing = new Map((view?.assets ?? []).map((asset) => [asset.name, asset]))
  const pending = []
  for (const asset of assets) {
    const hit = existing.get(asset.name)
    if (hit) {
      const size = statSync(asset.path).size
      if (typeof hit.size === 'number' && hit.size !== size) {
        fail(
          `release 上已有同名资产 ${asset.name} 但大小不同（远端 ${hit.size} vs 本地 ${size}）：` +
            '资产不能原地替换，请删掉整个 release 重建，或换一个新 tag',
        )
      }
      log(`跳过（已存在且大小一致）：${asset.name}`)
      continue
    }
    pending.push(asset)
  }
  if (pending.length === 0) {
    log('没有待上传的资产')
    return
  }
  if (dryRun) {
    for (const asset of pending) log(`dry-run: gh release upload ${tag} ${asset.name}`)
    return
  }
  gh(['release', 'upload', tag, ...pending.map((asset) => asset.path)])
  // 回读断言：传完必须真的在 release 上。
  const after = releaseView(tag)
  const names = new Set((after?.assets ?? []).map((asset) => asset.name))
  for (const asset of pending) {
    if (!names.has(asset.name)) fail(`上传后回读不到资产：${asset.name}`)
  }
  log(`已上传 ${pending.length} 个资产：${pending.map((asset) => asset.name).join('、')}`)
}

/** 发布前的资产完整性：清单与整包必须同在这次 release 上（Electrobun 的硬要求）。 */
function assertDesktopReleaseComplete(view) {
  const assets = view?.assets ?? []
  const assetNames = assets.map((asset) => asset.name)
  const manifests = assets.filter((asset) => asset.name.endsWith('-update.json'))
  if (manifests.length === 0) fail('release 上没有更新链清单（*-update.json）')
  const platforms = new Set()
  for (const asset of manifests) {
    // 用资产 API 直接取内容：draft release 的资产也取得到，不用先把 release 发布出去再验。
    const result = gh(
      ['api', `repos/${repoSlug()}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'],
      { allowFailure: true },
    )
    if (!result.ok) fail(`拉取更新链清单失败：${asset.name}：${result.stderr.trim() || result.stdout.trim()}`)
    let manifest
    try {
      manifest = JSON.parse(result.stdout)
    } catch (error) {
      fail(`release 上的清单 ${asset.name} 解析失败：${String(error)}`)
    }
    const bundle = manifest?.artifact?.file
    if (typeof bundle !== 'string' || bundle === '') fail(`release 上的清单 ${asset.name} 没有 artifact.file`)
    if (!assetNames.includes(bundle)) {
      fail(`清单 ${asset.name} 指向的整包 ${bundle} 不在同一个 release 上——自动更新会 404`)
    }
    platforms.add(String(manifest.platform ?? ''))
  }
  for (const platform of DESKTOP_PLATFORMS) {
    if (!platforms.has(platform)) fail(`release 少了 ${platform} 平台的更新链清单（已有：${[...platforms].join('、')}）`)
  }
}

function assertMobileReleaseComplete(view) {
  const assetNames = (view?.assets ?? []).map((asset) => asset.name)
  if (!assetNames.some((name) => name.endsWith('.apk'))) fail('release 上没有 Android APK')
  if (!assetNames.some((name) => name.endsWith('.ipa'))) fail('release 上没有 iOS IPA')
}

/** draft → published，并按通道决定 latest 归属；最后回读 latest 指针。 */
function publishRelease(tag, kind, dryRun) {
  const spec = KINDS[kind]
  const view = releaseView(tag)
  if (!view) fail(`${tag} 没有 release：先跑 upload`)
  if (!view.isDraft) {
    log(`${tag} 已经是发布态，跳过`)
    return
  }
  if (!dryRun) {
    if (kind === 'desktop') assertDesktopReleaseComplete(view)
    else assertMobileReleaseComplete(view)
  }
  const args = ['release', 'edit', tag, '--draft=false']
  if (spec.latest) args.push('--latest')
  if (spec.prerelease) args.push('--prerelease')
  if (dryRun) {
    log(`dry-run: gh ${args.join(' ')}`)
    if (!spec.latest) log(`dry-run: gh api -X PATCH repos/<slug>/releases/<id> --raw-field make_latest=false`)
  } else {
    gh(args)
    if (!spec.latest) {
      // 显式不夺 latest（`gh release edit` 没有 --latest=false，走 REST 的 make_latest）。
      const patched = gh(
        ['api', '-X', 'PATCH', `repos/${repoSlug()}/releases/${view.id}`, '--raw-field', 'make_latest=false'],
        { allowFailure: true },
      )
      if (!patched.ok) log(`显式取消 latest 失败（prerelease 本身也不会被解析成 latest）：${patched.stderr.trim()}`)
    }
  }
  if (dryRun) return
  const latest = latestReleaseTag()
  if (spec.latest) {
    if (latest !== tag) fail(`发布后 latest 指针不是 ${tag}（当前：${latest ?? '无'}）——桌面 stable 必须独占 latest`)
    log(`已发布 ${tag}，并占住 latest`)
  } else {
    if (latest === tag) fail(`发布后 ${tag} 夺了 latest——桌面 stable 的更新链会 404`)
    log(`已发布 ${tag}（prerelease，不夺 latest；当前 latest：${latest ?? '无'}）`)
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    command: null,
    kind: null,
    tag: null,
    root: repoRoot,
    artifactDir: null,
    assets: [],
    dryRun: false,
  }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--kind') options.kind = argv[++index]
    else if (arg === '--tag') options.tag = argv[++index]
    else if (arg === '--root') options.root = resolve(argv[++index])
    else if (arg === '--artifact-dir') options.artifactDir = argv[++index]
    else if (arg === '--asset') options.assets.push(argv[++index])
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg.startsWith('-')) fail(`未知参数：${arg}`)
    else positional.push(arg)
  }
  options.command = positional[0] ?? null
  if (!options.command) fail('缺子命令：check / upload / publish')
  if (!options.kind) fail('缺 --kind（desktop / mobile）')
  if (!KINDS[options.kind]) fail(`未知的通道：${options.kind}（desktop / mobile）`)
  if (!options.tag) fail('缺 --tag')
  return options
}

function resolveArtifactDir(options) {
  const raw = options.artifactDir ?? KINDS[options.kind].defaultArtifactDir
  if (raw === null) return null
  return resolve(options.root, raw)
}

/** 校验：tag 形状 + 版本一致性 + 资产集合。check / upload 共用。 */
function validate(options) {
  const version = parseTag(options.tag, options.kind)
  const expected = expectedVersion(options.kind, options.root)
  if (expected !== version) {
    fail(
      `tag 版本 ${version} ≠ 版本文件版本 ${expected}（${KINDS[options.kind].versionFile}）：` +
        '发版前先把版本文件改成 tag 里的版本，或换 tag',
    )
  }
  const artifactDir = resolveArtifactDir(options)
  const assets =
    options.kind === 'desktop'
      ? collectDesktopAssets(artifactDir, version)
      : collectMobileAssets(options.assets, version)
  return { version, assets, artifactDir }
}

function commandCheck(options) {
  const { version, assets } = validate(options)
  const summary = {
    kind: options.kind,
    tag: options.tag,
    version,
    assets: assets.map((asset) => ({ name: asset.name, role: asset.role, path: asset.path })),
  }
  console.log(JSON.stringify(summary, null, 2))
}

function commandUpload(options) {
  const { assets } = validate(options)
  let stagedDir = null
  let staged = assets
  if (options.kind === 'mobile') {
    // 移动端资产要按版本改名（app-debug.apk 这种名字不适合当对外资产名）。
    stagedDir = mkdtempSync(join(tmpdir(), 'dsh-release-assets-'))
    staged = assets.map((asset) => {
      const dest = join(stagedDir, asset.name)
      copyFileSync(asset.path, dest)
      return { ...asset, path: dest }
    })
  }
  try {
    ensureDraftRelease(options.tag, options.kind, options.dryRun)
    uploadAssets(options.tag, staged, options.dryRun)
  } finally {
    if (stagedDir !== null) rmSync(stagedDir, { recursive: true, force: true })
  }
}

function commandPublish(options) {
  parseTag(options.tag, options.kind)
  publishRelease(options.tag, options.kind, options.dryRun)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'check') commandCheck(options)
  else if (options.command === 'upload') commandUpload(options)
  else if (options.command === 'publish') commandPublish(options)
  else fail(`未知的子命令：${options.command}（check / upload / publish）`)
}

try {
  main()
} catch (error) {
  console.error(`[release-publish] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
