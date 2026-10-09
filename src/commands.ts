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
import { basename, isAbsolute, join, resolve } from 'node:path'
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
}

/** The session-query surface `/rebuild` and `/export` read (base mounts it). */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: string, cwd?: string, origin?: string, parentSession?: string } }>>
  readTitle(sessionId: SessionId, signal?: AbortSignal): Promise<{ title: string } | undefined>
  readSession(sessionId: SessionId, signal?: AbortSignal): Promise<{ events: ReadonlyArray<unknown> }>
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
