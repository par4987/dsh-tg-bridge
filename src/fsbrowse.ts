/**
 * Bounded directory traversal for the Telegram file browser.
 *
 * The harness filesystem seam exposes only `listDir`; the walk lives here so
 * `/ffind` stays pure enough to test: it takes the listing function, never a
 * service, and every bound (depth, visited directories, results) is a
 * parameter the caller sets.
 */

/** Structural face of the harness `FsTarget` — an opaque key plus the path shown to the user. */
export interface FsTargetLike {
  targetKey: string
  displayPath: string
}

/** Structural face of the harness `FsDirEntry` as the browser consumes it. */
export interface FsDirEntryLike {
  name: string
  type: 'file' | 'directory' | 'other'
  target: FsTargetLike
  size?: number
}

/** Structural face of the harness `FileSystem` service the browser drives. */
export interface FileSystemLike {
  resolve(path: string, opts?: { cwd?: string, signal?: AbortSignal }): Promise<FsTargetLike>
  listDir(target: FsTargetLike, signal?: AbortSignal): Promise<FsDirEntryLike[]>
  readText(target: FsTargetLike, signal?: AbortSignal): Promise<string>
}

/** One match `/ffind` reports. */
export interface FoundEntry {
  name: string
  displayPath: string
  type: 'file' | 'directory' | 'other'
  size?: number
}

/** Every bound of one walk; the caller owns each value. */
export interface WalkLimits {
  /** Directories deep the walk descends past the start. */
  maxDepth: number
  /** Total `listDir` calls; the walk stops when it spends the last one. */
  maxDirs: number
  /** Matches collected before the walk stops. */
  maxResults: number
}

/** Directory names the walk never enters — dependency roots and build output. */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'lib', 'build', 'out', 'target',
  '.venv', 'venv', '__pycache__', '.cache', '.next', 'coverage',
])

/**
 * Breadth-first walk matching entry names against a case-insensitive substring.
 * @param listDir - listing function over resolved targets; a rejected call
 *   ends that branch, never the walk.
 * @param start - directory the walk opens first.
 * @param query - substring an entry name must contain.
 * @param limits - every walk bound; the caller pins it.
 * @returns matches in visit order, capped at `limits.maxResults`.
 */
export async function findEntries(
  listDir: (target: FsTargetLike) => Promise<FsDirEntryLike[]>,
  start: FsTargetLike,
  query: string,
  limits: WalkLimits,
): Promise<FoundEntry[]> {
  const needle = query.toLowerCase()
  const results: FoundEntry[] = []
  const seen = new Set<string>()
  const queue: Array<{ target: FsTargetLike, depth: number }> = [{ target: start, depth: 0 }]
  let visits = 0
  while (queue.length > 0 && visits < limits.maxDirs && results.length < limits.maxResults) {
    const next = queue.shift()
    if (next === undefined) break
    if (seen.has(next.target.targetKey)) continue
    seen.add(next.target.targetKey)
    visits += 1
    let entries: FsDirEntryLike[]
    try {
      entries = await listDir(next.target)
    } catch {
      // An unreadable directory ends its own branch; the walk continues.
      continue
    }
    for (const entry of entries) {
      if (entry.name.toLowerCase().includes(needle)) {
        results.push({
          name: entry.name,
          displayPath: entry.target.displayPath,
          type: entry.type,
          ...(entry.size !== undefined ? { size: entry.size } : {}),
        })
        if (results.length >= limits.maxResults) break
      }
      if (
        entry.type === 'directory' && next.depth < limits.maxDepth
        && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')
      ) {
        queue.push({ target: entry.target, depth: next.depth + 1 })
      }
    }
  }
  return results
}
