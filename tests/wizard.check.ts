/** The reminder wizard: state-backed drafts survive a restart mid-conversation. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, define, type Check } from './harness.ts'
import { BridgeState } from '../src/state.ts'
import { feedWizard, splitWeeklyDetail } from '../src/wizard.ts'
import { parseModelArg } from '../src/parsing.ts'
import type { CommandDeps } from '../src/commands.ts'

/** Minimal deps: everything before the confirm step only needs the state. */
const depsOf = (state: BridgeState): CommandDeps => ({ state }) as unknown as CommandDeps

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'tg-wizard-'))
}

export const wizardChecks: Check[] = [
  define('a half-answered wizard resumes after a restart', async () => {
    const dir = freshDir()
    const file = join(dir, 'state.json')
    const before = new BridgeState(file)
    before.setWizard('ses-1', { step: 'name', name: '', prompt: '' })
    const reply = await feedWizard(depsOf(before), 'ses-1', 'Regaderas')
    assert(reply !== undefined && reply.length > 0, 'the first answer advances the wizard')

    // A restart reads the same state file: the conversation resumes at 'prompt'.
    const after = new BridgeState(file)
    const draft = after.wizardOf('ses-1')
    assert(draft?.step === 'prompt', `the step persisted (got ${draft?.step})`)
    assert(draft?.name === 'Regaderas', 'the answered name persisted')
    const resumed = await feedWizard(depsOf(after), 'ses-1', 'Regar las plantas del balcón')
    assert(after.wizardOf('ses-1')?.step === 'type', 'the resumed conversation advances further')
    assert(resumed !== undefined, 'the resumed step answered')
    rmSync(dir, { recursive: true, force: true })
  }),

  define('cancel clears the draft durably', async () => {
    const dir = freshDir()
    const file = join(dir, 'state.json')
    const state = new BridgeState(file)
    state.setWizard('ses-2', { step: 'type', name: 'X', prompt: 'Y' })
    const reply = await feedWizard(depsOf(state), 'ses-2', 'cancelar')
    assert(reply !== undefined && reply.length > 0, 'cancel answers')
    const reloaded = new BridgeState(file)
    assert(reloaded.wizardOf('ses-2') === undefined, 'the cleared draft is gone on disk')
    rmSync(dir, { recursive: true, force: true })
  }),

  define('model arguments split on the first slash only', () => {
    const parsed = parseModelArg('nvidia/z-ai/glm-5.3')
    assert(parsed?.provider === 'nvidia', 'the provider is the first segment')
    assert(parsed?.model === 'z-ai/glm-5.3', 'the model keeps its own slashes')
    assert(parseModelArg('glm') === undefined, 'a name without a provider slash is rejected')
    assert(parseModelArg('/glm') === undefined, 'an empty provider is rejected')
    assert(parseModelArg('nvidia/') === undefined, 'an empty model is rejected')
  }),

  define('weekly details resolve the ISO weekday from the locale day name', () => {
    assert(splitWeeklyDetail('lun 09:00')?.weekday === 1, 'Monday is ISO 1')
    assert(splitWeeklyDetail('dom 09:00')?.weekday === 7, 'Sunday is ISO 7')
    assert(splitWeeklyDetail('VIE 17:30')?.time === '17:30', 'the time rides along, case-insensitive')
    assert(splitWeeklyDetail('funday 09:00') === undefined, 'an unknown day is rejected')
    assert(splitWeeklyDetail('lun') === undefined, 'a missing time is rejected')
  }),

  define('a confirmed wizard writes the record through the Host schedule service', async () => {
    const dir = freshDir()
    const state = new BridgeState(join(dir, 'state.json'))
    const created: Array<{ sessionId: string, request: Record<string, unknown> }> = []
    const fakeSchedule = {
      create: async (sessionId: string, request: Record<string, unknown>) => {
        created.push({ sessionId, request })
        return { id: 'r1', prompt: String(request.prompt), scheduledAt: '2026-12-01T12:00:00Z' }
      },
      list: async () => [],
      delete: async () => ({ deleted: true }),
    }
    const deps = {
      state,
      ctx: { get: (name: string) => (name === 'schedule' ? fakeSchedule : undefined) },
    } as unknown as CommandDeps
    state.setWizard('ses-1', { step: 'name', name: '', prompt: '' })
    await feedWizard(deps, 'ses-1', 'Regaderas')
    await feedWizard(deps, 'ses-1', 'Regar las plantas')
    await feedWizard(deps, 'ses-1', '1')
    await feedWizard(deps, 'ses-1', '2026-12-01 09:00')
    const reply = await feedWizard(deps, 'ses-1', 'sí')
    assert(reply !== undefined && reply.length > 0, 'the confirm answers')
    assert(created.length === 1, `one record reached the service (got ${created.length})`)
    assert(created[0]?.sessionId === 'ses-1', 'the record is bound to the session')
    const request = created[0]?.request
    assert(request?.title === 'Regaderas', 'the wizard name becomes the task title')
    assert(request?.prompt === 'Regar las plantas', 'the prompt stays separate')
    const at = request?.at as { date: string, time: string, time_zone: string } | undefined
    assert(at?.date === '2026-12-01' && at?.time === '09:00', 'the once detail becomes the at selector')
    assert(typeof at?.time_zone === 'string' && at.time_zone.length > 0, 'the local zone travels with it')
    assert(state.wizardOf('ses-1') === undefined, 'the draft is cleared after the create')
    rmSync(dir, { recursive: true, force: true })
  }),

  define('a host error at confirm reports honestly and keeps no draft', async () => {
    const dir = freshDir()
    const state = new BridgeState(join(dir, 'state.json'))
    const fakeSchedule = {
      create: async () => { throw new Error('not_future') },
      list: async () => [],
      delete: async () => ({ deleted: true }),
    }
    const deps = {
      state,
      ctx: { get: (name: string) => (name === 'schedule' ? fakeSchedule : undefined) },
    } as unknown as CommandDeps
    state.setWizard('ses-2', { step: 'confirm', name: 'X', prompt: 'Y', type: 'once', detail: '2020-01-01 09:00' })
    const reply = await feedWizard(deps, 'ses-2', 'sí')
    assert(reply !== undefined && reply.includes('not_future'), 'the failure text reaches the phone')
    assert(state.wizardOf('ses-2') === undefined, 'the draft cleared even on failure')
    rmSync(dir, { recursive: true, force: true })
  }),
]
