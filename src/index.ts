/**
 * dsh-tg-bridge — a Telegram surface for DeepSeek Harness sessions.
 *
 * One forum thread per session: writing in a thread prompts the agent, the
 * turn renders back live (text, reasoning, tool cards, diffs), questions and
 * permission asks arrive as inline keyboards, media travels both ways, and
 * the whole thing runs inside the harness process — the same composition the
 * Web UI and every other profile drives, over the documented extension
 * points:
 *
 *   - durable facts: `session/event` (turns, settlements, tool activity);
 *   - live deltas: `agent/assistant-stream` frames;
 *   - input: `Agent.followup()` / `Agent.steer()`;
 *   - decisions: the `approval/request` and `user-questions/request`
 *     waterfalls, claimed only for sessions this bridge mirrors.
 *
 * A cross-process lock elects one poll owner: several profiles may load this
 * bundle at once, and Telegram answers a second `getUpdates` with 409.
 *
 * @module dsh-tg-bridge
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Side-effect type imports: declaration-merge the waterfalls answered below
// and the default-model service the bridge reads.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, expandAssistantStream, type ContentBlock, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { AgentHandle, AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId, Session } from '@deepseek-ai/dsh-session'
import { AttachmentStore, type FileAttachmentRef, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
// Side-effect type import: declares ctx.sessionPersistence for the injected service.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Side-effect type import: declares ctx.setInterval (the timer plugin base composes).
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { Telegram, DryRunTelegram, type Update } from './telegram.ts'
import { MessageCards } from './cards.ts'
import { Config, requireChatId, resolveToken } from './config.ts'
import { BridgeState } from './state.ts'
import { TurnRenderer } from './stream.ts'
import { AnswererHub } from './answerers.ts'
import { handleCommand, feedWizard, type CommandDeps, type ResolvedAgent } from './commands.ts'
import { acquireLock, beatProfile, clearProfileBeat, heartbeat, isElsewhereLive, releaseLock, LOCK_INTERVAL_MS } from './ownership.ts'
import { downloadsDir, decodeText, isTextLike, saveBinary, DOC_MAX_CHARS } from './ingest.ts'
import { sttAvailable, transcribeFile } from './stt.ts'
import { describeReplyTarget, extractFilePaths, isForumEcho, selectImages, withReplyContext, type ReplyLabels, type ReplyTarget } from './media-out.ts'
import { chunkHtml, escapeHtml } from './render.ts'
import { locale, setLocale, t } from './locale.ts'
import { safe, type LogFn } from './log.ts'

export const name = 'tg-bridge'
/**
 * Core services every base-backed profile composes; the timer plugin owns the
 * election interval's cleanup and agent-default-model supplies the route for
 * bridge-created sessions. Headless disposes the tree before exit, so the
 * poll's disposer settles on the way out.
 */
export const inject = ['agentDefaultModel', 'agents', 'llm', 'sessionPersistence', 'sessions', 'timer']
export { Config }

const REASONING_PREFIX = '💭 '

/** Block identity within one turn/step, shared by the live and settlement paths. */
function blockKey(turn: number, step: number, index: number): string {
  return `${turn}:${step}:${index}`
}

/** Text content of a block list, in order. */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text', text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** One line summarizing a tool result, for the card's status mark. */
function firstLineOf(content: readonly ContentBlock[]): string {
  return textOf(content).split('\n').find((line) => line.trim().length > 0)?.slice(0, 160) ?? ''
}

/**
 * Mount the Telegram bridge.
 * @param ctx - Cordis context carrying the agent factory, sessions, and persistence.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.mode === 'off') return

  const log: LogFn = (level, message, detail) => {
    ctx.logger[level](`tg-bridge: ${message}${detail !== undefined ? ` — ${safe(detail)}` : ''}`)
  }

  // Fail loud at load: a live/dry bridge without a token or an allowlist is
  // invalid configuration, not a degraded mode.
  const token = resolveToken(config)
  if (token.length === 0) {
    throw new Error('tg-bridge: no bot token — set `token` in configuration or the TELEGRAM_BOT_TOKEN environment variable')
  }
  if (config.allowedUsers.length === 0) {
    throw new Error('tg-bridge: `allowedUsers` is empty — the bridge refuses to answer an open chat')
  }
  const chatId = requireChatId(config)

  const stateDir = config.stateDir
  try {
    mkdirSync(stateDir, { recursive: true })
  } catch (error) {
    throw new Error(`tg-bridge: cannot create stateDir ${stateDir}: ${safe(error)}`)
  }

  const state = new BridgeState(join(stateDir, 'state.json'), (message, detail) => log('warn', message, detail))
  const savedLocale = state.savedLocale() ?? config.locale
  setLocale(savedLocale)
  config.locale = savedLocale

  /**
   * The profile this process runs under — sessions get tagged with it so the
   * poll owner can refuse to wake one another live profile is driving.
   */
  const myProfile = (ctx.get('profileContext') as { name?: string } | undefined)?.name ?? 'unknown'

  const workspace = config.workspace !== undefined ? resolve(config.workspace) : process.cwd()

  const telegram: Telegram = config.mode === 'dry'
    ? new DryRunTelegram((kind, text) => log('info', `dry/${kind}: ${text.slice(0, 160)}`))
    : new Telegram({
      token,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      pollTimeout: config.pollTimeout,
      offsetPath: join(stateDir, 'offset.txt'),
      onLog: log,
    })

  // ── session bookkeeping ─────────────────────────────────────────────────────

  /** Handles the bridge owns (its own /new sessions and resumed ones). */
  const owned = new Map<string, AgentHandle>()
  /** Live status of every agent this process has seen. */
  const liveStatus = new Map<string, 'idle' | 'running'>()

  const isLive = (sessionId: string): boolean => liveStatus.has(sessionId)
  const watched = (sessionId: string): boolean => state.has(sessionId) && !state.isArchived(sessionId)
  const threadOf = (sessionId: string): number | undefined =>
    watched(sessionId) ? state.threadOf(sessionId) : undefined
  const titleOf = (sessionId: string): string => (state.titleOf(sessionId) ?? '').trim() || t('no_title')

  /**
   * The default model route for agents the bridge creates or resumes — the
   * same selection every entry point reads. The loop prefers a logged
   * request header from the second request on, so this fills only sessions
   * that never picked a route.
   */
  function defaultAgentOptions(): AgentOptions {
    const selection: ModelSelection = ctx.agentDefaultModel.currentSelection()
    return {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {},
    }
  }

  /** Message ids this bridge queued itself — their events need no receipt echo. */
  const queuedIds = new Set<string>()

  /**
   * The live Agent for a session: in-process when the host runs it, resumed
   * from persistence when only the log exists — and refused when another
   * live profile owns it, so two processes never drive one session log.
   * Subagent children stay untouchable; their runtime belongs to the parent.
   */
  async function resolveAgent(sessionId: string): Promise<ResolvedAgent> {
    const id = brandString<SessionId>(sessionId)
    const live = ctx.agents.get(id)
    if (live !== undefined) return { agent: live }
    const alreadyOwned = owned.get(sessionId)
    if (alreadyOwned !== undefined) return { agent: alreadyOwned.agent }
    const sessionProfile = state.profileOf(sessionId)
    if (isElsewhereLive(stateDir, sessionProfile, myProfile)) {
      log('warn', `refusing to resume ${sessionId.slice(0, 12)}: profile ${sessionProfile} is live`)
      return { refusal: t('session_elsewhere', { profile: sessionProfile ?? '?' }) }
    }
    try {
      const stat = await ctx.sessionPersistence.stat(id)
      if (stat === undefined) return {}
      if (stat.header.origin === 'subagent') return {}
      const handle = await ctx.agents.resume({
        resumeSessionId: id,
        agentOptions: defaultAgentOptions(),
      })
      owned.set(sessionId, handle)
      liveStatus.set(sessionId, 'idle')
      // The resuming profile now drives the session.
      state.claim(sessionId, myProfile)
      return { agent: handle.agent }
    } catch (error) {
      log('warn', `cannot resume session ${sessionId.slice(0, 12)}`, error)
      return {}
    }
  }

  /** Create a fresh root session the bridge owns, in a working directory. */
  async function createSession(cwd: string): Promise<string> {
    const sessionId = brandString<SessionId>(randomUUID())
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: defaultAgentOptions(),
    })
    owned.set(sessionId, handle)
    liveStatus.set(sessionId, 'idle')
    state.claim(sessionId, myProfile)
    state.touchIdle(sessionId)
    return sessionId
  }

  // ── topics ──────────────────────────────────────────────────────────────────

  const pendingTopics = new Set<string>()

  /** Create (or reuse) the forum thread for a session. */
  async function ensureThread(sessionId: string): Promise<number | undefined> {
    const known = state.threadOf(sessionId)
    if (known !== undefined && known > 0) return known
    if (pendingTopics.has(sessionId)) return undefined
    pendingTopics.add(sessionId)
    try {
      const title = titleOf(sessionId)
      const threadId = await telegram.createForumTopic(chatId, title)
      if (threadId !== undefined) state.setThread(sessionId, threadId)
      return threadId
    } catch (error) {
      log('warn', 'topic creation failed', error)
      return undefined
    } finally {
      pendingTopics.delete(sessionId)
    }
  }

  telegram.onDeadThread = (_chat, threadId) => {
    // The thread was deleted from the phone: drop the mapping, keep the
    // archived flag's absence, and let the next event rebuild it.
    state.removeByThread(threadId)
  }

  // ── renderer ───────────────────────────────────────────────────────────────

  const renderer = new TurnRenderer(
    telegram,
    chatId,
    config.render,
    watched,
    (error) => log('warn', 'render', error),
    titleOf,
    threadOf,
    { noTitle: t('no_title'), toolCancelled: t('tool_cancelled') },
  )
  renderer.start()

  /** Send one HTML line into a session's thread (or the chat root). */
  async function send(sessionId: string | undefined, html: string): Promise<void> {
    try {
      const thread = sessionId !== undefined ? state.threadOf(sessionId) : undefined
      const opts = thread === undefined ? { parseMode: 'HTML' as const } : { parseMode: 'HTML' as const, messageThreadId: thread }
      for (const piece of chunkHtml(html)) {
        await telegram.sendMessage(chatId, piece, opts)
      }
    } catch (error) {
      log('warn', 'send', error)
    }
  }

  // ── typing pulse ────────────────────────────────────────────────────────────

  const typingTimers = new Map<string, ReturnType<typeof setInterval>>()

  function typingStart(sessionId: string): void {
    if (typingTimers.has(sessionId)) return
    const thread = threadOf(sessionId)
    void telegram.sendChatAction(chatId, 'typing', thread)
    typingTimers.set(sessionId, setInterval(() => {
      void telegram.sendChatAction(chatId, 'typing', threadOf(sessionId))
    }, 4000))
  }

  function typingStop(sessionId: string): void {
    const timer = typingTimers.get(sessionId)
    if (timer === undefined) return
    clearInterval(timer)
    typingTimers.delete(sessionId)
  }

  ctx.on('agent/status', ({ agent, status }) => {
    liveStatus.set(agent.id, status)
    if (status === 'running') typingStart(agent.id)
    else typingStop(agent.id)
  })

  // ── media delivery (agent → phone) ──────────────────────────────────────────

  const turnStart = new Map<string, number>()
  const turnPaths = new Map<string, Set<string>>()

  function collectPaths(sessionId: string, text: string): void {
    if (text.length === 0) return
    const set = turnPaths.get(sessionId) ?? new Set<string>()
    for (const path of extractFilePaths(text)) set.add(path)
    turnPaths.set(sessionId, set)
  }

  async function deliverProduced(sessionId: string): Promise<void> {
    const paths = turnPaths.get(sessionId)
    const since = turnStart.get(sessionId)
    turnPaths.delete(sessionId)
    turnStart.delete(sessionId)
    if (paths === undefined || since === undefined || !watched(sessionId)) return
    const picked = selectImages([...paths], since)
    if (picked.length === 0) return
    const thread = state.threadOf(sessionId)
    try {
      const { readFile } = await import('node:fs/promises')
      let sent = false
      const fileOpts = thread === undefined ? {} : { messageThreadId: thread }
      for (const item of picked) {
        if (item.as === 'photo') {
          await telegram.sendPhoto(chatId, item.path, fileOpts)
          sent = true
        } else if (item.as === 'document') {
          await telegram.sendDocument(chatId, item.path, fileOpts)
          sent = true
        } else {
          const text = (await readFile(item.path, 'utf-8')).slice(0, 3500)
          for (const piece of chunkHtml(`<pre>${escapeHtml(text)}</pre>`)) {
            await telegram.sendMessage(chatId, piece, thread === undefined ? { parseMode: 'HTML' } : { parseMode: 'HTML', messageThreadId: thread })
          }
          sent = true
        }
      }
      if (sent) await send(sessionId, t('files_header'))
    } catch (error) {
      log('warn', 'media-out', error)
    }
  }

  // ── durable session events ─────────────────────────────────────────────────

  ctx.on('session/created', (session: Session) => {
    const id = session.header.id
    liveStatus.set(id, 'idle')
    // Subagent children belong to their parent's runtime, not to the forum.
    if (session.header.origin === 'subagent') return
    if (config.mirror !== 'all') return
    if (state.isArchived(id)) return
    // This profile's process drives the session from its first event.
    state.claim(id, myProfile)
    void ensureThread(id)
  })

  ctx.on('session/disposed', (session: Session) => {
    const id = session.header.id
    liveStatus.delete(id)
    typingStop(id)
    owned.delete(id)
  })

  ctx.on('session/event', (session: Session, event) => {
    const id = session.header.id
    if (config.debugEvents) log('info', `event ${event.type} (${id.slice(0, 10)})`)

    switch (event.type) {
      case 'turn/start': {
        turnStart.set(id, Date.now())
        turnPaths.set(id, new Set<string>())
        break
      }
      case 'user/message': {
        if (event.data.source.kind === 'plugin' && event.data.source.plugin === 'schedule') {
          if (watched(id)) void send(id, t('reminder_receipt', { text: textOf(event.data.content).slice(0, 400) }))
          return
        }
        if (event.data.source.kind !== 'user') return
        state.touchIdle(id)
        // The first human prompt names the thread; later renames follow the
        // same learned title.
        const text = textOf(event.data.content).trim()
        if (text.length > 0 && (state.titleOf(id) ?? '').length === 0) {
          state.setTitle(id, text.slice(0, 60))
          const thread = state.threadOf(id)
          const title = state.titleOf(id)
          if (thread !== undefined && title !== undefined) {
            void telegram.editForumTopic(chatId, thread, title).catch((error) => log('warn', 'topic rename', error))
          }
        }
        // Mirror prompts typed at other surfaces; the bridge's own queues
        // were already seen by their author.
        if (watched(id) && !queuedIds.has(event.data.id)) {
          void send(id, t('prompt_receipt', { text: text.slice(0, 900) }))
        }
        queuedIds.delete(event.data.id)
        break
      }
      case 'assistant/message': {
        // Settlement: end each streamed block by its durable index, or
        // render it whole when the live frames never reached us.
        for (const { chunk } of expandAssistantStream(event.data.stream)) {
          if (chunk.type !== 'block-end') continue
          const key = blockKey(event.data.turn, event.data.step, chunk.index)
          if (chunk.block.type === 'text') {
            renderer.textCommit(id, key, '', chunk.block.text)
          } else if (chunk.block.type === 'reasoning' && config.render.showReasoning) {
            renderer.textCommit(id, `r:${key}`, REASONING_PREFIX, chunk.block.text)
          }
        }
        const usage = event.data.usage
        if (usage !== undefined) {
          state.addUsage(id, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
          })
        }
        state.touchIdle(id)
        break
      }
      case 'tool/call': {
        let input: Record<string, unknown> = {}
        try {
          input = JSON.parse(event.data.arguments) as Record<string, unknown>
        } catch {
          /* the model's raw arguments stay opaque on the card */
        }
        collectPaths(id, event.data.arguments)
        renderer.toolEvent(id, { id: event.data.callId, name: event.data.name, input, status: 'running' })
        break
      }
      case 'tool/result': {
        const result = event.data.message.content[0]
        if (result === undefined) break
        const summary = firstLineOf(result.content)
        collectPaths(id, textOf(result.content))
        renderer.toolEvent(id, {
          id: result.toolCallId,
          status: result.isError === true ? 'failed' : 'completed',
          output: summary,
        })
        break
      }
      case 'turn/end': {
        renderer.finalize(id)
        void deliverProduced(id)
        const reason = event.data.reason
        if (reason.kind === 'error') {
          void send(id, t('turn_failed', { detail: reason.error.message.slice(0, 300) }))
        } else if (reason.kind === 'aborted') {
          void send(id, t('turn_aborted'))
        } else if (reason.kind === 'max-tokens') {
          void send(id, t('turn_max_tokens'))
        } else if (reason.kind === 'blocked') {
          void send(id, t('turn_blocked'))
        }
        state.touchIdle(id)
        break
      }
      default:
        break
    }
  })

  /**
   * Delete the threads of sessions idle past `archiveAfterDays`. Telegram
   * offers no durable close, so the sweep deletes and `/unarchive` recreates.
   * It runs from the election tick, not on per-session events: a session idle
   * past the window by definition ends no turn that could trigger the check.
   * A mapping younger than the window is spared, so `/rebuild` importing an
   * old session does not lose its new thread on the next tick.
   */
  function sweepIdleArchives(): void {
    if (config.archiveAfterDays <= 0) return
    const now = Date.now()
    const cutoff = now - config.archiveAfterDays * 86_400_000
    for (const [id, mapping] of state.entries()) {
      if (mapping.threadId === undefined) continue
      if (mapping.lastIdle === undefined || mapping.lastIdle >= cutoff) continue
      const since = mapping.mappedAt ?? mapping.lastIdle
      if (now - since < config.archiveAfterDays * 86_400_000) continue
      state.setArchived(id, true)
      void telegram.deleteForumTopic(chatId, mapping.threadId)
        .then(() => { state.clearThread(id) })
        .catch((error) => log('warn', 'archive sweep', error))
      log('info', `swept idle thread for ${id.slice(0, 12)} (idle ${Math.round((now - mapping.lastIdle) / 86_400_000)}d)`)
    }
  }

  // ── live deltas ────────────────────────────────────────────────────────────

  /** attemptId -> turn/step, learned from each stream's start frame. */
  const attemptTurnStep = new Map<string, { turn: number, step: number }>()

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const id = agent.id
    if (!watched(id)) return
    if (frame.type === 'start') {
      attemptTurnStep.set(frame.attemptId, { turn: frame.turn, step: frame.step })
      return
    }
    if (frame.type === 'end') {
      attemptTurnStep.delete(frame.attemptId)
      return
    }
    const position = attemptTurnStep.get(frame.attemptId)
    if (position === undefined) return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta') {
      renderer.textDelta(id, blockKey(position.turn, position.step, chunk.index), frame.index, chunk.text)
    } else if (chunk.type === 'reasoning-delta' && config.render.showReasoning) {
      const key = `r:${blockKey(position.turn, position.step, chunk.index)}`
      renderer.textStarted(id, key, REASONING_PREFIX)
      renderer.textDelta(id, key, frame.index, chunk.text)
    }
  })

  // ── answerers (permissions + questions) ─────────────────────────────────────

  const answerers = new AnswererHub({
    telegram,
    chatId,
    threadOf,
    notify: (error) => log('warn', 'answerer', error),
  })

  ctx.on('approval/request', (request, next) => answerers.approval(request, next))
  ctx.on('user-questions/request', (request, next) => answerers.questions(request, next))

  // ── prompts ────────────────────────────────────────────────────────────────

  /** A model route pinned for one session's next request (`/models` picker). */
  const pendingRoutes = new Map<string, { provider: string, model: string }>()

  /**
   * The model switch behind `/models`: the next request of the chosen session
   * leaves with the picked route instead of its logged one. From the request
   * after that, the newly logged header wins again — one tap changes the
   * route, it does not fight the log.
   */
  ctx.on('agent/request', async (payload, next) => {
    const base: LlmCallConfig = await next()
    const pending = pendingRoutes.get(payload.agent.id)
    if (pending === undefined) return base
    pendingRoutes.delete(payload.agent.id)
    return { ...base, provider: pending.provider, model: pending.model }
  })

  interface Coalesced {
    texts: string[]
    timer: ReturnType<typeof setTimeout> | undefined
  }

  const coalescing = new Map<string, Coalesced>()

  /**
   * Writing to an archived session brings it back: the archived flag drops
   * and its thread is recreated, so the mirror resumes instead of silently
   * swallowing the conversation into a thread that no longer exists.
   */
  function revive(sessionId: string): void {
    if (!state.isArchived(sessionId)) return
    state.setArchived(sessionId, false)
    void ensureThread(sessionId)
  }

  async function deliverPrompt(sessionId: string, content: ContentBlock[]): Promise<void> {
    try {
      revive(sessionId)
      const resolved = await resolveAgent(sessionId)
      if (resolved.agent === undefined) {
        await send(sessionId, resolved.refusal ?? t('resume_none'))
        return
      }
      const message = createUserMessage({ content, source: { kind: 'user' } })
      queuedIds.add(message.id)
      if (resolved.agent.status === 'running') {
        resolved.agent.steer(message)
      } else {
        resolved.agent.followup(message)
      }
    } catch (error) {
      await send(sessionId, t('err_generic', { detail: safe(error).slice(0, 200) }))
    }
  }

  function flushCoalesced(sessionId: string): number {
    const buffer = coalescing.get(sessionId)
    if (buffer === undefined) return 0
    coalescing.delete(sessionId)
    if (buffer.timer !== undefined) clearTimeout(buffer.timer)
    const text = buffer.texts.join('\n\n').trim()
    if (text.length === 0) return 0
    void deliverPrompt(sessionId, [{ type: 'text', text }])
    return 1
  }

  function flushAll(): number {
    let count = 0
    for (const sessionId of [...coalescing.keys()]) count += flushCoalesced(sessionId)
    return count
  }

  function queuePrompt(sessionId: string, text: string): void {
    const busy = liveStatus.get(sessionId) === 'running'
    const windowMs = busy ? config.coalesceBusyMs : config.coalesceMs
    const existing = coalescing.get(sessionId)
    if (existing !== undefined) {
      existing.texts.push(text)
      if (existing.timer !== undefined) clearTimeout(existing.timer)
      existing.timer = setTimeout(() => flushCoalesced(sessionId), windowMs)
      return
    }
    const buffer: Coalesced = { texts: [text], timer: undefined }
    buffer.timer = setTimeout(() => flushCoalesced(sessionId), windowMs)
    coalescing.set(sessionId, buffer)
  }

  // ── inbound media (phone → agent) ──────────────────────────────────────────

  /** Download a Telegram file to a temp path under the state directory. */
  async function downloadToTemp(fileId: string, suffix: string): Promise<string> {
    const file = await telegram.getFile(fileId)
    if (file.file_path === undefined) throw new Error('Telegram returned no file_path')
    const bytes = await telegram.downloadFile(file.file_path)
    const path = join(stateDir, `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${suffix}`)
    writeFileSync(path, bytes)
    return path
  }

  async function ingestPhoto(message: NonNullable<Update['message']>, caption: string, target: string | undefined): Promise<void> {
    if (target === undefined) {
      await send(undefined, t('msg_no_target'))
      return
    }
    const largest = message.photo?.at(-1)
    const fileId = largest?.file_id
    if (fileId === undefined) return
    try {
      const file = await telegram.getFile(fileId)
      if (file.file_path === undefined) throw new Error('no file_path')
      const bytes = await telegram.downloadFile(file.file_path)
      const content: ContentBlock[] = []
      const attachments = ctx.get('attachments') as AttachmentStore | undefined
      if (attachments !== undefined) {
        try {
          const batch: SaveImageAttachment[] = [{ data: bytes, mediaType: 'image/jpeg' }]
          const [ref] = await attachments.saveImages(batch)
          if (ref !== undefined) content.push({ type: 'image', attachment: ref })
        } catch (error) {
          log('warn', 'photo admission fell back to disk', error)
        }
      }
      if (content.length === 0) {
        // No attachment store, or the image was refused: keep it on disk and
        // point the agent at the path.
        const path = saveBinary('foto.jpg', bytes, downloadsDir(stateDir))
        content.push({ type: 'text', text: t('photo_route_unsupported', { path }) })
      }
      if (caption.trim().length > 0) content.push({ type: 'text', text: caption.trim() })
      state.touchIdle(target)
      await deliverPrompt(target, content)
    } catch (error) {
      await send(target, t('photo_fail', { detail: safe(error).slice(0, 200) }))
    }
  }

  async function ingestDocument(message: NonNullable<Update['message']>, caption: string, target: string | undefined): Promise<void> {
    if (target === undefined) {
      await send(undefined, t('msg_no_target'))
      return
    }
    const document = message.document
    if (document?.file_id === undefined) return
    const name = document.file_name ?? 'documento'
    try {
      const file = await telegram.getFile(document.file_id)
      if (file.file_path === undefined) throw new Error('no file_path')
      const bytes = await telegram.downloadFile(file.file_path)
      const content: ContentBlock[] = []
      if (isTextLike(name, document.mime_type ?? '', bytes)) {
        const text = decodeText(bytes).slice(0, DOC_MAX_CHARS)
        content.push({ type: 'text', text })
        await send(target, t('doc_inline', { name, chars: text.length }))
      } else {
        const attachments = ctx.get('attachments') as AttachmentStore | undefined
        let savedRef: FileAttachmentRef | undefined
        if (attachments !== undefined) {
          try {
            savedRef = await attachments.saveFile({ data: bytes, name })
          } catch (error) {
            log('warn', 'file admission fell back to disk', error)
          }
        }
        if (savedRef !== undefined) {
          content.push({ type: 'file', attachment: savedRef })
          await send(target, t('doc_inline', { name, chars: bytes.length }))
        } else {
          const path = saveBinary(name, bytes, downloadsDir(stateDir))
          content.push({ type: 'text', text: t('doc_saved', { path }) })
        }
      }
      if (caption.trim().length > 0) content.push({ type: 'text', text: caption.trim() })
      state.touchIdle(target)
      await deliverPrompt(target, content)
    } catch (error) {
      await send(target, t('media_prompt_fail', { detail: safe(error).slice(0, 200) }))
    }
  }

  async function ingestVoice(message: NonNullable<Update['message']>, target: string | undefined): Promise<void> {
    if (target === undefined) {
      await send(undefined, t('msg_no_target'))
      return
    }
    const voice = message.voice
    if (voice?.file_id === undefined) return
    if (!sttAvailable(config.stt, stateDir)) {
      await send(target, t('voice_disabled'))
      return
    }
    let tempPath: string | undefined
    try {
      await send(target, t('voice_transcribing'))
      tempPath = await downloadToTemp(voice.file_id, 'ogg')
      const text = await transcribeFile(tempPath, config.stt, stateDir)
      if (text.trim().length === 0) {
        await send(target, t('voice_empty'))
        return
      }
      state.touchIdle(target)
      await deliverPrompt(target, [{ type: 'text', text: text.trim() }])
    } catch (error) {
      await send(target, t('voice_fail', { detail: safe(error).slice(0, 200) }))
    } finally {
      if (tempPath !== undefined) rmSync(tempPath, { force: true })
    }
  }

  async function ingestVideo(message: NonNullable<Update['message']>, caption: string, target: string | undefined): Promise<void> {
    if (target === undefined) {
      await send(undefined, t('msg_no_target'))
      return
    }
    const video = message.video
    if (video?.file_id === undefined) return
    try {
      const file = await telegram.getFile(video.file_id)
      if (file.file_path === undefined) throw new Error('no file_path')
      const bytes = await telegram.downloadFile(file.file_path)
      const path = saveBinary(video.file_name ?? 'video.mp4', bytes, downloadsDir(stateDir))
      const content: ContentBlock[] = [{ type: 'text', text: t('doc_saved', { path }) }]
      if (caption.trim().length > 0) content.push({ type: 'text', text: caption.trim() })
      state.touchIdle(target)
      await deliverPrompt(target, content)
    } catch (error) {
      await send(target, t('media_prompt_fail', { detail: safe(error).slice(0, 200) }))
    }
  }

  // ── commands ────────────────────────────────────────────────────────────────

  /** Route lists bound to each `/models` card, addressed by callback index. */
  const modelCards = new MessageCards<Array<{ provider: string, model: string }>>(10)

  /** The `/models` picker: current route plus one button per route. */
  async function sendModelPicker(
    sessionId: string | undefined,
    current: string | undefined,
    routes: Array<{ provider: string, model: string }>,
  ): Promise<void> {
    const lines = [t('models_header')]
    if (current !== undefined) lines.push(current)
    lines.push(t('models_pick'))
    const rows = routes.slice(0, 30).map((route, index) => [{
      text: `${route.provider}/${route.model}`.slice(0, 60),
      callback_data: `m:${index}`,
    }])
    const thread = sessionId !== undefined ? state.threadOf(sessionId) : undefined
    const messageId = await telegram.sendMessage(chatId, lines.join(''), {
      parseMode: 'HTML',
      ...(thread === undefined ? {} : { messageThreadId: thread }),
      replyMarkup: { inline_keyboard: rows },
    })
    if (messageId !== null) modelCards.set(messageId, routes)
  }

  /** One tap on the picker pins that route for the session's next request. */
  async function handleModelCallback(payload: string, messageId: number | undefined, cqId: string, sessionId: string): Promise<boolean> {
    if (!payload.startsWith('m:')) return false
    const routes = modelCards.get(messageId)
    const index = Number(payload.slice(2))
    if (routes === undefined || !Number.isInteger(index) || index < 0 || index >= routes.length) {
      await telegram.answerCallbackQuery(cqId, t('form_inactive')).catch(() => undefined)
      return true
    }
    const route = routes[index]
    if (route === undefined) return true
    modelCards.drop(messageId)
    pendingRoutes.set(sessionId, route)
    await telegram.answerCallbackQuery(cqId).catch(() => undefined)
    const thread = state.threadOf(sessionId)
    await telegram.sendMessage(chatId, t('models_switched', {
      provider: escapeHtml(route.provider),
      model: escapeHtml(route.model),
    }), {
      parseMode: 'HTML',
      ...(thread === undefined ? {} : { messageThreadId: thread }),
    }).catch((error) => log('warn', 'models switch receipt', error))
    return true
  }

  const commandDeps: CommandDeps = {
    ctx,
    config,
    state,
    telegram,
    chatId,
    resolveAgent,
    createSession,
    workspaceDir: () => workspace,
    ensureThread,
    flushAll,
    isLive,
    runningSessions: () => [...liveStatus.entries()].filter(([, status]) => status === 'running').map(([id]) => id),
    sendModelPicker,
    answerFreeText: (sessionId, text) => {
      const pending = answerers.pendingFreeText(sessionId)
      if (pending === undefined) return false
      pending.submit(text)
      return true
    },
    deliverPromptText: (sessionId, text) => deliverPrompt(sessionId, [{ type: 'text', text }]),
    claimSession: (sessionId) => { state.claim(sessionId, myProfile) },
  }

  // ── the update loop ─────────────────────────────────────────────────────────

  const replyLabels: ReplyLabels = {
    media_poll: (params) => t('media_poll', params),
    media_topic_created: (params) => t('media_topic_created', params),
    media_photo: () => t('media_photo'),
    media_animation: () => t('media_animation'),
    media_document: (params) => t('media_document', params),
    media_sticker: (params) => t('media_sticker', params),
    media_voice: (params) => t('media_voice', params),
    media_audio: (params) => t('media_audio', params),
    media_video_note: (params) => t('media_video_note', params),
    media_video: (params) => t('media_video', params),
    media_dice: (params) => t('media_dice', params),
    media_location: () => t('media_location'),
    media_contact: (params) => t('media_contact', params),
    media_no_text: () => t('media_no_text'),
  }

  async function onUpdate(update: Update): Promise<void> {
    if (update.message !== undefined) {
      const message = update.message
      const from = message.from?.id
      if (from === undefined || !config.allowedUsers.includes(from)) {
        log('warn', `rejected message from user ${String(from)}`)
        return
      }
      const byThread = message.message_thread_id !== undefined
        ? state.sessionOf(message.message_thread_id)
        : undefined
      const target = byThread ?? state.rootSession()
      const text = (message.text ?? message.caption ?? '').trim()

      // Media carries its own pipeline; captions ride along with it.
      if (message.photo !== undefined) {
        await ingestPhoto(message, text, target)
        return
      }
      if (message.voice !== undefined) {
        await ingestVoice(message, target)
        return
      }
      if (message.document !== undefined) {
        await ingestDocument(message, text, target)
        return
      }
      if (message.video !== undefined) {
        await ingestVideo(message, text, target)
        return
      }
      if (text.length === 0) return

      if (text.startsWith('/')) {
        const [command, ...rest] = text.slice(1).split(/\s+/)
        const name = (command ?? '').split('@')[0] ?? ''
        try {
          const reply = await handleCommand(commandDeps, name, rest.join(' '), target)
          if (reply !== undefined) await send(target, reply)
        } catch (error) {
          await send(target, t('err_generic', { detail: safe(error).slice(0, 200) }))
        }
        return
      }

      if (target === undefined) {
        await send(undefined, t('msg_no_target'))
        return
      }

      // A wizard in progress consumes the message.
      const wizardReply = await feedWizard(commandDeps, target, text)
      if (wizardReply !== undefined) {
        await send(target, wizardReply)
        return
      }

      // An armed free-text answer consumes the message.
      const pending = answerers.pendingFreeText(target)
      if (pending !== undefined) {
        pending.submit(text)
        return
      }

      // A plain prompt, with reply context when the user answered a message.
      const quote = isForumEcho(message)
        ? undefined
        : describeReplyTarget(message.reply_to_message as ReplyTarget | undefined, replyLabels)
      const prompt = withReplyContext(text, quote, ({ quote: q, prompt: p }) => t('quote_frame', { quote: q, prompt: p }))
      revive(target)
      state.touchIdle(target)
      queuePrompt(target, prompt)
      return
    }

    if (update.callback_query !== undefined) {
      const cq = update.callback_query
      const from = cq.from?.id
      if (from === undefined || !config.allowedUsers.includes(from)) {
        log('warn', `rejected callback from user ${String(from)}`)
        return
      }
      const threadId = cq.message?.message_thread_id
      const sessionId = threadId !== undefined ? state.sessionOf(threadId) : state.rootSession()
      const payload = cq.data ?? ''
      const target = sessionId ?? ''
      // The model picker owns its callbacks before the answerer hub does.
      if (await handleModelCallback(payload, cq.message?.message_id, cq.id, target)) return
      await answerers.handleCallback(payload, cq.message?.message_id, cq.id, target)
    }
  }

  // ── ownership of the poll ────────────────────────────────────────────────────

  let leading = false
  let pollDone: Promise<void> | undefined
  /** Backoff after yielding the poll to another process (three 409s). */
  let yieldedUntil = 0

  async function publishCommands(): Promise<void> {
    await telegram.setCommandsEverywhere([
      { command: 'help', description: 'Command list' },
      { command: 'new', description: 'New session' },
      { command: 'ls', description: 'List sessions' },
      { command: 'use', description: 'Point the chat root at a session' },
      { command: 'models', description: 'Model routes' },
      { command: 'usagestats', description: 'Session token usage' },
      { command: 'queue', description: 'Session inbox' },
      { command: 'tasks', description: 'Session reminders' },
      { command: 'newtask', description: 'Reminder wizard' },
      { command: 'archive', description: 'Delete this thread' },
      { command: 'unarchive', description: 'Recreate this thread' },
      { command: 'locale', description: 'Interface language' },
    ], [chatId]).catch((error) => log('warn', 'setMyCommands', error))
  }

  function elect(): void {
    if (config.mode !== 'live') return
    if (leading) {
      if (!telegram.pollAlive()) {
        log('warn', 'poll stopped turning — releasing the lock')
        releaseLock(stateDir)
        leading = false
        yieldedUntil = Date.now() + 15_000
      } else {
        heartbeat(stateDir, (error) => log('warn', 'lock write failed', error))
      }
      return
    }
    if (Date.now() < yieldedUntil) return
    if (!acquireLock(stateDir, (error) => log('warn', 'lock write failed', error))) return
    leading = true
    log('info', `leading the Telegram poll for chat ${chatId}`)
    void publishCommands()
    pollDone = telegram.longPoll(onUpdate, (error) => log('warn', 'poll', error))
    void pollDone.then(() => {
      if (!leading) return
      leading = false
      yieldedUntil = Date.now() + 60_000
      log('warn', 'poll exited (yielded) — backing off for 60s')
    })
  }

  /**
   * One shared cadence: refresh this profile's liveness entry (so poll owners
   * elsewhere refuse to wake this process's sessions), then contest or keep
   * the poll lock. Every active bridge beats — poll ownership and liveness
   * are independent facts.
   */
  function tick(): void {
    beatProfile(stateDir, myProfile, (error) => log('warn', 'profile beat write failed', error))
    elect()
    // Only the poll owner sweeps: one process must own the deletion.
    if (leading) sweepIdleArchives()
  }

  ctx.setInterval(tick, LOCK_INTERVAL_MS)
  tick()

  log('info', `mounted (mode: ${config.mode}, mirror: ${config.mirror}, locale: ${locale()})`)

  // ── teardown ────────────────────────────────────────────────────────────────

  ctx.effect(() => async () => {
    // The election interval is an effect the framework clears itself.
    if (leading) releaseLock(stateDir)
    clearProfileBeat(stateDir, myProfile)
    await telegram.stop()
    for (const timer of typingTimers.values()) clearInterval(timer)
    typingTimers.clear()
    renderer.stop()
    state.flushNow()
    const handles = [...owned.values()]
    owned.clear()
    for (const handle of handles) {
      try {
        await handle.dispose()
      } catch (error) {
        log('warn', 'agent dispose', error)
      }
    }
  }, 'tg-bridge.teardown')
}
