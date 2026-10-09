/** Cross-process ownership: acquire, refuse while held, steal when dead. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { assert, define, type Check } from './harness.ts'
import { acquireLock, heartbeat, releaseLock } from '../src/ownership.ts'

const scratch = mkdtempSync(join(tmpdir(), 'tg-bridge-lock-'))
process.env.TG_LOCK_FILE = join(scratch, 'leader.lock')

/** A child that stays alive until killed — the "other live process". */
function spawnSleeper(): { pid: number, kill: () => void } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  if (child.pid === undefined) throw new Error('could not spawn the sleeper process')
  return {
    pid: child.pid,
    kill: () => {
      child.kill()
    },
  }
}

export const ownershipChecks: Check[] = [
  define('acquire takes a free lock', () => {
    releaseLock(scratch)
    assert(acquireLock(scratch), 'the free lock is taken')
  }),

  define('acquire refuses while another live process holds it', () => {
    const other = spawnSleeper()
    try {
      writeFileSync(process.env.TG_LOCK_FILE ?? '', JSON.stringify({ pid: other.pid, since: Date.now(), beat: Date.now() }))
      assert(!acquireLock(scratch), 'a live fresh holder is not contestable')
    } finally {
      other.kill()
    }
  }),

  define('acquire steals a dead holder', () => {
    const other = spawnSleeper()
    writeFileSync(process.env.TG_LOCK_FILE ?? '', JSON.stringify({ pid: other.pid, since: Date.now(), beat: Date.now() }))
    other.kill()
    assert(acquireLock(scratch), 'a dead holder is replaced')
  }),

  define('acquire steals a wedged holder', () => {
    // Our own pid with a heartbeat frozen far in the past: the process
    // breathes but the poll is never coming back.
    writeFileSync(process.env.TG_LOCK_FILE ?? '', JSON.stringify({ pid: process.pid, since: 0, beat: 0 }))
    assert(acquireLock(scratch), 'a wedged holder is replaced')
  }),

  define('heartbeat refreshes and release gives the seat back', () => {
    assert(acquireLock(scratch), 'we hold the lock')
    heartbeat(scratch)
    releaseLock(scratch)
    assert(acquireLock(scratch), 'the released lock is free again')
    releaseLock(scratch)
    rmSync(scratch, { recursive: true, force: true })
  }),
]
