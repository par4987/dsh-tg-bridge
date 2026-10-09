/**
 * TurnRenderer: one message per block, edits in place, whole-block commits
 * for settlements the live stream never delivered.
 */
import { assert, define, type Check } from './harness.ts'
import { Telegram, type SendMessageOptions } from '../src/telegram.ts'
import { TurnRenderer } from '../src/stream.ts'
import type { RenderOptions } from '../src/config.ts'

interface Sent {
  kind: 'send' | 'edit' | 'markup'
  text: string
  threadId: number | undefined
  id: number
}

/** A Telegram that records instead of sending. */
class FakeTelegram extends Telegram {
  readonly sent: Sent[] = []
  private nextId = 100

  constructor() {
    super({ token: 'fake' })
  }

  override async sendMessage(_chatId: number, text: string, options: SendMessageOptions = {}): Promise<number | null> {
    const id = ++this.nextId
    this.sent.push({ kind: 'send', text, threadId: options.messageThreadId, id })
    return id
  }

  override async editMessageText(_chatId: number, messageId: number, text: string, options: SendMessageOptions = {}): Promise<boolean> {
    this.sent.push({ kind: 'edit', text, threadId: options.messageThreadId, id: messageId })
    return true
  }

  override async editMessageReplyMarkup(): Promise<boolean> {
    this.sent.push({ kind: 'markup', text: '', threadId: undefined, id: 0 })
    return true
  }
}

const options: RenderOptions = {
  editIntervalMs: 0,
  showDiffs: false,
  diffMaxLines: 10,
  showReasoning: true,
  reasoningChars: 500,
}

/** Let in-flight send/edit promises settle before asserting on them. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function makeRenderer(telegram: FakeTelegram, watchedId = 'ses-1'): TurnRenderer {
  return new TurnRenderer(
    telegram,
    1,
    options,
    (id) => id === watchedId,
    () => undefined,
    () => 'Título',
    (id) => (id === watchedId ? 77 : undefined),
    { noTitle: '(sin título)', toolCancelled: 'cancelada' },
  )
}

export const streamChecks: Check[] = [
  define('a text block creates one message and edits it in place', async () => {
    const telegram = new FakeTelegram()
    const renderer = makeRenderer(telegram)
    renderer.start()
    renderer.textStarted('ses-1', '1:0:0')
    renderer.textDelta('ses-1', '1:0:0', 0, 'hola ')
    renderer.textDelta('ses-1', '1:0:0', 1, 'mundo')
    renderer.textEnded('ses-1', '1:0:0')
    await settle()
    const sends = telegram.sent.filter((entry) => entry.kind === 'send')
    const edits = telegram.sent.filter((entry) => entry.kind === 'edit')
    assert(sends.length === 1, `one message is created (got ${sends.length})`)
    assert(edits.length >= 1, 'later content edits the same message')
    assert(sends[0]?.threadId === 77, 'the send lands in the session thread')
    const last = telegram.sent.at(-1)
    assert(last?.text.includes('hola mundo') === true, 'the final edit carries the whole text')
    renderer.stop()
  }),

  define('a settlement for an unstreamed block renders it whole', async () => {
    const telegram = new FakeTelegram()
    const renderer = makeRenderer(telegram)
    renderer.start()
    renderer.textCommit('ses-1', '2:1:0', '', 'respuesta completa')
    await settle()
    const last = telegram.sent.at(-1)
    assert(last?.text.includes('respuesta completa') === true, 'the committed text reaches Telegram')
    renderer.stop()
  }),

  define('tool events render as one card per run', async () => {
    const telegram = new FakeTelegram()
    const renderer = makeRenderer(telegram)
    renderer.start()
    renderer.toolEvent('ses-1', { id: 'call-1', name: 'bash', input: { command: 'pnpm test' }, status: 'running' })
    await settle()
    assert(telegram.sent.length >= 1, 'a card message is sent')
    assert(telegram.sent[0]?.text.includes('bash') === true, 'the card names the tool')
    renderer.stop()
  }),

  define('an unwatched session renders nothing', async () => {
    const telegram = new FakeTelegram()
    const renderer = makeRenderer(telegram)
    renderer.start()
    renderer.textStarted('ses-other', '1:0:0')
    renderer.toolEvent('ses-other', { id: 'c', name: 'bash', input: {}, status: 'completed' })
    await settle()
    assert(telegram.sent.length === 0, 'unwatched sessions stay silent')
    renderer.stop()
  }),
]
