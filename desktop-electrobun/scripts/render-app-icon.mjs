// 应用图标生成：从官方矢量源逐尺寸光栅化，产出 icon.ico / icon.icns / app-icon.ico。
//
// 转换方式与官方 apps/desktop/scripts/render-tray-icon.ts 同款：sharp 按 SVG density
// 逐尺寸独立光栅化（绝不大位图缩小，每个尺寸边缘都锐利），packIco 与官方逐行一致。
// 官方应用图标经 electron-builder 运行时转换（我们壳是 Electrobun，win.icon 只吃 .ico），
// 因此把同一转换方式落到仓内脚本，产物提交进仓；SVG 源是官方 resources/ 的原字节拷贝。
//
// 用法：node scripts/render-app-icon.mjs
// 依赖：sharp（优先本仓 node_modules，其次 SHARP_MODULE 指定，再退官方仓 node_modules）；
//       iconutil（macOS 自带，仅 icns 需要）。
// 官方托盘 tray.ico（16..64 七帧）是官方提交的产物，直接原字节使用，不经本脚本。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const repoRoot = resolve(projectRoot, '..')

const WIN_SVG = resolve(repoRoot, 'resources', 'icons', 'icon-windows.svg')
const MAC_SVG = resolve(repoRoot, 'resources', 'icons', 'icon-macos.svg')
const ICO_OUT = resolve(repoRoot, 'resources', 'icons', 'icon.ico')
const ICNS_OUT = resolve(repoRoot, 'resources', 'icons', 'icon.icns')
const APP_ICON_OUT = join(projectRoot, 'resources', 'app-icon.ico')

/** ICO 内打包的位图边长：桌面/任务栏/安装器各档。 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** SVG 画布边长（官方两个源均为 1024）。 */
const SOURCE_EDGE = 1024
const SOURCE_DENSITY = 72
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICON_DIRECTORY_BYTES = 6
const ICON_ENTRY_BYTES = 16

const sharp = loadSharp()

function loadSharp() {
  const hints = [
    process.env.SHARP_MODULE,
    join(projectRoot, 'node_modules', 'sharp'),
    join(repoRoot, 'node_modules', 'sharp'),
  ].filter(Boolean)
  for (const hint of hints) {
    try {
      return createRequire(import.meta.url)(hint)
    } catch {
      // 换下一个候选
    }
  }
  console.error('[icons] 找不到 sharp：本仓装依赖，或 SHARP_MODULE 指到 sharp 包目录')
  process.exit(1)
}

/** 从矢量源按目标边长独立光栅化一帧 PNG（官方同款 density 换算）。 */
async function rasterize(svgPath, size) {
  const density = Math.max(1, Math.round((SOURCE_DENSITY * size) / SOURCE_EDGE))
  return sharp(svgPath, { density }).resize(size, size).png().toBuffer()
}

/**
 * 把 PNG 位图打包成一个 ICO 文件（与官方 render-tray-icon.ts 逐行一致）。
 * @param entries - 按边长升序；每帧必须是以声明边长的正方形 PNG。
 */
function packIco(entries) {
  const header = Buffer.alloc(ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * entries.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach((entry, index) => {
    if (entry.size < 1 || entry.size > 256) throw new Error(`app icon: unsupported bitmap edge ${String(entry.size)}`)
    const { width, height } = pngDimensions(entry.png)
    if (width !== entry.size || height !== entry.size) {
      throw new Error(`app icon: bitmap ${String(index)} is ${String(width)}x${String(height)}, expected ${String(entry.size)}`)
    }
    const at = ICON_DIRECTORY_BYTES + ICON_ENTRY_BYTES * index
    // 256 px 在单字节边长字段里编码为 0。
    header.writeUInt8(entry.size % 256, at)
    header.writeUInt8(entry.size % 256, at + 1)
    header.writeUInt8(0, at + 2)
    header.writeUInt8(0, at + 3)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(entry.png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, ...entries.map((entry) => entry.png)])
}

/** 读取 PNG 的 IHDR 宽高（官方同款：校验帧尺寸与声明一致）。 */
function pngDimensions(png) {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('app icon: not a PNG stream')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

async function main() {
  for (const path of [WIN_SVG, MAC_SVG]) {
    if (!existsSync(path)) {
      console.error(`[icons] 缺矢量源：${path}`)
      process.exit(1)
    }
  }

  const icoEntries = []
  for (const size of ICO_SIZES) {
    icoEntries.push({ size, png: await rasterize(WIN_SVG, size) })
  }
  const ico = packIco(icoEntries)
  writeFileSync(ICO_OUT, ico)
  copyFileSync(ICO_OUT, APP_ICON_OUT)
  console.log(`[icons] ${ICO_OUT}（${String(ico.length)} B，${String(ICO_SIZES.length)} 帧）`)
  console.log(`[icons] ${APP_ICON_OUT}（exe / 安装器 / 通知图标同源）`)

  // icns：macOS 版式（rx=230）逐尺寸光栅化进 iconset，iconutil 打包。
  if (process.platform === 'darwin') {
    const iconset = join(mkdtempSync(join(tmpdir(), 'dsh-icons-')), 'x.iconset')
    rmSync(iconset, { recursive: true, force: true })
    mkdirSync(iconset, { recursive: true })
    const slots = [
      [16, 'icon_16x16.png'],
      [32, 'icon_16x16@2x.png'],
      [32, 'icon_32x32.png'],
      [64, 'icon_32x32@2x.png'],
      [128, 'icon_128x128.png'],
      [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'],
      [512, 'icon_256x256@2x.png'],
      [512, 'icon_512x512.png'],
      [1024, 'icon_512x512@2x.png'],
    ]
    for (const [size, name] of slots) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(iconset, name), await rasterize(MAC_SVG, size))
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', ICNS_OUT], { stdio: 'inherit' })
    rmSync(iconset, { recursive: true, force: true })
    console.log(`[icons] ${ICNS_OUT}（iconutil）`)
  }
}


main().catch((error) => {
  console.error('[icons] 生成失败：', error)
  process.exit(1)
})
