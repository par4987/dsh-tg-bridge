/**
 * The bridge's own durable state: the session ↔ forum-thread mapping, which
 * session the chat root points at, the last title learned for each session,
 * the interface language, and accumulated token usage.
 *
 * Several profiles may load the bridge at once (web and desktop), so every
 * access re-reads the file and every mutation persists immediately: writers
 * merge per mutation instead of clobbering each other's whole epoch. A
 * mapping records the profile that created the session, so an inbound prompt
 * can refuse to wake a session another live process is already driving.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** What the bridge remembers about one mapped session. */
export interface MappedSession {
  /** Forum thread id, once a topic exists. */
  threadId?: number
  /** The thread was closed (`/archive` or the idle sweep) — the mirror stays silent. */
  archived?: boolean
  /** Last title known for the session, learned from its first human prompt. */
  title?: string
  /** Last real interaction, in epoch milliseconds. */
  lastIdle?: number
  /** When the mapping was created — the sweep gives a fresh mapping one full window before deleting its thread. */
  mappedAt?: number
  /** Token usage accumulated from committed assistant messages. */
  usage?: { inputTokens: number, outputTokens: number, totalTokens: number }
  /** Usage of the most recently committed assistant message. */
  lastUsage?: { inputTokens: number, outputTokens: number, totalTokens: number }
  /** The profile whose process created and drives this session. */
  profile?: string
}

interface StoredState {
  /** sessionId -> mapping. */
  sessions?: Record<string, MappedSession>
  /** Session the chat root prompts go to. */
  rootTarget?: string
  /** Interface language remembered across restarts. */
  locale?: 'es' | 'en'
}

/** Token usage carried by one committed assistant message. */
export interface UsageDelta {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/**
 * The persisted mapping store. Every access re-reads the state file, so
 * concurrent bridge processes observe each other's mutations; a write
 * failure logs through the injected callback and never throws — a lost
 * persist costs a duplicate topic, not the bridge.
 */
export class BridgeState {
  constructor(
    private readonly file: string,
    private readonly onWarn: (message: string, detail?: unknown) => void = () => {},
  ) {}

  /** Re-read the file: writers in other processes must not be clobbered. */
  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as StoredState
      this.sessions = new Map(Object.entries(parsed.sessions ?? {})
        .filter(([, mapping]) => mapping !== null && typeof mapping === 'object'))
      this.rootTarget = parsed.rootTarget
      this.locale = parsed.locale === 'es' || parsed.locale === 'en' ? parsed.locale : undefined
    } catch {
      /* first run or a corrupt file — start empty */
    }
  }

  private sessions = new Map<string, MappedSession>()
  private rootTarget: string | undefined
  private locale: 'es' | 'en' | undefined

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const sessions: Record<string, MappedSession> = {}
      for (const [id, mapping] of this.sessions) sessions[id] = mapping
      const payload: StoredState = {
        sessions,
        ...(this.rootTarget === undefined ? {} : { rootTarget: this.rootTarget }),
        ...(this.locale === undefined ? {} : { locale: this.locale }),
      }
      writeFileSync(this.file, JSON.stringify(payload, null, 2), 'utf-8')
    } catch (error) {
      this.onWarn('state: persist failed', error)
    }
  }

  /** The mapping record, creating an empty one when the session is new. */
  mapping(sessionId: string): MappedSession {
    this.load()
    let mapping = this.sessions.get(sessionId)
    if (mapping === undefined) {
      mapping = { mappedAt: Date.now() }
      this.sessions.set(sessionId, mapping)
    }
    return mapping
  }

  /** Whether any mapping exists for the session. */
  has(sessionId: string): boolean {
    this.load()
    return this.sessions.has(sessionId)
  }

  /** Remember the thread id for a session. */
  setThread(sessionId: string, threadId: number): void {
    this.mapping(sessionId).threadId = threadId
    this.persist()
  }

  /**
   * Record which profile's process drives the session. Claimed before any
   * prompt can reach it, so the poll owner can tell a foreign live session
   * from one it is safe to resume.
   */
  claim(sessionId: string, profile: string): void {
    const mapping = this.mapping(sessionId)
    if (mapping.profile === profile) return
    mapping.profile = profile
    this.persist()
  }

  /** The profile that owns the session, when recorded. */
  profileOf(sessionId: string): string | undefined {
    this.load()
    return this.sessions.get(sessionId)?.profile
  }

  /** Forget a session entirely — its thread was deleted by hand. */
  remove(sessionId: string): void {
    this.load()
    if (!this.sessions.delete(sessionId)) return
    if (this.rootTarget === sessionId) this.rootTarget = undefined
    this.persist()
  }

  /** Forget a mapping by its thread id — the dead-thread healing path. */
  removeByThread(threadId: number): void {
    this.load()
    let changed = false
    for (const [id, mapping] of this.sessions) {
      if (mapping.threadId === threadId) {
        this.sessions.delete(id)
        if (this.rootTarget === id) this.rootTarget = undefined
        changed = true
      }
    }
    if (changed) this.persist()
  }

  /** Known thread id for a session, if a topic was ever created. */
  threadOf(sessionId: string): number | undefined {
    this.load()
    return this.sessions.get(sessionId)?.threadId
  }

  /** Which session owns a thread — the inverse lookup for inbound messages. */
  sessionOf(threadId: number): string | undefined {
    this.load()
    for (const [id, mapping] of this.sessions) {
      if (mapping.threadId === threadId) return id
    }
    return undefined
  }

  /** Resolve a session id by prefix, the way `/use` and replies name them. */
  sessionByPrefix(prefix: string): string | undefined {
    this.load()
    const trimmed = prefix.trim().toLowerCase()
    if (trimmed.length === 0) return undefined
    for (const id of this.sessions.keys()) {
      if (id.toLowerCase().startsWith(trimmed)) return id
    }
    return undefined
  }

  /** Forget a session's thread but keep its title, usage and archived flag. */
  clearThread(sessionId: string): void {
    const mapping = this.mapping(sessionId)
    if (mapping.threadId === undefined) return
    delete mapping.threadId
    this.persist()
  }

  /** Whether the session's thread is closed ("archived"). */
  isArchived(sessionId: string): boolean {
    this.load()
    return this.sessions.get(sessionId)?.archived === true
  }

  /** Mark a session's thread open or closed. */
  setArchived(sessionId: string, archived: boolean): void {
    const mapping = this.mapping(sessionId)
    if (archived) mapping.archived = true
    else delete mapping.archived
    this.persist()
  }

  /** Record the latest learned title. */
  setTitle(sessionId: string, title: string): void {
    const mapping = this.mapping(sessionId)
    if (mapping.title === title) return
    mapping.title = title
    this.persist()
  }

  /** The latest learned title, if any. */
  titleOf(sessionId: string): string | undefined {
    this.load()
    return this.sessions.get(sessionId)?.title
  }

  /** Record a real interaction moment. */
  touchIdle(sessionId: string, at = Date.now()): void {
    const mapping = this.mapping(sessionId)
    if (mapping.lastIdle === at) return
    mapping.lastIdle = at
    this.persist()
  }

  /** Fold one committed assistant usage record into the session total. */
  addUsage(sessionId: string, delta: UsageDelta | undefined): void {
    if (delta === undefined) return
    const mapping = this.mapping(sessionId)
    const usage = mapping.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    usage.inputTokens += delta.inputTokens
    usage.outputTokens += delta.outputTokens
    usage.totalTokens += delta.totalTokens
    mapping.usage = usage
    mapping.lastUsage = delta
    this.persist()
  }

  /** The accumulated and last-turn usage recorded for a session. */
  usageOf(sessionId: string): { total: UsageDelta | undefined, last: UsageDelta | undefined } {
    this.load()
    const mapping = this.sessions.get(sessionId)
    return {
      total: mapping === undefined ? undefined : mapping.usage,
      last: mapping === undefined ? undefined : mapping.lastUsage,
    }
  }

  /** The session the chat root prompts go to. */
  rootSession(): string | undefined {
    this.load()
    return this.rootTarget
  }

  setRootSession(sessionId: string | undefined): void {
    this.load()
    this.rootTarget = sessionId
    this.persist()
  }

  /** The remembered interface language. */
  savedLocale(): 'es' | 'en' | undefined {
    this.load()
    return this.locale
  }

  setSavedLocale(locale: 'es' | 'en'): void {
    this.load()
    this.locale = locale
    this.persist()
  }

  /** Every mapping, for `/ls`, `/find` and the idle sweep. */
  entries(): Array<[string, MappedSession]> {
    this.load()
    return [...this.sessions.entries()]
  }

  /** How many mappings exist. */
  size(): number {
    this.load()
    return this.sessions.size
  }

  /** Flush the state file now; returns whether one exists. */
  flushNow(): boolean {
    this.load()
    this.persist()
    return existsSync(this.file)
  }
}
