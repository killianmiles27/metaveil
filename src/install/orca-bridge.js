import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

// Sandboxed shells can't run Orca: its files and login are out of their reach, by
// design, and Muse's network sandbox blocks loopback. So the launcher, which runs as
// the real user inside the Orca tab, runs `orca` for them. Requests and replies are
// files in the project's ignored temp folder, the one place both sides can reach. To
// the agent it's just the orca command.
//
// In Contributor mode these commands are refused here, outside the sandbox, so nothing
// a sandboxed shell does can get past the check.
const CONTRIBUTOR_REFUSED = new Map([
  ['computer', 'computer use is not available in Contributor mode'],
  ['browser', 'the browser holds personal logins, so it is not available in Contributor mode'],
  ['search', 'searching past agent sessions is not available in Contributor mode'],
  ['account', 'account management is not available in Contributor mode'],
]);
const COMPUTER_USE = /orca(\.exe|\.cmd)?["']?\s+computer|orca-computer-use|computer[-_ ]use/i;
// Workers run as the real user, so this is a fence for the obvious routes and not a
// boundary: a task in a file or one vague enough gets through. Whatever a worker reports
// is still scanned by the proxy before it can reach Meta.
const PERSONAL_PLACES = /[\\/](downloads|documents|desktop|pictures|videos|onedrive|appdata|\.ssh|\.aws|\.gnupg|\.pi|\.claude|\.codex)\b|(^|[\s"'(])\.(ssh|aws|gnupg)\b|\bmy (downloads|documents|desktop|pictures|videos|files|email|inbox|calendar|contacts)\b|(^|[\s"'(=])~([\\/]|$)|%(userprofile|homepath|appdata|localappdata|onedrive)%|\$env:(userprofile|homepath|appdata|localappdata|onedrive)|\$home\b|(^|[^a-z])[d-z]:[\\/]/i;
const REQUEST_FILE = /^req-([0-9a-f]{16})\.json$/;
const POLL_MS = 100;

export function refusalFor(args, contributor) {
  if (!contributor) return null;
  const command = args.find((arg) => !String(arg).startsWith('-'));
  const direct = CONTRIBUTOR_REFUSED.get(String(command || '').toLowerCase());
  if (direct) return direct;
  // A new terminal or worker could otherwise be told to do what's refused above.
  if (args.some((arg) => COMPUTER_USE.test(String(arg)))) return 'computer use is not available in Contributor mode';
  if (args.some((arg) => PERSONAL_PLACES.test(String(arg)))) return 'workers started in Contributor mode stay inside the project, so a command that names personal folders or other drives is refused';
  return null;
}

function writeReply(dir, id, reply) {
  const file = path.join(dir, `res-${id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(reply));
  fs.renameSync(`${file}.tmp`, file);
}

export function startOrcaBridge({ contributor, dir, env = process.env, orcaCommand = 'orca.exe', spawnImpl = spawn }) {
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(dir, { recursive: true });

  const handle = (id, file) => {
    let request;
    try {
      // A link planted here could point anywhere, so only plain files are read.
      if (!fs.lstatSync(file).isFile()) throw new Error('not a file');
      request = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.rmSync(file, { force: true });
    if (request.token !== token) return;
    const args = Array.isArray(request.args) ? request.args.map(String) : [];
    const refusal = refusalFor(args, contributor);
    if (refusal) {
      writeReply(dir, id, { code: 1, stdout: '', stderr: `metaveil: ${refusal}\n` });
      return;
    }
    const cwd = typeof request.cwd === 'string' && fs.existsSync(request.cwd) ? request.cwd : undefined;
    let stdout = '';
    let stderr = '';
    let replied = false;
    const finish = (reply) => {
      if (replied) return;
      replied = true;
      try { writeReply(dir, id, reply); } catch { /* the session has ended */ }
    };
    const child = spawnImpl(orcaCommand, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish({ code: 1, stdout: '', stderr: `metaveil: could not run orca: ${error.message}\n` }));
    child.on('close', (code) => finish({ code: code == null ? 1 : code, stdout, stderr }));
    child.stdin.end(typeof request.stdin === 'string' ? request.stdin : '');
  };

  const timer = setInterval(() => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const match = REQUEST_FILE.exec(name);
      if (match) handle(match[1], path.join(dir, name));
    }
  }, POLL_MS);
  timer.unref();

  return {
    dir,
    token,
    close: () => {
      clearInterval(timer);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    },
  };
}

// Orca only reaches Muse when a turn ends, so a worker that reports while Muse sits idle
// would never wake it, with or without metaveil. This sends Orca's own notice instead. It
// waits so Orca can go first, and never types while Muse is busy or something is in the
// prompt box.
const WAKE_POLL_MS = 10_000;
const WAKE_GRACE_MS = 20_000;
const WAKE_REPEAT_MS = 120_000;

function runOrca(orcaCommand, args, env) {
  return new Promise((resolve) => {
    execFile(orcaCommand, args, { env, windowsHide: true, timeout: 15_000, maxBuffer: 1 << 24 }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

export function museLooksIdle(screen) {
  const lines = String(screen || '').split(/\r?\n/).map((line) => line.trimEnd());
  if (lines.some((line) => /esc to interrupt|Would you like to run/.test(line))) return false;
  const prompts = lines.filter((line) => /^\s*\u276F/.test(line));
  const last = prompts[prompts.length - 1];
  return last !== undefined && last.replace(/^\s*\u276F/, '').trim() === '';
}

// check --peek returns only unread messages, and doesn't include a handled field.
export function unreadIn(json) {
  try {
    const messages = JSON.parse(json)?.result?.messages;
    return Array.isArray(messages) ? messages.filter((m) => m && typeof m.id === 'string' && m.handled !== true) : [];
  } catch {
    return [];
  }
}

export function startWakeWatcher({ env = process.env, orcaCommand = 'orca.exe', pollMs = WAKE_POLL_MS, graceMs = WAKE_GRACE_MS, repeatMs = WAKE_REPEAT_MS, run = runOrca, now = Date.now } = {}) {
  const handle = env.ORCA_TERMINAL_HANDLE;
  if (!handle) return () => {};
  const seenAt = new Map();
  let lastNotice = 0;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const reply = await run(orcaCommand, ['orchestration', 'check', '--terminal', handle, '--peek', '--json'], env);
      const unread = unreadIn(reply);
      for (const id of [...seenAt.keys()]) if (!unread.some((m) => m.id === id)) seenAt.delete(id);
      for (const m of unread) if (!seenAt.has(m.id)) seenAt.set(m.id, now());
      const due = unread.filter((m) => now() - seenAt.get(m.id) >= graceMs);
      if (due.length === 0 || now() - lastNotice < repeatMs) return;
      const screen = await run(orcaCommand, ['terminal', 'read', '--terminal', handle, '--screen'], env);
      if (!museLooksIdle(screen)) return;
      const count = due.length === 1 ? '1 orchestration message' : `${due.length} orchestration messages`;
      await run(orcaCommand, ['terminal', 'send', '--terminal', handle, '--text', `You have ${count}. Run orca orchestration check.`, '--json'], env);
      await new Promise((resolve) => setTimeout(resolve, 900));
      await run(orcaCommand, ['terminal', 'send', '--terminal', handle, '--enter', '--json'], env);
      lastNotice = now();
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
  timer.unref();
  return () => clearInterval(timer);
}

// Muse won't run with its temp folder inside the workspace, yet the workspace is the
// only place a sandboxed shell can write, and Rust's linker needs a writable temp. So
// these two commands get the project's temp folder, and nothing else changes.
const TEMP_WRAPPED = ['cargo', 'rustc'];

function writeTempWrappers(target, env) {
  const home = env.USERPROFILE || os.homedir();
  for (const tool of TEMP_WRAPPED) {
    const real = path.join(env.CARGO_HOME || path.join(home, '.cargo'), 'bin', `${tool}.exe`);
    if (!fs.existsSync(real)) continue;
    fs.writeFileSync(path.join(target, `${tool}.ps1`), [
      'if ($env:METAVEIL_SHELL_TEMP) { $env:TEMP = $env:METAVEIL_SHELL_TEMP; $env:TMP = $env:METAVEIL_SHELL_TEMP }',
      `& '${real.replace(/'/g, "''")}' @args`,
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n'));
    fs.writeFileSync(path.join(target, `${tool}.cmd`), [
      '@if defined METAVEIL_SHELL_TEMP (set "TEMP=%METAVEIL_SHELL_TEMP%" & set "TMP=%METAVEIL_SHELL_TEMP%")',
      `@"${real}" %*`,
      '',
    ].join('\r\n'));
  }
}

// Copied on each launch so the sandbox always gets the matching files.
export function prepareSandboxBin(scratchDir, env = process.env) {
  const source = path.join(import.meta.dirname, 'sandbox-bin');
  const target = path.join(scratchDir, 'bin');
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(source)) fs.copyFileSync(path.join(source, name), path.join(target, name));
  writeTempWrappers(target, env);
  return target;
}
