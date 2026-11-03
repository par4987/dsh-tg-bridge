/**
 * The interactive `/queue` card: the inbox's pending messages rendered with
 * one row of per-item buttons, and the pure render that builds both.
 *
 * The harness Inbox gives the card its model — `nextStep` (steering for the
 * next step boundary) and `nextTurn` (prompts awaiting their own turn) — and
 * the mutation surface the buttons drive (`remove`, `splice`). Everything
 * here stays pure: no Telegram, no ctx, so the suite drives the corner cases
 * directly.
 */
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { escapeHtml } from './render.ts'
import { t } from './locale.ts'
import type { CardButton } from './commands.ts'

/** The subset of the harness Inbox the queue card drives. */
export interface InboxLike {
  readonly nextTurn: ReadonlyArray<UserMessage>
  readonly nextStep: ReadonlyArray<UserMessage>
  /** Durably remove one pending message. */
  remove(messageId: UserMessage['id']): boolean
  /** Splice one pending list; a durable record normalizes the result. */
  splice(target: 'next-turn' | 'next-step', start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[]
}

/** One pending inbox item the `/queue` card offers per-item buttons on. */
export interface QueueItem {
  message: UserMessage
  target: 'next-turn' | 'next-step'
  text: string
}

/** Text of a pending message's blocks — the queue card's one-line previews. */
function textOfQueue(content: ReadonlyArray<ContentBlock>): string {
  return content
    .filter((block): block is { type: 'text', text: string } => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
}

/**
 * The queue card: steering items first, then turn items, one row of
 * per-item buttons each, and a footer that replays the arrangement.
 * @param inbox - the live inbox the card renders from.
 * @returns the card's text plus its payload, or undefined when nothing is pending.
 */
export function renderQueue(inbox: InboxLike): { text: string, buttons: CardButton[], items: QueueItem[] } | undefined {
  const items: QueueItem[] = []
  for (const message of inbox.nextStep) {
    items.push({ message, target: 'next-step', text: textOfQueue(message.content) })
  }
  for (const message of inbox.nextTurn) {
    items.push({ message, target: 'next-turn', text: textOfQueue(message.content) })
  }
  if (items.length === 0) return undefined
  const buttons: CardButton[] = []
  const lines = [t('queue_card_header', { n: items.length })]
  let stepSeen = 0
  let turnSeen = 0
  items.forEach((item, index) => {
    if (item.target === 'next-step') {
      stepSeen += 1
      if (stepSeen === 1) lines.push(t('queue_step_header', { n: inbox.nextStep.length }))
      lines.push(`${stepSeen}. ${escapeHtml(item.text.slice(0, 120))}`)
    } else {
      turnSeen += 1
      if (turnSeen === 1) lines.push(t('queue_turn_header', { n: inbox.nextTurn.length }))
      lines.push(`${turnSeen}. ${escapeHtml(item.text.slice(0, 120))}`)
    }
    buttons.push(
      { text: '↑', callback: `q:u:${index}` },
      { text: '↓', callback: `q:d:${index}` },
      { text: '▶', callback: `q:f:${index}` },
      { text: '✖', callback: `q:x:${index}` },
      { text: '✏️', callback: `q:e:${index}` },
    )
  })
  lines.push(t('queue_hint'))
  buttons.push({ text: t('queue_send_order'), callback: 'q:order' })
  return { text: lines.join('\n'), buttons, items }
}
