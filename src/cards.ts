/**
 * Picker state bound to the message that carries its keyboard.
 *
 * A button's action must only ever address the card it lives in: when state
 * rode in one global, a second card silently rebound the first thread's
 * already-drawn keyboard, and a tap on the old card acted on the newer
 * session. State rides on the message id; a cap keeps a tapper's history
 * from growing without bound.
 */
export class MessageCards<T> {
  private readonly map = new Map<number, T>()

  constructor(private readonly cap = 30) {}

  /** Bind state to a message; the oldest binding is evicted at the cap. */
  set(messageId: number, state: T): void {
    this.map.set(messageId, state)
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  /** The state of THIS message's card, if the card is still around. */
  get(messageId: number | undefined): T | undefined {
    return messageId === undefined ? undefined : this.map.get(messageId)
  }

  /** Drop one card — a settled action must not be replayed by a second tap. */
  drop(messageId: number | undefined): void {
    if (messageId !== undefined) this.map.delete(messageId)
  }
}
