# metaveil installer, launcher and hook policy

This document covers the Round 3 build: the Windows ACL manager, the
`muse` launcher shim, the `PreToolUse` hook, the installer/uninstaller, and what
Orca actually does when it launches Muse on Windows.

## Status and safety model

**metaveil is a mitigation, not a guarantee.** The local proxy is the hard stop
for what reaches Meta; the hook and the Windows ACLs are defence in depth.

- The **proxy** is the only component that can inspect and redact the model
  request. The hook is best-effort: Muse 1.4.14 fails open when a hook crashes,
  exits non-zero, prints bad JSON, or times out (Round 2). The hook therefore
  wraps every internal error in a valid deny, but a Muse-side timeout still
  becomes an allow.
- The **ACL manager** writes an explicit Deny for the `MuseSandboxUsers` group
  only. It never touches the human user or `CodexSandboxUsers`. It is a shell
  boundary, not a mediated-tool boundary: Round 2 showed `read_file` and
  `search` still read denied paths.
- The **launcher** pins `--base-url` to the local proxy, disables telemetry with
  `-c telemetry.enabled=false`, translates `--yolo` to
  `--disable-approval --trust-workspace`, and refuses `--disable-sandbox` and
  `--sandbox-network unrestricted`.
- **Contributor mode is off by default.** The launcher passes
  `--contributor-mode on` only when all five gates hold: the config says
  enabled, the proxy is healthy and reports `jevReady`, the hook is installed,
  and `acl status` is clean with at least one applied entry. The setting lives
  in `%LOCALAPPDATA%\metaveil\launcher.json`, never in Muse's settings.
  `metaveil contributor on` refuses unless the leak-test marker exists.
- **The saved user PATH is the only PATH input.** The installer reads and
  writes `HKCU\Environment\Path` with
  `[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames`, keeps
  the registry value kind, and passes the value to PowerShell through an
  environment variable, never a command line. It prepends only `<repo>\bin`;
  uninstall removes only that entry (or restores the saved raw value when
  unchanged). `process.env.PATH` is never used as the saved value.
- **The proxy key is not persisted.** If `OPENROUTER_API_KEY` is unset, the
  launcher runs `apiKeyCommand` (default
  `pi auth print-api-key --provider openrouter`, `pi.exe` on Windows) without a
  shell, trims stdout, and passes the key only in the proxy child environment.
- **No real machine changes are made by tests.** Every mutating command is a
  dry-run by default and requires `--apply`. Tests pass `--home` to a synthetic
  temp directory. The CLI additionally refuses `--apply` against the real user
  home unless `--allow-real-home` is passed.

## Install / uninstall

```sh
# Dry-run: prints the exact settings.json diff, PATH change and ACL plan.
node src/install/cli.js install --home C:\temp\synthetic-home --workspace C:\work\repo --port 8787

# Apply against a synthetic home (what tests use):
node src/install/cli.js install --home C:\temp\synthetic-home --workspace C:\work\repo --port 8787 --apply

# Real install (intentional, explicit):
node src/install/cli.js install --home %USERPROFILE% --workspace C:\work\repo --port 8787 --apply --allow-real-home

# Optional: copy an identity file to <metaveil-home>\identity.json:
node src/install/cli.js install --home %USERPROFILE% --workspace C:\work\repo --identity C:\temp\identity.json --apply --allow-real-home

# Reverse it:
node src/install/cli.js uninstall --home C:\temp\synthetic-home --apply

# Read-only health/status, also works when nothing is installed:
metaveil status --home %USERPROFILE%
```

`bin\metaveil.cmd` routes `install`, `uninstall`, `acl`, `contributor` and
`status` to `src/install/cli.js`; all other commands go to `src/cli.js`.

The installer:

1. Backs up the existing Muse `settings.json` to
   `settings.json.metaveil-backup-<timestamp>`.
2. Merges an `endpoint_transport.base_url` of
   `http://127.0.0.1:<port>/v1` and
   `telemetry.enabled=false` into `~/.config/muse/settings.json`. Existing keys,
   including other keys inside `telemetry`, are preserved.
3. Copies `src/hook/policy.cjs` to
   `%LOCALAPPDATA%\metaveil\hook\policy.cjs` and writes
   `hook\hook-policy.json`. `hooksInstalled` is recorded only after these files
   are written.
4. Writes `launcher.json`, `proxy-config.json`, `install-state.json` and
   `acl-state.json` under `%LOCALAPPDATA%\metaveil`. `proxy-config.json`
   contains `homeAlias`, `workspaceAlias`, `identity`, and `jev` (enabled,
   OpenRouter base URL, `typesafe/jev-1.14`, `apiKeyEnv`, a cache path under the
   metaveil home, and `contributorOnly: true`). It intentionally contains no
   fixed `workspaceRoot`.
5. Validates that proxy config with the real config loader before any write.
6. Plans a PATH entry for `<repo>\bin` from the saved registry value. For a
   synthetic home it writes `path-plan.json` and **does not** touch the real
   user PATH. For a real home, `--apply` writes the saved user PATH and
   broadcasts `WM_SETTINGCHANGE`.
7. Plans and applies the ACL deny list (below).

`uninstall` restores the settings backup when the current settings still equal
the applied settings; otherwise it removes only metaveil's own
`base_url` and telemetry value, leaving user edits alone. It removes only the
config/state files this install created, removes only ACL entries recorded in
`acl-state.json`, and removes only the PATH entry it added. It does **not**
remove `identity.json`, `audit.jsonl`, the Jev cache, or the token map, and it
prints any retained files.

## Hook policy

`src/hook/policy.cjs` is a CommonJS hook. It reads a JSON config from
`METAVEIL_HOOK_CONFIG` or `hook-policy.json` next to itself:

```json
{
  "allowedRoots": [],
  "allowedSkills": [],
  "bundledSkills": [],
  "fileTools": ["read_file", "search", "write_file", "edit_file", "glob", "grep", "list_files", "read_multiple_files"],
  "timeoutMs": 8000
}
```

The installed config deliberately has no `workspaceRoot`. Each hook call uses
`payload.cwd` as the workspace root; `config.workspaceRoot` is only a fallback.
If neither exists, the hook denies.

Muse 1.4.14 ignores `hooks` in `settings.json`, `managed_hooks_path` set there and a
user-level `hooks.json`. The launcher therefore passes the hook with `-c hooks=` on
Contributor runs only, and the hook enforces whenever it is loaded. It can't detect
the mode itself, because Muse's payload names the plain model even in Contributor
mode. Muse never runs a hook command containing quotes and doesn't report it, so the
command is the unquoted `node <path>`, and a metaveil home whose path has a space
keeps Contributor off.

The proxy doesn't return a stream error for a denied call, because Muse retries those
indefinitely. It swaps the call for a `read_file` of `.metaveil-blocked/<reason>`, and
the hook refuses that with the reason so the model can carry on. Without the hook the
stand-in is just a missing file. The proxy also resolves junctions and symlinks, since
file tools run as the user and would follow one made by a sandboxed shell.

It returns `{}` to allow and:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"metaveil: ..."}}
```

to refuse. It denies:

- `read_file`, `search`, `write_file`, `edit_file` and configured file tools
  whose extracted paths are outside the per-call workspace root and
  `allowedRoots`.
- writes/edits to `.git`, `.muse` and `.agents` inside the workspace.
- `read_skill` names outside the allowlist. Contributor mode allows ids that
  start with `bundled:` unless they match a deny pattern (computer-use,
  orca-computer-use, built-in-browser, chrome-browser, claude-in-chrome,
  browser, gmail, drive, calendar, password, credential) or an explicit
  `allowedSkills`/`bundledSkills` entry. Everything else is denied.
- malformed stdin, invalid config, and any internal exception.
- its own internal watchdog timeout.

The installed hook handler uses an absolute Node path, an absolute hook path and
`"timeout": 15`. The hook's internal watchdog defaults to 8 s so it can print a
deny before Muse's 15 s timeout. Muse's own timeout still fails open if the
watchdog cannot run (see Round 2 C), so the proxy remains the hard stop.

## ACL manager

`src/install/acl.js` targets, under the selected home:

- `Downloads`, `Documents`, `Desktop`, `Pictures`, `Videos`, `Music`,
  `OneDrive*`
- `.ssh`, `.aws`, `.gnupg`, `.azure`, `.kube`, `.docker`
- `.claude`, `.codex`, `.pi`
- `.git-credentials`, `.netrc`, `_netrc`, `.config\muse\auth.json`
- browser profiles for Chrome, Edge, Firefox and Brave under `AppData`
- password-manager dirs (Bitwarden, 1Password, KeePassXC, Dashlane, NordPass)
- Windows Credentials/Vault/Protect dirs
- GitHub CLI/gcloud/AWS/Kubernetes/Docker auth files
- configurable `--extras`

Each directory gets:

```text
icacls <dir> /deny "MuseSandboxUsers:(OI)(CI)(RX)"
```

Files get `icacls <file> /deny "MuseSandboxUsers:(RX)"`. No other principal is
named. Arguments are passed as an array (no shell), so `--extras` paths with
spaces such as `Saved Games` stay one argument. The manager refuses to deny a
folder that contains the workspace or a configured project root, and reports it
as `skip contains workspace/project root`. It also skips paths inside the
workspace and missing paths.

State is written to `acl-state.json` with the exact path, kind, principal and
ACE. `acl apply` is idempotent: a second run reports every entry as
`already applied` and issues no commands. `acl status` checks each recorded
path and the deny ACE; a missing path or missing deny is drift. `acl remove`
runs `/remove:d MuseSandboxUsers` only for recorded entries. Round 2 evidence:
the deny blocks `Get-Content`, `cmd /c type`, `node`, `dir`, nested folders,
files created after the deny, and subagent shells; it does **not** stop
`read_file` or `search`.

## Launcher

`bin\muse.cmd` is a thin shim:

```bat
@echo off
setlocal
node "%~dp0..\src\install\launcher.js" %*
exit /b %ERRORLEVEL%
```

`src/install/launcher.js`:

- Finds the real Muse at `%LOCALAPPDATA%\Programs\muse\muse.cmd` (or
  `launcher.json.museReal` / `METAVEIL_MUSE_REAL`). It refuses if the resolved
  path is metaveil's own `bin\muse.cmd`, so it cannot recurse.
- Validates flags before starting anything. It refuses `--disable-sandbox`
  and `--sandbox-network unrestricted|enabled`.
- Translates `--yolo` to `--disable-approval --trust-workspace`; the shell
  sandbox stays on.
- Removes any user `--base-url`, `-c endpoint_transport.base_url=...`,
  `-c telemetry.enabled=...`, `-c hooks=...` and `--contributor-mode` so they cannot
  route around the proxy, drop the hook or flip contributor mode.
- Adds `--base-url http://127.0.0.1:<port>/v1`,
  `-c telemetry.enabled=false` and `--contributor-mode on|off`, plus `-c hooks=` on
  Contributor runs. Only `exec`, `resume` and bare `muse` get these flags;
  management commands such as `muse usage` reject them and pass through unchanged. It
  refuses any argument with both spaces and double quotes, which Windows PowerShell
  5.1 would split inside Muse's launcher. It never adds
  `-c endpoint_transport.base_url` and never adds a custom permission profile.
- Checks `GET /healthz` for `{ok, jevReady}`. If it is not healthy, obtains a
  key: use `OPENROUTER_API_KEY` when set, otherwise run `launcher.json`
  `apiKeyCommand` (default
  `["pi","auth","print-api-key","--provider","openrouter"]`, `pi.exe` on
  Windows) without a shell, trim stdout, and pass the value only in the child
  proxy environment. The key is never written or logged. If the command fails,
  the proxy still starts without a key and the reason is printed on stderr.
- Starts `node src/cli.js serve --config <proxy-config.json>` detached and polls
  for up to `proxyStartTimeoutMs` (default 10 s). If it is still unhealthy it
  kills the proxy and exits before launching Muse.
- Requires the health response `jevReady` before Contributor mode can turn on.
  Missing/empty `OPENROUTER_API_KEY` leaves Contributor off with reason
  `jev key unavailable`.
- Passes everything else through unmodified.

For a `.cmd` real Muse, the launcher invokes
`cmd.exe /d /s /c "<real>" <args>` only when there is no sibling
`.muse-launcher.ps1`. If that sibling exists, it spawns `powershell.exe`
directly with `["-NoProfile","-ExecutionPolicy","Bypass","-File",<ps1>,...args]`
and no shell. Without the sibling, any argument containing `"`, `&`, `|`, `<`,
`>`, `^`, `%`, CR or LF is refused with `UNSAFE_ARG` before a process starts.
Tests use a fake `.cmd` that records `process.argv` and injected spawn/key
runners; they do not touch the real registry, PATH, ACLs or Muse.

## Orca, git and toolchains inside the sandbox

Sandboxed shells run as a separate Windows user, can write only inside the project and
can't reach loopback. On every launch the launcher therefore:

- puts `%USERPROFILE%\.metaveil-sandbox\bin` first on PATH. Its `orca` writes each
  request to `<project>\.metaveil-tmp\bridge-<pid>`, and the launcher runs the real
  `orca` in the Orca tab's environment and writes the result back
  (`src/install/orca-bridge.js`). The bridge only runs when Muse is started in an Orca tab.
- refuses `computer`, `browser`, `search` and `account` there in Contributor mode, along
  with arguments naming computer use or personal folders. The check is outside the
  sandbox, so a shell can't get past it. Its token stays in the session's environment.
- sets `safe.directory`, so git accepts repos the real user owns, and `GIT_AUTHOR_*` and
  `GIT_COMMITTER_*` from the real git config or `launcher.json`'s `gitIdentity`. Commits
  carry the real name, and the proxy masks it in anything sent upstream.
- points npm and pip caches at `<project>\.metaveil-tmp`, which it adds to
  `.git/info/exclude`. `cargo` and `rustc` wrappers point temp there too, because Rust's
  linker needs a writable one and Muse refuses a temp folder inside the workspace.

Install also grants the sandbox read access to Python and the `.metaveil-sandbox`
folder, recorded in `acl-state.json` as `grants`. Pass drive roots to `--extras` with a
forward slash (`D:/`). Blocks on drive roots need an Administrator terminal to add or
remove; a plain uninstall reports them and keeps the record.

The launcher doesn't hide Muse's `muse-sbx-*` accounts. To hide them from the sign-in
screen, set each to DWORD 0 under
`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList`.

## Contributor mode against real models

Things only a real model showed, each with a test now:

- Real models call tools as `muse.powershell`. `scripts/e2e-real-machine.cjs` scripts them
  that way.
- A model that hits a withheld line may read the file again as a hex dump. See
  `src/encoded.js`.
- Compaction, goal reminders and other side requests carry no permission block. They pass
  only for a session that already showed its sandbox is on (`createVerifiedSessions`). The
  summarizer has no link to its session, so any verified session is enough for it. Tips are
  refused, since they send the conversation to Meta to pick a UI hint.
- `-c hooks=` replaces Orca's managed hooks, so `mergeHooks` carries them along.
- Orca doesn't wake an idle Muse by itself, with or without metaveil. `startWakeWatcher`
  checks for unread messages every 10 seconds and sends a notice when the prompt is empty.
- Orca can kill the shared proxy along with the tab that started it. Every running
  launcher restarts it (`watchProxy`).
- Auto-review falls back to asking a person when its reviewer's requests are refused, so
  Contributor runs use `--disable-approval` unless an approval mode was chosen.
- `web_fetch` runs outside the sandbox. The proxy limits it to public addresses, and Muse
  doesn't follow redirects by itself.

Never put real personal values in a test that reaches real Meta: on 2026-11-06 a trap file
holding the real hostname and name reached it as a hex dump, in Contributor mode. Use the
fake model for those, and `scripts/rehearsal-relay.cjs` for real-model runs. Its
`--passthrough` flag records without changing anything.

## Status

`metaveil status [--home <dir>] [--metaveil-home <dir>] [--port <n>] [--json]`
is read-only and works when nothing is installed. It prints the proxy
`/healthz` result, `jevReady`, hook presence, ACL status and entry count,
`endpoint_transport.base_url` presence, contributor enabled/disabled, leak-test
marker presence, and the full gate reason list. It does not write the PATH
registry, settings, ACLs or the Jev key.

## Orca on Windows: how `muse` is resolved and what hooks it adds

Read-only inspection of
`%LOCALAPPDATA%\Programs\orca\resources\app.asar` and
`app.asar.unpacked/out/main/chunks/managed-agent-hook-controls-_X8WthR2.js`.

Orca's Muse definition is a bare command name, not an absolute path:

```js
muse: {
  detectCmd: "muse",
  launchCmd: "muse --trust-workspace",
  promptInjectionMode: "stdin-after-start"
}
```

`resolveTuiAgentConfig` sets `launchCmd: source.launchCmd ?? source.detectCmd`.
The hook-service executable resolver does a PATH lookup:

```js
let o=Sv(n.pathEnv??process.env.PATH??``,i).filter(e=>!l.i(e,a)), ...
let e=Tv(t,n,r); ...
f[n.agent]=i?{state:`found`,executablePath:i}:{state:`missing`};
```

and `wv` appends Windows `PATHEXT` extensions (`.COM;.EXE;.BAT;.CMD`) when the
candidate has no extension. **So a `muse.cmd` placed earlier on the user PATH
will be found and used by Orca.** Orca does not use an absolute Muse path.

Orca's own managed Muse hooks use `managed_hooks_path`. metaveil doesn't touch that
key: its hook is passed per run with `-c hooks=`, so the two don't collide in
settings. Running both together on one tool call hasn't been tested.

## Base URL

The launcher pins `--base-url http://127.0.0.1:<port>/v1` and strips any user
`--base-url`, `-c endpoint_transport.base_url=...` and
`-c telemetry.enabled=...`. Normal prompts reach the local proxy; the table
below is the Coordinator retest with Contributor forced off:

| Route | Prompt | POST reached local server |
|---|---|---|
| `--base-url` | `Reply with OK.` | yes |
| `--base-url` | `What is 2 + 2?` | yes |
| `--base-url` | `hello my name is CANARY` | yes |
| `--base-url` | `hello`, `hi!` | no POST (built-in greeting path) |
| settings-file `base_url`, temp config, minimal and full catalog | `Reply with OK.` | yes |

A bare greeting is answered by Muse's built-in greeting pattern
`(?i)^[\s\p{P}]*(hi|hello)[\s\p{P}]*$`; it is not a routing test. A custom
permission profile is still avoided, because `-c endpoint_transport.base_url`
plus a profile went to Meta in Round 1. Keep a network-level leak test in place
for the real run; the local proxy plus the launcher flags are the application
boundary.

## Evidence: tests

`node --test` (full repository):

```text
ℹ tests 193
ℹ pass 193
ℹ fail 0
```

The Round 3 tests are:

- `test/hook-policy.test.js` — per-call `payload.cwd` with config fallback, no
  workspace-root refusal, standard/contributor model split, file tools,
  protected workspace dirs, bundled/deny-pattern skills, malformed JSON,
  invalid config, watchdog deny.
- `test/install-acl.test.js` — target list, workspace refusal, file vs dir ACE,
  only `MuseSandboxUsers`, idempotent apply, status drift, recorded-only remove,
  and an injected-runner `--extras` path containing a space.
- `test/install-launcher.test.js` — `--yolo` translation, proxy/telemetry flags,
  unsafe-flag refusal, fake Muse argument capture, recursion guard, dead-proxy
  refusal before Muse, contributor gate off/on with `jev key unavailable`,
  injected `apiKeyCommand`/child-env checks, PowerShell sibling spawn and
  metacharacter refusal, and the `bin\muse.cmd` shim.
- `test/install-installer.test.js` — settings diff, key preservation, backup,
  apply/uninstall, exact restore, user-edit-safe uninstall, contributor marker.
- `test/install-security.test.js` — saved-registry PATH read/write with a fake
  runner, kind/`%VAR%` preservation, exact install→uninstall restore, retained
  identity/audit/Jev cache, identity copy, config plan-time validation,
  telemetry, and read-only `metaveil status` when not installed.

The launcher and hook tests use fake `.cmd`/Muse, fake `/healthz` servers and
injected registry/command runners. They do not call the real model, read the
real registry or change real PATH, settings, ACLs or Muse. The real-Muse E2E
(`--yolo` captured request showing `Shell sandbox: on` and
`Approval: bypassed`) was **not run**; the Round 2 F evidence already captured
those developer lines from a real run:
`- Approval: bypassed at launch (--disable-approval / --yolo)` and
`- Shell sandbox: on.` for `--disable-approval`, and
`- Shell sandbox: off — shell commands run unsandboxed.` for `--yolo`.

## Incident log (must be read)

1. **Real-home apply and revert.** While testing the CLI, a bug in argument
   parsing treated the second token (`--home`) as a subcommand, so `--home` was
   ignored. A single `--apply` run applied settings, ACLs and a PATH change to
   the real home. It was reverted immediately:
   - `~/.config/muse/settings.json` was restored from the automatic backup
     (229 bytes, original content).
   - All 19 recorded ACL entries were removed with
     `icacls <path> /remove:d MuseSandboxUsers`; the real folders now show no
     metaveil-added deny. A pre-existing inherited deny on
     `~/.config/muse/auth.json` from the built-in Muse sandbox was left alone.
   - The real user PATH was reconstructed from the process PATH minus the
     machine PATH and restored (915 chars, the original user entries).
   - `%LOCALAPPDATA%\metaveil` and the backup file were removed.
   The CLI now parses the command correctly and refuses `--apply` on the real
   home without `--allow-real-home`.
2. **Real Muse calls during the base_url matrix.** The matrix and one-case probe
   were intended to be loopback-only and were stopped after real model replies
   appeared. No personal documents were read; the prompts were greetings. The
   observation is recorded as historical; it is not used as routing evidence.
   The current launcher uses `--base-url` for normal prompts and a network-level
   leak test remains part of a real run.

## Known limitations

- Muse hook failures are fail-open in 1.4.14 (Round 2 C); the hook is not a
  security boundary by itself.
- The ACL deny is a shell-only boundary; `read_file`/`search` ignore it.
- Orca's `full-access` choice for Muse passes `--yolo`, which the launcher translates
  so the shell sandbox stays on. That relies on Orca finding the shim on PATH.
- Requests without Muse's permission block, such as its background side requests, are
  refused in Contributor mode. Runs still finish.
- `scripts/e2e-real-machine.cjs` tests real Muse against a scripted fake model that
  calls tools the way real models do (`muse.powershell`). `scripts/rehearsal-relay.cjs`
  runs real Spark under the Contributor rules and turns Contributor off on the way out,
  recording every outgoing body. Contributor mode against real Meta, with the header on,
  has not been run. The network check samples Muse's TCP connections; it isn't a packet
  capture.
- Encoded text is decoded and scanned for hex dumps, xxd output, base64, hex strings and
  byte lists. Identity values split up by separators or reversed are caught too. A
  homemade cipher, or rot13, isn't.
- The AI scanner judges text, so it can miss things that don't read as personal, such as
  a lone email address at a reserved domain in a tool's output.
- In Muse's default network mode, `$env:TEMP` isn't writable from the shell. Only the
  `cargo` and `rustc` wrappers get a writable temp folder.
- Windows PowerShell runs in ConstrainedLanguage mode in the sandbox, so .NET method calls
  fail. Agents usually find another way.
- Workers started through Orca run as the real user, outside the sandbox. The bridge
  refuses commands that name personal folders or computer use, which is a fence and not
  a boundary. Whatever a worker reports is still scanned by the proxy.
- Muse's default network mode blocks loopback and some TLS. npm, pip and Rust builds
  work; `cargo add` and `git push` may need a worker.
- Muse won't create a new repo nested inside another repo. Existing repos work.
