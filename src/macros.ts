/**
 * Named prompts: everything `/macro` remembers, persisted under the state
 * directory so a restart keeps them.
 *
 * The store re-reads the file on every access, the same discipline the
 * session state keeps: several profiles may load the bridge at once, and a
 * writer merges one entry instead of clobbering the whole epoch.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One saved prompt: its text and when it was stored. */
export interface MacroEntry {
  /** The prompt text, delivered verbatim on run. */
  text: string
  /** When the macro was saved, in epoch milliseconds. */
  savedAt: number
}

/** The persisted file's whole shape. */
interface StoredMacros {
  /** name -> entry. */
  macros?: Record<string, MacroEntry>
}

export class MacroStore {
  constructor(
    private readonly file: string,
    private readonly onWarn: (message: string, detail?: unknown) => void = () => {},
  ) {}

  /** Re-read the file: writers in other processes must not be clobbered. */
  private read(): Record<string, MacroEntry> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as StoredMacros
      const macros = parsed?.macros
      if (macros === null || typeof macros !== 'object') return {}
      return Object.entries(macros)
        .filter(([, entry]) => entry !== null && typeof entry === 'object')
        .reduce<Record<string, MacroEntry>>((acc, [name, entry]) => {
          acc[name] = entry as MacroEntry
          return acc
        }, {})
    } catch {
      /* first run or a corrupt file — start empty */
    }
    return {}
  }

  private write(macros: Record<string, MacroEntry>): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ macros }, null, 2), 'utf-8')
    } catch (error) {
      this.onWarn('macros: persist failed', error)
    }
  }

  /** Save (or replace) one named prompt. */
  save(name: string, text: string): void {
    const macros = this.read()
    macros[name] = { text, savedAt: Date.now() }
    this.write(macros)
  }

  /** The named prompt, when it exists. The name is case-sensitive. */
  get(name: string): MacroEntry | undefined {
    return this.read()[name]
  }

  /** Delete one; returns whether anything went. */
  delete(name: string): boolean {
    const macros = this.read()
    if (macros[name] === undefined) return false
    delete macros[name]
    this.write(macros)
    return true
  }

  /** Every name, freshest first. */
  names(): string[] {
    const macros = this.read()
    return Object.entries(macros)
      .sort(([, a], [, b]) => b.savedAt - a.savedAt)
      .map(([name]) => name)
  }
}

/** Whether the file has ever been written — a probe the tests use. */
export function macrosExist(file: string): boolean {
  return existsSync(file)
}
