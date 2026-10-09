/**
 * Logging helpers shared by every module.
 *
 * The bridge logs through the host's Cordis logger (`ctx.logger`), which the
 * plugin entry adapts into the `LogFn` these modules take as a parameter —
 * modules stay pure and testable, and nothing writes to stdout on its own.
 */

/** Severity levels the bridge reports. */
export type Level = 'info' | 'warn' | 'error'

/** The logging surface modules receive; `detail` is rendered best-effort. */
export type LogFn = (level: Level, message: string, detail?: unknown) => void

/** Render any thrown value as one stable line, without dumping payloads. */
export function safe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
