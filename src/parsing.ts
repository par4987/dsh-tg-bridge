/**
 * Argument parsers shared by the command surface and the tests — pure, with
 * no harness dependency chain, so the suite can drive them directly.
 */

/**
 * Parse a `<provider>/<model>` argument; the model keeps every further slash
 * (models like `z-ai/glm-5.3` are their provider's own namespaced id).
 * @returns the pair, or undefined when the argument has no provider slash.
 */
export function parseModelArg(arg: string): { provider: string, model: string } | undefined {
  const trimmed = arg.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash >= trimmed.length - 1) return undefined
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) }
}
