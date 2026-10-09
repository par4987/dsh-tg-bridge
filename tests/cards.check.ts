/** MessageCards: card state rides on the message that carries its keyboard. */
import { assert, define, type Check } from './harness.ts'
import { MessageCards } from '../src/cards.ts'

export const cardsChecks: Check[] = [
  define('state binds to its own message', () => {
    const cards = new MessageCards<string>()
    cards.set(1, 'uno')
    cards.set(2, 'dos')
    assert(cards.get(1) === 'uno', 'message 1 keeps its own state')
    assert(cards.get(2) === 'dos', 'message 2 keeps its own state')
  }),

  define('a settled card drops its state', () => {
    const cards = new MessageCards<number>()
    cards.set(10, 99)
    cards.drop(10)
    assert(cards.get(10) === undefined, 'a dropped card answers nothing')
  }),

  define('the cap evicts the oldest binding', () => {
    const cards = new MessageCards<number>(3)
    cards.set(1, 1)
    cards.set(2, 2)
    cards.set(3, 3)
    cards.set(4, 4)
    assert(cards.get(1) === undefined, 'the oldest binding is evicted')
    assert(cards.get(4) === 4, 'the newest binding stays')
  }),

  define('an undefined message id has no card', () => {
    const cards = new MessageCards<string>()
    cards.set(1, 'uno')
    assert(cards.get(undefined) === undefined, 'no message means no card')
  }),
]
