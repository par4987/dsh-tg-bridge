/**
 * Speech-to-text for Telegram voice notes — provider-based, opt-in.
 *
 * Every deployment picks its own trade-off in configuration:
 *
 *   `stt: { provider: 'local' }`
 *     whisper.cpp on the same machine (no cloud, no keys). Binaries under
 *     `<stateDir>/stt` (`Release/whisper-cli` + `models/ggml-small.bin`),
 *     paths configurable. Telegram voices are OGG/Opus and this whisper
 *     build does not decode them, so ffmpeg decodes to 16 kHz mono WAV first.
 *
 *   `stt: { provider: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' }`
 *     Any server speaking OpenAI's `/audio/transcriptions` dialect: Groq,
 *     OpenAI itself, or a self-hosted one. The key lives in the environment
 *     variable `stt.apiKeyEnv` names — never in a configuration file.
 *
 * No provider at all: the voice handler points at the manual instead of
 * transcribing — the feature is opt-in by construction.
 *
 * Pure stdlib: child_process for the local binary, fetch for the cloud.
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SttConfig } from './config.ts'

/** Where the local binaries are dropped by the setup — the default paths. */
export function sttDefaults(stateDir: string): { whisper: string, model: string } {
  const root = join(stateDir, 'stt')
  const binary = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  return { whisper: join(root, 'Release', binary), model: join(root, 'models', 'ggml-small.bin') }
}

/**
 * True when the chosen provider is ready. No provider given: the local
 * binaries decide — an existing whisper.cpp install keeps working without
 * touching configuration.
 */
export function sttAvailable(cfg: SttConfig, stateDir: string): boolean {
  if (cfg.provider === 'openai-compatible') {
    return typeof cfg.baseUrl === 'string' && cfg.baseUrl.length > 0 && resolveApiKey(cfg).length > 0
  }
  const defaults = sttDefaults(stateDir)
  return existsSync(cfg.whisper ?? defaults.whisper) && existsSync(cfg.model ?? defaults.model)
}

/** The cloud key, from the environment variable `apiKeyEnv` names. */
export function resolveApiKey(cfg: SttConfig): string {
  const name = cfg.apiKeyEnv ?? 'STT_API_KEY'
  return (process.env[name] ?? '').trim()
}

/**
 * Clean whisper-cli's stdout: with `-nt` it prints the plain transcription,
 * one segment per line — joined here into one flowing paragraph.
 */
export function parseTranscription(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .trim()
}

/** Cloud replies are `{"text": "..."}` — anything else reads as empty. */
export function parseCloudResponse(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text.trim() : ''
  } catch {
    return ''
  }
}

function timeoutMessage(seconds: number): string {
  return `transcription timed out after ${seconds}s`
}

/** Spawn a binary and collect its output, with a hard timeout. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(timeoutMessage(Math.round(timeoutMs / 1000))))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function transcribeLocal(oggPath: string, cfg: SttConfig, stateDir: string, timeoutMs: number): Promise<string> {
  const defaults = sttDefaults(stateDir)
  const whisper = cfg.whisper ?? defaults.whisper
  const model = cfg.model ?? defaults.model
  if (!existsSync(whisper)) throw new Error(`whisper-cli not found at ${whisper}`)
  if (!existsSync(model)) throw new Error(`ggml model not found at ${model}`)
  // whisper.cpp's bundled miniaudio does not read Telegram's OGG/Opus on this
  // build — ffmpeg (system PATH or stt.ffmpeg) decodes to 16 kHz mono WAV
  // first. A WAV input skips the step.
  let audioPath = oggPath
  if (!oggPath.toLowerCase().endsWith('.wav')) {
    const ffmpeg = cfg.ffmpeg ?? 'ffmpeg'
    const wavPath = `${oggPath.replace(/\.[^.]+$/, '')}-${Date.now()}.wav`
    const conv = await run(ffmpeg, ['-y', '-i', oggPath, '-ar', '16000', '-ac', '1', wavPath], Math.min(timeoutMs, 120_000))
    if (conv.code !== 0 || !existsSync(wavPath)) {
      throw new Error(`ffmpeg failed: ${conv.stderr.slice(0, 200)}`)
    }
    audioPath = wavPath
  }
  const language = cfg.language !== undefined && cfg.language.length > 0 ? cfg.language : 'es'
  try {
    const { code, stdout, stderr } = await run(whisper, ['-m', model, '-f', audioPath, '-l', language, '-nt'], timeoutMs)
    if (code !== 0) throw new Error(`whisper-cli exit ${code}: ${stderr.slice(0, 300)}`)
    return parseTranscription(stdout)
  } finally {
    // The temporary WAV never outlives the transcription.
    if (audioPath !== oggPath) rmSync(audioPath, { force: true })
  }
}

/**
 * Any `/audio/transcriptions` dialect: multipart with file+model+language and
 * a Bearer key, resolving `{"text": "..."}`. Built with plain fetch.
 */
async function transcribeCloud(oggPath: string, cfg: SttConfig, timeoutMs: number): Promise<string> {
  if (cfg.baseUrl === undefined || cfg.baseUrl.length === 0) throw new Error('stt.baseUrl is not configured')
  const apiKey = resolveApiKey(cfg)
  if (apiKey.length === 0) throw new Error(`the ${cfg.apiKeyEnv ?? 'STT_API_KEY'} environment variable is not set`)
  if (cfg.model === undefined || cfg.model.length === 0) throw new Error('stt.model is not configured')
  const { readFile } = await import('node:fs/promises')
  const buffer = await readFile(oggPath)
  const boundary = `----dsh-tg-bridge-${Date.now()}`
  const parts: Buffer[] = []
  const push = (name: string, value: string): void => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  push('model', cfg.model)
  const language = cfg.language !== undefined && cfg.language.length > 0 ? cfg.language : 'es'
  push('language', language)
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voz.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`),
  )
  parts.push(buffer, Buffer.from(`\r\n--${boundary}--\r\n`))
  const response = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(parts),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`)
  }
  return parseCloudResponse(await response.text())
}

/**
 * Transcribe one voice note (OGG/Opus path) to text with the configured
 * provider. Resolves `''` when the audio carries no speech. Throws when the
 * provider is not ready — the caller says so plainly.
 */
export async function transcribeFile(oggPath: string, cfg: SttConfig, stateDir: string, timeoutMs = 300_000): Promise<string> {
  if (cfg.provider === 'openai-compatible') return transcribeCloud(oggPath, cfg, timeoutMs)
  // 'local', or no provider given: the local binaries decide.
  return transcribeLocal(oggPath, cfg, stateDir, timeoutMs)
}
