#!/usr/bin/env bun
/**
 * 生成 NSIS 安装程序的品牌资源：desktop-electrobun/installer/assets/*.bmp
 *
 * 语义对齐官方 apps/desktop/scripts/prepare-windows-installer.ps1——24bpp BMP、浅色底纯白、
 * 深色底 #151517、画布尺寸与官方 assets 一致；图案来源是本仓 resources/app-icon.ico
 * （取 ICO 里分辨率最高的 PNG 条目），零新依赖。
 *
 * 输出确定性：同输入同字节。`--check` 只比对不落盘（已提交的 BMP 与重新生成的结果必须相等）。
 *
 * 用法：
 *   bun run prepare:installer-assets            # 生成/覆盖 installer/assets/*.bmp
 *   bun run prepare:installer-assets --check    # 只校验，不一致退出码 1
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderBrandAssets } from '../installer/tools/brand-assets.ts'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconPath = join(projectRoot, 'resources', 'app-icon.ico')

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const outIndex = args.indexOf('--out')
const assetsDir = outIndex >= 0 ? (args[outIndex + 1] ?? '') : join(projectRoot, 'installer', 'assets')
if (assetsDir === '') {
  console.error('[assets] --out 后面要跟目录')
  process.exit(1)
}

const iconFile = new Uint8Array(readFileSync(iconPath))
if (iconFile.byteLength === 0) {
  console.error(`[assets] 图标是空文件：${iconPath}`)
  process.exit(1)
}

mkdirSync(assetsDir, { recursive: true })
let mismatched = 0
for (const { spec, bytes } of renderBrandAssets(iconFile)) {
  const target = join(assetsDir, spec.name)
  const label = `${spec.name}（${String(spec.width)}x${String(spec.height)}，${String(bytes.byteLength)} B）`
  if (checkOnly) {
    let existing = null
    try {
      existing = new Uint8Array(readFileSync(target))
    } catch {
      existing = null
    }
    if (existing === null || !Buffer.from(existing).equals(Buffer.from(bytes))) {
      console.error(`[assets] 不一致：${label}`)
      mismatched += 1
    }
    continue
  }
  writeFileSync(target, bytes)
  console.log(`[assets] 写出 ${relative(projectRoot, target).replaceAll('\\', '/')} ${label}`)
}

if (checkOnly) {
  if (mismatched > 0) {
    console.error(`[assets] ${String(mismatched)} 个文件与 app-icon.ico 重新生成的结果不一致：跑 bun run prepare:installer-assets 刷新`)
    process.exit(1)
  }
  console.log('[assets] 全部品牌资源与 app-icon.ico 一致')
}
