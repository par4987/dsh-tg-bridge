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

type ScheduleModule = typeof import('@deepseek-ai/dsh-schedule')

/** The Schedule domain module, or undefined when this profile composes none. */
export async function importSchedule(): Promise<ScheduleModule | undefined> {
  try {
    return (await import('@deepseek-ai/dsh-schedule')) as ScheduleModule
  } catch {
    // The profile does not compose the Schedule subsystem; say so honestly.
    return undefined
  }
}

/** `/tasks`: the session's active records with their next-run moments. */
export async function listTasks(deps: CommandDeps, sessionId: string): Promise<string> {
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
 * Append the wizard's record the way the model-facing schedule tool does:
 * flush, fold, allocate, validate through the schedule domain, append the
 * durable `schedule/change` create, flush again.
 */
async function createReminder(deps: CommandDeps, sessionId: string, wizard: WizardDraft): Promise<string> {
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
