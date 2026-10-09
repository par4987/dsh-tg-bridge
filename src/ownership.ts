/**
 * Cross-process ownership of the Telegram poll.
 *
 * Harness runs several processes that may all load this bundle — `web` and a
 * one-shot `headless`, two profiles side by side — and in live mode each would
 * start its own `getUpdates`. Telegram answers that with HTTP 409 and serves
 * only one of them, so the bridge elects a single owner the same way the
 * harness's own instances coordinate: a small JSON lock carrying the winner's
 * pid and a heartbeat. A holder whose pid is gone — or whose heartbeat froze
 * past `WEDGED_MS` while the process breathes — is contestable again.
 *
 * The lock is best effort: a profile that cannot write it still works, it just
 * may fight the 409 once.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const HEARTBEAT_MS = 5_000
/**
 * A live pid whose heartbeat froze this long is wedged — the process breathes
 * but its poll is stuck inside one never-returning call, so no code of its
 * will ever release the lock. Past this margin one hung process must not own
 * the bridge forever.
 */
export const WEDGED_MS = 60_000

interface LockFile {
  pid: number
  since: number
  beat: number
}

/** Tests point this at a temp file so they never touch the real election. */
function lockPath(stateDir: string): string {
  return process.env.TG_LOCK_FILE ?? join(stateDir, 'leader.lock')
}

function readLock(path: string): LockFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as LockFile
    if (typeof parsed.pid !== 'number' || typeof parsed.beat !== 'number') return undefined
    return parsed
  } catch {
    return undefined
  }
}

function writeLock(path: string, lock: LockFile, onWarn: (detail: unknown) => void): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(lock))
  } catch (error) {
    onWarn(error)
  }
}

/** A pid we cannot signal is not running. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Take the lock if it is free, its holder is dead, or its holder is wedged.
 * @param stateDir - the bridge's state directory holding the lock file.
 * @param onWarn - best-effort write-failure reporter.
 * @returns whether this process now owns the poll.
 */
export function acquireLock(stateDir: string, onWarn: (detail: unknown) => void = () => {}): boolean {
  const path = lockPath(stateDir)
  const now = Date.now()
  const existing = readLock(path)

  if (existing !== undefined && existing.pid !== process.pid) {
    const dead = !pidAlive(existing.pid)
    const wedged = !dead && now - existing.beat > WEDGED_MS
    if (!dead && !wedged) return false
  }

  writeLock(path, { pid: process.pid, since: existing?.since ?? now, beat: now }, onWarn)

  // Re-read: if a faster writer won, bow out instead of splitting the poll.
  const after = readLock(path)
  return after !== undefined && after.pid === process.pid
}

/** Refresh the heartbeat so other processes know we are still here. */
export function heartbeat(stateDir: string, onWarn: (detail: unknown) => void = () => {}): void {
  const path = lockPath(stateDir)
  const existing = readLock(path)
  if (existing === undefined || existing.pid !== process.pid) return
  writeLock(path, { ...existing, beat: Date.now() }, onWarn)
}

/** Release only if the lock is still ours. */
export function releaseLock(stateDir: string): void {
  const path = lockPath(stateDir)
  const existing = readLock(path)
  if (existing === undefined || existing.pid !== process.pid) return
  try {
    unlinkSync(path)
  } catch {
    /* already gone */
  }
}

/** The pid that currently owns the poll, if the lock is readable. */
export function lockHeldBy(stateDir: string): number | undefined {
  return readLock(lockPath(stateDir))?.pid
}

/** The election cadence the caller should schedule. */
export const LOCK_INTERVAL_MS = HEARTBEAT_MS

// ── per-profile liveness ─────────────────────────────────────────────────────

/**
 * Which profiles have a live bridge, for the poll owner's routing guard: an
 * inbound prompt may wake a persisted session, and waking one another live
 * process is already driving would point two agents at the same log. Each
 * loaded bridge refreshes its own entry every election tick; an entry whose
 * heartbeat went stale is a profile that left the room.
 */
export interface ProfileBeat {
  pid: number
  beat: number
}

interface BeatsFile {
  profiles?: Record<string, ProfileBeat>
}

function beatsPath(stateDir: string): string {
  return join(stateDir, 'profiles.json')
}

function readBeats(stateDir: string): Record<string, ProfileBeat> {
  try {
    const parsed = JSON.parse(readFileSync(beatsPath(stateDir), 'utf8')) as BeatsFile
    return parsed.profiles ?? {}
  } catch {
    return {}
  }
}

/** Refresh this profile's liveness entry. */
export function beatProfile(stateDir: string, profile: string, onWarn: (detail: unknown) => void = () => {}): void {
  const beats = readBeats(stateDir)
  beats[profile] = { pid: process.pid, beat: Date.now() }
  try {
    mkdirSync(dirname(beatsPath(stateDir)), { recursive: true })
    writeFileSync(beatsPath(stateDir), JSON.stringify({ profiles: beats }))
  } catch (error) {
    onWarn(error)
  }
}

/** Drop this profile's liveness entry on teardown. */
export function clearProfileBeat(stateDir: string, profile: string): void {
  const beats = readBeats(stateDir)
  if (!(profile in beats)) return
  delete beats[profile]
  try {
    mkdirSync(dirname(beatsPath(stateDir)), { recursive: true })
    writeFileSync(beatsPath(stateDir), JSON.stringify({ profiles: beats }))
  } catch {
    /* a stale entry expires on its own */
  }
}

/**
 * True when the session's owning profile is a DIFFERENT profile whose
 * bridge is still beating — the poll owner must not resume its sessions.
 * @param stateDir - the shared state directory.
 * @param sessionProfile - the profile recorded on the mapping.
 * @param myProfile - the profile this process runs under.
 * @param now - single wall-clock sample for staleness.
 */
export function isElsewhereLive(
  stateDir: string,
  sessionProfile: string | undefined,
  myProfile: string,
  now = Date.now(),
): boolean {
  if (sessionProfile === undefined || sessionProfile === myProfile) return false
  const beat = readBeats(stateDir)[sessionProfile]
  return beat !== undefined && now - beat.beat < WEDGED_MS
}
