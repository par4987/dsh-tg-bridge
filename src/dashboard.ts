/**
 * The dashboard: one anchored message per session thread that `/dashboard`
 * pins and the bridge keeps current as the session's facts change.
 *
 * The pins live in `dashboard.json` under the state directory (session id →
 * message id), so a restart still knows which message to edit. The rendered
 * text is a pure function of the facts the bridge already tracks — the
 * session state's usage, the title, and the live status — built by
 * {@link renderDashboard} and diffed before each edit so a quiet session
 * never burns an edit.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { escapeHtml } from './render.ts'
import { t } from './locale.ts'

/** One pinned dashboard message. */
export interface DashboardPin {
  /** The Telegram message carrying the panel. */
  messageId: number
  /** When the panel was pinned, in epoch milliseconds. */
  pinnedAt: number
  /** The last text the panel was edited to; unchanged text skips the edit. */
  lastText?: string
}

interface StoredDashboards {
  /** sessionId -> pin. */
  dashboards?: Record<string, DashboardPin>
}

/** Facts one panel renders from. */
export interface DashboardFacts {
  /** The session's known title, when one was learned. */
  title?: string
  /** Whether a turn is running in this process right now. */
  running: boolean
  /** The current route, when an in-process agent exposes it. */
  route?: string
  /** Accumulated token usage, when any assistant message committed one. */
  usage?: { inputTokens: number, outputTokens: number, totalTokens: number }
  /** Last-turn token usage, when one was committed. */
  lastUsage?: { inputTokens: number, outputTokens: number, totalTokens: number }
}

export class DashboardStore {
  constructor(
    private readonly file: string,
    private readonly onWarn: (message: string, detail?: unknown) => void = () => {},
  ) {}

  private read(): Record<string, DashboardPin> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as StoredDashboards
      const dashboards = parsed?.dashboards
      if (dashboards === null || typeof dashboards !== 'object') return {}
      return Object.entries(dashboards)
        .filter(([, pin]) => pin !== null && typeof pin === 'object')
        .reduce<Record<string, DashboardPin>>((acc, [id, pin]) => {
          acc[id] = pin as DashboardPin
          return acc
        }, {})
    } catch {
      /* first run or a corrupt file — start empty */
    }
    return {}
  }

  private write(dashboards: Record<string, DashboardPin>): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ dashboards }, null, 2), 'utf-8')
    } catch (error) {
      this.onWarn('dashboards: persist failed', error)
    }
  }

  /** The pin of one session, when it has a panel. */
  of(sessionId: string): DashboardPin | undefined {
    return this.read()[sessionId]
  }

  /** Pin (or re-pin) one session's panel. */
  set(sessionId: string, messageId: number): void {
    const dashboards = this.read()
    dashboards[sessionId] = { messageId, pinnedAt: Date.now() }
    this.write(dashboards)
  }

  /** Remember the text the panel was last edited to. */
  rememberText(sessionId: string, text: string): void {
    const dashboards = this.read()
    const pin = dashboards[sessionId]
    if (pin === undefined) return
    pin.lastText = text
    this.write(dashboards)
  }

  /** Forget one pin; silent when there is none. */
  remove(sessionId: string): void {
    const dashboards = this.read()
    if (dashboards[sessionId] === undefined) return
    delete dashboards[sessionId]
    this.write(dashboards)
  }
}

/** The panel's text for one set of facts. Pure: no Telegram, no state. */
export function renderDashboard(facts: DashboardFacts): string {
  const title = facts.title ?? t('no_title')
  const lines = [`${facts.running ? '🔴' : '⚪'} <b>${escapeHtml(title)}</b>`]
  lines.push(facts.running ? t('dashboard_running') : t('dashboard_idle'))
  if (facts.route !== undefined) lines.push(t('dashboard_route', { route: escapeHtml(facts.route) }))
  if (facts.lastUsage !== undefined) {
    lines.push(t('dashboard_last', {
      in: facts.lastUsage.inputTokens,
      out: facts.lastUsage.outputTokens,
      total: facts.lastUsage.totalTokens,
    }))
  }
  if (facts.usage !== undefined) {
    lines.push(t('dashboard_total', {
      in: facts.usage.inputTokens,
      out: facts.usage.outputTokens,
      total: facts.usage.totalTokens,
    }))
  }
  return lines.join('\n')
}
