/**
 * Direct shell execution for the command surface: `/sh`, `/git` and
 * `/worktree` run through the harness's own shell service instead of the
 * agent, exactly like opencode-tg ran them inside the session.
 *
 * The service seam is explicit: a caller's request goes to `resolve()`,
 * which fills and caps the required fields from the implementation's config,
 * and the resolved spec goes to `run()`. The output the phone sees never
 * reaches the model, so nothing model-visible escapes the session log. When
 * the profile composes no executor, every command answers honestly instead
 * of silently falling back behind the agent's back.
 *
 * @module dsh-tg-bridge/shell
 */

/** A caller's execution request — the fields the bridge fills itself. */
export interface ShellExecRequestLike {
  command: string
  /** Working directory override (default: implementation-configured). */
  workdir?: string | undefined
  /** Timeout override in milliseconds (implementations cap it). */
  timeoutMs?: number | undefined
  /** Foreground stdout capture budget in bytes. */
  stdoutMaxBytes?: number | undefined
  /** Abort signal — implementations kill the command when it fires. */
  signal?: AbortSignal | undefined
}

/** A resolved execution spec as `resolve()` hands it back. */
export interface ShellExecSpecLike {
  command: string
  workdir: string
  timeoutMs: number
  stdoutMaxBytes: number
  signal?: AbortSignal | undefined
}

/** One captured stream: the (possibly truncated) tail plus spill recovery. */
export interface CollectedOutputLike {
  text: string
  truncated: boolean
  spillPath?: string | undefined
}

/** The outcome of a foreground run. */
export interface ShellRunResultLike {
  exitCode: number | null
  timedOut: boolean
  stdout: CollectedOutputLike
  stderr: CollectedOutputLike
  /** Sandbox facts, present iff a sandboxing executor handled the run. */
  sandbox?: { denied: boolean } | undefined
}

/**
 * The `ctx.shell` surface the bridge speaks to — the Service Definition's
 * request/spec split, trimmed to the two methods the commands need.
 */
export interface ShellLike {
  /** Fill and cap the required fields of an execution request. */
  resolve(request: ShellExecRequestLike): ShellExecSpecLike
  /** Run one resolved spec to completion in the foreground. */
  run(spec: ShellExecSpecLike): Promise<ShellRunResultLike>
}

/** One command's run: its streams and exit disposition. */
export interface ShellOutcome {
  kind: 'ran'
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** True when a sandboxing executor denied a file operation. */
  denied: boolean
}

/** The profile composes no shell executor — the command cannot run. */
export interface ShellUnavailable {
  kind: 'unavailable'
}

/** What a shell command came back with: a run, or the executor's absence. */
export type ShellResult = ShellOutcome | ShellUnavailable

/**
 * Run one command in a working directory, bounded by a timeout.
 * @param shell - the executor, read through `ctx.get('shell')`; undefined
 *   answers `unavailable` so the command surface reports it honestly.
 * @param command - the full command line.
 * @param cwd - the working directory (the session's own, by design).
 * @param timeoutMs - the deadline; the executor kills the process when it fires.
 * @returns the run's streams and exit disposition, or the executor's absence.
 */
export async function runShell(
  shell: ShellLike | undefined,
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ShellResult> {
  if (shell === undefined) return { kind: 'unavailable' }
  const spec = shell.resolve({ command, workdir: cwd, timeoutMs, stdoutMaxBytes: 16 * 1024 })
  const result = await shell.run(spec)
  return {
    kind: 'ran',
    exitCode: result.exitCode,
    stdout: result.stdout.text,
    stderr: result.stderr.text,
    timedOut: result.timedOut,
    denied: result.sandbox?.denied === true,
  }
}

/**
 * Run a `git` invocation in a repository.
 * @returns the run, or the executor's absence.
 */
export function runGit(
  shell: ShellLike | undefined,
  cwd: string,
  args: readonly string[],
  timeoutMs = 60_000,
): Promise<ShellResult> {
  const command = `git ${args.join(' ')}`
  return runShell(shell, command, cwd, timeoutMs)
}

/** One file's change summary, as `/git` renders it. */
export interface GitRow {
  /** Path relative to the repository root. */
  file: string
  /** Lines added, when the diff knows them (untracked files do not). */
  additions?: number
  /** Lines removed, when the diff knows them. */
  deletions?: number
  /** Coarse kind for the row's mark: +, − or ~. */
  status: 'added' | 'deleted' | 'modified'
}

/** The `XY` flags porcelain v1 actually emits; anything else is not a row. */
const XY_CHARS = new Set([' ', 'M', 'A', 'D', 'R', 'C', 'T', 'U', '?', '!'])

/**
 * Parse `git status --porcelain=v1` output, annotated by `git diff --numstat`.
 * Pure on purpose — the suite drives the corner cases without a repo.
 */
export function parseGitStatus(statusOut: string, numstatOut: string): GitRow[] {
  const stats = new Map<string, { additions?: number, deletions?: number }>()
  for (const line of numstatOut.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const match = trimmed.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (match === null) continue
    const [, addRaw, delRaw, file] = match
    if (file === undefined) continue
    stats.set(file, {
      ...(addRaw !== undefined && addRaw !== '-' ? { additions: Number(addRaw) } : {}),
      ...(delRaw !== undefined && delRaw !== '-' ? { deletions: Number(delRaw) } : {}),
    })
  }
  const rows: GitRow[] = []
  for (const line of statusOut.split('\n')) {
    if (line.length < 4) continue
    // `XY PATH`: two status flags, one space, then the path. Renames carry
    // `ORIG -> PATH`; the row is about the path the file now wears.
    const xy = line.slice(0, 2)
    let file = line.slice(3)
    const arrow = file.indexOf(' -> ')
    if (arrow >= 0) file = file.slice(arrow + 4)
    file = file.replace(/^"(.*)"$/, '$1').trim()
    if (file.length === 0) continue
    const x = xy[0]
    const y = xy[1]
    if (x === undefined || y === undefined || !XY_CHARS.has(x) || !XY_CHARS.has(y)) continue
    const status: GitRow['status'] =
      (x === 'A' || y === 'A') || (x === '?' && y === '?') ? 'added'
      : (x === 'D' || y === 'D') ? 'deleted'
      : 'modified'
    const stat = stats.get(file)
    rows.push({
      file,
      status,
      ...(stat?.additions !== undefined ? { additions: stat.additions } : {}),
      ...(stat?.deletions !== undefined ? { deletions: stat.deletions } : {}),
    })
  }
  return rows
}

/**
 * True when a `/worktree new` name is safe to join a shell command line: a
 * git-branch charset with no spaces, no quotes and no metacharacters.
 */
export function validWorktreeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
}

/**
 * Parse `git worktree list --porcelain` into the worktree directories.
 * Pure on purpose — the suite drives the shape without a repo.
 */
export function parseWorktrees(out: string): string[] {
  const trees: string[] = []
  for (const line of out.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('worktree ')) {
      const dir = trimmed.slice('worktree '.length).trim()
      if (dir.length > 0) trees.push(dir)
    }
  }
  return trees
}
