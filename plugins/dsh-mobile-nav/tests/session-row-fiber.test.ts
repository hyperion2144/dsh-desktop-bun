// session-row-fiber.test.ts — unit tests for the DOM-free fiber-walk core.
//
// The fixtures are hand-built fiber objects (only `memoizedProps` and `return`
// are read), so the whole module is covered without a DOM, a renderer or a DSH
// runtime. The measured shapes are the ones the live 0.1.5-rc.2 host renders:
// the row item fiber is 3 hops above the tapped element and carries the id at
// `props.node.id`, and a `ScopeProvider` ancestor carries the shape-plausible
// string 'session-maybe' at `props.scope`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FIBER_WALK_LIMIT,
  findSessionIdInFiber,
  isTapWithinSlop,
  reactFiberOf,
} from '../src/client/effects/session-row-fiber.ts'
import type { FiberNodeLike } from '../src/client/effects/session-row-fiber.ts'

const KNOWN = new Set(['session-cad7-1', 'session-cad7-2', 'session-near', 'session-far'])
const isKnown = (id: string): boolean => KNOWN.has(id)

/**
 * Build a fiber chain. The FIRST props object is the starting fiber (the one
 * `reactFiberOf` returns for the tapped element); every later one is its
 * `.return` ancestor, i.e. `chain(a, b, c)` is a → b → c.
 */
function chain(...propsList: Array<Record<string, unknown>>): FiberNodeLike | null {
  let node: FiberNodeLike | null = null
  for (const props of [...propsList].reverse()) {
    node = { memoizedProps: props, return: node }
  }
  return node
}

/** `count` ancestors carrying nothing but unrelated props. */
function noise(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => ({}))
}

test('props.node.id on the row item fiber three hops up is the session id', () => {
  const tapped = chain({}, {}, {}, { node: { id: 'session-cad7-1' } })
  assert.equal(findSessionIdInFiber(tapped, isKnown), 'session-cad7-1')
})

test('the nearest accepted id wins over an accepted id further up', () => {
  const chainFixture = chain({ node: { id: 'session-near' } }, { node: { id: 'session-far' } })
  assert.equal(findSessionIdInFiber(chainFixture, isKnown), 'session-near')
})

test('a rejected hop does not shadow an accepted id further up', () => {
  const chainFixture = chain({ node: { id: 'session-fresh-9' } }, { sessionId: 'session-cad7-1' })
  assert.equal(findSessionIdInFiber(chainFixture, isKnown), 'session-cad7-1')
})

test('node / session / summary / result are the four object sources', () => {
  assert.equal(findSessionIdInFiber(chain({ node: { id: 'session-cad7-1' } }), isKnown), 'session-cad7-1')
  assert.equal(findSessionIdInFiber(chain({ session: { id: 'session-cad7-2' } }), isKnown), 'session-cad7-2')
  assert.equal(findSessionIdInFiber(chain({ summary: { id: 'session-near' } }), isKnown), 'session-near')
  assert.equal(findSessionIdInFiber(chain({ result: { id: 'session-far' } }), isKnown), 'session-far')
})

test('sessionId and id are the flat sources, and object sources are read first', () => {
  assert.equal(findSessionIdInFiber(chain({ sessionId: 'session-cad7-1' }), isKnown), 'session-cad7-1')
  assert.equal(findSessionIdInFiber(chain({ id: 'session-cad7-2' }), isKnown), 'session-cad7-2')
  // Pinned key order: a hop carrying both returns the object source.
  const both = chain({ node: { id: 'session-near' }, sessionId: 'session-far' })
  assert.equal(findSessionIdInFiber(both, isKnown), 'session-near')
})

test('unrelated command ids (rename / fork) are never mistaken for a session', () => {
  // The row's ⋯ menu items sit on the same fiber chain and carry command ids.
  const withMenu = chain({ id: 'rename' }, { id: 'fork' }, { node: { id: 'session-cad7-1' } })
  assert.equal(findSessionIdInFiber(withMenu, isKnown), 'session-cad7-1')
  assert.equal(findSessionIdInFiber(chain({ node: { id: 'rename' } }), isKnown), null)
  assert.equal(findSessionIdInFiber(chain({ id: 'fork' }), isKnown), null)
})

test('a session-shaped but unlisted id is rejected, not guessed', () => {
  const knows = (id: string): boolean => new Set(['session-cad7-1']).has(id)
  assert.equal(findSessionIdInFiber(chain({ id: 'session-fresh-9' }), knows), null)
  assert.equal(findSessionIdInFiber(chain({ scope: 'session-maybe' }), knows), null)
})

test('membership is the only gate: every candidate is offered to the caller', () => {
  const seen: string[] = []
  const spy = (id: string): boolean => {
    seen.push(id)
    return false
  }
  assert.equal(findSessionIdInFiber(chain({ id: 'session-fresh-9' }), spy), null)
  // The unlisted candidate reached the predicate, so the rejection came from
  // membership and not from a shape filter inside the walk.
  assert.ok(seen.includes('session-fresh-9'), `predicate never saw the candidate: ${JSON.stringify(seen)}`)
  // `scope` is not a session-id key, so the measured ScopeProvider hop is never
  // even offered (its value is the shape-plausible string 'session-maybe').
  seen.length = 0
  assert.equal(findSessionIdInFiber(chain({ scope: 'session-maybe' }), spy), null)
  assert.deepEqual(seen, [])
})

test('a known id above the session-maybe scope hop is still found', () => {
  const chainFixture = chain({ scope: 'session-maybe' }, { node: { id: 'session-cad7-1' } })
  assert.equal(findSessionIdInFiber(chainFixture, isKnown), 'session-cad7-1')
})

test('the walk is bounded by FIBER_WALK_LIMIT', () => {
  assert.equal(FIBER_WALK_LIMIT, 60)
  const lastInside = chain(...noise(FIBER_WALK_LIMIT - 1), { node: { id: 'session-cad7-1' } })
  const firstOutside = chain(...noise(FIBER_WALK_LIMIT), { node: { id: 'session-cad7-1' } })
  assert.equal(findSessionIdInFiber(lastInside, isKnown), 'session-cad7-1')
  assert.equal(findSessionIdInFiber(firstOutside, isKnown), null)
})

test('an explicit limit counts the starting fiber as the first hop', () => {
  const twoHops = chain({}, { node: { id: 'session-cad7-1' } })
  assert.equal(findSessionIdInFiber(twoHops, isKnown, 2), 'session-cad7-1')
  assert.equal(findSessionIdInFiber(twoHops, isKnown, 1), null)
  assert.equal(findSessionIdInFiber(chain({ node: { id: 'session-cad7-1' } }), isKnown, 0), null)
})

test('a missing or malformed chain yields null instead of throwing', () => {
  assert.equal(findSessionIdInFiber(null, isKnown), null)
  assert.equal(findSessionIdInFiber(undefined, isKnown), null)
  assert.equal(findSessionIdInFiber({}, isKnown), null)
  assert.equal(findSessionIdInFiber({ memoizedProps: null }, isKnown), null)
  assert.equal(findSessionIdInFiber({ return: null }, isKnown), null)
  // Wrong-typed values are ignored even when they carry a known id.
  const junk = chain({ node: null, session: 'session-cad7-1', sessionId: 42, id: { id: 'session-cad7-1' } })
  assert.equal(findSessionIdInFiber(junk, isKnown), null)
  assert.equal(findSessionIdInFiber(chain(...noise(200)), isKnown), null)
})

test('reactFiberOf reads the React fiber stamps and ignores anything else', () => {
  const fiber: FiberNodeLike = { memoizedProps: { node: { id: 'session-cad7-1' } } }
  const stale: FiberNodeLike = { memoizedProps: {} }
  assert.equal(reactFiberOf({ __reactFiber$abc123: fiber }), fiber)
  assert.equal(reactFiberOf({ __reactInternalInstance$zz9: fiber }), fiber)
  // __reactFiber$ wins when a node carries both stamps.
  assert.equal(reactFiberOf({ __reactInternalInstance$zz9: stale, __reactFiber$abc123: fiber }), fiber)
  // Deterministic when two renderers stamped the same node.
  assert.equal(reactFiberOf({ __reactFiber$a: fiber, __reactFiber$b: stale }), fiber)
})

test('reactFiberOf returns null for non-object values and unstamped objects', () => {
  assert.equal(reactFiberOf(null), null)
  assert.equal(reactFiberOf(undefined), null)
  assert.equal(reactFiberOf('session-cad7-1' as unknown as object), null)
  assert.equal(reactFiberOf(7 as unknown as object), null)
  assert.equal(reactFiberOf({}), null)
  assert.equal(reactFiberOf({ __reactProps$abc: {} }), null)
  assert.equal(reactFiberOf({ __reactFiber$abc: 'not a fiber' }), null)
  assert.equal(reactFiberOf({ __reactFiber$abc: null }), null)
})

test('isTapWithinSlop keeps a release within slop on BOTH axes', () => {
  const from = { x: 100, y: 200 }
  const at = (x: number, y: number): { x: number; y: number } => ({ x, y })
  assert.equal(isTapWithinSlop(from, at(100, 200), 12), true)
  assert.equal(isTapWithinSlop(from, at(112, 200), 12), true)
  assert.equal(isTapWithinSlop(from, at(88, 200), 12), true)
  assert.equal(isTapWithinSlop(from, at(100, 212), 12), true)
  assert.equal(isTapWithinSlop(from, at(112.5, 200), 12), false)
  assert.equal(isTapWithinSlop(from, at(100, 213), 12), false)
  // A drawer-list scroll moves the finger vertically; that release is not a tap.
  assert.equal(isTapWithinSlop(from, at(102, 260), 12), false)
  // Per-axis (max-norm) slop, not Euclidean: 12/12 is inside, 13/13 is not.
  assert.equal(isTapWithinSlop(from, at(112, 212), 12), true)
  assert.equal(isTapWithinSlop(from, at(113, 213), 12), false)
  // A zero slop is an exact-position test.
  assert.equal(isTapWithinSlop(from, at(100, 200), 0), true)
  assert.equal(isTapWithinSlop(from, at(100.5, 200), 0), false)
})
