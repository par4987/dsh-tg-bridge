/**
 * Rendering: session events -> Telegram HTML.
 *
 * Three rules drive everything here:
 *
 *  1. Escape FIRST, convert second. The agent's prose is arbitrary text; if
 *     markdown were converted before escaping, a stray `<` or unmatched
 *     backtick would make Telegram reject the whole message ("can't parse
 *     entities"). Escaping first means every `<tag>` in the output is one we
 *     put there.
 *  2. Everything must survive streaming. While the model writes, a ``` fence
 *     or a `<b>` can be half-open, so the HTML is balanced before every send.
 *  3. Never dump output. A tool card is one short line describing the
 *     request, not the stdout it produced.
 */

/** Telegram hard limit is 4096; leave room for the trailing chunk marker. */
export const MAX_MESSAGE = 3900

/** Tools whose output is a dump and whose input tells the whole story. */
const QUIET_TOOLS = new Set(['read', 'glob', 'ls', 'grep', 'search', 'find', 'skill'])
/** Tools where the result is prose that must NOT be shown raw. */
const INPUT_DESCRIBED_TOOLS = new Set([
  'bash', 'pwsh', 'shell', 'execute', 'run', 'web_fetch', 'web_search', 'grep', 'glob',
])

/** The ampersand entity prefix, built so no transport layer can un-escape it. */
const AMP = String.fromCharCode(38)

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, `${AMP}amp;`)
    .replace(/</g, `${AMP}lt;`)
    .replace(/>/g, `${AMP}gt;`)
}

/**
 * Escape, then promote the handful of markdown constructs we trust.
 * Italics are deliberately skipped: `_snake_case` is everywhere in code and
 * would toggle italics mid-word.
 */
export function toHtml(markdown: string): string {
  const fences: string[] = []
  // Pull ``` fences out first so their contents are never reinterpreted.
  let text = markdown.replace(/```([A-Za-z0-9+#-]*)\n?([\s\S]*?)```/g, (_all, _lang: string, body: string) => {
    fences.push(`<pre>${escapeHtml(body.replace(/\n$/, ''))}</pre>`)
    return `\u0000F${fences.length - 1}\u0000`
  })

  text = escapeHtml(text)
  // Inline code, then bold. Both markers are left untouched by escaping.
  text = text.replace(/`([^`\n]+)`/g, (_all, body: string) => `<code>${body}</code>`)
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (_all, body: string) => `<b>${body}</b>`)
  // Unterminated fence while streaming: close it as a block.
  text = text.replace(/```([A-Za-z0-9+#-]*)\n?([\s\S]*)$/, (_all, _lang: string, body: string) => {
    fences.push(`<pre>${escapeHtml(body.replace(/\n$/, ''))}</pre>`)
    return `\u0000F${fences.length - 1}\u0000`
  })

  return balanceHtml(text.replace(/\u0000F(\d+)\u0000/g, (_all, i: string) => fences[Number(i)] ?? ''))
}

/**
 * Close/repair the tag stack. Telegram rejects unbalanced HTML outright,
 * which is exactly what a half-finished stream produces.
 */
export function balanceHtml(html: string): string {
  const stack: string[] = []
  let out = ''
  let cursor = 0
  const tag = /<(\/?)([A-Za-z][A-Za-z0-9]*)([^<>]*)>/g
  let match: RegExpExecArray | null
  while ((match = tag.exec(html)) !== null) {
    out += html.slice(cursor, match.index)
    const closing = match[1] === '/'
    const name = (match[2] ?? '').toLowerCase()
    if (closing) {
      const at = stack.lastIndexOf(name)
      if (at >= 0) {
        for (let i = stack.length - 1; i > at; i--) out += `</${stack[i]}>`
        stack.splice(at, 1)
        out += match[0]
      }
      // Unmatched closing tag: drop it rather than fail the send.
    } else if (match[0].endsWith('/>')) {
      out += match[0]
    } else {
      stack.push(name)
      out += match[0]
    }
    cursor = tag.lastIndex
  }
  out += html.slice(cursor)
  for (let i = stack.length - 1; i >= 0; i--) out += `</${stack[i]}>`
  return out
}

/**
 * Split already-converted HTML into sendable pieces. Splits on paragraph
 * boundaries (double newline) first, then single newlines, so a long answer
 * never lands mid-tag.
 */
export function chunkHtml(html: string, limit = MAX_MESSAGE): string[] {
  if (html.length <= limit) return [html]

  const chunks: string[] = []
  let current = ''
  for (const paragraph of html.split(/\n{2,}/)) {
    const candidate = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph
    if (candidate.length <= limit) {
      current = candidate
      continue
    }
    if (current.length > 0) chunks.push(current)
    if (paragraph.length <= limit) {
      current = paragraph
      continue
    }
    // A single huge paragraph (minified code, a long table): hard-split on lines.
    let line = ''
    for (const piece of paragraph.split('\n')) {
      const next = line.length > 0 ? `${line}\n${piece}` : piece
      if (next.length <= limit) {
        line = next
        continue
      }
      if (line.length > 0) chunks.push(line)
      if (piece.length > limit) {
        chunks.push(balanceHtml(piece.slice(0, limit)))
        line = ''
      } else {
        line = piece
      }
    }
    if (line.length > 0) chunks.push(line)
  }
  if (current.length > 0) chunks.push(current)

  const balanced = chunks.map(balanceHtml)
  if (balanced.length > 1) {
    const last = balanced.length - 1
    balanced[last] = `${balanced[last]}\n<i>…</i>`
  }
  return balanced
}

/** Last two path segments, so `C:\very\long\root\src\file.ts` stays short. */
export function shortPath(path: string, max = 48): string {
  if (path.length === 0) return ''
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const tail = parts.length > 2 ? parts.slice(-2).join('/') : parts.join('/')
  return tail.length > max ? `…${tail.slice(-(max - 1))}` : tail
}

function oneLine(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

const TOOL_ICON: Record<string, string> = {
  bash: '\u{1F4BB}', pwsh: '\u{1F4BB}', shell: '\u{1F4BB}', execute: '\u{1F4BB}', run: '\u{1F4BB}',
  edit: '✏️', write: '\u{1F4DD}', read: '\u{1F4D6}',
  grep: '\u{1F50E}', glob: '\u{1F50E}', search: '\u{1F50E}', find: '\u{1F50E}',
  web_fetch: '\u{1F310}', web_search: '\u{1F310}',
  subagent: '\u{1F916}', task: '\u{1F916}',
  todo: '\u{1F5D3}\u{FE0F}', jobs: '\u{23F3}',
}

export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed'

const STATUS_MARK: Record<ToolStatus, string> = {
  pending: '▫️',
  running: '⏳',
  completed: '✅',
  failed: '❌',
}

/**
 * One compact line for a tool call. `input` describes the request; `output`
 * is only used when the result already reads like a label.
 */
export function formatToolCard(tool: {
  name: string
  input?: Record<string, unknown>
  status?: ToolStatus
  output?: string
  error?: string
  cancelledLabel: string
}): string {
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  const input = tool.input ?? {}
  const icon = TOOL_ICON[tool.name] ?? '\u{1F527}'
  const mark = STATUS_MARK[tool.status ?? 'completed']
  const name = tool.name || 'tool'

  let line = describe(name, input, str, tool.output ?? '')
  // A failed tool whose input never arrived would otherwise be an empty line
  // with a red mark.
  if (line.length === 0 && tool.status === 'failed') {
    line = oneLine(tool.error ?? '', 120) || tool.cancelledLabel
  }
  return `${icon} <code>${escapeHtml(name)}</code> ${escapeHtml(line)} ${mark}`
}

function describe(name: string, input: Record<string, unknown>, str: (v: unknown) => string, output: string): string {
  const tail = (p: string): string => shortPath(p, 40)

  if (name === 'grep' || name === 'search' || name === 'find') {
    const pattern = str(input.pattern)
    const where = tail(str(input.path)) || '.'
    return oneLine(pattern.length > 0 ? `“${pattern.slice(0, 60)}” en ${where}` : `en ${where}`)
  }
  if (name === 'glob') return oneLine(str(input.pattern) || '?')
  if (name === 'web_fetch') return oneLine(str(input.url), 110)
  if (name === 'web_search') return oneLine(str(input.query), 110)
  if (name === 'skill') return oneLine(str(input.id) || str(input.name), 60)
  if (name === 'subagent' || name === 'task') {
    return oneLine(str(input.description) || str(input.prompt) || output, 90)
  }

  const command = str(input.command) || str(input.cmd) || str(input.script) || str(input.code)
  if (command.length > 0 && ['bash', 'pwsh', 'shell', 'execute', 'run'].includes(name)) return oneLine(command)

  if (name === 'edit' || name === 'write' || name === 'str_replace_editor') {
    const path = str(input.path) || str(input.file_path) || str(input.filePath)
    if (output.length > 0) return oneLine(output, 140)
    if (path.length > 0) return tail(path)
  }

  if (output.length > 0 && !INPUT_DESCRIBED_TOOLS.has(name)) return oneLine(output, 150)
  const fallback = str(input.path) || str(input.url) || str(input.pattern) || str(input.id)
  return oneLine(fallback, 110) || (QUIET_TOOLS.has(name) ? '…' : '')
}

/**
 * Unified diff for a single contiguous replacement — which is what the edit
 * tool performs. The common prefix/suffix makes this O(n) and always accurate
 * for one hunk, instead of a full LCS that can blow up on big files.
 */
export function formatDiff(oldText: string, newText: string, maxLines = 40): string {
  const before = String(oldText).split('\n')
  const after = String(newText).split('\n')
  if (String(oldText) === String(newText)) return ''

  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }

  const removed = before.slice(start, endBefore)
  const added = after.slice(start, endAfter)
  const contextBefore = before.slice(Math.max(0, start - 2), start)
  const addedCount = added.length
  const removedCount = removed.length

  let body = contextBefore.map((l) => `  ${l}`).join('\n')
  const takeRemoved = removed.slice(0, maxLines)
  const takeAdded = added.slice(0, maxLines)
  if (body.length > 0) body += '\n'
  body += takeRemoved.map((l) => `- ${l}`).join('\n')
  if (takeRemoved.length > 0 && takeAdded.length > 0) body += '\n'
  body += takeAdded.map((l) => `+ ${l}`).join('\n')
  const clippedNote = removed.length > maxLines || added.length > maxLines
  const afterContext = before.slice(endBefore, endBefore + 2)
  if (afterContext.length > 0) body += `\n${afterContext.map((l) => `  ${l}`).join('\n')}`

  const header = `@@ -${start + 1},${removedCount} +${start + 1},${addedCount} @@`
  const badge = `<b>Diff</b> <code>+${addedCount} -${removedCount}</code>`
  return `${badge}${clippedNote ? ' <i>…</i>' : ''}\n<pre>${escapeHtml(`${header}\n${body}`)}</pre>`
}
