/**
 * Inbound file ingestion — what a Telegram document becomes when it reaches
 * the agent. Text-like files ride inside the prompt (a blob of code or
 * config is more useful inline than as an attachment); binaries land on disk
 * under the bridge's downloads directory with their path in the prompt, so
 * the agent opens them with its own file tools. Pure and file-bound, so it
 * can be tested without Telegram.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Inline limit — a 100k-char file is context, a 500k-char file is noise. */
export const DOC_MAX_CHARS = 100_000

/** MIME types that are text no matter what the bytes look like. */
const TEXT_MIME = new Set([
  'text/',
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/sql',
])

/** Extensions Telegram does not bother typing but the world reads as text. */
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'html', 'htm', 'svg',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'graphql', 'proto', 'cds',
  'gitignore', 'editorconfig', 'env', 'properties', 'csv', 'tsv', 'log', 'diff', 'patch',
  'xml', 'xsl', 'dtd', 'abap', 'makefile', 'dockerfile', 'cmake', 'gradle', 'lock',
])

/** MIME prefixes that are binary no matter what the sniffing says. */
const BINARY_MIME = new Set([
  'application/zip', 'application/x-7z-compressed', 'application/x-rar-compressed',
  'application/gzip', 'application/x-tar', 'application/pdf',
  'application/vnd.openxmlformats-officedocument', 'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint', 'application/msword', 'application/octet-stream',
  'video/', 'audio/', 'image/',
])

/**
 * Is this file worth inlining into a prompt? Decides by mime, by extension,
 * and finally by sniffing the bytes: a NUL byte or a swarm of control
 * characters within the first 8 KB means binary.
 */
export function isTextLike(name: string, mime: string, buffer: Buffer): boolean {
  const m = mime.trim().toLowerCase()
  if (m.startsWith('text/')) return true
  if (TEXT_MIME.has(m)) return true
  for (const binary of BINARY_MIME) {
    if (m.startsWith(binary)) return false
  }
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (TEXT_EXT.has(ext)) return true
  return sniffIsText(buffer)
}

function sniffIsText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true
  const window = buffer.subarray(0, Math.min(buffer.length, 8192))
  let control = 0
  for (const byte of window) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1
  }
  return control / window.length < 0.05
}

/** Decode with BOM awareness — UTF-16 files arrive as documents too. */
export function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le')
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8')
  return buffer.toString('utf8')
}

/** Where binaries land: inside the bridge's data directory, out of the way. */
export function downloadsDir(stateDir: string): string {
  return join(stateDir, 'downloads')
}

/**
 * Save a binary under the downloads directory with a timestamped, sanitized
 * name, creating the directory as needed. Resolves the absolute path so the
 * prompt can point at it unambiguously.
 */
export function saveBinary(name: string, buffer: Buffer, dir: string): string {
  const safe = name.replace(/[\\/:*?"<>|#\s]+/g, '_').slice(-80) || 'archivo.bin'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const target = resolve(join(dir, `${stamp}-${safe}`))
  mkdirSync(dir, { recursive: true })
  writeFileSync(target, buffer)
  return target
}
