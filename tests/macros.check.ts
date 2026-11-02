/** MacroStore: named prompts and their persistence across restarts. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, define, type Check } from './harness.ts'
import { MacroStore, macrosExist } from '../src/macros.ts'

function freshStore(dir = mkdtempSync(join(tmpdir(), 'tg-bridge-macros-'))): { store: MacroStore, dir: string } {
  return { store: new MacroStore(join(dir, 'macros.json')), dir }
}

export const macrosChecks: Check[] = [
  define('save and get round-trip, case-sensitive', () => {
    const { store } = freshStore()
    store.save('deploy', 'Despliega a produccion')
    assert(store.get('deploy')?.text === 'Despliega a produccion', 'a saved macro reads back')
    assert(store.get('DEPLOY') === undefined, 'the name is case-sensitive')
    store.save('deploy', 'Despliega a staging')
    assert(store.get('deploy')?.text === 'Despliega a staging', 'a re-save replaces the text')
  }),

  define('names arrive freshest first', () => {
    const { store } = freshStore()
    store.save('uno', 'prompt uno')
    store.save('dos', 'prompt dos')
    store.save('tres', 'prompt tres')
    const names = store.names()
    assert(names[0] === 'tres' && names[1] === 'dos' && names[2] === 'uno', 'newest heads the list')
  }),

  define('delete reports whether anything went', () => {
    const { store } = freshStore()
    store.save('keep', 'text')
    assert(store.delete('keep') === true, 'an existing macro is deleted')
    assert(store.delete('keep') === false, 'a second delete finds nothing')
    assert(store.names().length === 0, 'the store is empty again')
  }),

  define('macros survive a restart and a corrupt file stays empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-bridge-macros-'))
    const first = new MacroStore(join(dir, 'macros.json'))
    first.save('deploy', 'Despliega a produccion')
    const second = new MacroStore(join(dir, 'macros.json'))
    assert(second.get('deploy')?.text === 'Despliega a produccion', 'a fresh store reads the persisted file')
    assert(macrosExist(join(dir, 'macros.json')) === true, 'the file exists once written')
    const corrupt = new MacroStore(join(dir, 'nope', 'macros.json'))
    assert(corrupt.names().length === 0, 'an unreadable file starts empty, never throws')
    rmSync(dir, { recursive: true, force: true })
  }),
]
