import { test } from 'node:test'
import assert from 'node:assert/strict'
import { panelSelectorOf } from '../src/client/core/layout-compat.ts'

// The two host generations this plugin spans. rc.6's layout face has no
// selectPanel at all; 0.1.6-alpha.2 added it. Both shapes are declared inline
// (never imported) so the test keeps compiling against either generation's
// typings — the same reason the helper itself takes `unknown`.

test('rc.6 layout face has no panel selection: the probe yields null', () => {
  const rc6 = { toggleSidebar: (): void => {}, openDetails: (): void => {}, closeDetails: (): void => {} }
  assert.equal(panelSelectorOf(rc6), null)
})

test('alpha.2 layout face yields an action that selects no panel', () => {
  const calls: unknown[] = []
  const alpha2 = { toggleSidebar: (): void => {}, selectPanel: (panelId: unknown): void => { calls.push(panelId) } }
  const select = panelSelectorOf(alpha2)
  assert.notEqual(select, null)
  select?.()
  assert.deepEqual(calls, [null])
})

test('the action keeps its receiver (selectPanel is called on the layout face)', () => {
  const alpha2 = {
    seen: 'unset' as unknown,
    selectPanel(this: { seen: unknown }, panelId: unknown): void {
      this.seen = panelId
    },
  }
  panelSelectorOf(alpha2)?.()
  assert.equal(alpha2.seen, null)
})

test('absent or non-callable layouts degrade to null instead of throwing', () => {
  for (const value of [undefined, null, 0, 'layout', {}, { selectPanel: 'nope' }]) {
    assert.equal(panelSelectorOf(value), null, 'expected null for ' + String(value))
  }
})
