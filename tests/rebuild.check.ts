/** `/rebuild` selection: recency window, ordering, the cap, and the tree scan. */
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, define, type Check } from './harness.ts'
import { rebuildCandidates, scanSessionActivity } from '../src/rebuild.ts'

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

  define('the tree scan finds sessions under their cwd grouping', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rebuild-'))
    // The provider's real layout: <root>/<cwd-slug>/<session-id>/session.vN.jsonl
    const slug = join(root, '--C-work-project--')
    const a = join(slug, 'session-11111111-2222-3333-4444-555555555555')
    const b = join(slug, '99999999-8888-7777-6666-555555555555')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    writeFileSync(join(a, 'session.v1.jsonl'), 'old\n')
    const fresh = join(a, 'session.v2.jsonl')
    writeFileSync(fresh, 'newer\n')
    writeFileSync(join(b, 'session.v1.jsonl'), 'other\n')
    const activity = scanSessionActivity(root)
    assert(activity.size === 2, `both session directories were found (got ${activity.size})`)
    const aMtime = activity.get('session-11111111-2222-3333-4444-555555555555')
    assert(aMtime !== undefined, 'the prefixed session id was recorded')
    assert(aMtime === statSync(fresh).mtimeMs, 'the newest file inside the session directory wins')
    assert(activity.has('99999999-8888-7777-6666-555555555555'), 'the bare uuid session id was recorded')
  }),

  define('the tree scan ignores cwd slugs and empty sessions', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rebuild-'))
    mkdirSync(join(root, '--C-work--'), { recursive: true })
    mkdirSync(join(root, 'empty-session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), { recursive: true })
    const activity = scanSessionActivity(root)
    assert(activity.size === 0, `nothing reported activity (got ${activity.size})`)
  }),
]
