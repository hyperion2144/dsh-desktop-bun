// 品牌资源生成器（#92）的契约：安装/卸载界面用的 9 张 BMP（品牌图 1x/2x × 明暗 + 卸载侧栏 +
// 标题栏鲸鱼瓦片 1x/2x × 明暗）全部由 resources/app-icon.ico 现场生成。
// 钉住的是「换了图标或设计稿也必须继续成立」的部分——画布尺寸、24bpp 未压缩、浅/深底色、
// 图案居中、同输入同字节（产物不入库，构建期每次重新生成：.gitignore 的 installer/assets/）。
// PNG/ICO 的解码是自写的零依赖实现，所以这两处的边界也在这里兜住。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ACCENT,
  BRAND_ASSETS,
  DARK_BACKGROUND,
  LIGHT_BACKGROUND,
  WHALE_TILES,
  logoBox,
  renderBrandAssets,
  renderWhaleTile,
} from '../installer/tools/brand-assets.ts'
import { BMP_HEADER_SIZE, bmpFileSize, bmpRowSize, encodeBmp24 } from '../installer/tools/bmp.ts'
import { largestIcoEntry, readIcoEntries } from '../installer/tools/ico.ts'
import { decodePng } from '../installer/tools/png.ts'
import { createRaster } from '../installer/tools/raster.ts'

const projectRoot = join(import.meta.dir, '..')
const iconFile = new Uint8Array(readFileSync(join(projectRoot, 'resources', 'app-icon.ico')))

/** 按 BMP 规则读一个像素：24bpp、行序自下而上、行尾补齐到 4 字节。 */
function bmpPixel(bytes: Uint8Array, width: number, height: number, x: number, y: number): { r: number; g: number; b: number } {
  const offset = BMP_HEADER_SIZE + (height - 1 - y) * bmpRowSize(width) + x * 3
  return { r: bytes[offset + 2] ?? 0, g: bytes[offset + 1] ?? 0, b: bytes[offset] ?? 0 }
}

function bmpView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

describe('品牌资源生成器（#92）', () => {
  test('图标源：所有条目都是 PNG 型，取面积最大的那版（256×256）', () => {
    const entries = readIcoEntries(iconFile)
    expect(entries.length).toBeGreaterThanOrEqual(5) // 官方导出 16/32/48/64/128/256
    for (const entry of entries) {
      const signature = String.fromCharCode(entry.png[1] ?? 0, entry.png[2] ?? 0, entry.png[3] ?? 0)
      expect(signature).toBe('PNG')
    }
    const largest = largestIcoEntry(iconFile)
    expect(largest.width).toBe(256)
    expect(largest.height).toBe(256)
  })

  test('PNG 解码器解得动图标里的 256 版（8 位 RGBA、非隔行）', () => {
    const raster = decodePng(largestIcoEntry(iconFile).png)
    expect(raster.width).toBe(256)
    expect(raster.height).toBe(256)
    expect(raster.rgba.length).toBe(256 * 256 * 4)
    // 图案不是纯色板：至少有两种明显不同的颜色（底色盘 + 鲸鱼）
    const colors = new Set<string>()
    for (let offset = 0; offset < raster.rgba.length; offset += 4 * 97) {
      colors.add(`${String(raster.rgba[offset] ?? 0)},${String(raster.rgba[offset + 1] ?? 0)},${String(raster.rgba[offset + 2] ?? 0)}`)
      if (colors.size > 3) break
    }
    expect(colors.size).toBeGreaterThan(3)
  })

  test('五张规格与官方 assets 对齐：尺寸、深浅底色、2x 是 1x 的两倍', () => {
    expect(BRAND_ASSETS.map((spec) => `${spec.name} ${String(spec.width)}x${String(spec.height)}`)).toEqual([
      'brand.bmp 600x196',
      'brand-2x.bmp 1200x392',
      'brand-dark.bmp 600x196',
      'brand-dark-2x.bmp 1200x392',
      'uninstaller-sidebar.bmp 164x314',
    ])
    const byName = new Map(BRAND_ASSETS.map((spec) => [spec.name, spec]))
    expect(byName.get('brand.bmp')?.background).toEqual(LIGHT_BACKGROUND)
    expect(byName.get('brand-2x.bmp')?.background).toEqual(LIGHT_BACKGROUND)
    expect(byName.get('brand-dark.bmp')?.background).toEqual(DARK_BACKGROUND)
    expect(byName.get('brand-dark-2x.bmp')?.background).toEqual(DARK_BACKGROUND)
    expect(byName.get('uninstaller-sidebar.bmp')?.background).toEqual(LIGHT_BACKGROUND)
    expect(DARK_BACKGROUND).toEqual({ r: 0x15, g: 0x15, b: 0x17 })

    const oneX = byName.get('brand.bmp')
    const twoX = byName.get('brand-2x.bmp')
    expect(twoX?.logo).toBe((oneX?.logo ?? 0) * 2)
    expect(twoX?.width).toBe((oneX?.width ?? 0) * 2)
    expect(twoX?.height).toBe((oneX?.height ?? 0) * 2)
  })

  test('图案居中：左右/上下留白对称', () => {
    for (const spec of BRAND_ASSETS) {
      const box = logoBox(spec)
      expect(Math.abs(box.x * 2 + box.width - spec.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(box.y * 2 + box.height - spec.height)).toBeLessThanOrEqual(1)
    }
  })

  test('产物是 24bpp 未压缩 BMP，头部字段与文件长度自洽', () => {
    for (const { spec, bytes } of renderBrandAssets(iconFile)) {
      const view = bmpView(bytes)
      expect([bytes[0], bytes[1]]).toEqual([0x42, 0x4d]) // 'BM'
      expect(bytes.byteLength).toBe(bmpFileSize(spec.width, spec.height))
      expect(view.getUint32(10, true)).toBe(BMP_HEADER_SIZE) // 像素数组偏移
      expect(view.getUint32(14, true)).toBe(40) // BITMAPINFOHEADER
      expect(view.getInt32(18, true)).toBe(spec.width)
      expect(view.getInt32(22, true)).toBe(spec.height) // 正高度 = 自下而上
      expect(view.getUint16(26, true)).toBe(1) // 平面数
      expect(view.getUint16(28, true)).toBe(24) // 位深
      expect(view.getUint32(30, true)).toBe(0) // BI_RGB 未压缩
      expect(view.getInt32(38, true)).toBe(2835) // 72 DPI（2835 像素/米）
    }
  })

  test('底色铺满四角、图案确实落在中间', () => {

    for (const { spec, bytes } of renderBrandAssets(iconFile)) {
      const corners: Array<[number, number]> = [
        [0, 0],
        [spec.width - 1, 0],
        [0, spec.height - 1],
        [spec.width - 1, spec.height - 1],
      ]
      for (const [x, y] of corners) {
        expect(bmpPixel(bytes, spec.width, spec.height, x, y)).toEqual(spec.background)
      }
      // 内容框：带 logo 的规格取居中 logoBox；面板/大勾取中心 1/4 区域——
      // 两类都要求「框里绝大多数采样点不是页面底色」。强度沿用 #103 的比例口径
      // （>0.6，曾实测九张图最低 0.79），新增面板/大勾中心是 fill/圆盘，远高于阈值。
      const box =
        'logo' in spec
          ? logoBox(spec)
          : {
              x: Math.floor(spec.width * 0.3),
              y: Math.floor(spec.height * 0.3),
              width: Math.max(1, Math.floor(spec.width * 0.4)),
              height: Math.max(1, Math.floor(spec.height * 0.4)),
            }
      let painted = 0
      let sampled = 0
      for (let y = box.y; y < box.y + box.height; y += 4) {
        for (let x = box.x; x < box.x + box.width; x += 4) {
          sampled += 1
          const pixel = bmpPixel(bytes, spec.width, spec.height, x, y)
          if (pixel.r !== spec.background.r || pixel.g !== spec.background.g || pixel.b !== spec.background.b) painted += 1
        }
      }
      expect(sampled).toBeGreaterThan(0)
      expect(painted).toBeGreaterThan(sampled * 0.6)
    }
  })

  test('同输入同字节：构建期每次重新生成都得到同一份图', () => {
    const first = renderBrandAssets(iconFile)
    const second = renderBrandAssets(iconFile)
    for (const [index, asset] of first.entries()) {
      const other = second[index]?.bytes ?? new Uint8Array()
      expect(Buffer.from(other).equals(Buffer.from(asset.bytes))).toBe(true)
    }
  })

  test('行按 4 字节补齐：宽度不是 4 的倍数时补齐字节为 0', () => {
    expect(bmpRowSize(4)).toBe(12)
    expect(bmpRowSize(5)).toBe(16)
    const bytes = encodeBmp24(createRaster(5, 2, LIGHT_BACKGROUND))
    expect(bytes.byteLength).toBe(bmpFileSize(5, 2))
    for (let row = 0; row < 2; row++) {
      expect(bytes[BMP_HEADER_SIZE + row * bmpRowSize(5) + 5 * 3]).toBe(0)
    }
  })

  test('解码器只吃它承诺的子集：不是 PNG 直接抛错', () => {
    expect(() => decodePng(new Uint8Array([0x42, 0x4d, 1, 2, 3, 4, 5, 6]))).toThrow('不是 PNG')
    expect(() => decodePng(iconFile)).toThrow('不是 PNG')
  })
})

// 安装界面贴图（#103）：标题栏的鲸鱼瓦片——强调色圆角方块 + 居中的 app-icon。
// 24bpp 没有 alpha，所以四个角烘焙成页面底色：瓦片压在页面上不能露出方块角。
describe('安装界面品牌瓦片（#103）', () => {
  test('四张瓦片：1x/2x × 明暗；2x 是 1x 的严格两倍', () => {
    expect(WHALE_TILES.map((spec) => `${spec.name} ${String(spec.width)}x${String(spec.height)}`)).toEqual([
      'whale.bmp 44x44',
      'whale-2x.bmp 88x88',
      'whale-dark.bmp 44x44',
      'whale-dark-2x.bmp 88x88',
    ])
    const byName = new Map(WHALE_TILES.map((spec) => [spec.name, spec]))
    expect(byName.get('whale.bmp')?.background).toEqual(LIGHT_BACKGROUND)
    expect(byName.get('whale-dark.bmp')?.background).toEqual(DARK_BACKGROUND)
    expect(byName.get('whale-2x.bmp')?.width).toBe((byName.get('whale.bmp')?.width ?? 0) * 2)
    expect(byName.get('whale-2x.bmp')?.logo).toBe((byName.get('whale.bmp')?.logo ?? 0) * 2)
    expect(byName.get('whale.bmp')?.accent).toEqual(ACCENT)
  })

  test('瓦片＝底色 + 强调色圆角方块 + 居中图标；四角留给页面底色', () => {
    const tile = WHALE_TILES[0]
    expect(tile).toBeDefined()
    if (tile === undefined) return
    const bytes = encodeBmp24(renderWhaleTile(tile, decodePng(largestIcoEntry(iconFile).png)))
    expect(bytes.byteLength).toBe(bmpFileSize(tile.width, tile.height))
    expect(bmpPixel(bytes, tile.width, tile.height, 0, 0)).toEqual(tile.background)
    expect(bmpPixel(bytes, tile.width, tile.height, tile.width - 1, tile.height - 1)).toEqual(tile.background)
    // 左中/上中落在圆角方块内部：强调色满覆盖（取 1 而不是 0，避开羽化边）
    const middle = Math.floor(tile.height / 2)
    expect(bmpPixel(bytes, tile.width, tile.height, 1, middle)).toEqual(ACCENT)
    expect(bmpPixel(bytes, tile.width, tile.height, Math.floor(tile.width / 2), 1)).toEqual(ACCENT)
    // 中心是图标（既不等于底色也不等于强调色）
    const center = bmpPixel(bytes, tile.width, tile.height, middle, middle)
    expect(center).not.toEqual(tile.background)
    expect(center).not.toEqual(ACCENT)
  })
})
