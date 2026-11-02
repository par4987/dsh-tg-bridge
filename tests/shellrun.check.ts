/**
 * The shell adapter: the request/spec runway, the outcome shapes, and the
 * pure git parsers the /git and /worktree commands render from.
 */
import { assert, define, type Check } from './harness.ts'
import { parseGitStatus, parseWorktrees, runGit, runShell, validWorktreeName, type ShellLike } from '../src/shellrun.ts'

/**
 * A fake executor: resolve() answers a spec the check can inspect, run()
 * replays the canned outcome. No real process is ever spawned.
 */
function fakeShell(outcome: {
  exitCode?: number | null
  stdout?: string
  stderr?: string
  timedOut?: boolean
  denied?: boolean
}): ShellLike & { lastRequest: string | undefined, lastWorkdir: string | undefined, lastTimeout: number | undefined } {
  const recorder = {
    lastRequest: undefined as string | undefined,
    lastWorkdir: undefined as string | undefined,
    lastTimeout: undefined as number | undefined,
  }
  return {
    resolve(request) {
      recorder.lastRequest = request.command
      recorder.lastWorkdir = request.workdir
      recorder.lastTimeout = request.timeoutMs
      return {
        command: request.command,
        workdir: request.workdir ?? 'C:/proj',
        timeoutMs: request.timeoutMs ?? 60_000,
        stdoutMaxBytes: request.stdoutMaxBytes ?? 16 * 1024,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }
    },
    async run() {
      return {
        exitCode: outcome.exitCode ?? 0,
        timedOut: outcome.timedOut === true,
        stdout: { text: outcome.stdout ?? '', truncated: false },
        stderr: { text: outcome.stderr ?? '', truncated: false },
        ...(outcome.denied === true ? { sandbox: { denied: true } } : {}),
      }
    },
    get lastRequest() { return recorder.lastRequest },
    get lastWorkdir() { return recorder.lastWorkdir },
    get lastTimeout() { return recorder.lastTimeout },
  }
}

export const shellrunChecks: Check[] = [
  define('an absent executor answers unavailable', async () => {
    const result = await runShell(undefined, 'git status', 'C:/proj', 60_000)
    assert(result.kind === 'unavailable', 'no executor means unavailable, not a throw')
  }),

  define('resolve fills the runway and run reports the streams', async () => {
    const shell = fakeShell({ exitCode: 0, stdout: 'clean\n' })
    const result = await runShell(shell, 'git status', 'C:/proj', 90_000)
    assert(result.kind === 'ran', 'the run answers')
    if (result.kind === 'ran') {
      assert(result.exitCode === 0, 'the exit code passes through')
      assert(result.stdout === 'clean\n', 'stdout passes through')
      assert(result.stderr === '', 'an empty stderr stays empty')
      assert(result.timedOut === false, 'no timeout is reported')
      assert(result.denied === false, 'no sandbox denial is reported')
    }
    assert(shell.lastRequest === 'git status', 'resolve saw the command')
    assert(shell.lastWorkdir === 'C:/proj', 'resolve saw the workdir')
    assert(shell.lastTimeout === 90_000, 'resolve saw the caller timeout')
  }),

  define('a timeout and a sandbox denial surface on the outcome', async () => {
    const timed = await runShell(fakeShell({ timedOut: true, exitCode: null }), 'slow', 'C:/proj', 60_000)
    if (timed.kind !== 'ran') throw new Error('expected a run')
    assert(timed.timedOut === true, 'the timeout flag reaches the caller')
    const denied = await runShell(fakeShell({ exitCode: 1, denied: true, stderr: 'blocked' }), 'rm x', 'C:/proj', 60_000)
    if (denied.kind !== 'ran') throw new Error('expected a run')
    assert(denied.denied === true, 'the sandbox denial reaches the caller')
    assert(denied.stderr === 'blocked', 'stderr passes through on failure')
  }),

  define('runGit composes the git command line', async () => {
    const shell = fakeShell({ stdout: '' })
    const result = await runGit(shell, 'C:/proj', ['status', '--porcelain=v1'])
    assert(result.kind === 'ran', 'git runs through the same seam')
    assert(shell.lastRequest === 'git status --porcelain=v1', 'the arguments join the command line')
  }),

  define('parseGitStatus maps porcelain rows against numstat', () => {
    const status = [
      ' M src/index.ts',
      'A  src/new.ts',
      'D  src/old.ts',
      '?? src/untracked.ts',
      'R  src/old-name.ts -> src/new-name.ts',
      ' M "quo te d.ts"',
    ].join('\n')
    const numstat = [
      '12\t3\tsrc/index.ts',
      '5\t0\tsrc/new.ts',
      '0\t9\tsrc/old.ts',
      '-\t-\tsrc/untracked.ts',
    ].join('\n')
    const rows = parseGitStatus(status, numstat)
    assert(rows.length === 6, `six rows parse (got ${rows.length})`)
    const [modified, added, deleted, untracked, renamed, quoted] = rows
    assert(modified?.status === 'modified' && modified.additions === 12 && modified.deletions === 3, 'a modified row carries its numstat')
    assert(added?.status === 'added', 'a staged file is added')
    assert(deleted?.status === 'deleted' && deleted.deletions === 9, 'a deleted row carries its removals')
    assert(untracked?.status === 'added' && untracked.additions === undefined, 'an untracked file is added without counts')
    assert(renamed?.file === 'src/new-name.ts', 'a rename row wears the path it now has')
    assert(quoted?.file === 'quo te d.ts', 'a quoted path is unquoted')
  }),

  define('parseGitStatus survives an empty or malformed numstat', () => {
    const rows = parseGitStatus(' M x.ts', '')
    assert(rows.length === 1, 'a status row without numstat still parses')
    assert(rows[0]?.additions === undefined, 'no counts arrive without numstat')
    assert(parseGitStatus('', '1\t1\tx.ts').length === 0, 'no status rows means no rows')
    assert(parseGitStatus('not porcelain at all', 'garbage').length === 0, 'garbage parses to nothing')
  }),

  define('parseWorktrees reads the porcelain blocks', () => {
    const out = [
      'worktree C:/proj',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree C:/proj/feature-x',
      'HEAD def456',
      'branch refs/heads/feature-x',
      '',
      'worktree C:/proj/feature-y',
      'HEAD 789abc',
      'branch refs/heads/feature-y',
    ].join('\n')
    const trees = parseWorktrees(out)
    assert(trees.length === 3, `three worktrees parse (got ${trees.length})`)
    assert(trees[0] === 'C:/proj', 'the main worktree heads the list')
    assert(trees[2] === 'C:/proj/feature-y', 'each block contributes its directory')
    assert(parseWorktrees('').length === 0, 'an empty listing stays empty')
  }),

  define('validWorktreeName accepts branch names and refuses injection', () => {
    assert(validWorktreeName('feature-x') === true, 'a plain branch name is accepted')
    assert(validWorktreeName('feat_2.0/a') === true, 'dots, dashes, slashes and digits are accepted')
    assert(validWorktreeName('-g') === false, 'a leading dash is refused')
    assert(validWorktreeName('my work') === false, 'a space is refused')
    assert(validWorktreeName('x; rm -rf /') === false, 'a command separator is refused')
    assert(validWorktreeName('`whoami`') === false, 'backticks are refused')
    assert(validWorktreeName('$(id)') === false, 'a substitution is refused')
    assert(validWorktreeName('";shutdown"') === false, 'quotes are refused')
  }),
]
