// #82: the DSHA tap-close exemption (data-dsha-session-select rows close on
// dsha-session-open, not on tap) was added inside shouldCloseOnTapInsideDrawer
// — a predicate that ALSO gates long-press arming (onDrawerPointerDown).
// One predicate, two questions: tap-close callers must skip DSHA rows, the
// arming gate must not, or the host's ⋯ row menu becomes unreachable on touch.
// This test pins the split: arming uses the exemption-free base, tap-close
// callers keep the exempt predicate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = readFileSync(join(ROOT, 'src/client/effects/phone-chrome.ts'), 'utf8')

// Extract a top-level const arrow-function body inside installOverlayInteractions:
// from its declaration up to the next sibling — an exactly-4-space `const ` or
// `//` comment (sibling comments sit at 4 spaces; comments inside a body are
// indented with the body, so they never cut the window short).
const bodyOf = (name: string): string => {
  const start = CHROME.indexOf(`const ${name} = `)
  assert.notEqual(start, -1, `const ${name} not found in phone-chrome.ts`)
  const rest = CHROME.slice(start)
  const ends = ['\n    const ', '\n    // ']
    .map((marker) => rest.indexOf(marker, 1))
    .filter((index) => index !== -1)
  const next = ends.length > 0 ? Math.min(...ends) : -1
  return next === -1 ? rest : rest.slice(0, next)
}

test('#82: long-press arming gate is not routed through the DSHA-exempt predicate', () => {
  const arming = bodyOf('onDrawerPointerDown')
  // Fails on the pre-fix shape: the gate reused shouldCloseOnTapInsideDrawer,
  // whose DSHA early-return starved pressTimer on data-dsha-session-select rows.
  assert.doesNotMatch(arming, /shouldCloseOnTapInsideDrawer/)
  assert.match(arming, /isDrawerNavTarget\(target\)/)
  // The base predicate itself carries no DSHA exemption — if it creeps back
  // in, both callers collapse into the #82 bug again.
  assert.doesNotMatch(bodyOf('isDrawerNavTarget'), /data-dsha-session-select/)
})

test('#82: both tap-close callers keep the DSHA-exempt predicate', () => {
  // click (close on synthesized click) and pointerup (close/nav arming) must
  // still skip DSHA rows — single tap there only selects (DSHA_SESSION_
  // INTERACTION_V1), closing or navigating on it breaks double-tap-open.
  assert.match(bodyOf('onDrawerClick'), /shouldCloseOnTapInsideDrawer\(target\)/)
  assert.match(bodyOf('onDrawerPointerUp'), /shouldCloseOnTapInsideDrawer\(target\)/)
  // The exemption itself lives in exactly that predicate.
  assert.match(bodyOf('shouldCloseOnTapInsideDrawer'), /data-dsha-session-select/)
})
