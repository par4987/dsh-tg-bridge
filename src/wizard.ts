/**
 * The reminder domain: listing, the `/newtask` wizard, and record creation,
 * all over the harness's Schedule seam. The module stays free of harness
 * runtime imports — the schedule package loads lazily at confirm time — so
 * the test suite can drive a whole wizard conversation, restart included.
 */
import type { CommandDeps } from './commands.ts'
import type { WizardDraft } from './state.ts'
import { escapeHtml } from './render.ts'
import { t } from './locale.ts'
import { safe } from './log.ts'

/**
 * The record a `/taskcancel` argument addresses: the id itself, an id prefix,
 * or a substring of its prompt; with no argument, the last created one.
 */
export function matchScheduleRecord<T extends { id: string, prompt: string }>(
  active: ReadonlyArray<T>,
  query: string,
): T | undefined {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return active[active.length - 1]
  return active.find((record) =>
    record.id.toLowerCase() === needle
    || record.id.toLowerCase().startsWith(needle)
    || record.prompt.toLowerCase().includes(needle))
}

/** One reminder record as the bridge reads it: host storage or a legacy session event. */
interface ScheduleRecordLike {
  readonly id: string
  readonly title?: string
  readonly prompt: string
  readonly scheduledAt: string
}

/**
 * The Host schedule service: durable task storage that never activates the
 * session to read or delete. Structural face of `ctx.schedule`; absent when
 * the profile composes no schedule subsystem.
 */
interface ScheduleServiceLike {
  create(sessionId: string, request: {
    prompt: string
    title: string
    after_seconds?: number
    at?: { date: string, time: string, time_zone: string }
    every_seconds?: number
    daily?: { time: string, time_zone: string }
    weekly?: { time: string, time_zone: string, weekdays: number[] }
  }, signal?: AbortSignal): Promise<ScheduleRecordLike>
  list(request: { sessionId: string }): Promise<ReadonlyArray<ScheduleRecordLike>>
  delete(request: { sessionId: string, id: string }): Promise<{ deleted: boolean }>
}

function scheduleService(ctx: CommandDeps['ctx']): ScheduleServiceLike | undefined {
  return ctx.get('schedule') as ScheduleServiceLike | undefined
}

type ScheduleModule = typeof import('@deepseek-ai/dsh-schedule')

/** The legacy session-log Schedule domain, or undefined when this profile composes none. */
export async function importSchedule(): Promise<ScheduleModule | undefined> {
  try {
    return (await import('@deepseek-ai/dsh-schedule')) as ScheduleModule
  } catch {
    // The profile does not compose the Schedule subsystem; say so honestly.
    return undefined
  }
}

/** One task row for `/tasks`: the stored title when present, then the next target. */
function taskLine(record: ScheduleRecordLike): string {
  const label = (record.title ?? '').length > 0 ? `${record.title ?? ''}: ` : ''
  return `${t('task_entry', { prompt: escapeHtml(`${label}${record.prompt}`.slice(0, 80)) })}${t('task_next', { when: record.scheduledAt })}`
}

/**
 * `/tasks`: the Host's stored records for the session, then the legacy
 * session-log records this bridge (or the old model tool) appended before the
 * Host service existed — deduplicated by id, in case the Host adopted them.
 */
export async function listTasks(deps: CommandDeps, sessionId: string): Promise<string> {
  const host = scheduleService(deps.ctx)
  const lines: string[] = []
  const hostIds = new Set<string>()
  if (host !== undefined) {
    try {
      for (const record of await host.list({ sessionId })) {
        hostIds.add(record.id)
        lines.push(taskLine(record))
      }
    } catch (error) {
      return t('task_fail', { detail: escapeHtml(safe(error).slice(0, 160)) })
    }
  }
  const schedule = await importSchedule()
  if (schedule !== undefined) {
    const resolved = await deps.resolveAgent(sessionId)
    if (resolved.agent !== undefined) {
      await deps.ctx.sessions.flush(resolved.agent.session)
      const folded = schedule.foldScheduleEvents(resolved.agent.session.snapshotEvents())
      for (const record of folded.active) {
        if (hostIds.has(record.id)) continue
        lines.push(taskLine(record))
      }
    }
  }
  if (lines.length === 0) {
    return host === undefined && schedule === undefined ? t('tasks_unavailable') : t('tasks_none')
  }
  return `${t('tasks_header', { n: lines.length })}${lines.join('')} `
}

/**
 * `/taskcancel`: delete one reminder by id, id prefix, prompt substring, or
 * (with no argument) the last one — host storage first, legacy session-log
 * records behind it.
 */
export async function cancelTask(deps: CommandDeps, sessionId: string, query: string): Promise<string> {
  const host = scheduleService(deps.ctx)
  if (host !== undefined) {
    try {
      const records = await host.list({ sessionId })
      const record = matchScheduleRecord(records, query)
      if (record !== undefined) {
        await host.delete({ sessionId, id: record.id })
        return t('task_deleted')
      }
    } catch (error) {
      return t('task_fail', { detail: escapeHtml(safe(error).slice(0, 160)) })
    }
  }
  const schedule = await importSchedule()
  if (schedule !== undefined) {
    const resolved = await deps.resolveAgent(sessionId)
    if (resolved.agent !== undefined) {
      await deps.ctx.sessions.flush(resolved.agent.session)
      const folded = schedule.foldScheduleEvents(resolved.agent.session.snapshotEvents())
      const record = matchScheduleRecord(folded.active, query)
      if (record !== undefined) {
        resolved.agent.session.append('schedule/change', {
          version: 1,
          operation: 'delete',
          id: record.id,
        })
        await deps.ctx.sessions.flush(resolved.agent.session)
        return t('task_deleted')
      }
    }
  }
  if (host === undefined && schedule === undefined) return t('tasks_unavailable')
  return t('taskcancel_none', { query: escapeHtml(query) })
}

/**
 * Start the reminder wizard; the draft persists, so a profile restart resumes
 * it instead of silently dropping the half-answered conversation.
 */
export function startWizard(deps: CommandDeps, sessionId: string, args: string): string {
  if (args === 'cancelar' || args === 'cancel') {
    deps.state.setWizard(sessionId, undefined)
    return t('newtask_cancelled')
  }
  if (deps.state.wizardOf(sessionId) !== undefined) return t('newtask_taken')
  deps.state.setWizard(sessionId, { step: 'name', name: '', prompt: '' })
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
  const wizard = deps.state.wizardOf(sessionId)
  if (wizard === undefined) return undefined
  const trimmed = text.trim()
  if (CANCEL.includes(trimmed.toLowerCase())) {
    deps.state.setWizard(sessionId, undefined)
    return t('newtask_cancelled')
  }
  switch (wizard.step) {
    case 'name':
      wizard.name = trimmed.slice(0, 60)
      wizard.step = 'prompt'
      deps.state.setWizard(sessionId, wizard)
      return t('newtask_prompt')
    case 'prompt':
      wizard.prompt = trimmed
      wizard.step = 'type'
      deps.state.setWizard(sessionId, wizard)
      return `${t('newtask_type')}${t('newtask_types')}`
    case 'type': {
      const index = Number(trimmed)
      const types = ['once', 'daily', 'weekly', 'minutes'] as const
      if (!Number.isInteger(index) || index < 1 || index > types.length) return t('newtask_bad')
      const picked = types[index - 1]
      if (picked === undefined) return t('newtask_bad')
      wizard.type = picked
      wizard.step = 'detail'
      deps.state.setWizard(sessionId, wizard)
      if (wizard.type === 'once') return t('newtask_detail_once')
      if (wizard.type === 'daily') return t('newtask_detail_daily')
      if (wizard.type === 'weekly') return t('newtask_detail_weekly')
      return t('newtask_detail_minutes')
    }
    case 'detail': {
      wizard.detail = trimmed
      wizard.step = 'confirm'
      deps.state.setWizard(sessionId, wizard)
      return t('newtask_confirm', { summary: escapeHtml(wizardSummary(wizard)) })
    }
    case 'confirm': {
      if (!YES.includes(trimmed.toLowerCase())) return t('newtask_bad')
      deps.state.setWizard(sessionId, undefined)
      return createReminder(deps, sessionId, wizard)
    }
  }
  return undefined
}

function wizardSummary(wizard: WizardDraft): string {
  const detail = wizard.detail ?? ''
  if (wizard.type === 'once') return `${wizard.prompt}\n${t('sched_once', { at: detail })}`
  if (wizard.type === 'daily') return `${wizard.prompt}\n${t('sched_daily', { time: detail })}`
  if (wizard.type === 'weekly') {
    return `${wizard.prompt}\n${t('sched_weekly', { weekday: detail.split(' ')[0] ?? '?', time: detail.split(' ')[1] ?? '?' })}`
  }
  return `${wizard.prompt}\n${t('sched_mins', { n: Number(detail) || 0 })}`
}

/**
 * Create the wizard's record through the Host schedule service — the same
 * durable task storage the model-facing tool writes — without waking the
 * session's Agent.
 */
async function createReminder(deps: CommandDeps, sessionId: string, wizard: WizardDraft): Promise<string> {
  const schedule = scheduleService(deps.ctx)
  if (schedule === undefined) return t('tasks_unavailable')
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const detail = wizard.detail ?? ''
  try {
    let request: Parameters<ScheduleServiceLike['create']>[1]
    if (wizard.type === 'minutes') {
      const minutes = Math.round(Number(detail))
      if (!Number.isFinite(minutes) || minutes < 1) return t('newtask_bad')
      request = { prompt: wizard.prompt, title: wizard.name, every_seconds: minutes * 60 }
    } else if (wizard.type === 'daily') {
      if (!/^\d{1,2}:\d{2}$/.test(detail.trim())) return t('newtask_bad')
      request = { prompt: wizard.prompt, title: wizard.name, daily: { time: detail.trim(), time_zone: timeZone } }
    } else if (wizard.type === 'weekly') {
      const parsed = splitWeeklyDetail(detail)
      if (parsed === undefined) return t('newtask_bad')
      request = {
        prompt: wizard.prompt,
        title: wizard.name,
        weekly: { time: parsed.time, weekdays: [parsed.weekday], time_zone: timeZone },
      }
    } else {
      const once = splitOnceDetail(detail)
      if (once === undefined) return t('newtask_bad')
      request = { prompt: wizard.prompt, title: wizard.name, at: { date: once.date, time: once.time, time_zone: timeZone } }
    }
    await schedule.create(sessionId, request)
    return t('task_created', { summary: escapeHtml(wizardSummary(wizard)) })
  } catch (error) {
    return t('task_fail', { detail: escapeHtml(safe(error)) })
  }
}

/** `lun 09:00` → the ISO weekday (Monday 1 through Sunday 7) and the time the record wants. */
export function splitWeeklyDetail(detail: string): { weekday: number, time: string } | undefined {
  const match = /^([a-záé]{2,9})\s+(\d{1,2}:\d{2})$/.exec(detail.trim().toLowerCase())
  if (match === null) return undefined
  const days = t('days_short').split(',')
  const index = days.indexOf(match[1] ?? '')
  if (index < 0) return undefined
  return { weekday: index === 0 ? 7 : index, time: match[2] ?? '' }
}

/** `2026-12-01 09:00` / `01/12 09:00` / `lun 09:00` → the pair the record wants. */
export function splitOnceDetail(detail: string): { date: string, time: string } | undefined {
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
