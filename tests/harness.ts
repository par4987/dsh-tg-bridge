/**
 * The suite runner: imports every check module and tallies pass/fail.
 *
 * Every check imports only pure modules — no harness package, no network —
 * so the whole suite runs on plain `node` (TypeScript type stripping is
 * native on the engines range) in CI and locally alike.
 */

/** Fail the enclosing check with a visible message. */
export function assert(condition: unknown, message: string): void {
  if (condition === true || (condition as boolean) === true && typeof condition === 'boolean') {
    if (condition) return
  }
  if (!condition) throw new Error(`assert failed: ${message}`)
}

/** Fail unless the callback throws. */
export async function throws(fn: () => unknown | Promise<unknown>, message: string): Promise<void> {
  try {
    await fn()
  } catch {
    return
  }
  throw new Error(`assert failed (expected a throw): ${message}`)
}

export interface Check {
  readonly name: string
  readonly run: () => void | Promise<void>
}

/** Collect checks from one module's default export shape. */
export function define(name: string, run: () => void | Promise<void>): Check {
  return { name, run }
}
