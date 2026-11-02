/**
 * The prompts this phone sent: `/recent` replays them with one tap.
 *
 * Every prompt that reaches an agent through the bridge is recorded here —
 * typed messages, `/macro run` resends and `/recent` re-sends alike — as a
 * bounded ring, newest first. The store re-reads the file on every access,
 * the same discipline the session state keeps.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One delivered prompt, as the history remembers it. */
export interface RecentEntry {
  /** The session the prompt went to. */
  session: string
  /** The prompt text, verbatim. */
  text: string
  /** When the prompt was delivered, in epoch milliseconds. */
  at: number
}

/** The persisted file's whole shape. */
interface StoredRecents {
  /** Entries, oldest first — the tail of the ring. */
  recents?: RecentEntry[]
}

/** How many prompts the history keeps. */
export const RECENT_CAP = 200

export class RecentStore {
  constructor(
    private readonly file: string,
    private readonly onWarn: (message: string, detail?: unknown) => void = () => {},
  ) {}

  /** Re-read the file: writers in other processes must not be clobbered. */
  private read(): RecentEntry[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as StoredRecents
      const recents = parsed?.recents
      return Array.isArray(recents) ? recents.filter((entry) => entry !== null && typeof entry === 'object') : []
    } catch {
      /* first run or a corrupt file — start empty */
    }
    return []
  }

  private write(entries: RecentEntry[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ recents: entries }, null, 2), 'utf-8')
    } catch (error) {
      this.onWarn('recents: persist failed', error)
    }
  }

  /** Record one delivered prompt; the ring keeps the newest `RECENT_CAP`. */
  record(session: string, text: string): void {
    const entries = this.read()
    entries.push({ session, text, at: Date.now() })
    this.write(entries.slice(-RECENT_CAP))
  }

  /** The newest entries, most recent first. */
  list(limit = 10): RecentEntry[] {
    return this.read().slice(-limit).reverse()
  }
}
