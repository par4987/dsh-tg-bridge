/** Render pipeline: escape-first HTML, balance, chunk, diffs, tool cards. */
import { assert, define, type Check } from './harness.ts'
import { balanceHtml, chunkHtml, escapeHtml, formatDiff, formatToolCard, toHtml } from '../src/render.ts'

export const renderChecks: Check[] = [
  define('escapeHtml escapes every entity', () => {
    const amp = String.fromCharCode(38)
    assert(escapeHtml('a & < b > c') === `a ${amp}amp; ${amp}lt; b ${amp}gt; c`, 'all three entities must be escaped')
  }),

  define('toHtml converts fenced code without reinterpretation', () => {
    const html = toHtml('```ts\nconst x = "<b>";\n```')
    assert(html.includes('<pre>const x = '), 'fence becomes a pre block')
    assert(!html.includes('<b>;'), 'the raw tag inside the fence must stay escaped')
  }),

  define('toHtml promotes inline code and bold only', () => {
    const html = toHtml('run `pnpm build` **now** and _stay_')
    assert(html.includes('<code>pnpm build</code>'), 'inline code is promoted')
    assert(html.includes('<b>now</b>'), 'bold is promoted')
    assert(!html.includes('<i>stay</i>'), 'underscores never toggle italics')
  }),

  define('toHtml closes an unterminated fence while streaming', () => {
    const html = toHtml('look:\n```js\nlet x = 1')
    assert(html.includes('<pre>let x = 1</pre>'), 'the open fence closes as a block')
    assert(balanceHtml(html) === html, 'the emitted HTML is already balanced')
  }),

  define('balanceHtml repairs mismatched tags', () => {
    assert(balanceHtml('<b>x') === '<b>x</b>', 'unclosed tags get closed')
    assert(balanceHtml('x</b>') === 'x', 'stray closers are dropped')
  }),

  define('chunkHtml splits on paragraphs and respects the limit', () => {
    const long = 'a'.repeat(3000)
    const html = `${long}\n\n${long}`
    const chunks = chunkHtml(html)
    assert(chunks.length === 2, `two oversized paragraphs must split (got ${chunks.length})`)
    for (const chunk of chunks) {
      assert(chunk.length <= 3900, `each chunk must fit the limit (got ${chunk.length})`)
    }
    assert(chunks[1]?.includes('…') ?? false, 'overflow pieces carry the marker')
  }),

  define('formatDiff renders one contiguous replacement', () => {
    const diff = formatDiff('line1\nline2\nline3', 'line1\nchanged\nline3', 40)
    assert(diff.includes('- line2'), 'removed line present')
    assert(diff.includes('+ changed'), 'added line present')
    assert(diff.includes('@@ -2,1 +2,1 @@'), 'the hunk header names the position')
  }),

  define('formatDiff returns empty for identical text', () => {
    assert(formatDiff('same', 'same') === '', 'identical text has no diff')
  }),

  define('formatToolCard shows a cancelled label for a failed tool with no input', () => {
    const card = formatToolCard({ name: 'bash', status: 'failed', cancelledLabel: 'cancelada' })
    assert(card.includes('bash') && card.includes('cancelada'), 'the fallback label shows')
  }),

  define('formatToolCard describes a bash command from its input', () => {
    const card = formatToolCard({ name: 'bash', input: { command: 'pnpm test' }, status: 'completed', cancelledLabel: 'cancelada' })
    assert(card.includes('pnpm test'), 'the command is the visible line')
    assert(card.includes('✅'), 'the completed mark shows')
  }),
]
