import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

// assert-artifact.mjs 是构建尾部的独立脚本（非模块导出），这里按文本锁住硬闸清单，
// 防止必带项被无声摘掉（#20：手机布局插件漏进产物）。
const script = readFileSync(join(import.meta.dir, '..', 'scripts', 'assert-artifact.mjs'), 'utf8')

test('REQUIRED_PAYLOAD_FILES 必带手机布局插件（#20 硬闸）', () => {
  expect(script).toContain("'plugins/dsh-web-mobile/package.json'")
  expect(script).toContain("'plugins/dsh-web-mobile/lib/client.js'")
})
