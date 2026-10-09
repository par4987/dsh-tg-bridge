/**
 * `/rebuild` selection: which persisted sessions earn a forum thread.
 *
 * Harness-free on purpose — the selection is the part that gets unit-tested.
 * Recency comes from the newest file mtime inside the session's directory,
 * the log's own bytes rather than any housekeeping clock that touches every
 * session on startup.
 */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** A persisted session as `/rebuild` considers it. */
export interface RebuildCandidate {
  id: string
  mtime?: number
  cwd?: string
}

/**
 * The persisted-session root: same resolution the jsonl provider's
 * `dshHomePath('sessions')` uses at boot.
 */
export function sessionsRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
}

/**
 * Scan the persisted-session tree for last activity per session.
 *
 * The provider lays logs out as `<root>/<cwd-slug>/<session-id>/session.vN.jsonl[.zstd]` —
 * a cwd grouping level sits above the session directories, so a session's
 * directory cannot be addressed by id alone. Walk the tree instead and record
 * the newest file mtime inside every directory whose name carries a session
 * id (both bare uuid and `session-<uuid>` forms match).
 * @param root - the persisted-session root (`dshHomePath('sessions')`).
 * @returns session id → newest file mtime inside its directory.
 */
export function scanSessionActivity(root: string): Map<string, number> {
  const activity = new Map<string, number>()
  const walk = (dir: string, depth: number): void => {
    let entries: ReadonlyArray<import('node:fs').Dirent>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = join(dir, entry.name)
      if (SESSION_ID.test(entry.name)) {
        let newest = 0
        try {
          for (const file of readdirSync(child)) {
            const mtime = statSync(join(child, file)).mtimeMs
            if (mtime > newest) newest = mtime
          }
        } catch {
          /* an unreadable session directory simply reports no activity */
        }
        if (newest > 0) activity.set(entry.name, newest)
      } else if (depth < 2) {
        walk(child, depth + 1)
      }
    }
  }
  walk(root, 0)
  return activity
}

/**
 * Which persisted sessions `/rebuild` maps: unmapped ones with activity
 * inside the window, newest first, capped so one command never floods the
 * forum with topics.
 * @param candidates - unmapped root sessions with their last activity.
 * @param now - single wall-clock sample for the window.
 * @param days - how many days back "recently active" reaches.
 * @returns the sessions to import, newest first.
 */
export function rebuildCandidates(candidates: RebuildCandidate[], now: number, days: number): RebuildCandidate[] {
  const cutoff = now - days * 86_400_000
  return candidates
    .filter((candidate) => candidate.mtime !== undefined && candidate.mtime >= cutoff)
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    .slice(0, 12)
}
