// 工作区 chip「再点关闭」的源码契约（2026-09-23，对账 0.1.7-rc.1）。
//
// 背景：宿主的 hero 工作区 chip 自己是正常 toggle，但 ui-workspace 的
// WorkspacePickFlow 把菜单开成 `<Menu anchor={null} portal …>` —— 触发器在
// Menu 的 rootRef 之外，于是 Menu 的「外部 pointerdown 关闭」把 chip 自己的第二击
// 也当成外部点击：pointerdown 关、click 又 toggle 回开，净效果＝关不掉。
// 修复只吞掉这一击 click（React 挂在 root 容器上的 onClick 不再执行），
// 宿主关闭路径不动。本测试钉住的是「哪里介入、什么时候介入」这几个不可回退的判据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(
  fileURLToPath(new URL('../src/client/effects/workspace-chip-toggle.ts', import.meta.url)),
  'utf8',
)
const ENTRY = readFileSync(
  fileURLToPath(new URL('../src/client/index.tsx', import.meta.url)),
  'utf8',
)

test('chip 选择器只认 hero 行的直接子菜单触发器', () => {
  // 预设触发器在 Menu 的 anchor span 里（不是 hero 行的直接子）——带 `>` 才不会误伤它。
  assert.match(SRC, /const CHIP_SELECTOR = '\[class\*="heroWorkspaceRow"\] > button\[aria-haspopup="menu"\]'/)
})

test('两个事件都必须在捕获阶段介入', () => {
  assert.match(SRC, /document\.addEventListener\('pointerdown', onPointerDownCapture, true\)/)
  assert.match(SRC, /document\.addEventListener\('click', onClickCapture, true\)/)
})

test('开态取自 aria-expanded，且要求宿主的 portal 菜单在场', () => {
  const start = SRC.indexOf('const onPointerDownCapture')
  const end = SRC.indexOf('const onClickCapture', start)
  const body = SRC.slice(start, end)
  assert.ok(start > 0 && end > start, 'onPointerDownCapture 未找到')
  assert.match(body, /chip\.getAttribute\('aria-expanded'\) !== 'true'/, '开态必须读 chip 自己的 aria-expanded')
  assert.match(body, /document\.querySelector\(OPEN_MENU_SELECTOR\) === null/, '没有 portal 菜单时不得武装')
})

test('只在同一颗 chip 的紧随 click 上 stopPropagation', () => {
  const start = SRC.indexOf('const onClickCapture')
  const end = SRC.indexOf('document.addEventListener', start)
  const body = SRC.slice(start, end)
  assert.match(body, /chipFrom\(event\.target\) !== chip/)
  assert.match(body, /event\.stopPropagation\(\)/)
  // 吞 click 是这一处唯一的干预手段：不得额外派发合成事件/点按。
  assert.doesNotMatch(body, /dispatchEvent|\.click\(\)/)
})

test('dispose 摘掉两个监听器', () => {
  assert.match(SRC, /document\.removeEventListener\('pointerdown', onPointerDownCapture, true\)/)
  assert.match(SRC, /document\.removeEventListener\('click', onClickCapture, true\)/)
})

test('入口武装该效果', () => {
  assert.match(ENTRY, /import \{ installWorkspaceChipToggle \} from '\.\/effects\/workspace-chip-toggle\.ts'/)
  assert.match(ENTRY, /installWorkspaceChipToggle\(ctx\)/)
})
