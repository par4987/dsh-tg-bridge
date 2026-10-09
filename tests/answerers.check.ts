/**
 * AnswererHub: approvals and questions answered through inline keyboards,
 * and delegation to the next answerer when the bridge does not mirror the
 * session.
 */
import { assert, define, type Check } from './harness.ts'
import { Telegram, type SendMessageOptions } from '../src/telegram.ts'
import { AnswererHub } from '../src/answerers.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionRequestEvent, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'

interface Sent {
  text: string
  markup: Record<string, unknown> | undefined
  id: number
}

/** A Telegram that records sends and hands out ids for the cards. */
class FakeTelegram extends Telegram {
  readonly sent: Sent[] = []
  private nextId = 500

  constructor() {
    super({ token: 'fake' })
  }

  override async sendMessage(_chatId: number, text: string, options: SendMessageOptions = {}): Promise<number | null> {
    const id = ++this.nextId
    this.sent.push({ text, markup: options.replyMarkup, id })
    return id
  }

  override async editMessageText(_chatId: number, messageId: number, text: string): Promise<boolean> {
    this.sent.push({ text, markup: undefined, id: messageId })
    return true
  }

  override async editMessageReplyMarkup(): Promise<boolean> {
    return true
  }

  override async answerCallbackQuery(): Promise<void> {}
}

const agentOf = (id: string): Agent => ({ id } as unknown as Agent)

/** Wire a hub that mirrors only ses-1 into thread 5. */
function makeHub(): { hub: AnswererHub, telegram: FakeTelegram } {
  const telegram = new FakeTelegram()
  const hub = new AnswererHub({
    telegram,
    chatId: 1,
    threadOf: (sessionId) => (sessionId === 'ses-1' ? 5 : undefined),
    notify: () => undefined,
  })
  return { hub, telegram }
}

/** The id of the most recently sent card. */
function lastCardId(telegram: FakeTelegram): number {
  const last = telegram.sent.at(-1)
  if (last === undefined) throw new Error('no card was sent')
  return last.id
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

const approvalOf = (agent: Agent): ApprovalRequestEvent => ({ agent, toolName: 'bash', reason: 'escribe en el repo' })
const nextApproval = async (): Promise<'unavailable'> => 'unavailable'
const nextAnswer = async (): Promise<AskUserQuestionAnswer> => ({ answers: [] })

export const answererChecks: Check[] = [
  define('an approval is answered by its allow button', async () => {
    const { hub, telegram } = makeHub()
    const pending = hub.approval(approvalOf(agentOf('ses-1')), nextApproval)
    await settle()
    const card = telegram.sent.find((entry) => entry.text.includes('bash'))
    assert(card !== undefined, 'the permission card is sent')
    const handled = await hub.handleCallback('a:y', lastCardId(telegram), 'cq-1', 'ses-1')
    assert(handled, 'the bridge owns the tap')
    assert(await pending === 'allowed-once', 'the outcome is a one-shot allow')
  }),

  define('an approval can be rejected', async () => {
    const { hub, telegram } = makeHub()
    const pending = hub.approval(approvalOf(agentOf('ses-1')), nextApproval)
    await settle()
    await hub.handleCallback('a:n', lastCardId(telegram), 'cq-2', 'ses-1')
    assert(await pending === 'rejected', 'the outcome is a rejection')
  }),

  define('a session the bridge does not mirror delegates', async () => {
    const { hub } = makeHub()
    const pending = hub.approval(approvalOf(agentOf('ses-other')), nextApproval)
    assert(await pending === 'unavailable', 'the next answerer owns the request')
  }),

  define('a single-select question is answered by one tap', async () => {
    const { hub, telegram } = makeHub()
    const request: AskUserQuestionRequestEvent = {
      agent: agentOf('ses-1'),
      questions: [{ id: 'q1', question: '¿Cuál?', options: [{ label: 'Primera' }, { label: 'Segunda' }] }],
    }
    const pending = hub.questions(request, nextAnswer)
    await settle()
    assert(telegram.sent.some((entry) => entry.text.includes('¿Cuál?')), 'the question card is sent')
    await hub.handleCallback('q:0:1', lastCardId(telegram), 'cq-3', 'ses-1')
    const answer = await pending
    assert(answer.answers[0]?.id === 'q1', 'the answer names the question')
    assert(answer.answers[0]?.selected[0] === 'Segunda', 'the tapped option label is the answer')
  }),

  define('a multi-select question toggles and confirms', async () => {
    const { hub, telegram } = makeHub()
    const request: AskUserQuestionRequestEvent = {
      agent: agentOf('ses-1'),
      questions: [{ id: 'q1', question: 'Elegí varias', multiSelect: true, options: [{ label: 'Uno' }, { label: 'Dos' }] }],
    }
    const pending = hub.questions(request, nextAnswer)
    await settle()
    const cardId = lastCardId(telegram)
    await hub.handleCallback('q:0:0', cardId, 'cq-4', 'ses-1')
    await hub.handleCallback('q:0:1', cardId, 'cq-5', 'ses-1')
    await hub.handleCallback('q:0:ok', cardId, 'cq-6', 'ses-1')
    const answer = await pending
    assert(answer.answers[0]?.selected.join(',') === 'Uno,Dos', 'both toggled options arrive in tap order')
  }),

  define('the Other button arms a free-text answer', async () => {
    const { hub, telegram } = makeHub()
    const request: AskUserQuestionRequestEvent = {
      agent: agentOf('ses-1'),
      questions: [{ id: 'q1', question: 'Nombre', options: [{ label: 'Sugerido' }] }],
    }
    const pending = hub.questions(request, nextAnswer)
    await settle()
    const cardId = lastCardId(telegram)
    await hub.handleCallback('q:0:ft', cardId, 'cq-7', 'ses-1')
    const armed = hub.pendingFreeText('ses-1')
    assert(armed !== undefined, 'the next message answers the question')
    armed?.submit('Mi propio nombre')
    const answer = await pending
    assert(answer.answers[0]?.custom === 'Mi propio nombre', 'the free text becomes the custom answer')
  }),
]
