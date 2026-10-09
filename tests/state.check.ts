/** BridgeState: the persisted session↔thread mapping and its invariants. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, define, type Check } from './harness.ts'
import { BridgeState } from '../src/state.ts'

function freshState(): { state: BridgeState, dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tg-bridge-state-'))
  const state = new BridgeState(join(dir, 'state.json'))
  return { state, dir }
}

export const stateChecks: Check[] = [
  define('a new mapping appears once a thread is set', () => {
    const { state } = freshState()
    assert(!state.has('ses-1'), 'an unknown session has no mapping')
    state.setThread('ses-1', 42)
    assert(state.has('ses-1'), 'the mapping exists after setThread')
    assert(state.threadOf('ses-1') === 42, 'the thread id round-trips')
    assert(state.sessionOf(42) === 'ses-1', 'the inverse lookup finds the session')
  }),

  define('removeByThread forgets the mapping and the root target', () => {
    const { state } = freshState()
    state.setThread('ses-1', 10)
    state.setThread('ses-2', 20)
    state.setRootSession('ses-2')
    state.removeByThread(20)
    assert(!state.has('ses-2'), 'the dead thread\'s mapping is gone')
    assert(state.rootSession() === undefined, 'the root target no longer dangles')
    assert(state.has('ses-1'), 'other mappings survive')
  }),

  define('titles are learned and persisted across reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-bridge-state-'))
    const first = new BridgeState(join(dir, 'state.json'))
    first.setTitle('ses-9', 'Arreglar el build')
    first.setSavedLocale('en')
    first.flushNow()
    const second = new BridgeState(join(dir, 'state.json'))
    assert(second.titleOf('ses-9') === 'Arreglar el build', 'the title survives a reload')
    assert(second.savedLocale() === 'en', 'the locale survives a reload')
    rmSync(dir, { recursive: true, force: true })
  }),

  define('archive flags flip and clear', () => {
    const { state } = freshState()
    state.setArchived('ses-1', true)
    assert(state.isArchived('ses-1'), 'the flag is set')
    state.setArchived('ses-1', false)
    assert(!state.isArchived('ses-1'), 'the flag is cleared')
  }),

  define('usage accumulates and keeps the last turn', () => {
    const { state } = freshState()
    state.addUsage('ses-1', { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    state.addUsage('ses-1', { inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    const usage = state.usageOf('ses-1')
    assert(usage.total?.totalTokens === 17, 'the total accumulates')
    assert(usage.last?.totalTokens === 2, 'the last turn is the latest delta')
  }),

  define('sessionByPrefix resolves case-insensitively', () => {
    const { state } = freshState()
    state.setThread('ses-AbC123', 7)
    assert(state.sessionByPrefix('SES-ABC') === 'ses-AbC123', 'a prefix with other case resolves')
    assert(state.sessionByPrefix('zzz') === undefined, 'an unknown prefix resolves to nothing')
  }),

  define('concurrent instances merge instead of clobbering each other', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-bridge-state-'))
    const file = join(dir, 'state.json')
    // Two processes with their own instances over one file: an interleaved
    // write must not wipe the other one's mapping.
    const web = new BridgeState(file)
    web.setThread('ses-web', 1)
    const desktop = new BridgeState(file)
    desktop.setThread('ses-desktop', 2)
    assert(web.threadOf('ses-web') === 1, 'the first writer sees its own mapping')
    assert(web.threadOf('ses-desktop') === 2, 'the first writer also sees the second one\'s mapping')
    assert(desktop.threadOf('ses-web') === 1, 'the second writer sees the first one\'s mapping')
    // An interleaved mutation from the first writer keeps the second's data.
    web.setTitle('ses-web', 'título')
    assert(desktop.titleOf('ses-web') === 'título', 'the desktop instance sees the title')
    assert(desktop.threadOf('ses-desktop') === 2, 'the desktop mapping survives the web write')
    rmSync(dir, { recursive: true, force: true })
  }),

  define('profile claims travel with the mapping', () => {
    const { state } = freshState()
    state.claim('ses-1', 'web')
    assert(state.profileOf('ses-1') === 'web', 'the claim is recorded')
    state.claim('ses-1', 'desktop')
    assert(state.profileOf('ses-1') === 'desktop', 'a re-claim replaces the profile')
    const other = state.profileOf('ses-none')
    assert(other === undefined, 'an unknown session has no profile')
  }),
]
