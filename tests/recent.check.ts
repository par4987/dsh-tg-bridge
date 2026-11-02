/** RecentStore: the prompt history's ordering, bound and persistence. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, define, type Check } from './harness.ts'
import { RECENT_CAP, RecentStore } from '../src/recent.ts'

function freshStore(dir = mkdtempSync(join(tmpdir(), 'tg-bridge-recent-'))): { store: RecentStore, dir: string } {
  return { store: new RecentStore(join(dir, 'recent.json')), dir }
}

export const recentChecks: Check[] = [
  define('record lists newest first', () => {
    const { store } = freshStore()
    store.record('ses-1', 'primero')
    store.record('ses-2', 'segundo')
    const entries = store.list()
    assert(entries.length === 2, 'both prompts are recorded')
    assert(entries[0]?.text === 'segundo', 'the newest heads the list')
    assert(entries[1]?.session === 'ses-1', 'the oldest trails with its session')
  }),

  define('the ring keeps only the newest RECENT_CAP entries', () => {
    const { store } = freshStore()
    for (let i = 0; i < RECENT_CAP + 25; i++) store.record('ses', `prompt ${i}`)
    const entries = store.list(RECENT_CAP + 25)
    assert(entries.length === RECENT_CAP, `the history caps at ${RECENT_CAP} (got ${entries.length})`)
    assert(entries[0]?.text === `prompt ${RECENT_CAP + 24}`, 'the cap keeps the very newest')
    assert(entries[entries.length - 1]?.text === `prompt ${25}`, 'the oldest survivor is the one just inside the cap')
  }),

  define('the history survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-bridge-recent-'))
    const first = new RecentStore(join(dir, 'recent.json'))
    first.record('ses-1', 'hola')
    const second = new RecentStore(join(dir, 'recent.json'))
    assert(second.list()[0]?.text === 'hola', 'a fresh store reads the persisted history')
    rmSync(dir, { recursive: true, force: true })
  }),
]
