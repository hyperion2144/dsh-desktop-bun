/**
 * 24bpp BMP 编码（自下而上、行 4 字节对齐）。
 *
 * 为什么是 24bpp 而不是 32bpp：NSIS/MUI 与 Windows 向导页的位图按 24bpp 处理，
 * 带 alpha 的 32bpp 在部分系统上会被当 0 透明度或整片黑——官方
 * `apps/desktop/scripts/prepare-windows-installer.ps1` 也是先铺底色再存 24bpp RGB。
 * 所以这里假定输入已在 raster 层合成完毕（alpha 已抹平）。
 */

import type { Raster } from './raster.ts'

export const BMP_FILE_HEADER_SIZE = 14
export const BMP_INFO_HEADER_SIZE = 40
export const BMP_HEADER_SIZE = BMP_FILE_HEADER_SIZE + BMP_INFO_HEADER_SIZE // 54

/** 行字节数向上取到 4 的倍数（BMP 要求）。 */
export function bmpRowSize(width: number): number {
  return (width * 3 + 3) & ~3
}

/** 24bpp BMP 的文件字节数（供测试与落盘前校验）。 */
export function bmpFileSize(width: number, height: number): number {
  return BMP_HEADER_SIZE + bmpRowSize(width) * height
}

export function encodeBmp24(raster: Raster): Uint8Array {
  const { width, height, rgba } = raster
  const rowSize = bmpRowSize(width)
  const pixelBytes = rowSize * height
  const out = new Uint8Array(BMP_HEADER_SIZE + pixelBytes)
  const view = new DataView(out.buffer)
  out[0] = 0x42 // 'B'
  out[1] = 0x4d // 'M'
  view.setUint32(2, out.length, true) // 文件总长
  view.setUint32(10, BMP_HEADER_SIZE, true) // 像素数据偏移
  view.setUint32(14, BMP_INFO_HEADER_SIZE, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true) // 正数 = 自下而上
  view.setUint16(26, 1, true) // planes
  view.setUint16(28, 24, true) // bpp
  view.setUint32(30, 0, true) // BI_RGB，无压缩
  view.setUint32(34, pixelBytes, true)
  view.setUint32(38, 2835, true) // 72 DPI
  view.setUint32(42, 2835, true)

  for (let y = 0; y < height; y++) {
    const source = (height - 1 - y) * width * 4
    let target = BMP_HEADER_SIZE + y * rowSize
    for (let x = 0; x < width; x++) {
      out[target++] = rgba[source + x * 4 + 2] ?? 0 // B
      out[target++] = rgba[source + x * 4 + 1] ?? 0 // G
      out[target++] = rgba[source + x * 4] ?? 0 // R
    }
    // 行尾填充字节留 0
  }
  return out
}
