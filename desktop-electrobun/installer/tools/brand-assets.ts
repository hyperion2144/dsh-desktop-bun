/**
 * 安装程序品牌资源的规格与合成：把 app-icon 的图案铺到官方同尺寸的画布上，输出 24bpp BMP。
 *
 * 尺寸与底色对齐官方 `apps/desktop/installer/assets/`（600×196 / 1200×392 / 164×314）
 * 与其 `prepare-windows-installer.ps1` 的转换口径（浅色底白、深色底 #151517、24bpp）。
 * 官方那套图里除图案还有词标（deepseek HARNESS）；本仓 v1 只从 app-icon 生成图案部分——
 * 生成器的职责是「没有设计稿时也能出图且可复现」，将来有设计稿直接替换 assets/*.bmp 即可。
 */

import { encodeBmp24 } from './bmp.ts'
import { largestIcoEntry } from './ico.ts'
import { decodePng } from './png.ts'
import { createRaster, drawLineThick, drawScaled, fillRoundedRect, type Box, type Raster, type Rgb } from './raster.ts'

/** 官方 prepare 脚本里浅色底用的就是纯白（Color::White）。 */
export const LIGHT_BACKGROUND: Rgb = { r: 0xff, g: 0xff, b: 0xff }
/** 官方 prepare 脚本里深色底 Color::FromArgb(21, 21, 23)。 */
export const DARK_BACKGROUND: Rgb = { r: 0x15, g: 0x15, b: 0x17 }

export type BrandAssetSpec = {
  /** 落盘文件名：与官方同名（安装页按名字取用，见 #91）。 */
  name: string
  width: number
  height: number
  background: Rgb
  /** 图案（正方形）边长；2x 版是 1x 的严格两倍。 */
  logo: number
}

export const BRAND_ASSETS: readonly BrandAssetSpec[] = [
  { name: 'brand.bmp', width: 600, height: 196, background: LIGHT_BACKGROUND, logo: 140 },
  { name: 'brand-2x.bmp', width: 1200, height: 392, background: LIGHT_BACKGROUND, logo: 280 },
  { name: 'brand-dark.bmp', width: 600, height: 196, background: DARK_BACKGROUND, logo: 140 },
  { name: 'brand-dark-2x.bmp', width: 1200, height: 392, background: DARK_BACKGROUND, logo: 280 },
  { name: 'uninstaller-sidebar.bmp', width: 164, height: 314, background: LIGHT_BACKGROUND, logo: 120 },
]

/** 设计稿的强调色（docs/design/windows-installer-ui-prototype.html 的 --accent）。 */
export const ACCENT: Rgb = { r: 0x4d, g: 0x6b, b: 0xfe }

export type WhaleTileSpec = BrandAssetSpec

/**
 * 标题栏左上角的品牌瓦片：app-icon 图案铺满整个瓦片（#199 反馈：不再自画强调色圆角方块，
 * 那圈蓝是图标未铺满时露出的底——官方图标自带圆角与底色，直接铺满即可）。
 * 背景烘焙成页面底色——BMP 是 24bpp 没有 alpha，图标圆角外的四角经 alpha 混合落在页面底上。
 */
export const WHALE_TILES: readonly WhaleTileSpec[] = [
  { name: 'whale.bmp', width: 44, height: 44, background: LIGHT_BACKGROUND, logo: 44 },
  { name: 'whale-2x.bmp', width: 88, height: 88, background: LIGHT_BACKGROUND, logo: 88 },
  { name: 'whale-dark.bmp', width: 44, height: 44, background: DARK_BACKGROUND, logo: 44 },
  { name: 'whale-dark-2x.bmp', width: 88, height: 88, background: DARK_BACKGROUND, logo: 88 },
]

export function renderWhaleTile(spec: WhaleTileSpec, logo: Raster): Raster {
  const canvas = createRaster(spec.width, spec.height, spec.background)
  drawScaled(logo, canvas, logoBox(spec))
  return canvas
}

/** 图案居中放置的框（整数像素：奇偶差落在左/上，2x 版正好是 1x 的两倍）。 */
export function logoBox(spec: BrandAssetSpec): Box {
  return {
    x: Math.round((spec.width - spec.logo) / 2),
    y: Math.round((spec.height - spec.logo) / 2),
    width: spec.logo,
    height: spec.logo,
  }
}

export function renderBrandAsset(spec: BrandAssetSpec, logo: Raster): Raster {
  const canvas = createRaster(spec.width, spec.height, spec.background)
  drawScaled(logo, canvas, logoBox(spec))
  return canvas
}

export type RenderedBrandAsset = { spec: BrandAssetSpec | PanelSpec | CheckSpec; bytes: Uint8Array }



/** 设计稿浅色卡片：surface #F3F4F7 + 边框 #E3E5EA；深色 surface #1E1E23 + 边框 #2C2C33。 */
export const LIGHT_SURFACE: Rgb = { r: 0xf3, g: 0xf4, b: 0xf7 }
export const LIGHT_BORDER: Rgb = { r: 0xe3, g: 0xe5, b: 0xea }
export const DARK_SURFACE: Rgb = { r: 0x1e, g: 0x1e, b: 0x23 }
export const DARK_BORDER: Rgb = { r: 0x2c, g: 0x2c, b: 0x33 }

/** 圆角面板（欢迎页的「安装位置」卡片）：底色烘页面色，1px 边框环。 */
export type PanelSpec = { name: string; width: number; height: number; background: Rgb; fill: Rgb; border: Rgb; radius: number }
export const UI_PANELS: readonly PanelSpec[] = [
  { name: 'card.bmp', width: 536, height: 140, background: LIGHT_BACKGROUND, fill: LIGHT_SURFACE, border: LIGHT_BORDER, radius: 14 },
  { name: 'card-2x.bmp', width: 1072, height: 280, background: LIGHT_BACKGROUND, fill: LIGHT_SURFACE, border: LIGHT_BORDER, radius: 28 },
  { name: 'card-dark.bmp', width: 536, height: 140, background: DARK_BACKGROUND, fill: DARK_SURFACE, border: DARK_BORDER, radius: 14 },
  { name: 'card-dark-2x.bmp', width: 1072, height: 280, background: DARK_BACKGROUND, fill: DARK_SURFACE, border: DARK_BORDER, radius: 28 },
]

export function renderPanel(spec: PanelSpec): Raster {
  const canvas = createRaster(spec.width, spec.height, spec.background)
  fillRoundedRect(canvas, { x: 0, y: 0, width: spec.width, height: spec.height }, spec.radius, spec.border)
  fillRoundedRect(canvas, { x: 1, y: 1, width: spec.width - 2, height: spec.height - 2 }, Math.max(0, spec.radius - 1), spec.fill)
  return canvas
}

/** 完成页大勾：整圆底盘 + 两段勾笔画。 */
export type CheckSpec = { name: string; width: number; height: number; background: Rgb; circle: Rgb; check: Rgb; stroke: number }
export const UI_CHECKS: readonly CheckSpec[] = [
  { name: 'check-circle.bmp', width: 64, height: 64, background: LIGHT_BACKGROUND, circle: { r: 0xe9, g: 0xed, b: 0xfe }, check: ACCENT, stroke: 6 },
  { name: 'check-circle-2x.bmp', width: 128, height: 128, background: LIGHT_BACKGROUND, circle: { r: 0xe9, g: 0xed, b: 0xfe }, check: ACCENT, stroke: 12 },
  { name: 'check-circle-dark.bmp', width: 64, height: 64, background: DARK_BACKGROUND, circle: { r: 0x23, g: 0x2b, b: 0x4d }, check: ACCENT, stroke: 6 },
  { name: 'check-circle-dark-2x.bmp', width: 128, height: 128, background: DARK_BACKGROUND, circle: { r: 0x23, g: 0x2b, b: 0x4d }, check: ACCENT, stroke: 12 },
]

export function renderCheck(spec: CheckSpec): Raster {
  const canvas = createRaster(spec.width, spec.height, spec.background)
  fillRoundedRect(canvas, { x: 0, y: 0, width: spec.width, height: spec.height }, spec.width / 2, spec.circle)
  const s = spec.width / 64
  drawLineThick(canvas, 18 * s, 33 * s, 28 * s, 43 * s, spec.stroke, spec.check)
  drawLineThick(canvas, 28 * s, 43 * s, 46 * s, 24 * s, spec.stroke, spec.check)
  return canvas
}
/**
 * 从 app-icon.ico 的字节渲染全部品牌资源。
 * 纯函数：同输入必同输出——`prepare:installer-assets` 与测试（重新生成后逐字节比对）共用。
 */
export function renderBrandAssets(iconFile: Uint8Array): RenderedBrandAsset[] {
  const entry = largestIcoEntry(iconFile)
  const logo = decodePng(entry.png)
  return [
    ...BRAND_ASSETS.map((spec) => ({ spec, bytes: encodeBmp24(renderBrandAsset(spec, logo)) })),
    ...WHALE_TILES.map((spec) => ({ spec, bytes: encodeBmp24(renderWhaleTile(spec, logo)) })),
    ...UI_PANELS.map((spec) => ({ spec, bytes: encodeBmp24(renderPanel(spec)) })),
    ...UI_CHECKS.map((spec) => ({ spec, bytes: encodeBmp24(renderCheck(spec)) })),
  ]
}
