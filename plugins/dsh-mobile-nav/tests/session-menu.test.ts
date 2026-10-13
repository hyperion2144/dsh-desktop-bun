// Session-menu dual-generation contract: the host's per-row menu changed
// shape in 0.1.5 (label lives directly in the menuitem button, no
// `_itemLabel`/`_itemIcon` spans). Recognition and the injected delete item
// must keep working on both shapes — a _itemLabel-only read silently
// disables the whole feature on 0.1.5 (menu no longer recognized).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(join(ROOT, 'src/client/effects/session-menu.ts'), 'utf8')

test('menu recognition reads labels via the label-or-item fallback, not _itemLabel alone', () => {
  // The fallback helper exists and is documented for both generations.
  assert.match(SOURCE, /const itemLabel = \(item: HTMLElement\): string =>/)
  assert.match(SOURCE, /puts it directly in the button/)
  // isSessionMenu maps over the menuitem list through the helper — the
  // rc.2-only selector `[role="menuitem"] [class*="_itemLabel"]` must be gone
  // from the recognition path.
  assert.doesNotMatch(SOURCE, /querySelectorAll<HTMLElement>\('\[role="menuitem"\] \[class\*="_itemLabel"\]'\)/)
  assert.match(SOURCE, /querySelectorAll<HTMLElement>\('\[role="menuitem"\]'\)/)
  assert.match(SOURCE, /\.map\(itemLabel\)/)
})

test('injected delete item covers both menu shapes', () => {
  // rc.2: the `_itemLabel` span gets the text + danger color.
  assert.match(SOURCE, /label\.textContent = navT\('deleteSession'\)/)
  assert.match(SOURCE, /label\.style\.color = DANGER_COLOR/)
  // 0.1.5: a childless button gets its whole text replaced; a button with
  // element children but no label span is an unknown shape and must be left
  // alone (no text guessing).
  assert.match(SOURCE, /else if \(button\.firstElementChild === null\) \{[\s\S]*?button\.textContent = navT\('deleteSession'\)/)
  assert.match(SOURCE, /button\.style\.color = DANGER_COLOR/)
  assert.match(SOURCE, /unknown future shape/)
})

test('the host delete-endpoint flow is unchanged', () => {
  // Marker + dialog ids (the browser-review and probe contract).
  assert.match(SOURCE, /DELETE_ITEM_MARKER = 'data-mobile-nav="session-delete"'/)
  assert.match(SOURCE, /delete-dialog-backdrop/)
  // The host menu is closed through its own anchor before the flow starts.
  assert.match(SOURCE, /captured\?\.button\.click\(\)/)
})

test('menu recognition is containment-style: rename + fork + archive', () => {
  // 0.1.7 added a fourth 「置顶会话」 item — an exact item-count gate
  // silently disabled the whole feature there, so the counted form must
  // stay gone from the predicate (the source comment may still cite it as
  // history).
  assert.doesNotMatch(SOURCE, /labels\.length === 3/)
  assert.match(SOURCE, /labels\.includes\(rename\) && labels\.includes\(fork\)/)
  assert.match(SOURCE, /labels\.includes\(wsT\('menu\.archiveSession'\)\)/)
  // The discriminating-triple rationale (fork label exists only in the
  // session menu) is documented next to the predicate.
  assert.match(SOURCE, /fork label exists only in ui-workspace/)
})

test('archived rows (unarchive swap) never get the injected delete item', () => {
  // #V1 N1: the former unarchive branch recognized archived-row menus and
  // injected a delete item that resolution can never satisfy (archived ids
  // are filtered out) — the tap always ended in deleteErrorResolve. The
  // predicate must key on archiveSession only; the unarchive call form must
  // stay gone from the code (negative assertion pinned to the call shape,
  // NOT a bare word — source comments may still cite the history).
  assert.doesNotMatch(SOURCE, /labels\.includes\(wsT\('menu\.unarchiveSession'\)\)/)
  assert.match(SOURCE, /Archived rows swap archive/)
  assert.match(SOURCE, /delete via unarchive first/)
})

test('blank (new-session) rows never get the injected delete item', () => {
  // A blank row renders the host's localized "New session" label while
  // displayTitle stays empty — resolution could never succeed, so the item
  // is withheld and the menu stays host-native.
  assert.match(SOURCE, /const blankLabel = wsT\('session\.new'\)/)
  assert.match(SOURCE, /anchor\.title === blankLabel/)
  // The accepted ceiling (a session manually titled exactly the host label)
  // is annotated in the source so it is not re-litigated as a bug.
  assert.match(SOURCE, /Known ceiling/)
})
