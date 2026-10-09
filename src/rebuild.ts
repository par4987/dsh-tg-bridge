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
 * Last real activity for a persisted session: the newest file mtime inside
 * its directory, or undefined when there is nothing to read.
 */
export function lastActiveAt(sessionId: string): number | undefined {
  try {
    const dir = join(sessionsRoot(), sessionId)
    let newest = 0
    for (const entry of readdirSync(dir)) {
      const mtime = statSync(join(dir, entry)).mtimeMs
      if (mtime > newest) newest = mtime
    }
    return newest > 0 ? newest : undefined
  } catch {
    return undefined
  }
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
