/**
 * Entry point of the test suite.
 */
import { renderChecks } from './render.check.ts'
import { stateChecks } from './state.check.ts'
import { ownershipChecks } from './ownership.check.ts'
import { ingestChecks } from './ingest.check.ts'
import { mediaOutChecks } from './media-out.check.ts'
import { localeChecks } from './locale.check.ts'
import { cardsChecks } from './cards.check.ts'
import { streamChecks } from './stream.check.ts'
import { answererChecks } from './answerers.check.ts'
import { rebuildChecks } from './rebuild.check.ts'
import { fsbrowseChecks } from './fsbrowse.check.ts'
import type { Check } from './harness.ts'

const checks: Check[] = [
  ...renderChecks,
  ...stateChecks,
  ...ownershipChecks,
  ...ingestChecks,
  ...mediaOutChecks,
  ...localeChecks,
  ...cardsChecks,
  ...streamChecks,
  ...answererChecks,
  ...rebuildChecks,
  ...fsbrowseChecks,
]

let failed = 0
for (const check of checks) {
  try {
    await check.run()
    process.stdout.write(`ok   ${check.name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`FAIL ${check.name}\n     ${error instanceof Error ? error.stack : String(error)}\n`)
  }
}

process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`)
if (failed > 0) process.exit(1)
