// Issue #60: a third-party model seat (@hytime/dsh-thinking-effort) registered
// on conversation.input.model replaces the official pill, so the trailing lane
// keeps no aria-haspopup="menu" trigger: the pill absorber rule never matches,
// the meter fallback splits the slack with the seat, and in the seat's open
// state the zero-width root's right:0-anchored panel (width min(336px,
// 100vw - 32px)) sweeps 336px leftward off screen - reporter-measured at 393px:
// root x=106, panel left=-230; with our stylesheet disabled root x=339,
// panel left=+3. This pins the class fix: the seat root must stretch across
// the trailing lane (chip pushed right, free space consumed so the meter
// fallback's auto margin zeroes out) and the open panel must re-center on the
// stretched root so the plugin's own viewport-capped width stays on screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LAYOUT = readFileSync(join(ROOT, 'src/client/styles/layout.css.ts'), 'utf8')

const sectionStart = LAYOUT.indexOf('/* --- Composer bottom row on mobile ---')
const sectionEnd = LAYOUT.indexOf('/* --- Composer file entry', sectionStart)
const section =
  sectionStart !== -1 && sectionEnd > sectionStart
    ? LAYOUT.slice(sectionStart, sectionEnd)
    : ''

test('model-seat rules live inside the mobile composer row section', () => {
  assert.notEqual(sectionStart, -1, 'composer row section marker not found')
  assert.ok(sectionEnd > sectionStart, 'composer file entry marker not found')
  // The section sits mid-block, so "nearest @media" is a nested query (e.g.
  // hover:none). Find the MOBILE query opening before the section and prove
  // its block is still open at the section by counting braces (comments
  // stripped - they may quote braces).
  const MOBILE_MEDIA = '@media (max-width: 1023px) and (pointer: coarse)'
  const mediaAt = LAYOUT.indexOf(MOBILE_MEDIA)
  assert.notEqual(mediaAt, -1, 'mobile media query not found')
  assert.ok(mediaAt < sectionStart, 'mobile block must open before the section')
  const code = LAYOUT.slice(mediaAt, sectionStart).replace(/\/\*[\s\S]*?\*\//g, '')
  let depth = 0
  for (const ch of code) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
  }
  assert.ok(depth > 0, 'composer section must sit inside the mobile media block')
})

test('seat root stretches the trailing lane with content pushed right', () => {
  const at = section.indexOf('[data-seat-root] {')
  assert.notEqual(at, -1, 'seat root stretch rule missing')
  const block = section.slice(at, section.indexOf('}', at))
  assert.match(block, /flex: 1 1 auto/)
  assert.match(block, /justify-content: flex-end/)
  // Cascade guard: the lane's generic flex:none root rule shares the
  // stretch rule's specificity, so the stretch must be written after it.
  const flexNone = section.indexOf('[class*="_trailing"] > [class*="_root"] {')
  assert.ok(flexNone !== -1, 'generic lane-root flex:none rule not found')
  assert.ok(flexNone < at, 'seat stretch rule must follow the flex:none rule')
})

test('open panel re-centers on the stretched root instead of right:0', () => {
  const at = section.indexOf('[data-seat-root] > [data-seat-panel] {')
  assert.notEqual(at, -1, 'open-panel re-anchor rule missing')
  const block = section.slice(at, section.indexOf('}', at))
  assert.match(block, /left: 50%/)
  assert.match(block, /right: auto/)
  assert.match(block, /transform: translateX\(-50%\)/)
})

test('seat rules never touch the official pill (no trigger predicates dropped)', () => {
  // The official pill absorber rule and the meter fallback must survive
  // verbatim: third-party seats are the only targets of the new rules.
  assert.match(
    section,
    /\[class\*="_trailing"\] \[class\*="_root"\]:has\(> \[class\*="_trigger"\]\[aria-haspopup="menu"\]\) \{\s*margin-left: auto;\s*margin-right: -4px;/,
  )
  assert.match(
    section,
    /\[class\*="_trailing"\]:not\(:has\(\[class\*="_trigger"\]\[aria-haspopup="menu"\]\)\) > \[class\*="_root"\]:has\(> \[class\*="_trigger"\]\[aria-haspopup="dialog"\]\) \{\s*margin-left: auto;/,
  )
})
