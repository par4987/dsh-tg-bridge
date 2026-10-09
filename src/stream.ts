/**
 * Turn rendering: ordered blocks of live stream frames -> ordered Telegram
 * messages.
 *
 * Two things are hard here and both are handled explicitly:
 *
 *  ORDER. Telegram shows messages in the order they are created, not edited.
 *  So a block gets its message the moment it starts — a text block sends a
 *  `▌` caret — and every later update edits that same message. The
 *  transcript therefore matches the host UI's chronology.
 *
 *  CONCURRENCY. A delta can arrive while the creation request is still in
 *  flight. `sending` marks the block as reserved so a second message is
 *  never created; the newest HTML is kept and re-sent once the id is known.
 */
import type { Telegram } from './telegram.ts'
import { chunkHtml, escapeHtml, formatDiff, formatToolCard, toHtml } from './render.ts'
import type { RenderOptions } from './config.ts'

export interface ToolRecord {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'pending' | 'running' | 'completed' | 'failed'
  output: string
  error?: string
  pendingDiff?: string
}

/** A tool is only worth a line once we know what it was asked to do (or did). */
function hasContent(tool: ToolRecord): boolean {
  return Object.keys(tool.input).length > 0 || tool.output.length > 0 || tool.error !== undefined
}

interface BlockBase {
  messageId?: number
  sending: boolean
  lastEdit: number
  dirty: boolean
  /** Payload actually pushed (truncated): identical re-renders skip the edit. */
  lastHtml?: string
}

type TextBlock = BlockBase & {
  kind: 'text'
  key: string
  prefix: string
  parts: Map<number, string>
  text: string
  done: boolean
}

type ToolsBlock = BlockBase & {
  kind: 'tools'
  tools: Map<string, ToolRecord>
  done: boolean
}

type Block = TextBlock | ToolsBlock

/** The label a cancelled tool card shows; injected from the locale catalog. */
export interface RendererStrings {
  noTitle: string
  toolCancelled: string
}

class SessionView {
  readonly blocks: Block[] = []
  private readonly textByKey = new Map<string, TextBlock>()
  private lastTools: ToolsBlock | undefined

  constructor(
    readonly sessionID: string,
    private readonly chatId: number,
    private readonly telegram: Telegram,
    private readonly options: RenderOptions,
    private readonly isWatched: () => boolean,
    private readonly notify: (error: unknown) => void,
    /** Resolves the session's current title, so the label tracks renames. */
    private readonly titleOf: () => string,
    /** Forum thread for this session, or undefined when topics are off. */
    private readonly threadOf: () => number | undefined,
    private readonly strings: RendererStrings,
  ) {}

  /**
   * The one-line header every message from this session carries. When each
   * session has its own thread the topic title already identifies it, so
   * the header is only needed at the chat root.
   */
  private header(): string {
    if (this.threadOf() !== undefined) return ''
    const title = this.titleOf().trim() || this.strings.noTitle
    return `<b>${escapeHtml(title.slice(0, 60))}</b>`
  }

  // ── text / reasoning ───────────────────────────────────────────────────────

  textStarted(key: string, prefix = ''): void {
    if (this.textByKey.has(key)) return
    const block: TextBlock = {
      kind: 'text', key, prefix, parts: new Map(), text: '',
      done: false, sending: false, lastEdit: 0, dirty: false,
    }
    this.blocks.push(block)
    this.textByKey.set(key, block)
    // A new text block closes the previous run of tools, so tools that
    // follow form their own message instead of jumping above this one.
    this.lastTools = undefined
    const head = this.header()
    this.create(block, head.length > 0 ? `${head}\n${escapeHtml(`${prefix}▌`)}` : escapeHtml(`${prefix}▌`))
  }

  textDelta(key: string, ordinal: number, delta: string): void {
    let block = this.textByKey.get(key)
    if (block === undefined) {
      this.textStarted(key)
      block = this.textByKey.get(key)
      if (block === undefined) return
    }
    block.parts.set(ordinal, (block.parts.get(ordinal) ?? '') + delta)
    block.text = [...block.parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value)
      .join('')
    if (block.prefix.length > 0 && block.text.startsWith(block.prefix)) block.text = block.text.slice(block.prefix.length)
    block.dirty = true
    this.flush(block, false)
  }

  textEnded(key: string): void {
    const block = this.textByKey.get(key)
    if (block === undefined) return
    block.done = true
    block.dirty = true
    this.flush(block, true)
  }

  /**
   * The durable settlement of a block the live stream may have rendered
   * already — end it, or render it whole when the live frames never arrived
   * (the bridge loaded mid-turn, a replacement attempt, a resumed session).
   */
  textCommit(key: string, prefix: string, text: string): void {
    if (!this.textByKey.has(key)) {
      this.textStarted(key, prefix)
      if (text.length > 0) this.textDelta(key, 0, text)
    }
    this.textEnded(key)
  }

  // ── tools ──────────────────────────────────────────────────────────────────

  toolEvent(record: Partial<ToolRecord> & { id: string }): void {
    if (!this.isWatched()) return
    let block = this.lastTools
    if (block === undefined) {
      const tools: ToolsBlock = { kind: 'tools', tools: new Map(), done: false, sending: false, lastEdit: 0, dirty: false }
      block = tools
      this.blocks.push(tools)
      this.lastTools = tools
    }
    const existing = block.tools.get(record.id)
    const provided = record.name !== undefined && record.name !== 'tool' ? record.name : undefined
    const carried = existing !== undefined && existing.name !== 'tool' ? existing.name : undefined
    const merged: ToolRecord = {
      id: record.id,
      name: provided ?? carried ?? 'tool',
      input: { ...(existing?.input ?? {}), ...(record.input ?? {}) },
      status: record.status ?? existing?.status ?? 'running',
      output: record.output ?? existing?.output ?? '',
      ...(record.error !== undefined ? { error: record.error } : existing?.error !== undefined ? { error: existing.error } : {}),
      ...(existing?.pendingDiff !== undefined ? { pendingDiff: existing.pendingDiff } : {}),
    }
    if (this.options.showDiffs && merged.status === 'completed' && merged.pendingDiff === undefined && existing?.pendingDiff === undefined) {
      const diff = this.buildDiff(merged)
      if (diff !== undefined) merged.pendingDiff = diff
    }
    block.tools.set(record.id, merged)
    block.dirty = true
    this.flush(block, false)
  }

  // ── flushing ───────────────────────────────────────────────────────────────

  /** Options carrying the thread only when the session has one. */
  private sendOpts(thread: number | undefined): { parseMode: 'HTML', messageThreadId?: number } {
    return thread === undefined ? { parseMode: 'HTML' } : { parseMode: 'HTML', messageThreadId: thread }
  }

  /** Reserve the block's message. The id arrives asynchronously. */
  private create(block: Block, html: string): void {
    if (!this.isWatched() || block.messageId !== undefined || block.sending) return
    const chunks = chunkHtml(html)
    block.sending = true
    block.dirty = false
    block.lastHtml = html
    const thread = this.threadOf()
    void this.telegram
      .sendMessage(this.chatId, chunks[0] ?? html, this.sendOpts(thread))
      .then((messageId) => {
        block.sending = false
        if (messageId !== null) block.messageId = messageId
        block.lastEdit = Date.now()
        // Overflow pieces are append-only snapshots; never edit them.
        for (const extra of chunks.slice(1)) {
          void this.telegram
            .sendMessage(this.chatId, extra, this.sendOpts(thread))
            .catch(this.notify)
        }
        if (block.dirty) this.flush(block, true)
        this.sendPendingDiff(block)
      })
      .catch((error) => {
        block.sending = false
        this.notify(error)
      })
  }

  private flush(block: Block, force: boolean): void {
    if (!this.isWatched()) return
    if (!block.dirty && !force) return
    const html = this.render(block)
    if (html.length === 0) {
      block.dirty = false
      return
    }
    // Identical to what Telegram already holds: skip the call. Redundant
    // edits are the main way a bridge trips Telegram's flood limit.
    if (html === block.lastHtml) {
      block.dirty = false
      this.sendPendingDiff(block)
      return
    }

    if (block.messageId === undefined) {
      if (block.sending) return // creation in flight; latest html re-read after it lands
      this.create(block, html)
      return
    }

    const now = Date.now()
    if (!force && now - block.lastEdit < this.options.editIntervalMs) return

    block.lastEdit = now
    block.dirty = false
    // Edits respect the same ceiling as creation: a text block that grew
    // past 4096 while streaming would otherwise fail with "message is too
    // long" and the mirror would silently freeze on that block forever.
    const sent = chunkHtml(html)[0] ?? html
    void this.telegram
      .editMessageText(this.chatId, block.messageId, sent, this.sendOpts(this.threadOf()))
      .then((changed) => {
        if (changed) block.lastHtml = sent
        else block.dirty = false
        this.sendPendingDiff(block)
      })
      .catch(this.notify)
  }

  /** Non-forced pass; used by the periodic tick so nothing stalls. */
  tick(): void {
    for (const block of this.blocks) if (block.dirty) this.flush(block, false)
  }

  finalize(): void {
    for (const block of this.blocks) {
      block.done = true
      this.flush(block, true)
      this.sendPendingDiff(block)
    }
  }

  private render(block: Block): string {
    if (block.kind === 'text') {
      if (block.text.length === 0) return ''
      // A reasoning block stays capped however much the model produced.
      const body = block.key.startsWith('r:')
        ? toHtml(block.text.slice(0, this.options.reasoningChars))
        : toHtml(block.text)
      const head = this.header()
      const inner = block.prefix.length > 0 ? `${escapeHtml(block.prefix)}\n${body}` : body
      return head.length > 0 ? `${head}\n${inner}` : inner
    }
    // A card with nothing to say would be sent and rewritten a millisecond
    // later, so it waits until there is something to show.
    const cards = [...block.tools.values()].filter(hasContent).map((tool) => formatToolCard({ ...tool, cancelledLabel: this.strings.toolCancelled })).join('\n')
    if (cards.length === 0) return ''
    const head = this.header()
    return head.length > 0 ? `${head}\n${cards}` : cards
  }

  private buildDiff(tool: ToolRecord): string | undefined {
    const input = tool.input as { oldString?: string, newString?: string, old_text?: string, new_text?: string }
    const before = input.oldString ?? input.old_text
    const after = input.newString ?? input.new_text
    if (typeof before !== 'string' || typeof after !== 'string') return undefined
    if (before === after || before.length > 60_000 || after.length > 60_000) return undefined
    return formatDiff(before, after, this.options.diffMaxLines) || undefined
  }

  /**
   * Diffs are their own message: long, immutable, and they must not compete
   * with streaming text for the one-edit-per-second budget. Sent only once
   * the owning block exists so they land after the tool card, not before it.
   */
  private sendPendingDiff(block: Block): void {
    if (block.kind !== 'tools' || block.messageId === undefined || !this.isWatched()) return
    const thread = this.threadOf()
    for (const tool of block.tools.values()) {
      const diff = tool.pendingDiff
      if (diff === undefined) continue
      delete tool.pendingDiff
      // A big rewrite can produce a diff well past the limit on its own.
      for (const piece of chunkHtml(diff)) {
        void this.telegram
          .sendMessage(this.chatId, piece, this.sendOpts(thread))
          .catch(this.notify)
      }
    }
  }
}

/** Owns the session -> view mapping and the periodic tick. */
export class TurnRenderer {
  private readonly views = new Map<string, SessionView>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly telegram: Telegram,
    private readonly chatId: number,
    private readonly options: RenderOptions,
    private readonly isWatched: (sessionID: string) => boolean,
    private readonly notify: (error: unknown) => void,
    /** Session titles, for the header each message carries at the chat root. */
    private readonly titleOf: (sessionID: string) => string,
    /** Forum thread per session; undefined when topic mode is off. */
    private readonly threadOf: (sessionID: string) => number | undefined,
    private readonly strings: RendererStrings,
  ) {}

  private view(sessionID: string): SessionView {
    let view = this.views.get(sessionID)
    if (view === undefined) {
      view = new SessionView(
        sessionID, this.chatId, this.telegram, this.options,
        () => this.isWatched(sessionID), this.notify, () => this.titleOf(sessionID),
        () => this.threadOf(sessionID), this.strings,
      )
      this.views.set(sessionID, view)
    }
    return view
  }

  start(): void {
    // Safety net: a missed "ended" frame must not leave text frozen.
    this.timer = setInterval(() => this.tick(), 2000)
  }

  tick(): void {
    for (const view of this.views.values()) view.tick()
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    for (const view of this.views.values()) view.finalize()
  }

  textStarted(sessionID: string, key: string, prefix = ''): void {
    this.view(sessionID).textStarted(key, prefix)
  }

  textDelta(sessionID: string, key: string, ordinal: number, delta: string): void {
    this.view(sessionID).textDelta(key, ordinal, delta)
  }

  textEnded(sessionID: string, key: string): void {
    this.view(sessionID).textEnded(key)
  }

  /** Durable settlement of one streamed block; renders it whole when missed. */
  textCommit(sessionID: string, key: string, prefix: string, text: string): void {
    this.view(sessionID).textCommit(key, prefix, text)
  }

  toolEvent(sessionID: string, record: Partial<ToolRecord> & { id: string }): void {
    this.view(sessionID).toolEvent(record)
  }

  finalize(sessionID: string): void {
    this.views.get(sessionID)?.finalize()
  }
}

export type { ToolRecord as StreamToolRecord }
