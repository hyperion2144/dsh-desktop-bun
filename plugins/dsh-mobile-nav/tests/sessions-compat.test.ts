// Dual-generation sessions shape (audit doc §10.1): rc.2 carries
// SessionListState.current, a2 removed it (open/clear too) and moved
// selection to per-session retainedBy counters. The helpers must read both
// shapes so the plugin stays compile-green on rc.2 typings and runs green on
// an a2 host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentSessionIdOf, sessionsCanClear, sessionsCanOpen } from '../src/client/core/sessions-compat.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FOOTER = readFileSync(join(ROOT, 'src/client/components/MobileDrawerFooter.tsx'), 'utf8')
const MENU = readFileSync(join(ROOT, 'src/client/effects/session-menu.ts'), 'utf8')
const CHROME = readFileSync(join(ROOT, 'src/client/effects/phone-chrome.ts'), 'utf8')

test('currentSessionIdOf reads the rc.2 current field first', () => {
  assert.equal(currentSessionIdOf({ current: 's1', byId: {} }), 's1')
})

test('currentSessionIdOf derives from a2 retainedBy.mainView when current is gone', () => {
  const a2 = {
    byId: {
      a: { id: 'a', retainedBy: { mainView: 0 } },
      b: { id: 'b', retainedBy: { mainView: 2 } },
    },
  }
  assert.equal(currentSessionIdOf(a2), 'b')
})

test('currentSessionIdOf returns undefined on empty, foreign and null shapes', () => {
  assert.equal(currentSessionIdOf({}), undefined)
  assert.equal(currentSessionIdOf({ byId: { a: { id: 'a', retainedBy: { mainView: 0 } } } }), undefined)
  assert.equal(currentSessionIdOf(null), undefined)
  assert.equal(currentSessionIdOf('nope'), undefined)
})

test('sessionsCanClear / sessionsCanOpen feature-detect the a2 removals', () => {
  assert.equal(sessionsCanClear({ clear: () => {} }), true)
  assert.equal(sessionsCanClear({}), false)
  assert.equal(sessionsCanClear(null), false)
  assert.equal(sessionsCanOpen({ open: (id: string) => id }), true)
  assert.equal(sessionsCanOpen({}), false)
})

test('all four current reads go through currentSessionIdOf', () => {
  assert.match(FOOTER, /useSessions\(\(state\) => currentSessionIdOf\(state\)\)/)
  assert.doesNotMatch(FOOTER, /state\.current/)
  const snapshotReads = MENU.match(/currentSessionIdOf\(ctx\.sessions\.list\.getSnapshot\(\)\)/g) ?? []
  const chromeReads = CHROME.match(/currentSessionIdOf\(ctx\.sessions\.list\.getSnapshot\(\)\)/g) ?? []
  assert.ok(snapshotReads.length >= 1, 'session-menu reads via helper')
  assert.ok(chromeReads.length >= 2, 'phone-chrome reads via helper (tappedRowSessionId + closeOnNavigation)')
  assert.doesNotMatch(CHROME, /getSnapshot\(\)\.current/)
  assert.doesNotMatch(MENU, /getSnapshot\(\)\.current/)
})

test('clear and open are feature-detected, not assumed', () => {
  assert.match(MENU, /if \(wasCurrent && sessionsCanClear\(ctx\.sessions\)\) ctx\.sessions\.clear\(\)/)
  assert.match(CHROME, /sessionsCanOpen\(ctx\.sessions\)/)
  // a2 degrade: no open() -> the DOM-observer closer takes the tap, and the
  // store-subscription closer (which has no signal on a2) must NOT be armed.
  // Anchored on the a2 comment: the bare closer pair also matches the
  // pre-existing tap-fallback branch, which would make this assertion vacuous.
  assert.match(CHROME, /a2 removed sessions\.open[\s\S]*?disarmCloseOnNav\(\)\n\s*armNav\(\)/)
})
