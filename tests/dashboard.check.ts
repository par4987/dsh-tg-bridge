/** The dashboard: the pinning store and the pure render. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, define, type Check } from './harness.ts'
import { setLocale } from '../src/locale.ts'
import { DashboardStore, renderDashboard, type DashboardFacts } from '../src/dashboard.ts'

function freshStore(): DashboardStore {
  const dir = mkdtempSync(join(tmpdir(), 'tg-bridge-dash-'))
  return new DashboardStore(join(dir, 'dashboard.json'))
}

export const dashboardChecks: Check[] = [
  define('a fresh store pins nothing', () => {
    const store = freshStore()
    assert(store.of('ses-1') === undefined, 'no session has a pin yet')
  }),

  define('set, remember and remove round-trip through the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-bridge-dash-'))
    const first = new DashboardStore(join(dir, 'dashboard.json'))
    first.set('ses-1', 4242)
    first.rememberText('ses-1', 'panel text')
    const second = new DashboardStore(join(dir, 'dashboard.json'))
    const pin = second.of('ses-1')
    assert(pin?.messageId === 4242, 'the pin survives a restart')
    assert(pin?.lastText === 'panel text', 'the remembered text survives too')
    second.remove('ses-1')
    assert(second.of('ses-1') === undefined, 'the pin is gone after remove')
    rmSync(dir, { recursive: true, force: true })
  }),

  define('renderDashboard draws title, status, route and usage', () => {
    setLocale('es')
    const facts: DashboardFacts = {
      title: 'Arreglar el build',
      running: true,
      route: 'intern/Atria-Dawn',
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      lastUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }
    const text = renderDashboard(facts)
    assert(text.includes('Arreglar el build'), 'the title heads the panel')
    assert(text.includes('🔴'), 'a running session shows red')
    assert(text.includes('intern/Atria-Dawn'), 'the route draws when the session runs')
    assert(text.includes('100'), 'last-turn tokens draw')
    assert(text.includes('1000'), 'accumulated tokens draw')
  }),

  define('renderDashboard falls back for an idle, unknown session', () => {
    setLocale('es')
    const idle = renderDashboard({ running: false })
    assert(idle.includes('⚪'), 'an idle session shows white')
    assert(idle.includes('(sin título)'), 'a session without a title falls back to no_title')
    assert(!idle.includes('Ruta:'), 'no route draws when the session is idle')
    assert(!idle.includes('Acumulado:'), 'no usage draws when none was committed')
  }),
]
