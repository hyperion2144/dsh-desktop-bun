// Sessions service shape drifted in 0.1.6-alpha.2 (audit doc §10.1): a2
// removed `ISessions.open`/`clear` and `SessionListState.current` /
// `currentAddress`, moving selection to per-session `retainedBy` counters
// (upstream reads it as
// `Object.values(byId).find(s => (s.retainedBy.mainView ?? 0) > 0)?.id`).
// These helpers let call sites stay compile-green against rc.2 typings while
// degrading explicitly on an a2 host instead of throwing or silently dying.

/** Structural view across generations — never import service types here, so
 *  the helper compiles against either generation's typings. */
interface SessionListLike {
  current?: unknown
  byId?: Record<string, { id?: unknown; retainedBy?: { mainView?: unknown } }>
}

/** The current session id: rc.2's `current` field when present, else the a2
 *  main-view-retained session. Undefined when the shape matches neither. */
export function currentSessionIdOf(list: unknown): string | undefined {
  if (typeof list !== 'object' || list === null) return undefined
  const snapshot = list as SessionListLike
  if (typeof snapshot.current === 'string') return snapshot.current
  for (const key in snapshot.byId) {
    const summary = snapshot.byId[key]
    // for-in guarantees the key exists, not the value — an explicitly
    // undefined property still reaches the guard below.
    if (summary === undefined) continue
    const mainView = summary.retainedBy?.mainView
    if (typeof mainView === 'number' && mainView > 0 && typeof summary.id === 'string') return summary.id
  }
  return undefined
}

/** a2 removed `clear()` (selection lifecycle moved to the retain model). */
export function sessionsCanClear(sessions: unknown): boolean {
  return typeof (sessions as { clear?: unknown } | null | undefined)?.clear === 'function'
}

/** a2 removed `open()`; callers must degrade (armNav fallback in
 *  phone-chrome) instead of throwing inside the capture pointerup listener. */
export function sessionsCanOpen(sessions: unknown): boolean {
  return typeof (sessions as { open?: unknown } | null | undefined)?.open === 'function'
}
