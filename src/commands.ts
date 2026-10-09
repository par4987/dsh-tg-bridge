/**
 * The Telegram command surface: everything a message starting with `/` can
 * do, resolved against the harness services the bridge already holds.
 *
 * Commands act on the session the writing thread belongs to, or on the chat
 * root's target session — the same routing a plain prompt takes.
 */
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Telegram } from './telegram.ts'
import type { BridgeState } from './state.ts'
import type { Config } from './config.ts'
import { escapeHtml, shortPath } from './render.ts'
import { setLocale, t } from './locale.ts'
import { safe } from './log.ts'

/** Resolution of a session lookup: its live agent, or why it is unavailable. */
export interface ResolvedAgent {
  agent?: Agent
  /** Localized reason the session cannot be driven (foreign profile, nothing found). */
  refusal?: string
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
 *   needs no answer.
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
        const providers = ctx.llm.listProviders()
        const lines: string[] = [t('models_header')]
        for (const provider of providers) {
          const models = await ctx.llm.listModels(provider.id)
          for (const model of models) {
            lines.push(t('models_route', { provider: escapeHtml(provider.id), model: escapeHtml(model.id) }))
          }
        }
        const resolved = targetSession !== undefined ? await deps.resolveAgent(targetSession) : undefined
        const header = resolved?.agent?.session.requestHeader()
        if (header !== undefined) {
          lines.push(t('models_current', {
            provider: escapeHtml(header.config.provider),
            model: escapeHtml(header.config.model),
          }))
        }
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

    case 'archive': {
      const id = args.trim().length > 0 ? state.sessionByPrefix(args.trim()) : targetSession
      if (id === undefined) return t('archive_usage')
      const thread = state.threadOf(id)
      state.setArchived(id, true)
      if (thread !== undefined && thread > 0) {
        await deps.telegram.closeForumTopic(deps.chatId, thread)
      }
      return t('archive_done')
    }

    case 'unarchive': {
      const id = args.trim().length > 0 ? state.sessionByPrefix(args.trim()) : targetSession
      if (id === undefined) return t('archive_usage')
      state.setArchived(id, false)
      const thread = state.threadOf(id)
      if (thread !== undefined && thread > 0) {
        const reopened = await deps.telegram.reopenForumTopic(deps.chatId, thread).catch(() => false)
        return reopened ? t('unarchive_done') : t('unarchive_recreated')
      }
      void deps.ensureThread(id)
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
