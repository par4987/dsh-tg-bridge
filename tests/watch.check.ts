/** BridgeState's `/watch` selection: the mirror gate and its persistence. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, define, type Check } from './harness.ts'
import { BridgeState } from '../src/state.ts'

function freshState(): BridgeState {
  const dir = mkdtempSync(join(tmpdir(), 'tg-bridge-watch-'))
  return new BridgeState(join(dir, 'state.json'))
}

export const watchChecks: Check[] = [
  define('the default watches every mapped session', () => {
    const state = freshState()
    assert(state.watchOf().mode === 'all', 'a fresh state watches everything')
    state.setThread('ses-1', 11)
    state.setThread('ses-2', 22)
    assert(state.isWatched('ses-1') === true, 'a mapped session is watched')
    assert(state.isWatched('unmapped') === false, 'an unmapped session never is')
  }),

  define('one mode watches only the chosen session', () => {
    const state = freshState()
    state.setThread('ses-1', 11)
    state.setThread('ses-2', 22)
    state.setWatch({ mode: 'one', session: 'ses-2' })
    assert(state.isWatched('ses-1') === false, 'the other session goes silent')
    assert(state.isWatched('ses-2') === true, 'the chosen one stays mirrored')
    assert(state.watchOf().session === 'ses-2', 'the selection reads back')
  }),

  define('off mode watches nothing', () => {
    const state = freshState()
    state.setThread('ses-1', 11)
    state.setWatch({ mode: 'off' })
    assert(state.isWatched('ses-1') === false, 'nothing is watched in off mode')
  }),

  define('an archived session stays silent whatever the mode', () => {
    const state = freshState()
    state.setThread('ses-1', 11)
    state.setArchived('ses-1', true)
    assert(state.isWatched('ses-1') === false, 'archived beats the default mode')
    state.setWatch({ mode: 'one', session: 'ses-1' })
    assert(state.isWatched('ses-1') === false, 'archived beats the one selection too')
  }),

  define('the selection survives a restart and all clears it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-bridge-watch-'))
    const first = new BridgeState(join(dir, 'state.json'))
    first.setThread('ses-1', 11)
    first.setWatch({ mode: 'off' })
    const second = new BridgeState(join(dir, 'state.json'))
    assert(second.watchOf().mode === 'off', 'the off selection persists')
    assert(second.isWatched('ses-1') === false, 'the reload honors it')
    second.setWatch({ mode: 'all' })
    const third = new BridgeState(join(dir, 'state.json'))
    assert(third.watchOf().mode === 'all', 'all clears the selection')
    assert(third.isWatched('ses-1') === true, 'the mapping mirrors again')
    rmSync(dir, { recursive: true, force: true })
  }),
]
