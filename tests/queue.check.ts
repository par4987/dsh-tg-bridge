/** The queue card render: ordering, headers and the per-item buttons. */
import { assert, define, type Check } from './harness.ts'
import { setLocale } from '../src/locale.ts'
import { renderQueue, type InboxLike } from '../src/queue.ts'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** A minimal pending message: an id, one text block, no source wiring. */
function fakeMessage(id: string, text: string): UserMessage {
  return { id: id as UserMessage['id'], content: [{ type: 'text', text }] } as unknown as UserMessage
}

/** An inbox that only exposes the two readable lists (no mutation surface). */
function inbox(steps: UserMessage[], turns: UserMessage[]): InboxLike {
  return {
    nextStep: steps,
    nextTurn: turns,
    remove: () => false,
    splice: () => [],
  }
}

export const queueChecks: Check[] = [
  define('an empty inbox renders nothing', () => {
    assert(renderQueue(inbox([], [])) === undefined, 'no pending items means no card')
  }),

  define('steering heads the card, turns trail it, each with five ops', () => {
    setLocale('es')
    const stepA = fakeMessage('m1', 'corregí el typo')
    const stepB = fakeMessage('m2', 'y agregá el test')
    const turn = fakeMessage('m3', 'revisá el deploy')
    const rendered = renderQueue(inbox([stepA, stepB], [turn]))
    assert(rendered !== undefined, 'pending items render a card')
    if (rendered === undefined) return
    assert(rendered.items.length === 3, 'both lists land in the card')
    assert(rendered.items[0]?.message === stepA, 'steering items come first')
    assert(rendered.items[2]?.message === turn, 'turn items trail')
    assert(rendered.text.includes('Steering'), 'the steering section draws with its header')
    assert(rendered.text.includes('Turnos'), 'the turn section draws with its header')
    assert(rendered.text.includes('corregí el typo'), 'each item previews its text')
    assert(rendered.buttons.length === 3 * 5 + 1, 'five ops per item plus the footer')
    assert(rendered.buttons[5]?.text === '↑', 'the second item carries its own row')
    assert(rendered.buttons[4]?.callback === 'q:e:0', 'the edit op addresses the first item')
    assert(rendered.buttons[15]?.callback === 'q:order', 'the footer replays the arrangement')
  }),

  define('each section shows its live count from the inbox', () => {
    setLocale('es')
    const rendered = renderQueue(inbox([], [fakeMessage('only', 'turno único')]))
    if (rendered === undefined) return
    assert(!rendered.text.includes('Steering'), 'an empty steering section is not drawn')
    assert(rendered.text.includes('1'), 'the turn count reflects the inbox')
  }),
]
