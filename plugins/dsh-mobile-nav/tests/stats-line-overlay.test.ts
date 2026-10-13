import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Issue #104: relocating a React-owned node (the context ring, the TPS
// readout) makes the host's unmount removeChild throw NotFoundError — React
// calls it against the parent it rendered the node into — and the
// SlotErrorBoundary then blanks the whole composer slot. The stats-line task
// must therefore never move a host node: plugin-owned placeholder reserves
// plus absolutely positioned overlays only.

const src = await readFile(new URL('../src/client/effects/stats-line.ts', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/client/styles/compat.css.ts', import.meta.url), 'utf8')

test('stats-line never relocates a host node (issue #104 contract)', () => {
  // The two historic movers: ring into the trailing row, TPS into the strip.
  assert.doesNotMatch(src, /insertBefore\(ring\b/)
  assert.doesNotMatch(src, /appendChild\(el\b/)
  // The only nodes this task creates are plugin-owned placeholder spans.
  assert.doesNotMatch(src, /createElement\('(?!span)/)
  // Host nodes are overlaid where React rendered them, not parked elsewhere.
  assert.match(src, /placeOverlay\(ring, reserve\)/)
  assert.match(src, /placeOverlay\(el, reserve\)/)
})

test('overlay markers exist in source and stylesheet', () => {
  const markers = ['stats-ring-reserve', 'stats-tps-reserve', 'stats-ring-dock', 'stats-tps-row', 'stats-tps']
  for (const marker of markers) {
    assert.ok(src.includes(marker), `stats-line.ts: ${marker}`)
    assert.ok(css.includes(`"${marker}"`), `compat.css.ts: ${marker}`)
  }
  // The ring overlay resolves against a positioned container and the
  // reserves stay invisible (they only hold the slot).
  assert.match(css, /\[data-mobile-nav="stats-ring"\]\s*\{[^}]*position: absolute !important/)
  assert.match(
    css,
    /\[data-mobile-nav="stats-ring-reserve"\],\s*\[data-mobile-nav="stats-tps-reserve"\]\s*\{[^}]*visibility: hidden/,
  )
})

test('dispose hands the official layout back', () => {
  for (const key of ['stats', 'stats-ring', 'stats-ring-dock', 'stats-tps', 'stats-tps-row']) {
    assert.ok(src.includes(`'${key}'`), key)
  }
  assert.match(src, /removeEventListener\('resize', viewportHandler\)/)
  assert.match(src, /el\.remove\(\)/)
})
