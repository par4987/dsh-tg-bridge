/** Outbound media and reply context: extraction, selection, forum echoes. */
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, define, type Check } from './harness.ts'
import { describeReplyTarget, extractFilePaths, isForumEcho, selectImages, withReplyContext } from '../src/media-out.ts'
import type { ReplyLabels } from '../src/media-out.ts'

const labels: ReplyLabels = {
  media_poll: ({ q }) => `poll ${q}`,
  media_topic_created: ({ name }) => `topic ${name}`,
  media_photo: () => 'a photo',
  media_animation: () => 'a gif',
  media_document: ({ name }) => `doc ${name}`,
  media_sticker: ({ emoji }) => `sticker ${emoji}`,
  media_voice: ({ n }) => `voice ${n}`,
  media_audio: ({ n }) => `audio ${n}`,
  media_video_note: ({ n }) => `round ${n}`,
  media_video: ({ name }) => `video ${name}`,
  media_dice: ({ emoji }) => `dice ${emoji}`,
  media_location: () => 'a location',
  media_contact: ({ name }) => `contact ${name}`,
  media_no_text: () => 'no text',
}

const scratch = mkdtempSync(join(tmpdir(), 'tg-bridge-media-'))

/** Fixtures `selectImages` should and should not pick. */
function touch(name: string, ageSeconds: number, size = 10): string {
  const path = join(scratch, name)
  writeFileSync(path, Buffer.alloc(size))
  const when = new Date(Date.now() - ageSeconds * 1000)
  utimesSync(path, when, when)
  return path
}

export const mediaOutChecks: Check[] = [
  define('extractFilePaths finds Windows and POSIX paths', () => {
    const paths = extractFilePaths('wrote C:\\repo\\out\\graf.png and /tmp/build/reporte.pdf for you')
    assert(paths.includes('C:\\repo\\out\\graf.png'), 'the Windows path is found')
    assert(paths.includes('/tmp/build/reporte.pdf'), 'the POSIX path survives unchanged')
  }),

  define('selectImages keeps fresh displayable files and caps them', () => {
    const freshPng = touch('nuevo.png', 1)
    const stalePng = touch('viejo.png', 60 * 60 * 24 * 365)
    touch('instalador.exe', 1)
    const picked = selectImages([freshPng, stalePng, join(scratch, 'instalador.exe')], Date.now() - 60_000)
    assert(picked.length === 1, `only the fresh image qualifies (got ${picked.length})`)
    assert(picked[0]?.path === freshPng, 'the fresh png is the one picked')
    assert(picked[0]?.as === 'photo', 'a png travels as a photo')
    rmSync(scratch, { recursive: true, force: true })
  }),

  define('isForumEcho ignores the pinned opener and keeps real replies', () => {
    const echo = { message_thread_id: 5, reply_to_message: { message_id: 5, forum_topic_created: { name: 'x' } } }
    assert(isForumEcho(echo), 'the opener service message is an echo')
    const real = { message_thread_id: 5, reply_to_message: { message_id: 99, text: 'hola' } }
    assert(!isForumEcho(real), 'a reply to a real message is not an echo')
    assert(!isForumEcho(undefined), 'no reply is not an echo')
  }),

  define('describeReplyTarget quotes text and labels media', () => {
    assert(describeReplyTarget({ text: '  cómo va?  ' }, labels) === 'cómo va?', 'text is trimmed and kept')
    assert(describeReplyTarget({ photo: [{}] }, labels) === 'a photo', 'a photo gets its label')
    assert(describeReplyTarget({ document: { file_name: 'plan.md' } }, labels) === 'doc plan.md', 'a document names its file')
    assert(describeReplyTarget(undefined, labels) === undefined, 'no target gives no quote')
  }),

  define('withReplyContext frames the quote around the prompt', () => {
    const framed = withReplyContext('seguí así', 'la parte del diff', ({ quote, prompt }) => `«${quote}» → ${prompt}`)
    assert(framed === '«la parte del diff» → seguí así', 'the frame wraps both parts')
    assert(withReplyContext('sin cita', undefined, () => 'nunca') === 'sin cita', 'no quote keeps the prompt bare')
  }),
]
