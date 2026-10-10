/**
 * The reminder matcher `/taskcancel` argues with — pure, so the tests can
 * drive it without the harness dependency chain.
 */

/**
 * The record a `/taskcancel` argument addresses: the id itself, an id prefix,
 * or a substring of its prompt; with no argument, the last created one.
 * @param active - records the session's folded schedule history still holds.
 * @param query - the raw argument text after the command name.
 * @returns the addressed record, or undefined when no active one matches.
 */
export function matchScheduleRecord<T extends { id: string, prompt: string }>(
  active: ReadonlyArray<T>,
  query: string,
): T | undefined {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return active[active.length - 1]
  return active.find((record) =>
    record.id.toLowerCase() === needle
    || record.id.toLowerCase().startsWith(needle)
    || record.prompt.toLowerCase().includes(needle))
}
