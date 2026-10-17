/**
 * 最小 PNG 解码器：只覆盖本仓实际用到的子集——8 位深、非隔行、真彩 RGB(2)/RGBA(6)。
 *
 * 用途只有一个：把 `resources/app-icon.ico` 内嵌的 PNG 图案解出来喂给品牌图合成。
 * 所以故意不实现调色板/灰度/16 位深/隔行——真遇到就抛错，让后来者知道要扩这里，
 * 而不是静默解出错图。zlib 走 Node 兼容层，零依赖。
 */


import { inflateSync } from 'node:zlib'

import type { Raster } from './raster.ts'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

function paeth(a: number, b: number, c: number): number {
  const estimate = a + b - c
  const distanceA = Math.abs(estimate - a)
  const distanceB = Math.abs(estimate - b)
  const distanceC = Math.abs(estimate - c)
  if (distanceA <= distanceB && distanceA <= distanceC) return a
  if (distanceB <= distanceC) return b
  return c
}

export function decodePng(bytes: Uint8Array): Raster {
  if (bytes.length < 8 || SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('不是 PNG：签名不匹配')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let sawHeader = false
  const idat: Uint8Array[] = []

  for (let offset = 8; offset + 8 <= bytes.byteLength; ) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    )
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.byteLength) throw new Error(`PNG 块 ${type} 越界`)
    if (type === 'IHDR') {
      width = view.getUint32(dataStart)
      height = view.getUint32(dataStart + 4)
      bitDepth = bytes[dataStart + 8] ?? 0
      colorType = bytes[dataStart + 9] ?? 0
      interlace = bytes[dataStart + 12] ?? 0
      sawHeader = true
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }

  if (!sawHeader) throw new Error('PNG 缺 IHDR')
  if (bitDepth !== 8) throw new Error(`PNG 位深 ${String(bitDepth)} 未支持（只支持 8）`)
  if (interlace !== 0) throw new Error('PNG 隔行扫描未支持')
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (channels === 0) throw new Error(`PNG 颜色类型 ${String(colorType)} 未支持（只支持真彩 2/6）`)
  if (width <= 0 || height <= 0) throw new Error('PNG 尺寸非法')

  // 注意：Bun.inflateSync 解的是裸 deflate，而 PNG 的 IDAT 是 zlib 包装（2 字节头 + adler32 尾），
  // 所以这里用 node:zlib 的 inflateSync（Bun 内置实现，无需额外依赖）。
  const raw = inflateSync(concatChunks(idat))
  const stride = width * channels
  if (raw.length < height * (stride + 1)) {
    throw new Error(`PNG 像素数据不足：${String(raw.length)} < ${String(height * (stride + 1))}`)
  }

  const unfiltered = new Uint8Array(height * stride)
  let cursor = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor] ?? 0
    cursor += 1
    const rowStart = y * stride
    const previousStart = rowStart - stride
    for (let x = 0; x < stride; x++) {
      const value = raw[cursor + x] ?? 0
      const left = x >= channels ? (unfiltered[rowStart + x - channels] ?? 0) : 0
      const up = y > 0 ? (unfiltered[previousStart + x] ?? 0) : 0
      const upLeft = y > 0 && x >= channels ? (unfiltered[previousStart + x - channels] ?? 0) : 0
      let restored: number
      switch (filter) {
        case 0:
          restored = value
          break
        case 1:
          restored = value + left
          break
        case 2:
          restored = value + up
          break
        case 3:
          restored = value + ((left + up) >> 1)
          break
        case 4:
          restored = value + paeth(left, up, upLeft)
          break
        default:
          throw new Error(`PNG 行滤镜 ${String(filter)} 未知`)
      }
      unfiltered[rowStart + x] = restored & 0xff
    }
    cursor += stride
  }

  const rgba = new Uint8Array(width * height * 4)
  for (let index = 0, source = 0, target = 0; index < width * height; index++, source += channels, target += 4) {
    rgba[target] = unfiltered[source] ?? 0
    rgba[target + 1] = unfiltered[source + 1] ?? 0
    rgba[target + 2] = unfiltered[source + 2] ?? 0
    rgba[target + 3] = channels === 4 ? (unfiltered[source + 3] ?? 0) : 255
  }
  return { width, height, rgba }
}
