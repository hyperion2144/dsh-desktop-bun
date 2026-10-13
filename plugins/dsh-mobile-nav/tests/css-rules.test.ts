import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findRuleBlocks, matchesSelectorText, fontSizeFor } from '../src/client/core/css-rules.ts'
import { LAYOUT_CSS } from '../src/client/styles/layout.css.ts'

const MESSAGE_P: any = {
  tag: 'p',
  ancestors: [{ tag: 'div', classes: ['abc_scroll'] }],
}

test('findRuleBlocks descends into at-rules and keeps selector/body pairs', () => {
  const css = '@keyframes spin { from { opacity: 0 } to { opacity: 1 } }\n@media (max-width: 700px) { .x:has(p) { font-size: 15px !important; } }'
  const blocks = findRuleBlocks(css)
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].selector, /:has\(p\)/)
  assert.match(blocks[0].body, /15px/)
})

test('matchesSelectorText handles plain, class-substring and :has() arms', () => {
  assert.equal(matchesSelectorText('[class*="_scroll"]:has(p)', MESSAGE_P), true)
  assert.equal(matchesSelectorText('[class*="_scrollBody"]:has(p)', MESSAGE_P), false)
  // The wrapped spelling this repo writes for long arms (layout.css.ts:327-329)
  // must stay readable, or a px rule whose only subject arm is wrapped is invisible.
  assert.equal(matchesSelectorText('[ class*="abc_scroll" ]', MESSAGE_P), true)
  assert.equal(matchesSelectorText('p', MESSAGE_P), true)
  assert.equal(matchesSelectorText('li', MESSAGE_P), false)
})

test('the message text family carries no hardcoded px font-size', () => {
  const hit = fontSizeFor(LAYOUT_CSS, MESSAGE_P)
  assert.ok(hit !== null, 'expected a message text rule to match the fixture')
  assert.doesNotMatch(hit.value, /^\s*[\d.]+px/, `hardcoded size in: ${hit.selector}`)
  assert.match(hit.value, /var\(/)
})
