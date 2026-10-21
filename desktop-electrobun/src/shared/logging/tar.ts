/**
 * 最小 ustar tar 容器（纯逻辑，零 IO）——日志导出包的装载层。
 *
 * Bun 1.4 有 gzipSync 没有 tar/zip 容器写入器（#223 盘点 ⇒ #224 Decision 3 定 tar.gz）。
 * 这里手写 ustar 头：512 字节块 + 校验和 + 两个全零收尾块，按 10240 字节记录对齐——
 * 系统自带 tar 与常见解包工具都能直接打开。名字只放 ASCII 相对路径（包内结构固定，
 * 由 exporter.ts 决定），长度远小于 100 字节前缀上限，不走 ustar 的 prefix 拆分。
 */

export interface TarEntry {
  /** 包内相对路径（POSIX 分隔，ASCII）。 */
  name: string
  data: Uint8Array
  mtime?: Date
}

const BLOCK = 512
const RECORD = 10 * BLOCK

function octal(value: number, width: number): string {
  // width 含结尾 NUL：7 位八进制最多表达 8MiB-1……size 字段给 11 位，够 8GB 单文件。
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function headerChecksum(header: Uint8Array): number {
  let sum = 0
  for (const byte of header) sum += byte
  return sum
}

function writeString(target: Uint8Array, offset: number, text: string, width: number): void {
  const bytes = Buffer.from(text, 'utf8')
  target.set(bytes.subarray(0, width), offset)
}

function entryHeader(entry: TarEntry): Uint8Array {
  const header = new Uint8Array(BLOCK)
  writeString(header, 0, entry.name, 100)
  writeString(header, 100, '0000644\0', 8) // mode
  writeString(header, 108, '0000000\0', 8) // uid
  writeString(header, 116, '0000000\0', 8) // gid
  writeString(header, 124, octal(entry.data.length, 12), 12) // size
  writeString(header, 136, octal(Math.floor((entry.mtime ?? new Date()).getTime() / 1000), 12), 12)
  // chksum 字段先按全空格占位再求和（ustar 规矩）
  header.fill(0x20, 148, 156)
  header[156] = 0x30 // typeflag: '0' 普通文件
  writeString(header, 257, 'ustar\0', 6) // magic
  writeString(header, 263, '00', 2) // version
  writeString(header, 265, 'dsh', 32) // uname（占位）
  writeString(header, 297, 'dsh', 32) // gname（占位）
  const checksum = headerChecksum(header)
  writeString(header, 148, `${checksum.toString(8).padStart(6, '0')}\0 `, 8)
  return header
}

/** 拼一个完整 tar 字节流（多条目 + 两个零块收尾 + 记录对齐）。 */
export function buildTar(entries: TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = []
  let size = 0
  for (const entry of entries) {
    const header = entryHeader(entry)
    chunks.push(header)
    size += BLOCK
    if (entry.data.length > 0) {
      chunks.push(entry.data)
      size += entry.data.length
      const padding = (BLOCK - (entry.data.length % BLOCK)) % BLOCK
      if (padding > 0) {
        chunks.push(new Uint8Array(padding))
        size += padding
      }
    }
  }
  // 收尾：两个 512 全零块，再补齐到 10240 记录边界
  const endPadding = (RECORD - ((size + 2 * BLOCK) % RECORD)) % RECORD
  const total = size + 2 * BLOCK + endPadding
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
