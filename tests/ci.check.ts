/** `/ci`: the run parser, the glyphs and the formatter. */
import { assert, define, type Check } from './harness.ts'
import { setLocale } from '../src/locale.ts'
import { ageText, formatRuns, parseRuns, runsUrl, stateGlyph, type CiRun } from '../src/ci.ts'

function run(over: Partial<CiRun> = {}): CiRun {
  return {
    name: 'CI',
    status: 'completed',
    conclusion: 'success',
    sha: 'abcdef1234567890',
    title: 'Fix the build',
    url: 'https://github.com/x/y/actions/runs/1',
    at: Date.now() - 3 * 3_600_000,
    ...over,
  }
}

export const ciChecks: Check[] = [
  define('runsUrl composes the endpoint', () => {
    assert(runsUrl('par4987/dsh-tg-bridge', 12) === 'https://api.github.com/repos/par4987/dsh-tg-bridge/actions/runs?per_page=12', 'the URL carries repo and limit')
  }),

  define('parseRuns survives garbage and reads the fields', () => {
    setLocale('es')
    assert(parseRuns(undefined).length === 0, 'undefined parses to nothing')
    assert(parseRuns({}).length === 0, 'an empty body parses to nothing')
    assert(parseRuns({ workflow_runs: 'nope' }).length === 0, 'a non-array parses to nothing')
    const parsed = parseRuns({
      workflow_runs: [
        { name: 'CI\ndetail', status: 'in_progress', conclusion: null, head_sha: '1234567890', head_commit: { message: 'one\ntwo' }, html_url: 'u', created_at: '2026-10-10T04:42:36Z' },
        { name: '', status: '', head_commit: {} },
      ],
    })
    assert(parsed.length === 2, 'both rows parse')
    assert(parsed[0]?.name === 'CI', 'the name keeps its first line')
    assert(parsed[0]?.conclusion === null, 'a running run carries a null conclusion')
    assert(parsed[0]?.title === 'one', 'the commit title keeps its first line')
    assert((parsed[0]?.at ?? 0) > 0, 'the ISO timestamp parses')
    assert(parsed[1]?.name === '(desconocido)', 'an empty name falls back to the unknown label')
    assert(parsed[1]?.conclusion === null, 'a missing conclusion is null, not undefined')
  }),

  define('stateGlyph covers the five states', () => {
    setLocale('es')
    assert(stateGlyph(run({ status: 'in_progress', conclusion: null })) === '🟡', 'in flight is yellow')
    assert(stateGlyph(run()) === '🟢', 'success is green')
    assert(stateGlyph(run({ conclusion: 'failure' })) === '🔴', 'failure is red')
    assert(stateGlyph(run({ conclusion: 'cancelled' })) === '⚪', 'cancelled is grey')
    assert(stateGlyph(run({ conclusion: 'timed_out' })) === '🟠', 'timed out is orange')
    assert(stateGlyph(run({ conclusion: 'weird' })) === '❔', 'an unknown conclusion is a question')
  }),

  define('ageText scales minutes, hours and days', () => {
    setLocale('es')
    assert(ageText(0) === 'fecha desconocida', 'a zero timestamp is unknown')
    assert(ageText(Date.now() - 5 * 60_000).includes('5'), 'five minutes read in minutes')
    assert(ageText(Date.now() - 3 * 3_600_000).includes('3 h'), 'three hours read in hours')
    assert(ageText(Date.now() - 3 * 86_400_000).includes('3 d'), 'three days read in days')
  }),

  define('formatRuns renders a header and one line per run', () => {
    setLocale('es')
    const one = formatRuns([run()], 'par4987/dsh-tg-bridge')
    assert(one.includes('CI'), 'the workflow name draws')
    assert(one.includes('abcdef1'), 'the short sha draws')
    assert(one.includes('3 h'), 'the age draws')
    assert(formatRuns([], 'par4987/dsh-tg-bridge').includes('No hay runs'), 'an empty list says so honestly')
  }),
]
