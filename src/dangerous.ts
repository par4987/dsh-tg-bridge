/**
 * Guard for shell commands the bridge runs directly through the harness
 * shell service (`ctx.shell`).
 *
 * The damage is not symmetric, so the guard has tiers:
 *  - "forbidden" never runs, not even after a tap: no recovery from a
 *    formatted disk, a wiped shadow copy or an exfiltrated key file.
 *  - "confirm" waits for an explicit tap: recoverable, sometimes necessary.
 *
 * Design (the four principles that make a blocklist actually protect):
 *
 *  1. Parse, don't regex. The command is split on `;` `|` `&&` newlines with
 *     quote awareness, the command name is taken from the first token, and
 *     aliases are resolved to the canonical cmdlet. `--format=` in a git
 *     command can never look like `Format-Volume` again.
 *  2. Invert where possible. A short read-only allowlist (Get-*, Test-*...
 *     plus the dev toolchain) passes straight through; everything unknown
 *     goes to confirmation, because a name we do not recognise is a name we
 *     cannot vouch for.
 *  3. Scope by path, not by blanket ban. A coding agent has to delete files:
 *     `Remove-Item` is fine inside the project folder and forbidden anywhere
 *     else. Destruction is only ever allowed where the damage is ours.
 *  4. Show what was parsed. The confirm card lists the commands with aliases
 *     resolved, so the person approves what is actually running.
 *
 * Ported from opencode-tg (the incident that motivated it: a service restart
 * killed the host process mid-command there); here it Guards the commands
 * the bridge runs without the agent in the loop.
 */
import { t } from './locale.ts'

export type DangerLevel = 'ok' | 'confirm' | 'forbidden'

export interface ParsedCommand {
  /** The segment as written. */
  raw: string
  /** Command name as typed. */
  asWritten?: string
  /** Canonical name after alias resolution. */
  resolved?: string
  /** Arguments after the name (for path scoping and the approval card). */
  args: string[]
  /** True when the name is not a literal (a variable or a bracketed type). */
  dynamic?: boolean
}

export interface DangerMatch {
  level: DangerLevel
  /** What is at stake, in plain words, for the card. */
  reason: string
  /** Every command the line would run, parsed and alias-resolved. */
  commands: ParsedCommand[]
}

// ── aliases → canonical cmdlet ──────────────────────────────────────────────
/** PowerShell's built-in aliases plus the short forms that actually get used. */
const ALIASES: Record<string, string> = {
  rm: 'remove-item', del: 'remove-item', erase: 'remove-item', rd: 'remove-item',
  rmdir: 'remove-item', ri: 'remove-item', rni: 'rename-item', ren: 'rename-item',
  kill: 'stop-process', spps: 'stop-process', gps: 'get-process',
  iex: 'invoke-expression', icm: 'invoke-command', ii: 'invoke-item',
  iwr: 'invoke-webrequest', irm: 'invoke-restmethod',
  saps: 'start-process', start: 'start-process', spps2: 'stop-process',
  sc: 'set-service', gsv: 'get-service', spsv: 'stop-service',
  ls: 'get-childitem', dir: 'get-childitem', cat: 'get-content', type: 'get-content',
  gc: 'get-content', pwd: 'get-location', cd: 'set-location', chdir: 'set-location',
  sl: 'set-location', pushd: 'push-location', popd: 'pop-location',
  ps: 'get-process', tasklist: 'get-process', curl: 'invoke-webrequest',
  wget: 'invoke-webrequest', ftp: 'ftp', echo: 'write-output',
  clc: 'clear-content', cli: 'clear-item', clhy: 'clear-history',
  csn: 'new-pssession', etsn: 'enter-pssession',
}

// ── the blocklist, by category ──────────────────────────────────────────────
/** Never runs, confirmation or not. Each entry: [names, reason]. */
const FORBIDDEN: Array<[string[], string]> = [
  // Deletion and destruction of data.
  [['remove-item', 'clear-content', 'clear-item', 'clear-recyclebin',
    'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition',
    'set-partition', 'resize-partition', 'format', 'diskpart', 'cipher',
    'fsutil', 'sdelete', 'mkfs', 'dd', 'shred', 'wipefs'],
   'danger_data_destruction'],
  // Boot, backups and recovery — the machine may not come back.
  [['bcdedit', 'bcdboot', 'bootsect', 'reagentc', 'vssadmin', 'wbadmin',
    'disable-computerrestore'],
   'danger_boot_recovery'],
  // Machine state and installed software.
  [['stop-computer', 'restart-computer', 'shutdown', 'logoff', 'reboot',
    'halt', 'poweroff', 'remove-computer', 'add-computer', 'rename-computer',
    'reset-computermachinepassword', 'disable-windowsoptionalfeature',
    'remove-windowscapability', 'remove-appxpackage', 'dism'],
   'danger_machine_state'],
  // The registry.
  [['reg', 'regedit', 'regini'],
   'danger_registry'],
  // Users, permissions and credentials.
  [['new-localuser', 'remove-localuser', 'set-localuser',
    'add-localgroupmember', 'remove-localgroupmember', 'set-acl', 'icacls',
    'takeown', 'cmdkey', 'vaultcmd', 'ntdsutil', 'convertfrom-securestring',
    'set-ad', 'new-ad', 'remove-ad', 'add-ad'],
   'danger_users_creds'],
  // Defenses: antivirus, firewall, execution policy, BitLocker.
  [['set-mppreference', 'add-mppreference', 'set-executionpolicy',
    'set-netfirewallprofile', 'new-netfirewallrule', 'remove-netfirewallrule',
    'disable-netfirewallrule', 'netsh', 'auditpol', 'disable-bitlocker',
    'enable-bitlocker', 'manage-bde'],
   'danger_defenses'],
  // Trace clearing — the footprint of something that already happened.
  [['clear-eventlog', 'remove-eventlog', 'limit-eventlog', 'wevtutil',
    'clear-history', 'set-psreadlineoption'],
   'danger_traces'],
  // Evasion vectors — always blocked.
  // Indirect or hidden execution is how a payload slips past every other rule.
  [['invoke-expression', 'invoke-command', 'invoke-item',
    'powershell', 'pwsh', 'cmd', 'wscript', 'cscript', 'mshta', 'rundll32',
    'regsvr32', 'msbuild', 'installutil', 'wsl', 'bash', 'forfiles',
    'add-type', 'start-process', 'start-job', 'start-threadjob',
    'set-alias', 'new-alias'],
   'danger_evasion'],
]

/** Recoverable but able to interrupt the service or reach outside the box. */
const CONFIRM: Array<[string[], string]> = [
  // Processes and services the bridge depends on — killing the harness
  // process takes this bot and every active session down with it.
  [['stop-process', 'taskkill', 'pkill', 'debug-process', 'stop-service',
    'set-service', 'new-service', 'remove-service', 'suspend-service'],
   'danger_processes'],
  // Software installation.
  [['install-module', 'install-package', 'install-script', 'save-module',
    'winget', 'choco', 'scoop', 'msiexec', 'add-appxpackage', 'uninstall-package'],
   'danger_software'],
  // Network, download and exfiltration.
  [['invoke-webrequest', 'invoke-restmethod', 'start-bitstransfer',
    'bitsadmin', 'certutil', 'curl.exe', 'ftp', 'tftp', 'scp', 'sftp', 'ssh',
    'send-mailmessage', 'net', 'new-smbshare', 'grant-smbshareaccess',
    'enable-psremoting', 'winrm', 'set-netipaddress', 'disable-netadapter',
    'set-dnsclientserveraddress', 'route'],
   'danger_network_egress'],
  // Remote execution.
  [['enter-pssession', 'new-pssession', 'invoke-wmimethod',
    'invoke-cimmethod', 'wmic', 'psexec', 'winrs'],
   'danger_remote_exec'],
  // Persistence.
  [['register-scheduledtask', 'set-scheduledtask', 'unregister-scheduledtask',
    'register-scheduledjob', 'schtasks', 'at', 'register-wmievent',
    'set-wmiinstance', 'new-ciminstance'],
   'danger_persistence'],
  // Runtime name resolution — the prelude to calling something by another name.
  [['get-command', 'get-alias'],
   'danger_name_resolution'],
]

/** Prefixes of the read-only surface: answers without side effects. */
const READONLY_PREFIXES = [
  'get-', 'test-', 'measure-', 'select-', 'where-', 'sort-', 'group-',
  'compare-', 'format-', 'convertto-', 'out-', 'write-', 'tee-', 'show-',
  'read-', 'find-', 'watch-', 'resolve-', 'trace-', 'assert-',
]

/** The local dev toolchain — the reason this bot exists. */
const DEV_TOOLS = new Set([
  'git', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'tsc', 'tsx', 'esbuild',
  'vite', 'webpack', 'rollup', 'python', 'py', 'python3', 'pip', 'pip3',
  'uv', 'poetry', 'cargo', 'rustc', 'go', 'make', 'cmake', 'gcc', 'g++',
  'clang', 'java', 'javac', 'mvn', 'gradle', 'dotnet', 'docker',
  'ls', 'dir', 'cat', 'type', 'pwd', 'cd', 'set-location', 'push-location',
  'pop-location', 'echo', 'printf', 'head', 'tail', 'more', 'less', 'tree',
  'findstr', 'grep', 'jq', 'wc', 'sort', 'uniq', 'diff', 'stat', 'file',
  'du', 'df', 'free', 'ps', 'whoami', 'hostname', 'ipconfig', 'ping',
  'tracert', 'tasklist', 'exit', 'clear', 'cls', 'help', 'man',
])

/** Read-only commands that are nonetheless on the confirm list by name. */
function inList(list: Array<[string[], string]>, name: string): string | undefined {
  for (const [names, reason] of list) {
    if (names.includes(name)) return t(reason)
  }
  return undefined
}

// ── secret paths — never readable, whatever the command ─────────────────────
/**
 * The bot token and the API keys live here. The lookbehind keeps a single
 * `$env:PATH` read legal while the `Env:` drive — which dumps every secret at
 * once — stays blocked.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(?<![\w$])env:/i, 'danger_secret_env_drive'],
  [/(?:^|[\\/.])\.ssh(?:[\\/]|$)/i, 'danger_secret_ssh_dir'],
  [/\bid_(?:rsa|ed25519|ecdsa)(?:\.pub)?\b/i, 'danger_secret_ssh_key'],
  [/(?:^|[\\/\s])\.env(?:[\\/]|$|\.\w)/i, 'danger_secret_env_file'],
  [/\bcredentials\b|\bkey4\.db\b|\blogin data\b|\bplaces\.sqlite\b/i,
   'danger_secret_creds'],
  [/[\\/](?:mozilla|google[\\/]chrome|microsoft[\\/]edge)[\\/]/i,
   'danger_secret_browser_profiles'],
]

/** Registry hives — the paths, not just the tools. Unanchored on purpose: it
 * has to catch `-Path HKLM:\...` wherever the argument sits. */
const REGISTRY_PATH = /(?:registry::|hklm:|hkcu:|hkcr:|hku:|hkcc:)/i

/** Flags that hide or encode what a command really does. */
const FORBIDDEN_FLAGS: Array<[RegExp, string]> = [
  [/-encodedcommand\b|(?<=\s)-enc\b/i, 'danger_flag_base64'],
  [/-executionpolicy\s+(?:bypass|unrestricted|remotesigned)/i,
   'danger_flag_execpolicy'],
  [/-windowstyle\s+hidden/i, 'danger_flag_hidden'],
  [/-comobject\b/i, 'danger_flag_com'],
  [/\s\/mir\b/i, 'danger_flag_robocopy'],
]

/** Flags that change the reach of a command rather than hiding it. */
const CONFIRM_FLAGS: Array<[RegExp, string]> = [
  [/-computername\b/i, 'danger_flag_computername'],
]

/** Bracketed types that touch the filesystem, the process list, the network or
 *  reflection — the .NET escape hatch out of every cmdlet rule above. A cast
 *  (`[int]"5"`) is harmless; these never are. */
const DANGEROUS_TYPES = [
  'system.io', 'system.diagnostics', 'system.net', 'system.reflection',
  'system.management.automation', 'microsoft.win32', 'system.security',
  'scriptblock', 'system.activator', 'system.runtime.interopservices',
]

// ── the parser ──────────────────────────────────────────────────────────────
/**
 * Split a line into the commands it would run. PowerShell separates with
 * `;`, `|`, `&&` and newlines; quoting must be respected or a `"; shutdown"`
 * inside a string looks like two commands.
 */
function splitSegments(text: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      current += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    const pair = text.slice(i, i + 2)
    if (ch === ';' || ch === '|' || ch === '\n' || pair === '&&' || pair === '||') {
      out.push(current)
      current = ''
      if (pair === '&&' || pair === '||') i += 1
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** Take the last path component and drop the extension: `C:\x\y.exe` -> `y`.
 *  Also strips odd extensions like `mkfs.ext4` — a command name never has a
 *  dotted tail, so whatever follows the last dot is not part of the name. */
function baseName(name: string): string {
  const stripped = name.replace(/\\/g, '/')
  const slash = stripped.lastIndexOf('/')
  const file = slash >= 0 ? stripped.slice(slash + 1) : stripped
  return file.replace(/\.[a-z0-9]{1,5}$/i, '').toLowerCase()
}

/** Read one command token (bare word or quoted string) from the start. */
function readToken(text: string): { value: string, quoted: boolean, rest: string } {
  const first = text[0]
  if (first === '"' || first === "'") {
    const end = text.indexOf(first, 1)
    if (end === -1) return { value: text.slice(1), quoted: true, rest: '' }
    return { value: text.slice(1, end), quoted: true, rest: text.slice(end + 1).trim() }
  }
  const match = text.match(/^[\w.:/\\-]+/)
  if (!match) return { value: '', quoted: false, rest: text }
  return { value: match[0], quoted: false, rest: text.slice(match[0].length).trim() }
}

function parseSegment(raw: string): ParsedCommand {
  let rest = raw.replace(/^[\s(]+/, '')
  const cmd: ParsedCommand = { raw, args: [] }
  // A leading `&` or `.` is the call operator: the "command" is whatever the
  // next token evaluates to.
  const callOp = rest.match(/^[&.]\s*/)
  if (callOp) rest = rest.slice(callOp[0].length).trim()

  if (rest.startsWith('[')) {
    // Bracketed type access — .NET, COM or a type literal. Never a cmdlet.
    const close = rest.indexOf(']')
    cmd.resolved = close === -1 ? rest : rest.slice(1, close)
    cmd.asWritten = '[' + cmd.resolved + ']'
    cmd.dynamic = true
    cmd.args = rest.slice(close + 1).split(/\s+/).filter(Boolean)
    return cmd
  }
  if (rest.startsWith('$')) {
    // A variable as the command: unresolvable without running it.
    cmd.asWritten = rest.split(/\s+/)[0] ?? ''
    cmd.dynamic = true
    cmd.args = rest.split(/\s+/).slice(1).filter(Boolean)
    return cmd
  }
  if (/^function\s+/i.test(rest)) {
    cmd.asWritten = 'function'
    cmd.resolved = 'function'
    cmd.args = rest.split(/\s+/).slice(1).filter(Boolean)
    return cmd
  }
  const token = readToken(rest)
  cmd.asWritten = token.value
  // A quoted command name is a literal string invoked dynamically — resolve
  // it (we can read it), but flag it so the card says how it was called.
  cmd.dynamic = callOp !== null && token.quoted
  const canonical = (ALIASES[token.value.toLowerCase()] ?? token.value.toLowerCase())
  cmd.resolved = baseName(canonical)
  cmd.args = token.rest.length > 0 ? token.rest.split(/\s+/).filter(Boolean) : []
  return cmd
}

/** First argument that is not a flag — the path a destructive command hits.
 * A flag is `-x`, `--x` or `/x` (Windows style), but not a path like
 * `/tmp/x` — the trailing slash is what separates them. */
function firstPathArg(args: string[]): string | undefined {
  for (const a of args) {
    if (/^[-/][\w.]*$/.test(a)) continue
    return a.replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

/** True when a path stays inside the project folder. */
function insideProject(path: string, projectDir: string): boolean {
  if (!path) return false
  if (path.includes('..')) return false
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith('/') || path.startsWith('\\')) {
    const p = path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
    const base = projectDir.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
    return p === base || p.startsWith(base + '/')
  }
  // Relative: resolved against the session's working directory.
  return true
}

// ── the classifier ──────────────────────────────────────────────────────────
/**
 * Classify a command line. `projectDir` is the session's directory — the one
 * place destructive commands may operate.
 */
export function dangerousCommand(text: string, projectDir = ''): DangerMatch {
  const commands = splitSegments(text).map(parseSegment)
  if (commands.length === 0) return { level: 'ok', reason: '', commands }

  // 1. Secret paths are unreadable by any command, read-only or not.
  for (const [pattern, reason] of SECRET_PATTERNS) {
    if (pattern.test(text)) return { level: 'forbidden', reason: t(reason), commands }
  }
  // 2. Flags that hide or redirect what runs.
  for (const [pattern, reason] of FORBIDDEN_FLAGS) {
    if (pattern.test(text)) return { level: 'forbidden', reason: t(reason), commands }
  }
  for (const [pattern, reason] of CONFIRM_FLAGS) {
    if (pattern.test(text)) return { level: 'confirm', reason: t(reason), commands }
  }

  for (const cmd of commands) {
    // 3. Anything but a literal name needs a human: we cannot know what it
    //    would run, so it never runs unsupervised. A bracketed type is the
    //    .NET/COM surface — a static call or a filesystem type is evasion,
    //    while `[int]"5"` is just a cast and passes.
    if (cmd.dynamic) {
      if (cmd.asWritten?.startsWith('[')) {
        const body = (cmd.resolved ?? '').toLowerCase()
        const callsStatic = cmd.args.some((a) => a.startsWith('::'))
        if (callsStatic || DANGEROUS_TYPES.some((prefix) => body.startsWith(prefix))) {
          return {
            level: 'forbidden',
            reason: t('danger_dotnet'),
            commands,
          }
        }
        continue
      }
      return {
        level: 'confirm',
        reason: t('danger_dynamic'),
        commands,
      }
    }
    const name = cmd.resolved ?? ''
    if (!name) continue

    // 4. A function definition hides whatever it will later be asked to do.
    if (name === 'function') {
      return { level: 'forbidden', reason: t('danger_function'), commands }
    }
    // 5. Registry paths — anywhere in the arguments.
    if (cmd.args.some((a) => REGISTRY_PATH.test(a)) || REGISTRY_PATH.test(cmd.raw)) {
      return { level: 'forbidden', reason: t('danger_registry_path'), commands }
    }
    // 6. `net` is only dangerous with its user/group subcommands.
    if (name === 'net') {
      const sub = (cmd.args[0] ?? '').toLowerCase()
      if (sub === 'user' || sub === 'localgroup' || sub === 'accounts') {
        return { level: 'forbidden', reason: t('danger_net_users'), commands }
      }
      if (sub === 'use' || sub === 'share' || sub === 'start') {
        return { level: 'confirm', reason: t('danger_net_share'), commands }
      }
    }

    // 7. Destruction is only allowed inside the project folder — but the
    //    folder itself and its history are not ours to throw away.
    if (name === 'remove-item') {
      const target = firstPathArg(cmd.args)
      if (target === undefined) {
        return { level: 'confirm', reason: t('danger_rm_no_target'), commands }
      }
      if (target === '.' || /^\.git\b/i.test(target)) {
        return {
          level: 'confirm',
          reason: t(target === '.' ? 'danger_rm_project' : 'danger_rm_git'),
          commands,
        }
      }
      if (!insideProject(target, projectDir)) {
        return {
          level: 'forbidden',
          reason: t('danger_rm_outside', { target }),
          commands,
        }
      }
      continue // In scope: it is ours to delete.
    }

    // 8. The explicit blocklists win over every allowlist below.
    const forbiddenReason = inList(FORBIDDEN, name)
    if (forbiddenReason) return { level: 'forbidden', reason: forbiddenReason, commands }
    const confirmReason = inList(CONFIRM, name)
    if (confirmReason) return { level: 'confirm', reason: confirmReason, commands }

    // 9. The read-only allowlist and the toolchain pass through.
    if (READONLY_PREFIXES.some((p) => name.startsWith(p)) || DEV_TOOLS.has(name)) {
      continue
    }
    // 10. Everything else is unknown — confirm rather than guess.
    return {
      level: 'confirm',
      reason: t('danger_unknown_cmd', { cmd: cmd.asWritten ?? name }),
      commands,
    }
  }

  return { level: 'ok', reason: '', commands }
}

// ── the explainer — what the command actually does, in plain words ──────────
/**
 * Every command that reaches a card gets a line of its own: the command as it
 * will run (aliases resolved) and, underneath, what it does. The blocklist says
 * *whether* it may run; this says *why* the person is being asked.
 */
const EXPLAINS: Record<string, string> = {
  // Processes and services.
  'stop-process': 'danger_explain_stop_process',
  'taskkill': 'danger_explain_taskkill',
  'debug-process': 'danger_explain_debug_process',
  'stop-service': 'danger_explain_stop_service',
  'set-service': 'danger_explain_set_service',
  'new-service': 'danger_explain_new_service',
  'remove-service': 'danger_explain_remove_service',
  'suspend-service': 'danger_explain_suspend_service',
  // Software.
  'install-module': 'danger_explain_install_module',
  'install-package': 'danger_explain_install_package',
  'install-script': 'danger_explain_install_script',
  'save-module': 'danger_explain_save_module',
  'winget': 'danger_explain_winget',
  'choco': 'danger_explain_choco',
  'scoop': 'danger_explain_scoop',
  'msiexec': 'danger_explain_msiexec',
  'add-appxpackage': 'danger_explain_add_appxpackage',
  'uninstall-package': 'danger_explain_uninstall_package',
  // Network.
  'invoke-webrequest': 'danger_explain_invoke_webrequest',
  'invoke-restmethod': 'danger_explain_invoke_restmethod',
  'start-bitstransfer': 'danger_explain_start_bitstransfer',
  'bitsadmin': 'danger_explain_bitsadmin',
  'certutil': 'danger_explain_certutil',
  'curl.exe': 'danger_explain_curl_exe',
  'ftp': 'danger_explain_ftp',
  'tftp': 'danger_explain_tftp',
  'scp': 'danger_explain_scp',
  'sftp': 'danger_explain_sftp',
  'ssh': 'danger_explain_ssh',
  'send-mailmessage': 'danger_explain_send_mailmessage',
  'net': 'danger_explain_net',
  'new-smbshare': 'danger_explain_new_smbshare',
  'grant-smbshareaccess': 'danger_explain_grant_smbshareaccess',
  'enable-psremoting': 'danger_explain_enable_psremoting',
  'winrm': 'danger_explain_winrm',
  'set-netipaddress': 'danger_explain_set_netipaddress',
  'disable-netadapter': 'danger_explain_disable_netadapter',
  'set-dnsclientserveraddress': 'danger_explain_set_dnsclientserveraddress',
  'route': 'danger_explain_route',
  // Remote execution.
  'enter-pssession': 'danger_explain_enter_pssession',
  'new-pssession': 'danger_explain_new_pssession',
  'invoke-wmimethod': 'danger_explain_invoke_wmimethod',
  'invoke-cimmethod': 'danger_explain_invoke_cimmethod',
  'wmic': 'danger_explain_wmic',
  'psexec': 'danger_explain_psexec',
  'winrs': 'danger_explain_winrs',
  // Persistence.
  'register-scheduledtask': 'danger_explain_register_scheduledtask',
  'set-scheduledtask': 'danger_explain_set_scheduledtask',
  'unregister-scheduledtask': 'danger_explain_unregister_scheduledtask',
  'register-scheduledjob': 'danger_explain_register_scheduledjob',
  'schtasks': 'danger_explain_schtasks',
  'at': 'danger_explain_at',
  'register-wmievent': 'danger_explain_register_wmievent',
  'set-wmiinstance': 'danger_explain_set_wmiinstance',
  'new-ciminstance': 'danger_explain_new_ciminstance',
  // Name resolution.
  'get-command': 'danger_explain_get_command',
  'get-alias': 'danger_explain_get_alias',
}

/**
 * Plain-language description of one parsed command, for the approval card.
 * Falls back to the raw command when nothing specific is known — never to
 * silence, and never to a guess.
 */
export function explainCommand(cmd: ParsedCommand): string {
  const name = cmd.resolved ?? cmd.asWritten ?? ''
  const known = EXPLAINS[name]
  if (known) return t(known)
  if (cmd.dynamic) {
    return t('danger_explain_dynamic')
  }
  if (!name) return cmd.raw
  const args = cmd.args.length ? t('danger_explain_args', { args: cmd.args.join(' ') }) : ''
  return t('danger_explain_unknown', { cmd: cmd.asWritten ?? name, args })
}

/** True only when the command may run after an explicit confirmation. */
export function needsConfirm(text: string, projectDir = ''): boolean {
  return dangerousCommand(text, projectDir).level === 'confirm'
}

/** True when the command must never run, confirmation or not. */
export function isForbidden(text: string, projectDir = ''): boolean {
  return dangerousCommand(text, projectDir).level === 'forbidden'
}
