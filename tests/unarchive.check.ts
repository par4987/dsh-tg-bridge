/** The archived picker: paging boundary and row addressing. */
import { assert, define, type Check } from './harness.ts'
import { setLocale } from '../src/locale.ts'
import { renderUnarchive, type ArchivedRow } from '../src/unarchive.ts'

function rows(n: number): ArchivedRow[] {
  const out: ArchivedRow[] = []
  for (let i = 0; i < n; i++) out.push({ id: `ses-${i}`, title: `Tarea ${i}`, ago: 'hace 1 h' })
  return out
}

export const unarchiveChecks: Check[] = [
  define('a short list draws one page with no navigation buttons', () => {
    setLocale('es')
    const rendered = renderUnarchive(rows(3), 0)
    assert(rendered.payload.kind === 'unarchive', 'the payload is an unarchive card')
    if (rendered.payload.kind !== 'unarchive') return
    assert(rendered.payload.page === 0, 'the page rides the payload')
    assert(rendered.payload.candidates.length === 3, 'every candidate rides the payload')
    assert(!rendered.payload.buttons.some((button) => button.callback.startsWith('ua:')), 'no page buttons on a single page')
    assert(rendered.text.includes('Tarea 0'), 'the rows draw')
  }),

  define('a long list pages eight at a time and offers the next page', () => {
    setLocale('es')
    const first = renderUnarchive(rows(20), 0)
    assert(first.payload.kind === 'unarchive', 'the payload is an unarchive card')
    if (first.payload.kind !== 'unarchive') return
    assert(first.payload.candidates.length === 20, 'all candidates ride the payload for tap lookup')
    assert(first.payload.buttons.some((button) => button.callback === 'ua:1'), 'the first page offers the next one')
    assert(!first.payload.buttons.some((button) => button.callback === 'ua:-1'), 'the first page offers no back button')
    const last = renderUnarchive(rows(20), 2)
    assert(last.text.includes('página 3/3'), 'the page count draws')
    assert(!last.payload.buttons.some((button) => button.callback === 'ua:3'), 'the last page offers no next button')
  }),

  define('the tap callbacks address the global candidate index', () => {
    setLocale('es')
    const rendered = renderUnarchive(rows(10), 1)
    assert(rendered.payload.kind === 'unarchive', 'the payload is an unarchive card')
    if (rendered.payload.kind !== 'unarchive') return
    const tap = rendered.payload.buttons[0]
    assert(tap?.callback === 'u:8', 'the second page addresses the ninth candidate')
    assert(rendered.payload.candidates[8] === 'ses-8', 'the lookup index matches the candidate')
  }),
]
