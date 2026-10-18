/**
 * The bridge as an in-process remote client of its own profile's Gateway.
 *
 * `decisions: parallel` stops holding the approval and user-questions
 * waterfalls in-process (one listener either claims or delegates — never
 * both). Instead the bridge opens the Gateway-internal `$events` stream the
 * way the Desktop and Web clients do, so a request reaches every surface at
 * once: the app's panel and the phone's card render together, the first
 * answer wins, and the Gateway's own `cancel` frame retires the losing card.
 * With the app closed the bridge client keeps the requests alive, so the
 * phone answers alone; with the bridge down, the app answers alone.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: declares ctx.typertGateway for the remote answerer.
import type {} from '@deepseek-ai/dsh-api-gateway'

/** Gateway-internal endpoints of the forwarded-event stream and its result RPC. */
const REMOTE_EVENT_STREAM_ENDPOINT = '$events'
/** The result RPC splits its endpoint: namespace `$events`, method `result`. */
const REMOTE_EVENT_RESULT = { namespace: '$events', method: 'result' } as const
/** The stream opens with exactly this payload; the Gateway validates it. */
const REMOTE_EVENT_STREAM_PAYLOAD = { args: {} } as const

/** The two waterfalls this client claims for mirrored sessions. */
const HANDLED_EVENTS = new Set(['approval/request', 'user-questions/request'])

/** The minimal Gateway face this module drives — the in-process wire adapter and unary invoke. */
export interface RemoteGatewayLike {
  readonly wireStream: {
    open(
      endpoint: string,
      payload: unknown,
      uplink: AsyncIterable<unknown>,
      peer: undefined,
      signal: AbortSignal,
    ): Promise<AsyncIterable<unknown>>
  }
  invoke(request: { namespace: string, method: string, args: unknown, signal?: AbortSignal }): Promise<unknown>
}

/** What the remote answerer needs from the bridge. */
export interface RemoteAnswerDeps {
  /** Thread id for a session the bridge mirrors — only those claim requests. */
  threadOf: (sessionId: string) => number | undefined
  /**
   * Answer one waterfall request for a mirrored session and resolve its
   * outcome (the Telegram card's decision); never called otherwise.
   */
  onWaterfall: (
    event: string,
    agentId: string,
    request: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<unknown>
  /** Report a contained failure to the host logger. */
  notify: (message: string, error: unknown) => void
}

/** The Gateway-internal frames this client reads; same-process values, not wire input. */
type DownFrame =
  | { readonly type: 'ready', readonly clientId: string }
  | { readonly type: 'emit', readonly event: string, readonly args: readonly unknown[] }
  | { readonly type: 'waterfall', readonly event: string, readonly eventId: string, readonly agentId: string, readonly request: Record<string, unknown> }
  | { readonly type: 'cancel', readonly eventId: string }

/**
 * Run the remote answerer until `signal` aborts: open the event stream, claim
 * the handled waterfalls for mirrored sessions, and forward every outcome.
 * @param gateway - the profile's own Typert Gateway.
 * @param deps - mirrored-session lookup, the waterfall answerer, and the logger.
 * @param signal - the bridge's lifetime; aborting ends the client cleanly.
 * @param retryMs - backoff before reopening an ended stream.
 */
export async function pumpRemoteAnswers(
  gateway: RemoteGatewayLike,
  deps: RemoteAnswerDeps,
  signal: AbortSignal,
  retryMs = 2_000,
): Promise<void> {
  while (!signal.aborted) {
    const active = new Map<string, AbortController>()
    let clientId: string | undefined
    try {
      const stream = await gateway.wireStream.open(
        REMOTE_EVENT_STREAM_ENDPOINT,
        REMOTE_EVENT_STREAM_PAYLOAD,
        (async function* () {})(),
        undefined,
        signal,
      )
      for await (const raw of stream) {
        if (signal.aborted) return
        const frame = raw as DownFrame
        if (frame.type === 'ready') {
          clientId = frame.clientId
          continue
        }
        if (frame.type === 'cancel') {
          active.get(frame.eventId)?.abort(new Error('remote answers: the request was settled elsewhere'))
          continue
        }
        // Emit frames reach the bridge through its own in-process event
        // subscriptions; the remote stream carries only the waterfalls.
        if (frame.type !== 'waterfall' || clientId === undefined) continue
        if (!HANDLED_EVENTS.has(frame.event)) continue
        if (deps.threadOf(frame.agentId) === undefined) {
          // Not mirrored here: delegate so the app (or a later answerer) owns it.
          void sendResult(gateway, clientId, frame.eventId, { kind: 'next' }, signal)
            .catch((error: unknown) => deps.notify('remote answers: delegation failed', error))
          continue
        }
        const controller = new AbortController()
        active.set(frame.eventId, controller)
        const task = answerOne(gateway, deps, frame, clientId, controller, signal)
          .catch((error: unknown) => {
            if (!signal.aborted) deps.notify('remote answers: delivery failed', error)
          })
          .finally(() => active.delete(frame.eventId))
        void task
      }
    } catch (error) {
      if (signal.aborted) return
      deps.notify('remote answers: stream failed', error)
    }
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, retryMs)
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
}

/** Answer one waterfall: render on the phone, then forward the outcome to the Gateway. */
async function answerOne(
  gateway: RemoteGatewayLike,
  deps: RemoteAnswerDeps,
  frame: Extract<DownFrame, { type: 'waterfall' }>,
  clientId: string,
  controller: AbortController,
  lifetime: AbortSignal,
): Promise<void> {
  const deliverySignal = AbortSignal.any([lifetime, controller.signal])
  try {
    const outcome = await deps.onWaterfall(frame.event, frame.agentId, frame.request, deliverySignal)
    // A cancelled delivery means the request settled elsewhere; the card
    // already retired itself and the result would be a no-op.
    if (deliverySignal.aborted) return
    await sendResult(gateway, clientId, frame.eventId, { kind: 'result', value: outcome }, deliverySignal)
  } catch (error) {
    if (deliverySignal.aborted || lifetime.aborted) return
    // A failed render or send must not hang the host's waterfall: reject it.
    await sendResult(gateway, clientId, frame.eventId, {
      kind: 'rejected',
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    }, lifetime).catch(() => undefined)
  }
}

/** Forward one outcome through the Gateway-internal result RPC. */
function sendResult(
  gateway: RemoteGatewayLike,
  clientId: string,
  eventId: string,
  outcome: { kind: 'next' } | { kind: 'result', value?: unknown } | { kind: 'rejected', error: { name: string, message: string } },
  signal: AbortSignal,
): Promise<unknown> {
  return gateway.invoke({
    ...REMOTE_EVENT_RESULT,
    args: { args: { clientId, eventId, outcome } },
    signal,
  })
}

/**
 * Attach the remote answerer to the bridge's own fiber: the client lives as
 * long as the plugin, and its requests die with it.
 * @param ctx - bridge root context; `ctx.typertGateway` must be the profile's Gateway.
 * @param deps - mirrored-session lookup, the waterfall answerer, and the logger.
 */
export function attachRemoteAnswerer(ctx: Context, deps: RemoteAnswerDeps): void {
  ctx.effect(() => {
    const lifetime = new AbortController()
    const gateway = ctx.typertGateway as RemoteGatewayLike | undefined
    if (gateway === undefined) {
      deps.notify('remote answers: the profile composes no typert Gateway', undefined)
      return () => lifetime.abort()
    }
    void pumpRemoteAnswers(gateway, deps, lifetime.signal)
    return () => lifetime.abort()
  }, 'tg-bridge.remote-answers')
}
