/**
 * The shipped manual as the help system's detail source: one section per
 * command, read from MANUAL.md / MANUAL.en.md next to the bundle. The
 * package publishes both files, so the phone reads the same text the reader
 * does — no second description to keep in step.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One command's manual entry: the section heading plus its body. */
export interface ManualSection {
  /** The command name the heading names (first backticked token). */
  command: string
  /** The heading line without the `###` marker. */
  title: string
  /** The section body, verbatim markdown. */
  body: string
}

/** A command heading: `### \`/<name>…\`` — aliases may trail the first token. */
const SECTION_HEADING = /^###\s+`\/([a-z]+)[^`]*`/
/** Chapter headings end a command section. */
const CHAPTER_HEADING = /^##\s/

/**
 * Parse the manual's command sections out of its markdown.
 * @returns every section in file order; a heading that names no command
 *   (or a chapter break) closes the current section.
 */
export function parseManualSections(markdown: string): ManualSection[] {
  const sections: ManualSection[] = []
  let title: string | undefined
  let body: string[] = []
  const flush = (): void => {
    if (title !== undefined) {
      const match = SECTION_HEADING.exec(title)
      if (match !== null) {
        sections.push({
          command: match[1] ?? '',
          title: title.replace(/^###\s+/, ''),
          body: body.join('\n').trim(),
        })
      }
    }
    title = undefined
    body = []
  }
  for (const line of markdown.split(/\r?\n/)) {
    if (SECTION_HEADING.test(line)) {
      flush()
      title = line
      continue
    }
    if (CHAPTER_HEADING.test(line)) {
      flush()
      continue
    }
    if (title !== undefined) body.push(line)
  }
  flush()
  return sections
}

/**
 * Read the shipped manual for one language.
 * @returns the manual's markdown, or undefined when the package publishes
 *   none where the bundle looks.
 */
export function readManual(language: 'es' | 'en'): string | undefined {
  const file = language === 'es' ? 'MANUAL.md' : 'MANUAL.en.md'
  try {
    // One level up from this module: src/ and lib/ are both one deep.
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', file), 'utf-8')
  } catch {
    return undefined
  }
}

/**
 * Render manual markdown for Telegram: escape HTML first, then apply the
 * subset the manual uses — strong, code spans, and links as their label.
 * @param section - heading plus body, verbatim.
 * @param cap - the render ceiling; a longer section ends with an ellipsis.
 */
export function manualToHtml(section: string, cap = 3200): string {
  const AMP = '\u0026'
  const html = section
    .replace(/&/g, AMP + 'amp;')
    .replace(/</g, AMP + 'lt;')
    .replace(/>/g, AMP + 'gt;')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (html.length > cap) return `${html.slice(0, cap).trimEnd()}…`
  return html
}
