/**
 * Telegram answerers for the harness's two human-decision waterfalls.
 *
 * OpenCode needed an HTTP detour to answer a question from the phone. The
 * harness exposes the decision points themselves as in-process waterfalls —
 * `approval/request` (may this operation proceed?) and `user-questions/request`
 * (structured input the model asked for) — so the bridge answers them
 * directly with inline keyboards:
 *
 *  - approvals offer one-shot allow / reject, the vocabulary the waterfall
 *    owns (durable "always" policy belongs to the harness's permission
 *    system, not to a chat tap);
 *  - questions render every option as a button, multi-select toggles with a
 *    confirm row, and "Other" arms free text — the next message in the
 *    thread becomes the answer.
 *
 * The bridge claims only requests for sessions it mirrors (a thread exists);
 * everything else delegates with `next()`, so other answerers (the ACP
 * machine answerer, the Web UI) keep their requests.
 */
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionRequestEvent,
} from '@deepseek-ai/dsh-user-questions/types'
import { MessageCards } from './cards.ts'
import { t } from './locale.ts'
import type { Telegram } from './telegram.ts'
import { chunkHtml, escapeHtml } from './render.ts'

/** One keyboard button as the Bot API shapes it. */
type Button = { text: string, callback_data: string }

function keyboard(rows: Button[][]): Record<string, unknown> {
  return { inline_keyboard: rows }
}

/** The state a card's buttons act on. */
interface ApprovalCard {
  kind: 'approval'
  resolve: (outcome: ApprovalOutcome) => void
  messageId: number
}

interface QuestionCard {
  kind: 'question'
  /** Answers accumulator, shared by every card of one request. */
  answers: Map<string, AskUserQuestionAnswerItem>
  settle: () => void
  questionId: string
  multiSelect: boolean
  /** Indices of the selected options (multi-select toggling). */
  selected: Set<number>
  /** Every option label, by the button's index. */
  labels: string[]
  resolveQuestion: (answer: AskUserQuestionAnswerItem) => void
  messageId: number
}

type Card = ApprovalCard | QuestionCard

/** A free-text answer armed by the "Other" button: the next message answers it. */
export interface PendingFreeText {
  questionId: string
  multiSelect: boolean
  submit: (text: string) => void
}

export interface AnswererDeps {
  telegram: Telegram
  chatId: number
  /** Thread id for a session, or undefined when the bridge does not mirror it. */
  threadOf: (sessionId: string) => number | undefined
  /** Reports a contained send failure to the host logger. */
  notify: (error: unknown) => void
}

export class AnswererHub {
  private readonly cards = new MessageCards<Card>(40)
  /** sessionId -> the one pending free-text answer, if any. */
  private readonly freeText = new Map<string, PendingFreeText>()

  constructor(private readonly deps: AnswererDeps) {}

  /** Whether a free-text answer is armed for the session. */
  pendingFreeText(sessionId: string): PendingFreeText | undefined {
    return this.freeText.get(sessionId)
  }

  /** Drop an armed free-text answer without using it. */
  dropFreeText(sessionId: string): void {
    this.freeText.delete(sessionId)
  }

  // ── approvals ──────────────────────────────────────────────────────────────

  /** Answer one approval request from Telegram buttons, or delegate. */
  approval(req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const sessionId = req.agent.id
    const thread = this.deps.threadOf(sessionId)
    if (thread === undefined) return next()

    const header = t('approval_header', { tool: escapeHtml(req.toolName) })
    const reason = req.reason !== undefined && req.reason.length > 0
      ? t('approval_reason', { reason: escapeHtml(req.reason) })
      : ''
    const text = `${header}${reason}`
    return new Promise<ApprovalOutcome>((resolve) => {
      let settled = false
      const settle = (outcome: ApprovalOutcome): void => {
        if (settled) return
        settled = true
        this.cards.drop(cardMessageId)
        void this.finishCard(
          sessionId,
          cardMessageId,
          `${text}\n${outcome === 'allowed-once' ? t('approval_allowed') : t('approval_rejected')}`,
        )
        resolve(outcome)
      }
      // The card message id arrives after send; the callback carries it.
      let cardMessageId = -1
      const data = (allow: boolean): string => `a:${allow ? 'y' : 'n'}`
      void this.deps.telegram
        .sendMessage(this.deps.chatId, chunkHtml(text)[0] ?? text, {
          parseMode: 'HTML',
          messageThreadId: thread,
          replyMarkup: keyboard([
            [{ text: t('approval_allow'), callback_data: data(true) }],
            [{ text: t('approval_reject'), callback_data: data(false) }],
          ]),
        })
        .then((messageId) => {
          if (messageId === null) {
            settle('unavailable')
            return
          }
          cardMessageId = messageId
          this.cards.set(messageId, { kind: 'approval', resolve: settle, messageId })
        })
        .catch((error) => {
          this.deps.notify(error)
          settle('unavailable')
        })
      req.signal?.addEventListener('abort', () => settle('cancelled'), { once: true })
    })
  }

  // ── questions ──────────────────────────────────────────────────────────────

  /** Answer one user-questions request from Telegram buttons and replies. */
  questions(req: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer> {
    const sessionId = req.agent?.id
    const thread = sessionId !== undefined ? this.deps.threadOf(sessionId) : undefined
    if (sessionId === undefined || thread === undefined) return next()

    const questions = req.questions
    return new Promise<AskUserQuestionAnswer>((resolve) => {
      const answers = new Map<string, AskUserQuestionAnswerItem>()
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        if (sessionId !== undefined) this.dropFreeText(sessionId)
        resolve({ answers: questions.map((question) => answers.get(question.id) ?? { id: question.id, selected: [] }) })
      }
      const submitAnswer = (questionId: string, answer: AskUserQuestionAnswerItem): void => {
        if (answers.has(questionId)) return
        answers.set(questionId, answer)
        if (questions.every((question) => answers.has(question.id))) settle()
      }

      req.signal?.addEventListener('abort', () => settle(), { once: true })

      for (const [qi, question] of questions.entries()) {
        const multiSelect = question.multiSelect === true
        const options = question.options ?? []
        const head = question.header !== undefined && question.header.length > 0
          ? t('question_header_label', { header: escapeHtml(question.header) })
          : t('questions_header')
        const numbered = questions.length > 1
          ? t('question_numbered', { i: qi + 1, n: questions.length, question: escapeHtml(question.question) })
          : t('question_plain', { question: escapeHtml(question.question) })
        const detail = question.detail !== undefined && question.detail.length > 0
          ? t('question_detail', { detail: escapeHtml(toPlainText(question.detail).slice(0, 600)) })
          : ''
        const hint = options.length === 0
          ? t('question_options_hint')
          : multiSelect ? t('question_multi_hint') : ''
        const text = `${head}${numbered}${detail}${hint}`

        if (options.length === 0) {
          // Nothing to tap: arm free text as the answer channel.
          void this.armFreeText(sessionId, thread, text, question.id, false, submitAnswer, req, settle)
          continue
        }

        const rows: Button[][] = []
        for (const [oi, option] of options.entries()) {
          rows.push([{ text: option.label.slice(0, 60), callback_data: `q:${qi}:${oi}` }])
        }
        if (!multiSelect) {
          rows.push([{ text: t('question_other'), callback_data: `q:${qi}:ft` }])
        } else {
          rows.push([
            { text: t('question_other'), callback_data: `q:${qi}:ft` },
            { text: t('question_confirm'), callback_data: `q:${qi}:ok` },
          ])
        }
        void this.deps.telegram
          .sendMessage(this.deps.chatId, chunkHtml(text)[0] ?? text, {
            parseMode: 'HTML',
            messageThreadId: thread,
            replyMarkup: keyboard(rows),
          })
          .then((messageId) => {
            if (messageId === null) return
            this.cards.set(messageId, {
              kind: 'question',
              answers,
              settle,
              questionId: question.id,
              multiSelect,
              selected: new Set<number>(),
              labels: options.map((option) => option.label),
              resolveQuestion: (answer: AskUserQuestionAnswerItem) => submitAnswer(question.id, answer),
              messageId,
            })
          })
          .catch(this.deps.notify)
      }
    })
  }

  /** Arm the next message in the thread as a free-text answer. */
  private armFreeText(
    sessionId: string,
    thread: number,
    text: string,
    questionId: string,
    multiSelect: boolean,
    submitAnswer: (questionId: string, answer: AskUserQuestionAnswerItem) => void,
    _req: AskUserQuestionRequestEvent,
    settle: () => void,
  ): void {
    void this.deps.telegram
      .sendMessage(this.deps.chatId, chunkHtml(text)[0] ?? text, thread === undefined ? { parseMode: 'HTML' } : { parseMode: 'HTML', messageThreadId: thread })
      .then(() => {
        if (this.freeText.has(sessionId)) return
        this.freeText.set(sessionId, {
          questionId,
          multiSelect,
          submit: (textAnswer) => {
            this.freeText.delete(sessionId)
            const custom = textAnswer.trim()
            submitAnswer(questionId, custom.length > 0
              ? (multiSelect
                ? { id: questionId, selected: [], custom }
                : { id: questionId, selected: [], custom })
              : { id: questionId, selected: [] })
          },
        })
      })
      .catch((error) => {
        this.deps.notify(error)
        settle()
      })
  }

  // ── callback dispatch ──────────────────────────────────────────────────────

  /**
   * Dispatch one inline-keyboard tap. Answers the callback query and returns
   * whether the bridge owned it.
   */
  async handleCallback(payload: string, cqMessageId: number | undefined, cqId: string, sessionIdForThread: string): Promise<boolean> {
    const card = this.cards.get(cqMessageId)
    if (card === undefined) {
      // A button outliving its request (a restart dropped the entry, or the
      // host answered first) would lie forever — acknowledge and say so.
      await this.deps.telegram.answerCallbackQuery(cqId, t('form_inactive')).catch(() => undefined)
      return false
    }

    if (card.kind === 'approval') {
      if (payload !== 'a:y' && payload !== 'a:n') return false
      await this.deps.telegram.answerCallbackQuery(cqId).catch(() => undefined)
      card.resolve(payload === 'a:y' ? 'allowed-once' : 'rejected')
      return true
    }

    // Question card: `q:<qi>:<oi|ft|ok>`
    const match = /^q:(\d+):(ok|ft|\d+)$/.exec(payload)
    if (match === null) return false
    const action = match[2]
    await this.deps.telegram.answerCallbackQuery(cqId).catch(() => undefined)

    if (action === 'ft') {
      // "Other": the next message in the thread answers this question.
      this.freeText.set(sessionIdForThread, {
        questionId: card.questionId,
        multiSelect: card.multiSelect,
        submit: (text) => {
          this.freeText.delete(sessionIdForThread)
          this.cards.drop(card.messageId)
          const answerThread = this.deps.threadOf(sessionIdForThread)
          void this.deps.telegram
            .sendMessage(
              this.deps.chatId,
              `${t('question_answered', { answer: escapeHtml(text.slice(0, 120)) })}`,
              answerThread === undefined ? { parseMode: 'HTML' } : { parseMode: 'HTML', messageThreadId: answerThread },
            )
            .catch(this.deps.notify)
          card.resolveQuestion({ id: card.questionId, selected: [], custom: text })
        },
      })
      await this.deps.telegram.answerCallbackQuery(cqId, t('question_options_hint')).catch(() => undefined)
      return true
    }

    if (action === 'ok') {
      // Multi-select confirm: the accumulated toggles become the answer.
      const selected = [...card.selected].map((oi) => card.labels[oi] ?? '').filter((label) => label.length > 0)
      this.cards.drop(card.messageId)
      card.resolveQuestion({ id: card.questionId, selected })
      return true
    }

    const oi = Number(action)
    if (!Number.isInteger(oi) || oi < 0 || oi >= card.labels.length) return false

    if (card.multiSelect) {
      // Toggle and redraw the keyboard with checkmarks.
      if (card.selected.has(oi)) card.selected.delete(oi)
      else card.selected.add(oi)
      const rows: Button[][] = []
      for (const [index, label] of card.labels.entries()) {
        rows.push([{ text: `${card.selected.has(index) ? '✅ ' : ''}${label.slice(0, 58)}`, callback_data: `q:${payload.split(':')[1]}:${index}` }])
      }
      const qi = payload.split(':')[1] ?? '0'
      rows.push([
        { text: t('question_other'), callback_data: `q:${qi}:ft` },
        { text: t('question_confirm'), callback_data: `q:${qi}:ok` },
      ])
      await this.deps.telegram
        .editMessageReplyMarkup(this.deps.chatId, card.messageId, keyboard(rows))
        .catch(() => undefined)
      return true
    }

    // Single select: this tap is the whole answer.
    this.cards.drop(card.messageId)
    const label = card.labels[oi] ?? ''
    const singleThread = this.deps.threadOf(sessionIdForThread)
    void this.deps.telegram
      .sendMessage(
        this.deps.chatId,
        t('question_answered', { answer: escapeHtml(label) }),
        singleThread === undefined ? { parseMode: 'HTML' } : { parseMode: 'HTML', messageThreadId: singleThread },
      )
      .catch(this.deps.notify)
    card.resolveQuestion({ id: card.questionId, selected: [label] })
    return true
  }

  /** Rewrite a settled card without its keyboard. */
  private finishCard(sessionId: string, messageId: number, text: string): void {
    const thread = this.deps.threadOf(sessionId)
    void this.deps.telegram
      .editMessageText(
        this.deps.chatId,
        messageId,
        chunkHtml(text)[0] ?? text,
        thread === undefined ? { parseMode: 'HTML' } : { parseMode: 'HTML', messageThreadId: thread },
      )
      .catch(() => undefined)
    void this.deps.telegram.editMessageReplyMarkup(this.deps.chatId, messageId).catch(() => undefined)
  }
}

/** Strip markdown emphasis the question detail may carry for plain display. */
function toPlainText(markdown: string): string {
  return markdown.replace(/[*_`]+/g, '')
}
