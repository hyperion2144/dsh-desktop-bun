import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function layoutSource(): string {
  return readFileSync(join(root, 'src/client/styles/layout.css.ts'), 'utf8')
}

// The 0.1.6-alpha.2 header adaptation block must be inert on pre-alpha.2
// hosts: only _headerLeading/_crumbCurrent/_crumbSeg/_headerCorner are
// alpha.2-only classes, so every cross-generation anchor in the block
// (_titleCluster/_crumbs/_headerActions/_headerUtilities/tablist/QsffPG_/
// ZKlsPq_/:first-child chains) has to sit behind a header:has existence gate.
test('every selector in the alpha.2 header block carries the _headerLeading generation gate', () => {
  const source = layoutSource()
  const start = source.indexOf('0.1.6-alpha.2 session-header adaptation')
  assert.ok(start > 0, 'alpha.2 header section marker not found')
  const end = source.indexOf('/* --- Settings dialog on mobile ---', start)
  assert.ok(end > start, 'settings section marker not found after the header block')
  const lines = source.slice(start, end).split('\n')
  const offenders = lines
    .filter((line) => line.includes('[data-phase] header'))
    .filter((line) => !line.includes('header:has([class*="_headerLeading"])'))
  assert.deepEqual(offenders, [], 'ungated cross-generation selectors in the alpha.2 block')
  const gates = lines.filter((line) => line.includes('header:has([class*="_headerLeading"])')).length
  assert.ok(gates >= 30, `expected the full gated block, found only ${gates} gates`)
})

// The old position:static containment has higher specificity than the new
// absolute chip rules; with both !important, specificity decides (not source
// order), so on alpha.2 it must be excluded or the chips never leave the row.
test('the static containment rule is excluded on alpha.2 so absolute chips win', () => {
  assert.ok(
    layoutSource().includes(
      'header:not(:has([class*="_headerLeading"])) [class*="_headerActions"] [class*="_root"]',
    ),
    'static containment rule must carry the alpha.2 exclusion gate',
  )
})

// rc hosts render the input.left seat but ship no input[type=file] (intake is
// paste/drop only there); without this hide the control is a dead button.
test('the file-upload control hides itself where the host has no file input', () => {
  assert.ok(layoutSource().includes(':not(:has(input[type=file])) [data-mobile-nav="file-upload"]'))
})

// alpha.2 renamed the hero-empty marker; both hide rules must coexist.
test('the hero empty-header hide covers both generation markers', () => {
  const source = layoutSource()
  assert.ok(source.includes('header[class*="_headerHidden"]'))
  assert.ok(source.includes('header[class*="headerBlank"]'))
})
