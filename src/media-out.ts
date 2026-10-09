/**
 * Outbound media — what the agent produced that deserves a Telegram photo.
 *
 * After a turn finishes, the bridge scans tool results for local file paths
 * that were created or modified during the turn, and sends them so the user
 * sees the result without opening the PC. Pure, testable.
 *
 * Reply context lives here too: what the user is replying to, so the agent
 * gets the quote — and the forum-echo detection that keeps a thread's pinned
 * opener from being mistaken for a reply.
 */
import { existsSync, statSync } from 'node:fs'

/** Extensions Telegram can display inline as photos. */
const PHOTO_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp'])
/** Extensions that ride better as documents (too big or not displayable). */
const DOCUMENT_EXT = new Set(['pdf', 'csv', 'xlsx', 'docx', 'zip', '7z', 'rar', 'tar', 'gz'])
/** Extensions whose content is readable text — inlined as a message when small. */
const TEXT_EXT = new Set(['md', 'txt'])
/** Text files up to this many bytes are inlined; larger ones ride as documents. */
export const TEXT_INLINE_LIMIT = 12_000
/** How many images to send before the rest get listed as text only. */
export const MAX_IMAGES = 8
/** Maximum photo size Telegram accepts (10 MB). */
export const PHOTO_LIMIT = 10 * 1024 * 1024
/** Maximum document size Telegram accepts (45 MB). */
export const DOCUMENT_LIMIT = 45 * 1024 * 1024

/** How a captured file travels to Telegram. */
export type SendKind = 'photo' | 'document' | 'text'

/**
 * Extract local file paths from a tool's output or input. Matches Windows and
 * POSIX absolute paths with image or document extensions. Segments exclude
 * whitespace so two paths in one sentence never glue into one wrong match;
 * the trade is that a filename containing spaces is not auto-delivered.
 */
export function extractFilePaths(text: string): string[] {
  // Windows: C:\...\file.png or C:/.../file.png.
  const winRegex = /\b[A-Z]:[\\/](?:[^<>:"|?*\s\\/]*[\\/])*[^<>:"|?*\s\\/]+\.(?:png|jpe?g|webp|bmp|gif|pdf|csv|xlsx?|docx?|zip|7z|rar|tar|gz|md|txt)\b/gi
  // POSIX: /home/.../file.png
  const posixRegex = /(?:\/(?:[\w.-]+\/)*[\w.-]+\.(?:png|jpe?g|webp|bmp|gif|pdf|csv|xlsx?|docx?|zip|7z|rar|tar|gz|md|txt))\b/gi
  const matches = new Set<string>()
  for (const match of text.matchAll(winRegex)) matches.add(match[0])
  for (const match of text.matchAll(posixRegex)) matches.add(match[0])
  return [...matches].filter((p) => p.length > 5 && p.length < 500)
}

/**
 * A path qualifies as a "send this to the user" candidate when it exists,
 * it was touched since `since` (the turn's start), and it fits the size cap.
 */
export function qualifyingImage(path: string, since: number): { path: string, as: SendKind } | undefined {
  try {
    if (!existsSync(path)) return undefined
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    if (stat.mtimeMs < since - 5000) return undefined
    const ext = path.toLowerCase().split('.').pop() ?? ''
    if (PHOTO_EXT.has(ext) && stat.size <= PHOTO_LIMIT) {
      return { path, as: 'photo' }
    }
    // Readable text: a small file is far easier to read as a message than as
    // an attachment on the phone; a big one keeps the document path.
    if (TEXT_EXT.has(ext) && stat.size <= DOCUMENT_LIMIT) {
      return { path, as: stat.size <= TEXT_INLINE_LIMIT ? 'text' : 'document' }
    }
    if (DOCUMENT_EXT.has(ext) && stat.size <= DOCUMENT_LIMIT) {
      return { path, as: 'document' }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * De-duplicate and cap: keep the first MAX_IMAGES unique files, newest
 * modification order (most recent first).
 */
export function selectImages(paths: string[], since: number): Array<{ path: string, as: SendKind }> {
  const seen = new Set<string>()
  const out: Array<{ path: string, as: SendKind, mtime: number }> = []
  for (const p of paths) {
    if (seen.has(p)) continue
    seen.add(p)
    const q = qualifyingImage(p, since)
    if (q === undefined) continue
    try {
      out.push({ ...q, mtime: statSync(p).mtimeMs })
    } catch {
      continue
    }
  }
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_IMAGES)
    .map(({ path, as }) => ({ path, as }))
}

// ── reply context ───────────────────────────────────────────────────────────

/** The part of a Telegram message the reply-quote needs. */
export interface ReplyTarget {
  text?: string
  caption?: string
  photo?: unknown[]
  document?: { file_name?: string }
  sticker?: { emoji?: string }
  voice?: { duration?: number }
  video?: { file_name?: string }
  animation?: { mime_type?: string }
  audio?: { duration?: number }
  video_note?: { duration?: number }
  poll?: { question?: string }
  dice?: { emoji?: string }
  location?: { latitude?: number }
  contact?: { first_name?: string }
  forum_topic_created?: { name?: string }
}

/** The localized reply-context labels `describeReplyTarget` needs. */
export interface ReplyLabels {
  media_poll: (params: { q: string }) => string
  media_topic_created: (params: { name: string }) => string
  media_photo: () => string
  media_animation: () => string
  media_document: (params: { name: string }) => string
  media_sticker: (params: { emoji: string }) => string
  media_voice: (params: { n: number }) => string
  media_audio: (params: { n: number }) => string
  media_video_note: (params: { n: number }) => string
  media_video: (params: { name: string }) => string
  media_dice: (params: { emoji: string }) => string
  media_location: () => string
  media_contact: (params: { name: string }) => string
  media_no_text: () => string
}

/**
 * Describe what the user is replying to, so the agent has the quote. Falls
 * back to a short placeholder for media types that cannot inline as text.
 */
export function describeReplyTarget(target: ReplyTarget | undefined, labels: ReplyLabels): string | undefined {
  if (target === undefined) return undefined
  const text = (target.text ?? target.caption ?? '').trim()
  if (text.length > 0) return text.slice(0, 4000)
  if (target.poll?.question !== undefined) return labels.media_poll({ q: target.poll.question.slice(0, 200) })
  if (target.forum_topic_created !== undefined) {
    return labels.media_topic_created({ name: target.forum_topic_created.name ?? '?' })
  }
  if (target.photo !== undefined && target.photo.length > 0) return labels.media_photo()
  if (target.animation !== undefined) return labels.media_animation()
  if (target.document?.file_name !== undefined) return labels.media_document({ name: target.document.file_name })
  if (target.sticker?.emoji !== undefined) return labels.media_sticker({ emoji: target.sticker.emoji })
  if (target.voice?.duration !== undefined) return labels.media_voice({ n: target.voice.duration })
  if (target.audio?.duration !== undefined) return labels.media_audio({ n: target.audio.duration })
  if (target.video_note?.duration !== undefined) return labels.media_video_note({ n: target.video_note.duration })
  if (target.video?.file_name !== undefined) return labels.media_video({ name: target.video.file_name })
  if (target.dice?.emoji !== undefined) return labels.media_dice({ emoji: target.dice.emoji })
  if (target.location !== undefined) return labels.media_location()
  if (target.contact?.first_name !== undefined) return labels.media_contact({ name: target.contact.first_name })
  return labels.media_no_text()
}

/**
 * A forum thread pins its opener at the top, and Telegram echoes that opener
 * in `reply_to_message` for ordinary messages sent inside the thread — the
 * user replied to nothing. The opener is a service message: some clients give
 * it the thread id as its message_id, others its own id, so the id check
 * alone lets the echo through. The `forum_topic_created` marker is the
 * reliable witness — and even a deliberate reply to the opener carries no
 * context worth quoting.
 */
export function isForumEcho(message: { message_thread_id?: number, reply_to_message?: { message_id?: number, forum_topic_created?: { name?: string } } } | undefined): boolean {
  if (message?.reply_to_message === undefined) return false
  const reply = message.reply_to_message
  if (reply.forum_topic_created !== undefined) return true
  return reply.message_id !== undefined && reply.message_id === message.message_thread_id
}

/**
 * Prepend the reply quote to a prompt, so the agent knows what is being
 * discussed. The framing line comes from the caller's locale catalog.
 */
export function withReplyContext(prompt: string, quote: string | undefined, frame: (params: { quote: string, prompt: string }) => string): string {
  if (quote === undefined || quote.length === 0) return prompt
  return frame({ quote, prompt })
}
