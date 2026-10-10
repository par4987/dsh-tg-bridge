/** The file-browser walk, the reminder matcher, and the button layout. */
import { assert, define, type Check } from './harness.ts'
import { findEntries, type FsDirEntryLike, type FsTargetLike } from '../src/fsbrowse.ts'
import { matchScheduleRecord } from '../src/schedmatch.ts'
import { chunkButtons } from '../src/cards.ts'

interface FakeEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  key: string
  size?: number
  fails?: boolean
}

/**
 * An in-memory tree: each key lists its children; a `fails` entry makes the
 * listing of that key reject, standing in for an unreadable directory.
 */
function fakeListDir(dirs: Record<string, FakeEntry[] | undefined>): (target: FsTargetLike) => Promise<FsDirEntryLike[]> {
  return async (target) => {
    const children = dirs[target.targetKey]
    if (children === undefined) throw new Error(`unreadable: ${target.targetKey}`)
    return children.map((child) => ({
      name: child.name,
      type: child.type,
      target: { targetKey: child.key, displayPath: `${target.displayPath}/${child.name}` },
      ...(child.size !== undefined ? { size: child.size } : {}),
    }))
  }
}

const TREE: Record<string, FakeEntry[] | undefined> = {
  root: [
    { name: 'src', type: 'directory', key: 'src' },
    { name: 'docs', type: 'directory', key: 'docs' },
    { name: 'node_modules', type: 'directory', key: 'nm' },
    { name: 'deep', type: 'directory', key: 'deep' },
    { name: 'README.md', type: 'file', key: 'readme', size: 120 },
  ],
  src: [
    { name: 'index.ts', type: 'file', key: 'index' },
    { name: 'util.ts', type: 'file', key: 'util' },
  ],
  docs: [{ name: 'guide.md', type: 'file', key: 'guide' }],
  nm: [{ name: 'pkg', type: 'directory', key: 'pkg' }],
  pkg: [{ name: 'evil.ts', type: 'file', key: 'evil' }],
  deep: [{ name: 'a', type: 'directory', key: 'a' }],
  a: [{ name: 'b', type: 'directory', key: 'b' }],
  b: [{ name: 'c', type: 'directory', key: 'c' }],
  c: [{ name: 'buried.ts', type: 'file', key: 'buried' }],
}

const start: FsTargetLike = { targetKey: 'root', displayPath: 'C:/proj' }
const LIMITS = { maxDepth: 5, maxDirs: 50, maxResults: 15 }

export const fsbrowseChecks: Check[] = [
  define('the walk matches names case-insensitively across levels', async () => {
    const util = await findEntries(fakeListDir(TREE), start, 'UTIL', LIMITS)
    assert(util.length === 1, `util.ts is found whatever the case (got ${util.length})`)
    assert(util[0]?.displayPath === 'C:/proj/src/util.ts', 'the match carries its full path')
    const guide = await findEntries(fakeListDir(TREE), start, 'GUIDE', LIMITS)
    assert(guide.length === 1, 'guide.md is found')
  }),

  define('the walk never enters dependency and build directories', async () => {
    const found = await findEntries(fakeListDir(TREE), start, 'evil', LIMITS)
    assert(found.length === 0, `nothing inside node_modules is ever reported (got ${found.length})`)
  }),

  define('the depth cap stops the descent', async () => {
    const shallow = await findEntries(fakeListDir(TREE), start, 'buried', { ...LIMITS, maxDepth: 3 })
    assert(shallow.length === 0, 'buried.ts sits deeper than three levels and stays unseen')
    const full = await findEntries(fakeListDir(TREE), start, 'buried', { ...LIMITS, maxDepth: 4 })
    assert(full.length === 1, 'one more level reaches it')
  }),

  define('the visit cap bounds the work', async () => {
    const one = await findEntries(fakeListDir(TREE), start, 'index', { ...LIMITS, maxDirs: 1 })
    assert(one.length === 0, 'a single visit lists only the root, where index.ts is absent')
    const enough = await findEntries(fakeListDir(TREE), start, 'index', LIMITS)
    assert(enough.length === 1, 'a normal budget reaches src/index.ts')
  }),

  define('a rejected listing ends its branch, not the walk', async () => {
    const failing = { ...TREE, src: undefined }
    const util = await findEntries(fakeListDir(failing), start, 'util', LIMITS)
    assert(util.length === 0, 'the unreadable branch reports nothing')
    const guide = await findEntries(fakeListDir(failing), start, 'guide', LIMITS)
    assert(guide.length === 1, 'the walk kept going and found guide.md elsewhere')
  }),

  define('the result cap stops collection early', async () => {
    const found = await findEntries(fakeListDir(TREE), start, '.ts', { ...LIMITS, maxResults: 2 })
    assert(found.length === 2, `collection stops at the cap (got ${found.length})`)
  }),

  define('the reminder matcher resolves id, prefix, prompt, and last', () => {
    const active = [
      { id: 'r1', prompt: 'Revisar logs del pipeline' },
      { id: 'r2', prompt: 'Actualizar el manual' },
      { id: 'r3', prompt: 'Revisar correos' },
    ]
    assert(matchScheduleRecord(active, 'r2')?.id === 'r2', 'the exact id resolves')
    assert(matchScheduleRecord(active, 'r')?.id === 'r1', 'an id prefix resolves to the first hit')
    assert(matchScheduleRecord(active, 'manual')?.id === 'r2', 'a prompt substring resolves')
    assert(matchScheduleRecord(active, '')?.id === 'r3', 'no argument resolves to the last created')
    assert(matchScheduleRecord(active, 'zzz') === undefined, 'an unknown argument resolves to nothing')
    assert(matchScheduleRecord([], '') === undefined, 'an empty corpus has no last record')
  }),

  define('buttons lay out two per row with a short last row', () => {
    const rows = chunkButtons(['a', 'b', 'c'], 2)
    assert(rows.length === 2, `three buttons make two rows (got ${rows.length})`)
    assert(rows[0]?.length === 2 && rows[1]?.length === 1, 'the last row keeps the remainder')
    assert(chunkButtons([], 2).length === 0, 'no buttons make no rows')
  }),
]
