/**
 * ICO 容器读取：只取「内嵌 PNG 的条目」——本仓 `resources/app-icon.ico` 六个尺寸全是 PNG 条目
 * （macOS 上的图标导出工具默认如此）。DIB 条目（老的 BMP 型 ICO）不实现：真遇到就抛错，
 * 提示改用 PNG 条目导出，而不是解出半张图。
 */

export type IcoEntry = {
  width: number
  height: number
  /** 条目原始字节（PNG 文件）。 */
  png: Uint8Array
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
}

export function readIcoEntries(bytes: Uint8Array): IcoEntry[] {
  if (bytes.byteLength < 6) throw new Error('ICO 文件太短')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
    throw new Error('不是 ICO：reserved/type 字段不对')
  }
  const count = view.getUint16(4, true)
  const entries: IcoEntry[] = []
  for (let index = 0; index < count; index++) {
    const base = 6 + index * 16
    if (base + 16 > bytes.byteLength) throw new Error('ICO 目录项越界')
    // 目录里 0 表示 256（一个字节放不下 256）
    const width = bytes[base] === 0 ? 256 : (bytes[base] ?? 0)
    const height = bytes[base + 1] === 0 ? 256 : (bytes[base + 1] ?? 0)
    const size = view.getUint32(base + 8, true)
    const offset = view.getUint32(base + 12, true)
    if (offset + size > bytes.byteLength) throw new Error('ICO 条目数据越界')
    const payload = bytes.subarray(offset, offset + size)
    if (!isPng(payload)) {
      throw new Error('ICO 条目不是 PNG（DIB 条目未支持）：请导出成 PNG 型 ICO')
    }
    entries.push({ width, height, png: payload })
  }
  if (entries.length === 0) throw new Error('ICO 里没有条目')
  return entries
}

/** 取面积最大的条目——品牌图要用分辨率最高的那版图案。 */
export function largestIcoEntry(bytes: Uint8Array): IcoEntry {
  return readIcoEntries(bytes).reduce((best, entry) =>
    entry.width * entry.height > best.width * best.height ? entry : best,
  )
}
