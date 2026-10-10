/**
 * The Telegram command surface: everything a message starting with `/` can
 * do, resolved against the harness services the bridge already holds.
 *
 * Commands act on the session the writing thread belongs to, or on the chat
 * root's target session — the same routing a plain prompt takes. The
 * surface mirrors opencode-tg's: commands that exist there keep their name
 * and intent; where the harness owns a better mechanism (Schedule records,
 * session/title renames, the compaction seam, agent/request route pins) the
 * command drives that mechanism instead of a bridge-private imitation.
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Side-effect type imports: the session-title event the rename appends and
// the compaction seam /compact drives.
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-compaction'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { Telegram } from './telegram.ts'
import type { BridgeState } from './state.ts'
import type { Config } from './config.ts'
import { rebuildCandidates, scanSessionActivity, sessionsRoot, type RebuildCandidate } from './rebuild.ts'
import { type FileSystemLike, type FsTargetLike, findEntries } from './fsbrowse.ts'
import { matchScheduleRecord } from './schedmatch.ts'
import { escapeHtml, shortPath } from './render.ts'
import { setLocale, t } from './locale.ts'
import { safe } from './log.ts'

/** Resolution of a session lookup: its live agent, or why it is unavailable. */
export interface ResolvedAgent {
  agent?: Agent
  /** Localized reason the session cannot be driven (foreign profile, nothing found). */
  refusal?: string
}

/** One model route the `/models` picker offers. */
export interface ModelRoute {
  provider: string
  model: string
}

/** One button of a card: its label and the callback payload a tap sends back. */
export interface CardButton {
  text: string
  callback: string
}

/** One entry the `/files` browser shows: its name, its kind, and the target that continues navigation or reads it. */
export interface FsCardEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  size?: number
  target: FsTargetLike
}

/**
 * State bound to one card's message: what its buttons mean. A tap only ever
 * addresses the card it lives in, so every variant carries the data its own
 * callbacks index into, plus the buttons to redraw after a rebind.
 */
export type CardPayload =
  | { kind: 'menu', buttons: CardButton[] }
  | { kind: 'projects', buttons: CardButton[], paths: string[] }
  | { kind: 'skills', buttons: CardButton[], names: string[], cwd: string }
  | { kind: 'agents', buttons: CardButton[], ids: string[] }
  | { kind: 'perms', buttons: CardButton[], values: string[] }
  | { kind: 'commands', buttons: CardButton[], lines: string[] }
  | { kind: 'files', buttons: CardButton[], entries: FsCardEntry[] }

/** What the command handlers need from the bridge. */
export interface CommandDeps {
  ctx: Context
  config: Config
  state: BridgeState
  telegram: Telegram
  chatId: number
  /** Live agent for a session, resumed from persistence when needed; refuses foreign live profiles. */
  resolveAgent: (sessionId: string) => Promise<ResolvedAgent>
  /** Create a fresh session in a directory; returns its id. */
  createSession: (cwd: string) => Promise<string>
  /** The directory /new uses when the argument is absent. */
  workspaceDir: () => string
  /** Create (or reuse) the forum thread for a session. */
  ensureThread: (sessionId: string) => Promise<number | undefined>
  /** Send coalescing buffers for every session now; returns how many. */
  flushAll: () => number
  /** Whether the live runtime reports the session running. */
  isLive: (sessionId: string) => boolean
  /** Sessions with a turn in flight in this process. */
  runningSessions: () => string[]
  /** Send the `/models` route picker for a session (or the chat root). */
  sendModelPicker: (sessionId: string | undefined, current: string | undefined, routes: ModelRoute[]) => Promise<void>
  /** Feed a free-text answer to the armed question; false when none is armed. */
  answerFreeText: (sessionId: string, text: string) => boolean
  /** Deliver one text prompt to a session (followup/steer by its status). */
  deliverPromptText: (sessionId: string, text: string) => Promise<void>
  /** Tag the session as driven by this profile. */
  claimSession: (sessionId: string) => void
  /** The session's creation working directory, from its persisted header. */
  sessionCwd: (sessionId: string) => Promise<string | undefined>
  /** Send one text message into a session's thread (or the chat root). */
  sendText: (sessionId: string | undefined, html: string) => Promise<void>
  /** Send one button card and bind its state to the message that carries it. */
  sendCard: (sessionId: string | undefined, text: string, payload: CardPayload) => Promise<void>
  /** Replace one card's message: new text, new buttons, new bound state. */
  rebindCard: (messageId: number, text: string, payload: CardPayload) => Promise<void>
  /** Bridge self-report for `/status`. */
  bridgeStatus: () => { mode: string, leading: boolean, profile: string, mapped: number, running: number }
}

/** The session-query surface `/rebuild` and `/export` read (base mounts it). */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: string, cwd?: string, origin?: string, parentSession?: string } }>>
  readTitle(sessionId: SessionId, signal?: AbortSignal): Promise<{ title: string } | undefined>
  readSession(sessionId: SessionId, signal?: AbortSignal): Promise<{ events: ReadonlyArray<unknown> }>
}

/** The workspace-registry surface `/projects` reads. */
interface WorkspaceRegistryLike {
  list(): Array<{ path: string, title: string, sessionIds: ReadonlyArray<string>, updatedAt: string }>
}

/** The commands surface `/commands` lists and runs. */
interface CommandsLike {
  list(agent: unknown): ReadonlyArray<{ name: string, description: string }>
  execute(
    agent: unknown,
    line: string,
    submittedAttachments: ReadonlyArray<never>,
    signal: AbortSignal,
  ): Promise<{ result: { kind: 'success', text?: string } | { kind: 'error', text: string } } | undefined>
}

/** The permission-preset surface `/perms` reads and one-tap buttons apply. */
interface PermissionPresetsLike {
  catalog(): { options: ReadonlyArray<{ value: string, name: string, description?: string }> }
  current(session: unknown): string
  set(session: unknown, name: string): void
}

/** The skill-registry surface `/skills` and `/skill` read. */
interface SkillsLike {
  list(options?: { cwd?: string }): Promise<ReadonlyArray<{ name: string, description: string, whenToUse?: string }>>
  get(name: string, options?: { cwd?: string }): Promise<{ name: string, description: string, whenToUse?: string, content: string } | undefined>
}

/** The agent-preset surface `/agents` lists and one-tap buttons select. */
interface AgentPresetsLike {
  list(): Promise<ReadonlyArray<{ id: string, name?: string, description?: string }>>
  select(agent: unknown, agentPreset: string): Promise<string>
}

const DOTS = ['\u{1F534}', '\u{1F7E0}', '\u{1F7E1}', '\u{1F7E2}', '\u{1F535}', '\u{1F7E3}', '\u{1F7E4}', '\u{26AB}']

function dotFor(sessionId: string): string {
  let hash = 0
  for (let i = 0; i < sessionId.length; i++) hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0
  return DOTS[hash % DOTS.length] ?? '\u{26AB}'
}

/**
 * Dispatch one command.
 * @returns the HTML reply for the thread, or undefined when the command
 *   already answered (or needs no answer).
 */
export async function handleCommand(
  deps: CommandDeps,
  command: string,
  args: string,
  targetSession: string | undefined,
): Promise<string | undefined> {
  const { ctx, state } = deps
  const label = (sessionId: string | undefined): string =>
    sessionId === undefined ? '?' : (state.titleOf(sessionId) ?? sessionId.slice(0, 18))

  switch (command) {
    case 'help': {
      return t('help_body', { workspace: escapeHtml(shortPath(deps.workspaceDir(), 40)) })
    }

    case 'new': {
      const raw = args.trim()
      const cwd = raw.length > 0 ? resolve(raw) : resolve(deps.workspaceDir())
      if (!isAbsolute(cwd)) {
        return t('new_usage', { workspace: escapeHtml(shortPath(deps.workspaceDir(), 40)) })
      }
      try {
        const sessionId = await deps.createSession(cwd)
        void deps.ensureThread(sessionId)
        return t('new_done', { id: sessionId, dir: escapeHtml(shortPath(cwd, 46)) })
      } catch (error) {
        return t('new_fail', { detail: escapeHtml(safe(error)) })
      }
    }

    case 'rebuild': {
      const days = Math.min(Math.max(Number(args.trim()) || deps.config.rebuildDays, 1), 365)
      const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined
      if (sessionQuery === undefined) return t('rebuild_fail', { detail: 'sessionQuery is not mounted' })
      let roots: RebuildCandidate[]
      let skipped = 0
      try {
        const records = await sessionQuery.listSessions()
        const unfiltered = records.filter((record) =>
          record.header.origin !== 'subagent' && record.header.parentSession === undefined)
        for (const record of unfiltered) {
          if (state.has(record.header.id)) skipped += 1
        }
        const activity = scanSessionActivity(sessionsRoot())
        roots = unfiltered
          .filter((record) => !state.has(record.header.id))
          .map((record) => {
            const mtime = activity.get(record.header.id)
            return {
              id: record.header.id,
              ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
              ...(mtime === undefined ? {} : { mtime }),
            }
          })
      } catch (error) {
        return t('rebuild_fail', { detail: escapeHtml(safe(error).slice(0, 160)) })
      }
      const picked = rebuildCandidates(roots, Date.now(), days)
      if (picked.length === 0) {
        return skipped > 0 ? t('rebuild_none') + ` (${skipped})` : t('rebuild_none')
      }
      const lines: string[] = [t('rebuild_header', { n: picked.length, days })]
      for (const candidate of picked) {
        let title = candidate.id.slice(0, 24)
        try {
          title = (await sessionQuery.readTitle(brandString<SessionId>(candidate.id)))?.title ?? title
        } catch {
          /* an unreadable title falls back to the id prefix */
        }
        if (title === candidate.id.slice(0, 24) && candidate.cwd !== undefined) {
          title = `${basename(candidate.cwd)} · ${candidate.id.slice(0, 8)}`
        }
        state.setTitle(candidate.id, title.slice(0, 60))
        deps.claimSession(candidate.id)
        state.touchIdle(candidate.id, candidate.mtime)
        void deps.ensureThread(candidate.id)
        lines.push(t('rebuild_entry', { title: escapeHtml(title.slice(0, 48)) }))
      }
      if (skipped > 0) lines.push(`(${skipped})`)
      return lines.join('')
    }

    case 'ls': {
      const entries = state.entries()
      if (entries.length === 0) return t('ls_none')
      const lines = entries
        .sort((a, b) => (b[1].lastIdle ?? 0) - (a[1].lastIdle ?? 0))
        .slice(0, 20)
        .map(([id, mapping]) => t('ls_entry', {
          dot: dotFor(id),
          id: id.slice(0, 18),
          live: deps.isLive(id) ? t('ls_live') : '',
          archived: mapping.archived === true ? t('ls_archived') : '',
          title: escapeHtml((mapping.title ?? '').slice(0, 40)),
        }))
      return `${t('ls_header', { n: entries.length })}\n${lines.join('\n')}`
    }

    case 'running': {
      const running = deps.runningSessions()
      if (running.length === 0) return t('running_none')
      const lines = running.map((id) => t('ls_entry', {
        dot: dotFor(id),
        id: id.slice(0, 18),
        live: t('ls_live'),
        archived: '',
        title: escapeHtml((state.titleOf(id) ?? '').slice(0, 40)),
      }))
      return `${t('running_header', { n: running.length })}\n${lines.join('\n')}`
    }

    case 'use': {
      const prefix = args.trim()
      if (prefix.length === 0) return t('use_usage')
      const id = state.sessionByPrefix(prefix)
      if (id === undefined) return t('use_not_found')
      state.setRootSession(id)
      state.touchIdle(id)
      return t('use_done', { id })
    }

    case 'detach': {
      if (state.rootSession() === undefined) return t('detach_none')
      state.setRootSession(undefined)
      return t('detach_done')
    }

    case 'models': {
      try {
        const routes: ModelRoute[] = []
        for (const provider of ctx.llm.listProviders()) {
          for (const model of await ctx.llm.listModels(provider.id)) {
            routes.push({ provider: provider.id, model: model.id })
          }
        }
        let current: string | undefined
        if (targetSession !== undefined) {
          const resolved = await deps.resolveAgent(targetSession)
          const header = resolved.agent?.session.requestHeader()
          if (header !== undefined) {
            current = t('models_current', {
              provider: escapeHtml(header.config.provider),
              model: escapeHtml(header.config.model),
            })
          } else if (resolved.refusal !== undefined) {
            return resolved.refusal
          }
        }
        if (targetSession !== undefined) {
          await deps.sendModelPicker(targetSession, current, routes)
          return undefined
        }
        const lines = [t('models_header'), ...routes.map((route) =>
          t('models_route', { provider: escapeHtml(route.provider), model: escapeHtml(route.model) }))]
        if (current !== undefined) lines.push(current)
        return lines.join('')
      } catch (error) {
        return t('models_fail', { detail: escapeHtml(safe(error)) })
      }
    }

    case 'usagestats': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const usage = state.usageOf(id)
      const parts: string[] = [t('usage_header', { label: escapeHtml(label(id)) })]
      if (usage.total !== undefined) {
        parts.push(t('usage_total', {
          in: usage.total.inputTokens,
          out: usage.total.outputTokens,
          total: usage.total.totalTokens,
        }))
      }
      if (usage.last !== undefined) {
        parts.push(t('usage_last', {
          in: usage.last.inputTokens,
          out: usage.last.outputTokens,
          total: usage.last.totalTokens,
        }))
      }
      try {
        const resolved = await deps.resolveAgent(id)
        const meter = ctx.get('tokenMeter') as { measure: (session: unknown) => { totalTokens: number } } | undefined
        const window = resolved.agent?.session.requestContext()?.contextWindow
        if (resolved.agent !== undefined && meter !== undefined) {
          const used = meter.measure(resolved.agent.session).totalTokens
          if (window !== undefined) parts.push(t('usage_ctx', { used, size: window }))
        }
      } catch {
        /* occupancy is a nicety; totals still answer the command */
      }
      if (parts.length === 1) return t('usage_none')
      return parts.join('')
    }

    case 'queue': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const resolved = await deps.resolveAgent(id)
      if (resolved.agent === undefined) return resolved.refusal ?? t('queue_none')
      const nextTurn = resolved.agent.inbox.nextTurn.length
      const nextStep = resolved.agent.inbox.nextStep.length
      if (nextTurn === 0 && nextStep === 0) return t('queue_none')
      const parts: string[] = [t('queue_header')]
      if (nextTurn > 0) parts.push(t('queue_turn', { n: nextTurn }))
      if (nextStep > 0) parts.push(t('queue_step', { n: nextStep }))
      return parts.join('')
    }

    case 'flush': {
      const flushed = deps.flushAll()
      return flushed > 0 ? t('flush_done', { n: flushed }) : t('flush_none')
    }

    case 'find': {
      const query = args.trim().toLowerCase()
      if (query.length === 0) return t('find_usage')
      const hits = state.entries()
        .filter(([id, mapping]) =>
          (mapping.title ?? '').toLowerCase().includes(query) || id.toLowerCase().includes(query))
        .slice(0, 12)
        .map(([id, mapping]) => t('ls_entry', {
          dot: dotFor(id),
          id: id.slice(0, 18),
          live: deps.isLive(id) ? t('ls_live') : '',
          archived: mapping.archived === true ? t('ls_archived') : '',
          title: escapeHtml((mapping.title ?? '').slice(0, 40)),
        }))
      if (hits.length === 0) return t('find_none', { query: escapeHtml(args.trim()) })
      return `${t('find_header', { n: hits.length })}\n${hits.join('\n')}`
    }

    case 'history': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const resolved = await deps.resolveAgent(id)
      if (resolved.agent === undefined) return resolved.refusal ?? t('history_none')
      const wanted = Math.min(Math.max(Number(args.trim()) || 8, 1), 30)
      const entries: Array<{ role: 'user' | 'assistant', text: string }> = []
      for (const event of resolved.agent.session.snapshotEvents()) {
        if (event.type === 'user/message' && event.data.source.kind === 'user') {
          const text = event.data.content
            .filter((block): block is { type: 'text', text: string } => block.type === 'text')
            .map((block) => block.text)
            .join('')
          if (text.trim().length > 0) entries.push({ role: 'user', text })
        } else if (event.type === 'assistant/message') {
          const text = event.data.message.content
            .filter((block): block is { type: 'text', text: string } => block.type === 'text')
            .map((block) => block.text)
            .join('')
          if (text.trim().length > 0) entries.push({ role: 'assistant', text })
        }
      }
      const tail = entries.slice(-wanted)
      if (tail.length === 0) return t('history_none')
      const lines = tail.map((entry) => `${entry.role === 'user' ? '🧑' : '🤖'} ${escapeHtml(entry.text.slice(0, 240))}`)
      return `${t('history_header', { n: tail.length })}\n${lines.join('\n\n')}`
    }

    case 'export': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined
      if (sessionQuery === undefined) return t('export_fail', { detail: 'sessionQuery is not mounted' })
      try {
        const snapshot = await sessionQuery.readSession(brandString<SessionId>(id))
        const name = `${id.slice(0, 12)}.jsonl`
        const path = join(tmpdir(), `tg-export-${Date.now()}-${name}`)
        writeFileSync(path, snapshot.events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf-8')
        const thread = state.threadOf(id)
        await deps.telegram.sendDocument(deps.chatId, path, {
          ...(thread === undefined ? {} : { messageThreadId: thread }),
        })
        return t('export_done', { name: escapeHtml(name) })
      } catch (error) {
        return t('export_fail', { detail: escapeHtml(safe(error).slice(0, 160)) })
      }
    }

    case 'rename': {
      const title = args.trim()
      if (title.length === 0) return t('rename_usage')
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const resolved = await deps.resolveAgent(id)
      if (resolved.agent === undefined) return resolved.refusal ?? t('history_none')
      // The harness's own explicit-rename record: pins the title and stops
      // automatic scheduling — the web UI reads the same event.
      resolved.agent.session.append('session/title', {
        title: title.slice(0, 200),
        messageSeqs: [],
        source: { kind: 'user' },
      })
      state.setTitle(id, title.slice(0, 60))
      const thread = state.threadOf(id)
      if (thread !== undefined) {
        await deps.telegram.editForumTopic(deps.chatId, thread, title.slice(0, 60))
      }
      return t('rename_done', { title: escapeHtml(title.slice(0, 60)) })
    }

    case 'note': {
      const text = args.trim()
      if (text.length === 0) return t('note_usage')
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const resolved = await deps.resolveAgent(id)
      if (resolved.agent === undefined) return resolved.refusal ?? t('history_none')
      resolved.agent.inject(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'tg-bridge' },
      }))
      state.touchIdle(id)
      return t('note_added')
    }

    case 'txt': {
      const text = args.trim()
      if (text.length === 0) return t('txt_usage')
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      if (!deps.answerFreeText(id, text)) return t('txt_none')
      return t('txt_done', { text: escapeHtml(text.slice(0, 120)) })
    }

    case 'sh': {
      const cmd = args.trim()
      if (cmd.length === 0) return t('sh_usage')
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      // The harness invariant — model-visible means logged — forbids running
      // shell outside the agent: the command goes to the agent, which runs
      // it through its sandboxed shell tool with its permission gates.
      await deps.deliverPromptText(id, t('sh_frame', { cmd }))
      state.touchIdle(id)
      return t('sh_sent')
    }

    case 'compact': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const resolved = await deps.resolveAgent(id)
      if (resolved.agent === undefined) return resolved.refusal ?? t('history_none')
      try {
        const result = await ctx.compaction.compactNow(resolved.agent, AbortSignal.timeout(180_000))
        if (result === null) return t('compact_noop')
        return t('compact_done', { n: result.shadowedSeqs.length, tokens: result.shadowedTokenCount })
      } catch (error) {
        if (error instanceof ManualCompactionError) {
          return t('compact_fail', { detail: escapeHtml(error.code) })
        }
        return t('compact_fail', { detail: escapeHtml(safe(error).slice(0, 160)) })
      }
    }

    case 'archive': {
      const id = args.trim().length > 0 ? state.sessionByPrefix(args.trim()) : targetSession
      if (id === undefined) return t('archive_usage')
      state.setArchived(id, true)
      const thread = state.threadOf(id)
      if (thread !== undefined) {
        await deps.telegram.deleteForumTopic(deps.chatId, thread)
        state.clearThread(id)
      }
      return t('archive_done')
    }

    case 'unarchive': {
      const id = args.trim().length > 0 ? state.sessionByPrefix(args.trim()) : targetSession
      if (id === undefined) return t('archive_usage')
      state.setArchived(id, false)
      await deps.ensureThread(id)
      return t('unarchive_recreated')
    }

    case 'kill': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const resolved = await deps.resolveAgent(id)
      if (resolved.agent === undefined) return resolved.refusal ?? t('kill_none')
      resolved.agent.cancel({ kind: 'user' })
      return t('kill_done')
    }

    case 'tasks': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      return listTasks(deps, id)
    }

    case 'newtask': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      return startWizard(id, args.trim())
    }

    case 'taskcancel': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const schedule = await importSchedule()
      if (schedule === undefined) return t('tasks_unavailable')
      const resolved = await deps.resolveAgent(id)
      if (resolved.agent === undefined) return resolved.refusal ?? t('tasks_none')
      await ctx.sessions.flush(resolved.agent.session)
      const folded = schedule.foldScheduleEvents(resolved.agent.session.snapshotEvents())
      const record = matchScheduleRecord(folded.active, args.trim())
      if (record === undefined) return t('taskcancel_none', { query: escapeHtml(args.trim()) })
      resolved.agent.session.append('schedule/change', {
        version: 1,
        operation: 'delete',
        id: record.id,
      })
      await ctx.sessions.flush(resolved.agent.session)
      return t('task_deleted')
    }

    case 'send': {
      const trimmed = args.trim()
      const space = trimmed.indexOf(' ')
      const prefix = space === -1 ? trimmed : trimmed.slice(0, space)
      const text = space === -1 ? '' : trimmed.slice(space + 1).trim()
      if (prefix.length === 0 || text.length === 0) return t('send_usage')
      const id = state.sessionByPrefix(prefix)
      if (id === undefined) return t('use_not_found')
      await deps.deliverPromptText(id, text)
      state.touchIdle(id)
      return t('send_done', { id: id.slice(0, 18), text: escapeHtml(text.slice(0, 90)) })
    }

    case 'sessions': {
      const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined
      if (sessionQuery === undefined) return t('rebuild_fail', { detail: 'sessionQuery is not mounted' })
      let records: Array<{ header: { id: string } }>
      try {
        records = (await sessionQuery.listSessions())
          .filter((record) => record.header.origin !== 'subagent' && record.header.parentSession === undefined)
      } catch (error) {
        return t('rebuild_fail', { detail: escapeHtml(safe(error).slice(0, 160)) })
      }
      if (records.length === 0) return t('sessions_none')
      const liveIds = new Set(ctx.agents.list().map((agent): string => agent.session.id))
      const rowOf = (id: string, mapping: { archived?: boolean, title?: string } | undefined) => t('ls_entry', {
        dot: dotFor(id),
        id: id.slice(0, 18),
        live: liveIds.has(id) ? t('ls_live') : '',
        archived: mapping?.archived === true ? t('ls_archived') : '',
        title: escapeHtml((mapping?.title ?? '').slice(0, 40)),
      })
      const mapped = state.entries().sort((a, b) => (b[1].lastIdle ?? 0) - (a[1].lastIdle ?? 0)).slice(0, 15)
        .map(([id, mapping]) => rowOf(id, mapping))
      const rest: string[] = []
      for (const record of records) {
        if (rest.length >= 10) break
        if (state.has(record.header.id)) continue
        let title = ''
        try {
          title = (await sessionQuery.readTitle(brandString<SessionId>(record.header.id)))?.title.slice(0, 40) ?? ''
        } catch {
          /* an unreadable title stays blank; the id row still answers */
        }
        rest.push(rowOf(record.header.id, { title }))
      }
      const lines = [t('sessions_header', { total: records.length })]
      if (mapped.length > 0) lines.push(t('sessions_mapped', { n: mapped.length }), ...mapped)
      if (rest.length > 0) lines.push(t('sessions_rest', { n: records.length - state.size() }), ...rest)
      return lines.join('\n')
    }

    case 'projects': {
      const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
      if (registry === undefined) return t('projects_unavailable')
      const workspaces = [...registry.list()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 12)
      if (workspaces.length === 0) return t('projects_none')
      const lines = workspaces.map((workspace) => t('projects_entry', {
        title: escapeHtml(workspace.title.slice(0, 40)),
        n: workspace.sessionIds.length,
        path: escapeHtml(shortPath(workspace.path, 44)),
      }))
      const buttons = workspaces.map((workspace, index) => ({
        text: `＋ ${workspace.title}`.slice(0, 60),
        callback: `p:${index}`,
      }))
      await deps.sendCard(targetSession, `${t('projects_header', { n: workspaces.length })}${lines.join('')}\n${t('projects_pick')}`, {
        kind: 'projects',
        buttons,
        paths: workspaces.map((workspace) => workspace.path),
      })
      return undefined
    }

    case 'context': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const meter = ctx.get('tokenMeter') as { measure: (session: unknown) => { totalTokens: number } } | undefined
      if (meter === undefined) return t('context_unavailable')
      const resolved = await deps.resolveAgent(id)
      if (resolved.agent === undefined) return resolved.refusal ?? t('history_none')
      const used = meter.measure(resolved.agent.session).totalTokens
      const window = resolved.agent.session.requestContext()?.contextWindow
      const compactions = resolved.agent.session.snapshotEvents()
        .filter((event) => event.type === 'compaction/summary')
      const lines = [t('context_header', { label: escapeHtml(label(id)) })]
      lines.push(t('context_tokens', {
        used,
        size: window ?? '?',
        pct: window === undefined ? '' : t('context_pct', { pct: Math.round((used / window) * 100) }),
      }))
      if (compactions.length > 0) {
        lines.push(t('context_compactions', { n: compactions.length }))
        const last = compactions[compactions.length - 1]
        if (last !== undefined) {
          const summaryText = last.data.summary
            .filter((block): block is { type: 'text', text: string } => block.type === 'text')
            .map((block) => block.text)
            .join('')
          lines.push(t('context_last_summary', { summary: escapeHtml(summaryText.slice(0, 220)) }))
        }
      }
      if (window !== undefined && used > window * 0.5) lines.push(t('context_hint'))
      return lines.join('')
    }

    case 'clearqueue': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const resolved = await deps.resolveAgent(id)
      if (resolved.agent === undefined) return resolved.refusal ?? t('queue_none')
      resolved.agent.inbox.clear()
      return t('clearqueue_done')
    }

    case 'usage': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const resolved = await deps.resolveAgent(id)
      if (resolved.agent === undefined) return resolved.refusal ?? t('usage_none')
      const agent = resolved.agent
      const header = agent.session.requestHeader()
      const parts: string[] = [t('usage_now_header', { label: escapeHtml(label(id)) })]
      if (header !== undefined) {
        parts.push(t('usage_route', { provider: escapeHtml(header.config.provider), model: escapeHtml(header.config.model) }))
      }
      parts.push(t('usage_status', {
        status: agent.status === 'running' ? t('usage_running') : t('usage_idle'),
      }))
      const usage = state.usageOf(id)
      if (usage.total !== undefined) {
        parts.push(t('usage_total', {
          in: usage.total.inputTokens,
          out: usage.total.outputTokens,
          total: usage.total.totalTokens,
        }))
      }
      if (usage.last !== undefined) {
        parts.push(t('usage_last', {
          in: usage.last.inputTokens,
          out: usage.last.outputTokens,
          total: usage.last.totalTokens,
        }))
      }
      try {
        const meter = ctx.get('tokenMeter') as { measure: (session: unknown) => { totalTokens: number } } | undefined
        const window = agent.session.requestContext()?.contextWindow
        if (meter !== undefined) {
          parts.push(t('usage_ctx', { used: meter.measure(agent.session).totalTokens, size: window ?? '?' }))
        }
      } catch {
        /* occupancy is a nicety; totals still answer the command */
      }
      return parts.join('')
    }

    case 'commands': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const commands = ctx.get('commands') as CommandsLike | undefined
      if (commands === undefined) return t('commands_unavailable')
      const resolved = await deps.resolveAgent(id)
      if (resolved.agent === undefined) return resolved.refusal ?? t('history_none')
      if (args.trim().startsWith('run')) {
        const rest = args.trim().slice(3).trim()
        const [name, ...tail] = rest.split(/\s+/)
        if (name === undefined || name.length === 0) return t('commands_run_usage')
        const line = `/${name}${tail.length > 0 ? ` ${tail.join(' ')}` : ''}`
        try {
          const execution = await commands.execute(resolved.agent, line, [], AbortSignal.timeout(180_000))
          if (execution === undefined) return t('commands_not_found', { name: escapeHtml(name) })
          if (execution.result.kind === 'error') {
            return t('commands_error', { text: escapeHtml(execution.result.text.slice(0, 400)) })
          }
          const text = execution.result.text ?? ''
          return text.length > 0
            ? t('commands_ok', { text: escapeHtml(text.slice(0, 1500)) })
            : t('commands_ok_plain')
        } catch (error) {
          return t('commands_error', { text: escapeHtml(safe(error).slice(0, 300)) })
        }
      }
      const list = commands.list(resolved.agent)
      if (list.length === 0) return t('commands_none')
      const shown = list.slice(0, 25)
      const lines = shown.map((descriptor) => t('commands_entry', {
        name: escapeHtml(descriptor.name.slice(0, 40)),
        desc: escapeHtml(descriptor.description.slice(0, 80)),
      }))
      const buttons = shown.map((descriptor, index) => ({
        text: `/${descriptor.name}`.slice(0, 60),
        callback: `r:${index}`,
      }))
      await deps.sendCard(targetSession, `${t('commands_header', { n: list.length })}${lines.join('')}\n${t('commands_pick')}`, {
        kind: 'commands',
        buttons,
        lines: shown.map((descriptor) => `/${descriptor.name}`),
      })
      return undefined
    }

    case 'perms': {
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const presets = ctx.get('permissionPresets') as PermissionPresetsLike | undefined
      if (presets === undefined) return t('perms_unavailable')
      const resolved = await deps.resolveAgent(id)
      if (resolved.agent === undefined) return resolved.refusal ?? t('history_none')
      const approval = ctx.get('approval') as { overrideOf: (session: unknown) => string | undefined } | undefined
      const sandbox = ctx.get('sandboxPolicy') as { overrideOf: (session: unknown) => string | undefined } | undefined
      const options = presets.catalog().options.slice(0, 12)
      const lines = [
        t('perms_header', { label: escapeHtml(label(id)) }),
        t('perms_current', { name: escapeHtml(presets.current(resolved.agent.session)) }),
        t('perms_approval', { policy: approval?.overrideOf(resolved.agent.session) ?? 'ask' }),
        t('perms_sandbox', { mode: sandbox?.overrideOf(resolved.agent.session) ?? 'default' }),
      ]
      if (options.length > 0) lines.push(t('perms_pick'))
      const buttons = options.map((option, index) => ({
        text: option.name.slice(0, 60),
        callback: `x:${index}`,
      }))
      await deps.sendCard(targetSession, lines.join(''), {
        kind: 'perms',
        buttons,
        values: options.map((option) => option.value),
      })
      return undefined
    }

    case 'skills': {
      const cwd = targetSession !== undefined
        ? (await deps.sessionCwd(targetSession)) ?? deps.workspaceDir()
        : deps.workspaceDir()
      const skills = ctx.get('skills') as SkillsLike | undefined
      if (skills === undefined) return t('skills_unavailable')
      const list = await skills.list({ cwd })
      if (list.length === 0) return t('skills_none')
      const shown = list.slice(0, 30)
      const lines = shown.map((skill) => t('skills_entry', {
        name: escapeHtml(skill.name.slice(0, 44)),
        desc: escapeHtml(skill.description.slice(0, 70)),
      }))
      const buttons = shown.map((skill, index) => ({
        text: skill.name.slice(0, 60),
        callback: `k:${index}`,
      }))
      await deps.sendCard(targetSession, `${t('skills_header', { n: list.length })}${lines.join('')}\n${t('skills_pick')}`, {
        kind: 'skills',
        buttons,
        names: shown.map((skill) => skill.name),
        cwd,
      })
      return undefined
    }

    case 'skill': {
      const trimmed = args.trim()
      const space = trimmed.indexOf(' ')
      const name = (space === -1 ? trimmed : trimmed.slice(0, space)).trim()
      const text = space === -1 ? '' : trimmed.slice(space + 1).trim()
      if (name.length === 0) return t('skill_usage')
      const id = targetSession
      if (id === undefined) return t('msg_no_target')
      const skills = ctx.get('skills') as SkillsLike | undefined
      if (skills === undefined) return t('skills_unavailable')
      const cwd = (await deps.sessionCwd(id)) ?? deps.workspaceDir()
      const definition = await skills.get(name, { cwd })
      if (definition === undefined) return t('skill_not_found', { name: escapeHtml(name) })
      await deps.deliverPromptText(id, t('skill_frame', {
        name,
        content: definition.content,
        text: text.length > 0 ? text : t('skill_default_task'),
      }))
      state.touchIdle(id)
      return t('skill_sent', { name: escapeHtml(name) })
    }

    case 'agents': {
      const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
      if (presets === undefined) return t('agents_unavailable')
      const list = await presets.list()
      if (list.length === 0) return t('agents_none')
      const shown = list.slice(0, 15)
      const lines = shown.map((preset) => t('agents_entry', {
        name: escapeHtml((preset.name ?? preset.id).slice(0, 40)),
        desc: escapeHtml((preset.description ?? '').slice(0, 80)),
      }))
      const buttons = shown.map((preset, index) => ({
        text: (preset.name ?? preset.id).slice(0, 60),
        callback: `a:${index}`,
      }))
      await deps.sendCard(targetSession, `${t('agents_header', { n: list.length })}${lines.join('')}\n${t('agents_pick')}`, {
        kind: 'agents',
        buttons,
        ids: shown.map((preset) => preset.id),
      })
      return undefined
    }

    case 'menu': {
      const entries: Array<[string, string]> = [
        ['🧭', 'running'], ['📂', 'sessions'], ['📁', 'projects'], ['🧠', 'models'],
        ['📊', 'usage'], ['🧮', 'context'], ['📚', 'skills'], ['⏰', 'tasks'],
        ['📥', 'queue'], ['❓', 'help'],
      ]
      const buttons = entries.map(([emoji, command]) => ({
        text: `${emoji} ${command}`.slice(0, 60),
        callback: `c:${command}`,
      }))
      await deps.sendCard(targetSession, t('menu_header'), { kind: 'menu', buttons })
      return undefined
    }

    case 'status': {
      const report = deps.bridgeStatus()
      const root = state.rootSession()
      const lines = [
        t('status_header'),
        t('status_mode', { mode: escapeHtml(report.mode), profile: escapeHtml(report.profile) }),
        t('status_leader', { leader: report.leading ? t('status_yes') : t('status_no') }),
        t('status_mapped', { mapped: report.mapped, running: report.running }),
        t('status_root', { root: root !== undefined ? root.slice(0, 18) : t('status_root_none') }),
      ]
      return lines.join('')
    }

    case 'delthread': {
      const id = args.trim().length > 0 ? state.sessionByPrefix(args.trim()) : targetSession
      if (id === undefined) return t('archive_usage')
      const thread = state.threadOf(id)
      if (thread !== undefined) {
        await deps.telegram.deleteForumTopic(deps.chatId, thread)
        state.clearThread(id)
      }
      return t('delthread_done')
    }

    case 'files': {
      const fs = ctx.get('fs') as FileSystemLike | undefined
      if (fs === undefined) return t('files_unavailable')
      const raw = args.trim()
      const cwd = targetSession !== undefined
        ? (await deps.sessionCwd(targetSession)) ?? deps.workspaceDir()
        : deps.workspaceDir()
      const absolute = raw.length === 0 ? cwd : isAbsolute(raw) ? raw : join(cwd, raw)
      try {
        const target = await fs.resolve(absolute, { cwd })
        const rendered = await renderFileBrowser(fs, target)
        await deps.sendCard(targetSession, rendered.text, rendered.payload)
        return undefined
      } catch (error) {
        return t('files_fail', { detail: escapeHtml(safe(error).slice(0, 160)) })
      }
    }

    case 'ffind': {
      const query = args.trim()
      if (query.length === 0) return t('ffind_usage')
      const fs = ctx.get('fs') as FileSystemLike | undefined
      if (fs === undefined) return t('files_unavailable')
      const cwd = targetSession !== undefined
        ? (await deps.sessionCwd(targetSession)) ?? deps.workspaceDir()
        : deps.workspaceDir()
      try {
        const target = await fs.resolve(cwd, { cwd })
        const found = await findEntries((dir) => fs.listDir(dir), target, query, {
          maxDepth: 4,
          maxDirs: 150,
          maxResults: 15,
        })
        if (found.length === 0) return t('ffind_none', { query: escapeHtml(query) })
        const lines = found.map((entry) => t('ffind_entry', {
          path: escapeHtml(shortPath(entry.displayPath, 58)),
          size: entry.size !== undefined ? ` · ${String(entry.size)}` : '',
        }))
        return `${t('ffind_header', { n: found.length, query: escapeHtml(query) })}${lines.join('')}`
      } catch (error) {
        return t('files_fail', { detail: escapeHtml(safe(error).slice(0, 160)) })
      }
    }

    case 'locale': {
      const wanted = args.trim().toLowerCase()
      if (wanted !== 'es' && wanted !== 'en') return t('locale_usage')
      setLocale(wanted)
      state.setSavedLocale(wanted)
      deps.config.locale = wanted
      return t('locale_done', { locale: wanted })
    }

    default:
      return t('unknown_command', { cmd: escapeHtml(command) })
  }
}

// ── button cards and their callbacks ────────────────────────────────────────

/** Commands a menu button may run; any other `c:` payload falls through. */
const MENU_COMMANDS = new Set([
  'running', 'sessions', 'projects', 'models', 'usage', 'context', 'skills', 'tasks', 'queue', 'help',
])

/** The largest file a `/files` tap downloads as a document, in bytes. */
const FILE_DOWNLOAD_CAP = 256 * 1024

/** One directory listing as a card: its text, its buttons, and the entries they address. */
async function renderFileBrowser(
  fs: FileSystemLike,
  target: FsTargetLike,
): Promise<{ text: string, payload: CardPayload }> {
  const entries = await fs.listDir(target)
  const sorted = [...entries].sort((a, b) =>
    (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name))
  const shown: FsCardEntry[] = sorted.slice(0, 40).map((entry) => ({
    name: entry.name,
    type: entry.type,
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    target: entry.target,
  }))
  // The up-button: one synthetic entry appended last, so a tap climbs out.
  const parent = dirname(target.displayPath)
  if (parent !== target.displayPath) {
    try {
      shown.push({ name: '..', type: 'directory', target: await fs.resolve(parent) })
    } catch {
      /* a directory whose parent will not resolve loses the up-button, not the listing */
    }
  }
  const lines = shown.map((entry) => entry.type === 'directory'
    ? `\n📁 ${escapeHtml(entry.name)}`
    : `\n📄 ${escapeHtml(entry.name)}${entry.size !== undefined ? ` · ${String(entry.size)}` : ''}`)
  const buttons = shown.map((entry, index) => ({
    text: `${entry.type === 'directory' ? '📁' : '📄'} ${entry.name}`.slice(0, 60),
    callback: `f:${index}`,
  }))
  return {
    text: `${t('files_dir', { path: escapeHtml(shortPath(target.displayPath, 50)) })}${lines.join('')}`,
    payload: { kind: 'files', buttons, entries: shown },
  }
}

/**
 * One tap on a card the bridge drew. The card's state rides the message id, so
 * a tap only ever addresses the card it lives in.
 * @returns true when the payload belonged to a bridge card — answered, refused,
 *   or failed alike — and the tap needs no other handler.
 */
export async function handleCardCallback(
  deps: CommandDeps,
  payload: string,
  card: CardPayload,
  messageId: number | undefined,
  cqId: string,
  target: string,
): Promise<boolean> {
  const { ctx, state } = deps
  const session = target.length > 0 ? target : undefined
  const answer = (text?: string, alert = false): Promise<void> =>
    deps.telegram.answerCallbackQuery(cqId, text, alert).catch(() => undefined)
  /** Resolve `<prefix><index>` against a list the card carries; undefined when the payload is not that prefix. */
  const pick = (prefix: string, list: ReadonlyArray<string>): string | undefined => {
    if (!payload.startsWith(prefix)) return undefined
    const index = Number(payload.slice(prefix.length))
    if (!Number.isInteger(index) || index < 0) return undefined
    return list[index]
  }

  if (payload.startsWith('c:')) {
    const command = payload.slice(2)
    if (!MENU_COMMANDS.has(command)) return false
    await answer()
    const reply = await handleCommand(deps, command, '', session)
    if (reply !== undefined) await deps.sendText(session, reply)
    return true
  }

  if (payload.startsWith('p:')) {
    if (card.kind !== 'projects') return false
    const path = pick('p:', card.paths)
    if (path === undefined) {
      await answer(t('form_inactive'))
      return true
    }
    await answer()
    try {
      const sessionId = await deps.createSession(path)
      void deps.ensureThread(sessionId)
      if (messageId !== undefined) {
        await deps.rebindCard(messageId, t('projects_created', {
          id: sessionId,
          title: escapeHtml(basename(path)),
        }), { kind: 'projects', buttons: card.buttons, paths: card.paths })
      }
    } catch (error) {
      if (messageId !== undefined) {
        await deps.rebindCard(messageId, t('projects_fail', { detail: escapeHtml(safe(error).slice(0, 200)) }), card)
      }
    }
    return true
  }

  if (payload.startsWith('k:')) {
    if (card.kind !== 'skills') return false
    const name = pick('k:', card.names)
    if (name === undefined) {
      await answer(t('form_inactive'))
      return true
    }
    const skills = ctx.get('skills') as SkillsLike | undefined
    if (skills === undefined) {
      await answer(t('skills_unavailable'))
      return true
    }
    const definition = await skills.get(name, { cwd: card.cwd })
    if (definition === undefined) {
      await answer(t('form_inactive'))
      return true
    }
    await answer()
    if (messageId !== undefined) {
      await deps.rebindCard(messageId, t('skills_detail', {
        name: escapeHtml(definition.name.slice(0, 60)),
        desc: escapeHtml(definition.description.slice(0, 200)),
        when: definition.whenToUse !== undefined
          ? t('skills_when', { when: escapeHtml(definition.whenToUse.slice(0, 200)) })
          : '',
        content: escapeHtml(definition.content.slice(0, 1200)),
      }), card)
    }
    return true
  }

  if (payload.startsWith('a:')) {
    if (card.kind !== 'agents') return false
    const id = pick('a:', card.ids)
    if (id === undefined) {
      await answer(t('form_inactive'))
      return true
    }
    if (session === undefined) {
      await answer(t('msg_no_target'))
      return true
    }
    const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
    if (presets === undefined) {
      await answer(t('agents_unavailable'))
      return true
    }
    const resolved = await deps.resolveAgent(session)
    if (resolved.agent === undefined) {
      await answer(resolved.refusal ?? t('resume_none'))
      return true
    }
    try {
      await presets.select(resolved.agent, id)
      await answer()
      if (messageId !== undefined) {
        await deps.rebindCard(messageId, t('agents_selected', { name: escapeHtml(id) }), card)
      }
    } catch (error) {
      await answer(t('agents_error', { detail: safe(error).slice(0, 160) }), true)
    }
    return true
  }

  if (payload.startsWith('x:')) {
    if (card.kind !== 'perms') return false
    const value = pick('x:', card.values)
    if (value === undefined) {
      await answer(t('form_inactive'))
      return true
    }
    if (session === undefined) {
      await answer(t('msg_no_target'))
      return true
    }
    const presets = ctx.get('permissionPresets') as PermissionPresetsLike | undefined
    if (presets === undefined) {
      await answer(t('perms_unavailable'))
      return true
    }
    const resolved = await deps.resolveAgent(session)
    if (resolved.agent === undefined) {
      await answer(resolved.refusal ?? t('resume_none'))
      return true
    }
    try {
      presets.set(resolved.agent.session, value)
      await answer()
      if (messageId !== undefined) {
        await deps.rebindCard(messageId, t('perms_done', { name: escapeHtml(value) }), card)
      }
    } catch (error) {
      await answer(t('perms_error', { detail: safe(error).slice(0, 160) }), true)
    }
    return true
  }

  if (payload.startsWith('r:')) {
    if (card.kind !== 'commands') return false
    const line = pick('r:', card.lines)
    if (line === undefined) {
      await answer(t('form_inactive'))
      return true
    }
    if (session === undefined) {
      await answer(t('msg_no_target'))
      return true
    }
    const commands = ctx.get('commands') as CommandsLike | undefined
    if (commands === undefined) {
      await answer(t('commands_unavailable'))
      return true
    }
    const resolved = await deps.resolveAgent(session)
    if (resolved.agent === undefined) {
      await answer(resolved.refusal ?? t('resume_none'))
      return true
    }
    try {
      const execution = await commands.execute(resolved.agent, line, [], AbortSignal.timeout(180_000))
      const output = execution?.result.text ?? ''
      const text = execution === undefined
        ? t('commands_not_found_plain')
        : execution.result.kind === 'error'
          ? t('commands_error', { text: escapeHtml(output.slice(0, 500)) })
          : output.length > 0
            ? t('commands_ok', { text: escapeHtml(output.slice(0, 1500)) })
            : t('commands_ok_plain')
      await answer()
      if (messageId !== undefined) await deps.rebindCard(messageId, text, card)
    } catch (error) {
      await answer(t('commands_error', { text: safe(error).slice(0, 200) }), true)
    }
    return true
  }

  if (payload.startsWith('f:')) {
    if (card.kind !== 'files') return false
    const index = Number(payload.slice(2))
    if (!Number.isInteger(index) || index < 0 || index >= card.entries.length) {
      await answer(t('form_inactive'))
      return true
    }
    const entry = card.entries[index]
    if (entry === undefined) return true
    const fs = ctx.get('fs') as FileSystemLike | undefined
    if (fs === undefined) {
      await answer(t('files_unavailable'))
      return true
    }
    if (entry.type === 'directory') {
      try {
        const rendered = await renderFileBrowser(fs, entry.target)
        await answer()
        if (messageId !== undefined) await deps.rebindCard(messageId, rendered.text, rendered.payload)
      } catch (error) {
        await answer(t('files_fail', { detail: safe(error).slice(0, 120) }), true)
      }
      return true
    }
    if (entry.size !== undefined && entry.size > FILE_DOWNLOAD_CAP) {
      await answer(t('files_too_big', { kb: Math.round(entry.size / 1024) }), true)
      return true
    }
    try {
      const content = await fs.readText(entry.target)
      const safeName = entry.name.replace(/[^\w.-]+/g, '_').slice(0, 60)
      const path = join(tmpdir(), `tg-file-${Date.now()}-${safeName}`)
      writeFileSync(path, content, 'utf-8')
      const thread = session !== undefined ? state.threadOf(session) : undefined
      await deps.telegram.sendDocument(deps.chatId, path, {
        ...(thread === undefined ? {} : { messageThreadId: thread }),
      })
      await answer(t('files_sent', { name: entry.name.slice(0, 60) }))
    } catch (error) {
      await answer(t('files_fail', { detail: safe(error).slice(0, 160) }), true)
    }
    return true
  }

  return false
}

// ── tasks and the /newtask wizard ────────────────────────────────────────────

type WizardStep = 'name' | 'prompt' | 'type' | 'detail' | 'confirm'

interface Wizard {
  step: WizardStep
  name: string
  prompt: string
  type?: 'once' | 'daily' | 'weekly' | 'minutes'
  detail?: string
}

const wizards = new Map<string, Wizard>()

async function listTasks(deps: CommandDeps, sessionId: string): Promise<string> {
  const resolved = await deps.resolveAgent(sessionId)
  if (resolved.agent === undefined) return resolved.refusal ?? t('history_none')
  const agent = resolved.agent
  const schedule = await importSchedule()
  if (schedule === undefined) return t('tasks_unavailable')
  await deps.ctx.sessions.flush(agent.session)
  const folded = schedule.foldScheduleEvents(agent.session.snapshotEvents())
  if (folded.active.length === 0) return t('tasks_none')
  const lines = folded.active.map((record) => {
    const view = schedule.scheduleView(record, Date.now())
    const next = (view as { nextAt?: string }).nextAt
    const suffix = next !== undefined && next !== null ? t('task_next', { when: next }) : ''
    return `${t('task_entry', { prompt: escapeHtml(record.prompt.slice(0, 80)) })}${suffix}`
  })
  return `${t('tasks_header', { n: folded.active.length })}${lines.join('')} `
}

type ScheduleModule = typeof import('@deepseek-ai/dsh-schedule')

async function importSchedule(): Promise<ScheduleModule | undefined> {
  try {
    return (await import('@deepseek-ai/dsh-schedule')) as ScheduleModule
  } catch {
    // The profile does not compose the Schedule subsystem; say so honestly.
    return undefined
  }
}

function startWizard(sessionId: string, args: string): string {
  if (args === 'cancelar' || args === 'cancel') return t('newtask_cancelled')
  if (wizards.has(sessionId)) return t('newtask_taken')
  const wizard: Wizard = { step: 'name', name: '', prompt: '' }
  wizards.set(sessionId, wizard)
  return t('newtask_name')
}

const CANCEL = ['cancelar', 'cancel', '/newtask cancelar', '/newtask cancel']
const YES = ['sí', 'si', 'yes', '/newtask sí', '/newtask si', '/newtask yes', '1', 'y']

/**
 * Feed one plain message into the wizard running for a session.
 * @returns the wizard's reply when the message was consumed, or undefined
 *   when no wizard is running there.
 */
export async function feedWizard(deps: CommandDeps, sessionId: string, text: string): Promise<string | undefined> {
  const wizard = wizards.get(sessionId)
  if (wizard === undefined) return undefined
  const trimmed = text.trim()
  if (CANCEL.includes(trimmed.toLowerCase())) {
    wizards.delete(sessionId)
    return t('newtask_cancelled')
  }
  switch (wizard.step) {
    case 'name':
      wizard.name = trimmed.slice(0, 60)
      wizard.step = 'prompt'
      return t('newtask_prompt')
    case 'prompt':
      wizard.prompt = trimmed
      wizard.step = 'type'
      return `${t('newtask_type')}${t('newtask_types')}`
    case 'type': {
      const index = Number(trimmed)
      const types = ['once', 'daily', 'weekly', 'minutes'] as const
      if (!Number.isInteger(index) || index < 1 || index > types.length) return t('newtask_bad')
      const picked = types[index - 1]
      if (picked === undefined) return t('newtask_bad')
      wizard.type = picked
      wizard.step = 'detail'
      if (wizard.type === 'once') return t('newtask_detail_once')
      if (wizard.type === 'daily') return t('newtask_detail_daily')
      if (wizard.type === 'weekly') return t('newtask_detail_weekly')
      return t('newtask_detail_minutes')
    }
    case 'detail': {
      wizard.detail = trimmed
      wizard.step = 'confirm'
      return t('newtask_confirm', { summary: escapeHtml(wizardSummary(wizard)) })
    }
    case 'confirm': {
      if (!YES.includes(trimmed.toLowerCase())) return t('newtask_bad')
      wizards.delete(sessionId)
      return createReminder(deps, sessionId, wizard)
    }
  }
  return undefined
}

function wizardSummary(wizard: Wizard): string {
  const detail = wizard.detail ?? ''
  if (wizard.type === 'once') return `${wizard.prompt}\n${t('sched_once', { at: detail })}`
  if (wizard.type === 'daily') return `${wizard.prompt}\n${t('sched_daily', { time: detail })}`
  if (wizard.type === 'weekly') {
    return `${wizard.prompt}\n${t('sched_weekly', { weekday: detail.split(' ')[0] ?? '?', time: detail.split(' ')[1] ?? '?' })}`
  }
  return `${wizard.prompt}\n${t('sched_mins', { n: Number(detail) || 0 })}`
}

/**
 * Append the wizard's record the way the model-facing schedule tool does:
 * flush, fold, allocate, validate through the schedule domain, append the
 * durable `schedule/change` create, flush again.
 */
async function createReminder(deps: CommandDeps, sessionId: string, wizard: Wizard): Promise<string> {
  const resolved = await deps.resolveAgent(sessionId)
  if (resolved.agent === undefined) return resolved.refusal ?? t('history_none')
  const agent = resolved.agent
  const schedule = await importSchedule()
  if (schedule === undefined) return t('tasks_unavailable')
  try {
    await deps.ctx.sessions.flush(agent.session)
    const folded = schedule.foldScheduleEvents(agent.session.snapshotEvents())
    const id = schedule.allocateScheduleId(folded)
    const now = Date.now()
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const detail = wizard.detail ?? ''
    let record
    if (wizard.type === 'minutes') {
      const minutes = Math.round(Number(detail))
      if (!Number.isFinite(minutes) || minutes < 1) return t('newtask_bad')
      record = schedule.createEveryScheduleRecord(id, `${wizard.name}: ${wizard.prompt}`, minutes * 60, now)
    } else {
      const once = splitOnceDetail(detail)
      if (once === undefined) return t('newtask_bad')
      record = schedule.createAtScheduleRecord(id, `${wizard.name}: ${wizard.prompt}`, { date: once.date, time: once.time, time_zone: timeZone }, now)
    }
    agent.session.append('schedule/change', {
      version: 1,
      operation: 'create',
      schedule: record,
    })
    await deps.ctx.sessions.flush(agent.session)
    return t('task_created', { summary: escapeHtml(wizardSummary(wizard)) })
  } catch (error) {
    return t('task_fail', { detail: escapeHtml(safe(error)) })
  }
}

/** `2026-12-01 09:00` / `01/12 09:00` / `lun 09:00` → the pair the record wants. */
function splitOnceDetail(detail: string): { date: string, time: string } | undefined {
  const iso = /^(\d{4}-\d{2}-\d{2})[ t](\d{1,2}:\d{2})$/.exec(detail.trim())
  if (iso !== null) return { date: iso[1] ?? '', time: iso[2] ?? '' }
  const regional = /^(\d{1,2})\/(\d{1,2})[ t](\d{1,2}):(\d{2})$/.exec(detail.trim())
  if (regional !== null) {
    // Day/month, the order the region writes: "01/12" is December 1st.
    const now = new Date()
    const candidate = new Date(now.getFullYear(), Number(regional[2]) - 1, Number(regional[1]))
    if (candidate.getTime() < now.getTime()) candidate.setFullYear(candidate.getFullYear() + 1)
    const p2 = (n: number): string => String(n).padStart(2, '0')
    return {
      date: `${candidate.getFullYear()}-${p2(Number(regional[2]))}-${p2(Number(regional[1]))}`,
      time: `${(regional[3] ?? '').padStart(2, '0')}:${regional[4]}`,
    }
  }
  const weekly = /^([a-záé]{2,9})\s+(\d{1,2}:\d{2})$/.exec(detail.trim().toLowerCase())
  if (weekly !== null) {
    // The next occurrence of that weekday.
    const days = t('days_short').split(',')
    const target = days.indexOf(weekly[1] ?? '')
    if (target >= 0) {
      const date = new Date()
      const parts = (weekly[2] ?? '0:0').split(':')
      date.setHours(Number(parts[0]), Number(parts[1]), 0, 0)
      let add = (target - date.getDay() + 7) % 7
      if (add === 0 && date.getTime() <= Date.now()) add = 7
      date.setDate(date.getDate() + add)
      const p2 = (n: number): string => String(n).padStart(2, '0')
      return { date: `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`, time: weekly[2] ?? '' }
    }
  }
  return undefined
}
