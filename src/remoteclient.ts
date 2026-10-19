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
 *
 * Answers travel the Connection's `/api` RPC interception — the same path
 * the browser clients take — because the Gateway's unary `invoke` resolves
 * descriptors only for registered Remote methods, and `$events/result` is an
 * interception, not one.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: declares ctx.typertGateway for the remote answerer.
import type {} from '@deepseek-ai/dsh-api-gateway'
import { safe } from './log.ts'

/** Gateway-internal endpoint of the forwarded-event stream. */
const REMOTE_EVENT_STREAM_ENDPOINT = '$events'
/** The result RPC's endpoint, claimed by the Connection's /api interception. */
const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'
/** The stream opens with exactly this payload; the Gateway validates it. */
const REMOTE_EVENT_STREAM_PAYLOAD = { args: {} } as const

/** The two waterfalls this client claims for mirrored sessions. */
const HANDLED_EVENTS = new Set(['approval/request', 'user-questions/request'])

/** One delivered request's answer, as the result RPC carries it. */
export type RemoteEventOutcome =
  | { kind: 'next' }
  | { kind: 'result'; value?: unknown }
  | { kind: 'rejected'; error: { name: string, message: string } }

/**
 * The minimal Gateway face this module drives: the in-process wire adapter
 * for the event stream, and the Connection RPC path for answers.
 */
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
  /** Forward one outcome through the Connection's /api result interception. */
  callResult(result: { clientId: string, eventId: string, outcome: RemoteEventOutcome }, signal: AbortSignal): Promise<void>
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

/**
 * What `/status` reads: the client's stage and its frame accounting, so a
 * missing card is diagnosable from the phone in one command.
 */
export interface RemoteAnswererStatus {
  /** `absent` until both services resolve; `attached` with a live stream; `reconnecting` after a failure. */
  stage: 'absent' | 'attached' | 'reconnecting'
  /** Waterfalls received for mirrored sessions (a card rendered for each). */
  handled: number
  /** Answers that reached the Connection RPC and settled the request. */
  answered: number
  /** Waterfalls delegated because the session has no thread here. */
  delegated: number
  /** Cancel frames: the request settled elsewhere or its turn died. */
  cancelled: number
  /** The failure behind a `reconnecting` stage, when one is known. */
  lastError?: string | undefined
}

/** The fresh status an attach call fills in as it runs. */
export function createRemoteAnswererStatus(): RemoteAnswererStatus {
  return { stage: 'absent', handled: 0, answered: 0, delegated: 0, cancelled: 0 }
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
 * @param gateway - the profile's own Typert Gateway face.
 * @param deps - mirrored-session lookup, the waterfall answerer, and the logger.
 * @param status - the observable accounting `/status` reads.
 * @param signal - the bridge's lifetime; aborting ends the client cleanly.
 * @param retryMs - backoff before reopening an ended stream.
 */
export async function pumpRemoteAnswers(
  gateway: RemoteGatewayLike,
  deps: RemoteAnswerDeps,
  status: RemoteAnswererStatus,
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
          status.stage = 'attached'
          status.lastError = undefined
          continue
        }
        if (frame.type === 'cancel') {
          status.cancelled += 1
          active.get(frame.eventId)?.abort(new Error('remote answers: the request was settled elsewhere'))
          continue
        }
        // Emit frames reach the bridge through its own in-process event
        // subscriptions; the remote stream carries only the waterfalls.
        if (frame.type !== 'waterfall' || clientId === undefined) continue
        if (!HANDLED_EVENTS.has(frame.event)) continue
        if (deps.threadOf(frame.agentId) === undefined) {
          // Not mirrored here: delegate so the app (or a later answerer) owns it.
          status.delegated += 1
          void sendResult(gateway, clientId, frame.eventId, { kind: 'next' }, signal)
            .catch((error: unknown) => deps.notify('remote answers: delegation failed', error))
          continue
        }
        status.handled += 1
        const controller = new AbortController()
        active.set(frame.eventId, controller)
        const task = answerOne(gateway, deps, status, frame, clientId, controller, signal)
          .catch((error: unknown) => {
            if (!signal.aborted) deps.notify('remote answers: delivery failed', error)
          })
          .finally(() => active.delete(frame.eventId))
        void task
      }
    } catch (error) {
      if (signal.aborted) return
      status.stage = 'reconnecting'
      status.lastError = describe(error).slice(0, 400)
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
  status: RemoteAnswererStatus,
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
    status.answered += 1
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

/** Forward one outcome through the Connection's /api result interception. */
function sendResult(
  gateway: RemoteGatewayLike,
  clientId: string,
  eventId: string,
  outcome: RemoteEventOutcome,
  signal: AbortSignal,
): Promise<void> {
  return gateway.callResult({ clientId, eventId, outcome }, signal)
}

/**
 * One stable line for `/status`: the error plus its first stack frames, so a
 * reconnecting stage names the throwing call site from the phone.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return safe(error)
  const frames = (error.stack ?? '')
    .split('\n')
    .slice(1, 5)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' | ')
  return frames.length > 0 ? `${safe(error)} @ ${frames}` : safe(error)
}

/** The Connection's RPC face the result interception answers through. */
interface ConnectionRpcLike {
  rpc: {
    call(
      path: '/api',
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<{ ok: boolean, error?: { message: string } }>
  }
}

/**
 * Attach the remote answerer to the bridge's own fiber: the client lives as
 * long as the plugin, and its requests die with it. Either service may mount
 * after the bridge does — an absent one retries on a timer instead of giving
 * up, so a slow-starting profile still gets parallel answers.
 * @param ctx - bridge root context; the profile's own Gateway and Connection.
 * @param deps - mirrored-session lookup, the waterfall answerer, and the logger.
 * @param status - the observable accounting `/status` reads.
 */
export function attachRemoteAnswerer(ctx: Context, deps: RemoteAnswerDeps, status: RemoteAnswererStatus): void {
  ctx.effect(() => {
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let loggedAbsent = false
    const probe = (): void => {
      // Optional services read through the strict global store; the ctx
      // property proxy would demand a declared inject here.
      const gateway = ctx.get('typertGateway') as Pick<RemoteGatewayLike, 'wireStream'> | undefined
      const connection = ctx.get('connection') as ConnectionRpcLike | undefined
      if (gateway === undefined || connection === undefined) {
        if (!loggedAbsent) {
          deps.notify('remote answers: the typert Gateway or Connection is not up yet — retrying every 5s', undefined)
          loggedAbsent = true
        }
        status.stage = 'absent'
        timer = setTimeout(probe, 5_000)
        return
      }
      const face: RemoteGatewayLike = {
        wireStream: gateway.wireStream,
        callResult: async (result, signal) => {
          const response = await connection.rpc.call('/api', REMOTE_EVENT_RESULT_ENDPOINT, { args: result }, signal)
          if (!response.ok) throw new Error(response.error?.message ?? 'remote answers: the result RPC failed')
        },
      }
      void pumpRemoteAnswers(face, deps, status, lifetime.signal)
    }
    probe()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      lifetime.abort()
    }
  }, 'tg-bridge.remote-answers')
}
