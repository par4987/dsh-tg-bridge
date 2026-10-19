/**
 * The parallel-decision remote client: $events frames in, results out,
 * mirrored sessions claimed, everything else delegated.
 */
import { assert, define, type Check } from './harness.ts'
import {
  createRemoteAnswererStatus, pumpRemoteAnswers,
  type RemoteGatewayLike,
} from '../src/remoteclient.ts'

/** One scripted $events stream plus every result the client sent back. */
class FakeGateway implements RemoteGatewayLike {
  /** Streams the scripted open() calls hand out, one per (re)connect. */
  readonly opens: Array<{ payload: unknown, frames: Array<unknown> }> = []
  /** Every result the client forwarded, in order. */
  readonly results: Array<{ clientId: string, eventId: string, outcome: unknown }> = []
  private openCalls = 0

  constructor(private readonly scripts: Array<Array<unknown>>) {}

  readonly wireStream = {
    open: async (_endpoint: string, payload: unknown, _uplink: AsyncIterable<unknown>, _peer: undefined, _signal: AbortSignal) => {
      const index = this.openCalls++
      const frames = [...(this.scripts[index] ?? [])]
      this.opens.push({ payload, frames })
      return (async function* () {
        for (const frame of frames) yield frame
      })()
    },
  }

  async callResult(result: { clientId: string, eventId: string, outcome: unknown }): Promise<void> {
    this.results.push(result)
  }
}

/** Script a waterfall frame the way the Gateway delivers it. */
const waterfall = (eventId: string, agentId: string, event: string, request: Record<string, unknown> = {}): unknown => ({
  type: 'waterfall',
  event,
  eventId,
  agentId,
  request,
})

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

export const remoteClientChecks: Check[] = [
  define('a mirrored session is answered through the result RPC', async () => {
    const gateway = new FakeGateway([
      [{ type: 'ready', clientId: 'cli-1', host: { home: '/home/x' } }, waterfall('ev-1', 'ses-1', 'approval/request', { toolName: 'bash' })],
    ])
    const status = createRemoteAnswererStatus()
    const answered: Array<{ event: string, agentId: string, signal: AbortSignal }> = []
    const lifetime = new AbortController()
    void pumpRemoteAnswers(gateway, {
      threadOf: (sessionId: string) => (sessionId === 'ses-1' ? 5 : undefined),
      onWaterfall: async (event, agentId, _request, signal) => {
        answered.push({ event, agentId, signal })
        return 'allowed-once'
      },
      notify: () => undefined,
    }, status, lifetime.signal, 10)
    await settle()
    lifetime.abort()
    assert(answered.length === 1, `the mirrored session was claimed (got ${answered.length})`)
    assert(answered[0]?.event === 'approval/request', 'the approval reached the answerer')
    assert(gateway.results.length === 1, 'one result went back')
    const result = gateway.results[0]
    assert(result?.clientId === 'cli-1' && result?.eventId === 'ev-1', 'the result carries its correlation')
    assert(result?.outcome !== undefined && (result?.outcome as { kind: string }).kind === 'result', 'the outcome is a result')
    assert((result?.outcome as { value?: unknown }).value === 'allowed-once', "the answerer's outcome travels")
    assert(status.stage === 'attached' && status.handled === 1 && status.answered === 1, 'the status counted the delivery')
  }),

  define('an unmirrored session delegates without waking the answerer', async () => {
    const gateway = new FakeGateway([
      [{ type: 'ready', clientId: 'cli-2', host: { home: '/home/x' } }, waterfall('ev-2', 'ses-other', 'approval/request')],
    ])
    const status = createRemoteAnswererStatus()
    const answered: Array<unknown> = []
    const lifetime = new AbortController()
    pumpRemoteAnswers(gateway, {
      threadOf: () => undefined,
      onWaterfall: async () => { answered.push('woke'); return 'allowed-once' },
      notify: () => undefined,
    }, status, lifetime.signal, 10)
    await settle()
    lifetime.abort()
    assert(answered.length === 0, 'the answerer never woke for a foreign session')
    assert(gateway.results.length === 1, 'the client answered once')
    assert((gateway.results[0]?.outcome as { kind: string }).kind === 'next', 'the answer delegated to the other surfaces')
    assert(status.delegated === 1, 'the status counted the delegation')
  }),

  define('a cancel frame aborts the pending delivery', async () => {
    const gateway = new FakeGateway([
      [
        { type: 'ready', clientId: 'cli-3', host: { home: '/home/x' } },
        waterfall('ev-3', 'ses-1', 'approval/request'),
        { type: 'cancel', eventId: 'ev-3' },
      ],
    ])
    const status = createRemoteAnswererStatus()
    const answered: Array<{ signal: AbortSignal }> = []
    const lifetime = new AbortController()
    pumpRemoteAnswers(gateway, {
      threadOf: (sessionId: string) => (sessionId === 'ses-1' ? 5 : undefined),
      onWaterfall: async (_event, _agentId, _request, signal) => {
        answered.push({ signal })
        // The answerer holds its card open until the cancel aborts it.
        return new Promise<unknown>((resolve) => {
          signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
        })
      },
      notify: () => undefined,
    }, status, lifetime.signal, 10)
    await settle()
    lifetime.abort()
    assert(answered.length === 1, 'the delivery started')
    assert(answered[0]?.signal.aborted === true, 'the cancel frame aborted the delivery signal')
    assert(gateway.results.length === 0, 'a cancelled delivery sends no result')
    assert(status.cancelled === 1, 'the status counted the cancellation')
  }),

  define('an ended stream reconnects until the lifetime aborts', async () => {
    const gateway = new FakeGateway([
      [{ type: 'ready', clientId: 'cli-4', host: { home: '/home/x' } }],
      [{ type: 'ready', clientId: 'cli-5', host: { home: '/home/x' } }, waterfall('ev-5', 'ses-1', 'approval/request')],
    ])
    const status = createRemoteAnswererStatus()
    const answered: Array<unknown> = []
    const lifetime = new AbortController()
    void pumpRemoteAnswers(gateway, {
      threadOf: (sessionId: string) => (sessionId === 'ses-1' ? 5 : undefined),
      onWaterfall: async () => { answered.push('yes'); return 'allowed-once' },
      notify: () => undefined,
    }, status, lifetime.signal, 10)
    await settle()
    assert(gateway.opens.length === 2, `the stream reconnected (got ${gateway.opens.length})`)
    assert(answered.length === 1, 'the second generation answered a request')
    lifetime.abort()
    await settle()
    assert(gateway.opens.length === 2, 'an aborted lifetime stops reconnecting')
  }),
]
