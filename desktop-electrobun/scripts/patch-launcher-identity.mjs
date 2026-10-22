#!/usr/bin/env bun
// #239 多壳模型底座：给 launcher bundle 注入 CEF identity 覆盖杠杆。
//
// 背景：electrobun 上游 launcher（产物 Resources/main.js）把 identifier/channel
// 明文传给 native（electrobun_core_run_main_thread），CEF 数据目录
// 明文传给 native（electrobun_core_run_main_thread），CEF 数据目录
// <id>/<channel>/CEF 与 Chromium ProcessSingleton 锁都由它派生。
// 本 patch 注入 env 杠杆 DSH_SHELL_CEF_IDENTITY：非空时覆盖 identifier ——
// 主进程与壳进程即可各用各的 CEF 数据目录（#243：壳 CEF 互斥不再带走对方）。
// LaunchServices 看到的仍是同一个 bundle id（Info.plist 不变）。
//
// 锚点缺失即报错退出：上游 bundle 结构变化时宁可构建失败，不可静默漏 patch。
// 幂等：产物已含杠杆则跳过，重复构建安全。
//
// 用法：
//   bun run scripts/patch-launcher-identity.mjs                # 自动找 build/ 下最新构建目录
//   bun run scripts/patch-launcher-identity.mjs <构建目录|.app>  # 指定产物

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'

import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'


const projectRoot = new URL('..', import.meta.url).pathname
const buildRoot = join(projectRoot, 'build')

const ANCHOR = `      if (versionInfo.identifier) {
        identifier = versionInfo.identifier;
      }`

const INJECTION = `
      const identityOverride = process.env.DSH_SHELL_CEF_IDENTITY ?? "";
      if (identityOverride !== "") {
        identifier = identityOverride;
        console.log(\`[LAUNCHER] CEF identity override: \${identityOverride}\`);
      }`

/** 在 build/ 下找最新的构建目录（<env>-<os>-<arch>），与 assert-artifact.mjs 同口径。 */
function findLatestBuildDir() {
  if (!existsSync(buildRoot)) {
    console.error(`[patch-launcher] 找不到构建目录：${buildRoot}`)
    process.exit(1)
  }
  const candidates = readdirSync(buildRoot)
    .map((name) => join(buildRoot, name))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (candidates.length === 0) {
    console.error(`[patch-launcher] build/ 下没有构建目录：${buildRoot}`)
    process.exit(1)
  }
  return candidates[0]
}

/**
 * 定位需要 patch 的 main.js 载体。
 * 首启自解压前的全新产物：Resources 下只有 <hash>.tar.zst（tar 内是完整 .app），
 * main.js 必须解出来 patch 再打回去（#243 实证 extractor 不校验 payload hash）。
 * 跑过一次的产物：Resources 有解压残留 main.js，直接原地 patch。
 */
function findPayload(root) {
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith('.app')) continue
    const resources = join(root, entry, 'Contents', 'Resources')
    if (!existsSync(resources)) continue
    const tar = readdirSync(resources).find((f) => f.endsWith('.tar.zst'))
    if (tar) return { kind: 'tar', path: join(resources, tar) }
    const mainJs = join(resources, 'main.js')
    if (existsSync(mainJs)) return { kind: 'plain', path: mainJs }
  }
  // Windows：安装树布局（打包期已把 payload 解并进应用树，无 .app），
  // main.js 在应用根的 Resources/ 下——CEF 身份拆分三平台一致，win 也要注入。
  return findWindowsMainJs(root)
}

function findWindowsMainJs(root) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const p = join(dir, entry)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p, depth + 1)
      else if (entry === 'main.js' && basename(dir) === 'Resources') found.push(p)
    }
  }
  walk(root, 0)
  return found.length > 0 ? { kind: 'plain', path: found[0] } : null
}

/** 对 main.js 文本注入杠杆；已注入返回 null，锚缺失抛错（拒绝静默漏 patch）。 */
function injectIdentityLever(text) {
  if (text.includes('DSH_SHELL_CEF_IDENTITY')) return null
  if (!text.includes(ANCHOR)) {
    throw new Error('锚点缺失（上游 launcher bundle 结构变了）')
  }
  return text.replace(ANCHOR, ANCHOR + INJECTION)
}

const target = process.argv[2] ?? findLatestBuildDir()
const resolved = statSync(target).isDirectory() ? target : findLatestBuildDir()
const payload = resolved.endsWith('.app')
  ? findPayload(dirname(resolved))
  : findPayload(resolved)

if (!payload) {
  console.log(`[patch-launcher] ${resolved} 下没有 mac 载体（.app/main.js），跳过`)
  process.exit(0)
}

if (payload.kind === 'plain') {
  const original = readFileSync(payload.path, 'utf8')
  let patched
  try {
    patched = injectIdentityLever(original)
  } catch (error) {
    console.error(`[patch-launcher] ${payload.path}：${error.message}，拒绝静默跳过`)
    process.exit(1)
  }
  if (patched === null) {
    console.log(`[patch-launcher] 已注入过，跳过：${payload.path}`)
    process.exit(0)
  }
  writeFileSync(payload.path, patched)
  console.log(`[patch-launcher] 已注入 CEF identity 杠杆：${payload.path}`)
  process.exit(0)
}

// tar 载体：解包 → patch 内层 main.js → 重打 → 原子替换（#243 冒烟实证路径）。
const tmp = mkdtempSync(join(tmpdir(), 'patch-launcher-'))
try {
  execFileSync('tar', ['--zstd', '-xf', payload.path, '-C', tmp])
  const topLevel = readdirSync(tmp)[0]
  if (topLevel === undefined) throw new Error('tar.zst 解包为空')
  const innerMainJs = join(tmp, topLevel, 'Contents', 'Resources', 'main.js')
  if (!existsSync(innerMainJs)) throw new Error(`tar 内没有 main.js：${topLevel}`)
  const original = readFileSync(innerMainJs, 'utf8')
  let patched
  try {
    patched = injectIdentityLever(original)
  } catch (error) {
    console.error(`[patch-launcher] ${payload.path}：${error.message}，拒绝静默跳过`)
    process.exit(1)
  }
  if (patched !== null) writeFileSync(innerMainJs, patched)
  const repacked = join(tmp, '..', 'repacked.tar.zst')
  execFileSync('tar', ['--zstd', '-cf', repacked, '-C', tmp, topLevel])
  renameSync(repacked, payload.path)
  console.log(`[patch-launcher] 已注入 CEF identity 杠杆（经 tar）：${payload.path}${patched === null ? '（原本已注入）' : ''}`)
} catch (error) {
  console.error(`[patch-launcher] tar patch 失败：${error.message}`)
  process.exit(1)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
