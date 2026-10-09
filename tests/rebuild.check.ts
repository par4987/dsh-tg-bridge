/** `/rebuild` candidate selection: recency window, ordering, and the cap. */
import { assert, define, type Check } from './harness.ts'
import { rebuildCandidates } from '../src/rebuild.ts'

const DAY = 86_400_000

export const rebuildChecks: Check[] = [
  define('only sessions active inside the window qualify', () => {
    const now = 10 * DAY
    const picked = rebuildCandidates([
      { id: 'fresh', mtime: now - DAY },
      { id: 'stale', mtime: now - 30 * DAY },
    ], now, 7)
    assert(picked.length === 1, `only the fresh one qualifies (got ${picked.length})`)
    assert(picked[0]?.id === 'fresh', 'the fresh session is the one picked')
  }),

  define('sessions without activity never qualify', () => {
    const picked = rebuildCandidates([{ id: 'never-touched' }, { id: 'zero', mtime: 0 }], 10 * DAY, 7)
    assert(picked.length === 0, 'a session with no log activity is never imported')
  }),

  define('newest first, capped at twelve', () => {
    const now = 100 * DAY
    const candidates = Array.from({ length: 20 }, (_, i) => ({ id: `ses-${i}`, mtime: now - i * DAY }))
    const picked = rebuildCandidates(candidates, now, 365)
    assert(picked.length === 12, `the cap holds at twelve (got ${picked.length})`)
    assert(picked[0]?.id === 'ses-0', 'the newest comes first')
    assert(picked[11]?.id === 'ses-11', 'the twelfth newest is the last in')
  }),
]
