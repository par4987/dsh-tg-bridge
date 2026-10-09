/**
 * Plugin configuration: the Schemastery schema Cordis validates at load and
 * the resolved options the bridge reads.
 *
 * Every value two deployments may want different is a config field — nothing
 * tunable is hardcoded. Secrets never ride the config: the bot token
 * resolves from the `TELEGRAM_BOT_TOKEN` environment variable and the cloud
 * STT key from the variable `stt.apiKeyEnv` names.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

/** What the bridge does with Telegram: nothing, log what it would send, or run. */
export type Mode = 'off' | 'dry' | 'live'

/** Render tuning, applied by the streaming renderer. */
export interface RenderOptions {
  /** Throttle between edits of the same message. Telegram allows ~1/s. */
  editIntervalMs: number
  /** Show diff blocks for edit/write tool results. */
  showDiffs: boolean
  /** Cap on a rendered diff. */
  diffMaxLines: number
  /** Render the model's reasoning (prefixed, capped). */
  showReasoning: boolean
  /** Cap on a reasoning block. */
  reasoningChars: number
}

/** Voice-note transcription, opt-in by construction. */
export interface SttConfig {
  /** `local` (whisper.cpp) or `openai-compatible` (Groq, OpenAI, self-hosted). */
  provider?: 'local' | 'openai-compatible'
  /** local: whisper-cli binary path. */
  whisper?: string
  /** local: ggml model path — cloud: model name (`whisper-large-v3-turbo`…). */
  model?: string
  /** local: ffmpeg binary that decodes Telegram's OGG/Opus (default: from PATH). */
  ffmpeg?: string
  /** cloud: base URL, e.g. `https://api.groq.com/openai/v1`. */
  baseUrl?: string
  /**
   * cloud: name of the environment variable holding the API key — the key
   * itself never enters configuration files.
   */
  apiKeyEnv?: string
  /** Language hint for both paths. */
  language?: string
}

export interface Config {
  /**
   * `off` (the default) mounts the bundle inert, so a freshly installed row
   * in an unconfigured profile stays silent; `dry` validates the wiring and
   * logs what would be sent without touching Telegram; `live` runs the poll.
   */
  mode: Mode
  /** Telegram bot token; resolved from the environment when absent here. */
  token: string
  /** Telegram user ids allowed to talk to the bridge. Empty list refuses everyone. */
  allowedUsers: number[]
  /** Forum chat id; defaults to the first allowed user's private chat. */
  chatId?: number
  /** Directory for the bridge's own state, lock, downloads and STT binaries. */
  stateDir: string
  /** Working directory recorded for sessions created with `/new`. */
  workspace?: string
  /** `/rebuild` maps persisted sessions active within this many days. */
  rebuildDays: number
  /** Which sessions get a thread: every one, or only those already mapped. */
  mirror: 'all' | 'watched'
  /** Idle window that merges consecutive text messages into one prompt. */
  coalesceMs: number
  /** Wider burst window while the target session is busy (steering batches). */
  coalesceBusyMs: number
  /** Close a session's thread after this many idle days. 0 = never. */
  archiveAfterDays: number
  render: RenderOptions
  stt: SttConfig
  /** Interface language for the bot's own messages. */
  locale: 'es' | 'en'
  /** Telegram Bot API base URL override. */
  baseUrl?: string
  /** Long-poll timeout in seconds. */
  pollTimeout: number
  /** Log every session event type the renderer sees. */
  debugEvents: boolean
}

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['off', 'dry', 'live'] as const).default('off'),
  token: Schema.string().default(''),
  allowedUsers: Schema.array(Schema.number()).default([]),
  chatId: Schema.number(),
  stateDir: Schema.string().default(join(homedir(), '.dsh-tg-bridge')),
  workspace: Schema.string(),
  rebuildDays: Schema.number().min(1).max(365).default(7),
  mirror: Schema.union(['all', 'watched'] as const).default('all'),
  coalesceMs: Schema.number().min(200).max(10_000).default(2000),
  coalesceBusyMs: Schema.number().min(2000).max(30_000).default(8000),
  archiveAfterDays: Schema.number().min(0).default(0),
  render: Schema.object({
    editIntervalMs: Schema.number().min(200).default(1400),
    showDiffs: Schema.boolean().default(true),
    diffMaxLines: Schema.number().min(1).default(40),
    showReasoning: Schema.boolean().default(true),
    reasoningChars: Schema.number().min(100).default(1400),
  }).default({
    editIntervalMs: 1400,
    showDiffs: true,
    diffMaxLines: 40,
    showReasoning: true,
    reasoningChars: 1400,
  }),
  stt: Schema.object({
    provider: Schema.union(['local', 'openai-compatible'] as const).default('local'),
    whisper: Schema.string().default(''),
    model: Schema.string().default(''),
    ffmpeg: Schema.string().default(''),
    baseUrl: Schema.string().default(''),
    apiKeyEnv: Schema.string().default('STT_API_KEY'),
    language: Schema.string().default('es'),
  }).default({
    provider: 'local',
    whisper: '',
    model: '',
    ffmpeg: '',
    baseUrl: '',
    apiKeyEnv: 'STT_API_KEY',
    language: 'es',
  }),
  locale: Schema.union(['es', 'en'] as const).default('es'),
  baseUrl: Schema.string(),
  pollTimeout: Schema.number().min(5).max(90).default(30),
  debugEvents: Schema.boolean().default(false),
})

/**
 * Resolve the effective bot token: explicit configuration wins, then the
 * conventional environment variable.
 * @param config - validated plugin configuration.
 * @returns the token, or an empty string when none is configured.
 */
export function resolveToken(config: Pick<Config, 'token'>): string {
  const fromConfig = config.token.trim()
  if (fromConfig.length > 0) return fromConfig
  return (process.env.TELEGRAM_BOT_TOKEN ?? '').trim()
}

/**
 * Resolve the configured chat id without failing: the explicit field, then
 * the first allowed user's private chat.
 * @param config - validated plugin configuration.
 * @returns the chat id, or undefined when nothing supplies one.
 */
export function resolveChatId(config: Config): number | undefined {
  if (config.chatId !== undefined) return config.chatId
  return config.allowedUsers[0]
}

/**
 * The forum chat the bridge talks to, or a load failure.
 * @param config - validated plugin configuration.
 * @returns the configured chat id, or the first allowed user's private chat.
 * @throws when neither `chatId` nor an allowed user supplies one — the bridge
 *   has nowhere to send, which is invalid configuration, not a degraded mode.
 */
export function requireChatId(config: Config): number {
  const resolved = resolveChatId(config)
  if (resolved === undefined) {
    throw new Error('tg-bridge: no chat id — set `chatId` or at least one allowed user')
  }
  return resolved
}
