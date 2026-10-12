/** The manual-backed help: section parsing, the Telegram render, and the shipped manuals. */
import { assert, define, type Check } from './harness.ts'
import { manualToHtml, parseManualSections, readManual } from '../src/manual.ts'

/** A literal ampersand that survives authoring mangling. */
const AMP = '\u0026'

const SAMPLE = [
  '# Manual',
  '## Comandos',
  '',
  '### `/help`',
  'La **lista** y `detalle`.',
  '',
  '### `/archive` / `/unarchive`',
  'Dos comandos, una sección. Visita [el repo](https://x.y).',
  '',
  '## Preguntas',
  'Fuera de la sección.',
].join('\n')

export const manualChecks: Check[] = [
  define('command sections parse in file order and stop at chapters', () => {
    const sections = parseManualSections(SAMPLE)
    assert(sections.length === 2, `both command sections parse (got ${sections.length})`)
    assert(sections[0]?.command === 'help', 'the first section names /help')
    assert(sections[0]?.body === 'La **lista** y `detalle`.', 'the body carries its markdown verbatim')
    assert(sections[1]?.command === 'archive', 'an alias heading keys by its first command')
    assert(!(sections[1]?.body ?? '').includes('Fuera'), 'the chapter break ends the section')
  }),

  define('manual markdown renders to the Telegram subset', () => {
    const html = manualToHtml('### `/sh <cmd>`\nCorre **grave** `git status` — mira [el manual](https://x.y).\n<raw> y tal')
    assert(html.includes('<b>grave</b>'), 'strong becomes bold')
    assert(html.includes('<code>git status</code>'), 'code spans become code')
    assert(!html.includes('https://'), 'links keep only their label')
    assert(html.includes(`${AMP}lt;raw${AMP}gt;`), 'angle brackets escape')
    assert(html.includes(`<code>/sh ${AMP}lt;cmd${AMP}gt;</code>`), 'the heading renders as escaped code')
  }),

  define('long sections cap with an ellipsis', () => {
    const html = manualToHtml(`${'x'.repeat(50)}\n`.repeat(200), 3200)
    assert(html.length <= 3201, `the render stays under the ceiling (got ${html.length})`)
    assert(html.endsWith('…'), 'a capped render ends with an ellipsis')
  }),

  define('the shipped manuals carry the command surface', () => {
    for (const language of ['es', 'en'] as const) {
      const manual = readManual(language)
      assert(manual !== undefined, `the ${language} manual ships with the package`)
      const sections = parseManualSections(manual ?? '')
      assert(sections.length >= 35, `the ${language} manual documents the surface (got ${sections.length})`)
      assert(sections.some((section) => section.command === 'help'), `the ${language} manual documents /help`)
      assert(sections.some((section) => section.command === 'fork'), `the ${language} manual documents /fork`)
    }
  }),
]
