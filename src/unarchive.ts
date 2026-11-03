/**
 * The archived-session picker behind `/unarchive`: one button per sleeping
 * session, eight rows per page, with the pure render the suite drives.
 *
 * The rows themselves come from the bridge state (the title and last
 * activity each mapping remembers); this module only lays them out and
 * addresses the tap callbacks against the global candidate index.
 */
import { escapeHtml } from './render.ts'
import { t } from './locale.ts'
import type { CardPayload } from './commands.ts'

/** One archived session as the picker renders it: id, title and last activity. */
export interface ArchivedRow {
  id: string
  title: string
  ago: string
}

/** How many archived rows one picker page draws. */
export const UNARCHIVE_PAGE = 8

/**
 * The archived picker's text and payload for one page.
 * @param rows - every candidate, freshest first (the caller filtered).
 * @param page - the zero-based page to draw.
 */
export function renderUnarchive(rows: ArchivedRow[], page: number): { text: string, payload: CardPayload } {
  const pages = Math.max(1, Math.ceil(rows.length / UNARCHIVE_PAGE))
  const slice = rows.slice(page * UNARCHIVE_PAGE, (page + 1) * UNARCHIVE_PAGE)
  const lines = [t('unarchive_header', { n: rows.length, page: page + 1, pages })]
  for (const row of slice) {
    lines.push(t('unarchive_row', { title: escapeHtml(row.title), ago: row.ago }))
  }
  const buttons = slice.map((row, index) => ({
    text: `📂 ${row.title}`.slice(0, 60),
    callback: `u:${page * UNARCHIVE_PAGE + index}`,
  }))
  if (page > 0) buttons.push({ text: '⬅️', callback: `ua:${page - 1}` })
  if (page < pages - 1) buttons.push({ text: '➡️', callback: `ua:${page + 1}` })
  return {
    text: lines.join(''),
    payload: { kind: 'unarchive', buttons, candidates: rows.map((row) => row.id), page, query: '' },
  }
}
