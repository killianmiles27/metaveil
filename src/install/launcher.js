#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { statusAcl } from './acl.js';
import { prepareSandboxBin, startOrcaBridge, startWakeWatcher } from './orca-bridge.js';
import {
  aclStatePath,
  DEFAULT_API_KEY_COMMAND,
  hookConfigPath,
  installStatePath,
  installedHookPath,
  launcherConfigPath,
  metaveilHome,
  museSettingsPath,
  realMuseCmd,
} from './paths.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const SUBCOMMANDS = new Set([
  'resume', 'exec', 'config', 'export', 'trace', 'model-profile', 'skills',
  'voice', 'plugins', 'sandbox', 'schema', 'serve', 'session-message', 'mcp',
  'auth', 'login', 'logout', 'usage', 'init',
]);
// Only these accept --base-url and --contributor-mode. Management commands such as
// `muse usage` reject them, and get the base URL from settings anyway.
const MODEL_SUBCOMMANDS = new Set(['exec', 'resume']);

export class LauncherError extends Error {
  constructor(message, code = 'LAUNCHER_ERROR', exitCode = 1) {
    super(message);
    this.name = 'LauncherError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function loadLauncherConfig(home = metaveilHome()) {
  const configPath = launcherConfigPath(home);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new LauncherError(`launcher config not found: ${configPath}; run metaveil install --apply first`, 'NO_LAUNCHER_CONFIG');
    }
    throw new LauncherError(`could not read launcher config ${configPath}: ${error.message}`, 'BAD_LAUNCHER_CONFIG');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LauncherError(`launcher config must be a JSON object: ${configPath}`, 'BAD_LAUNCHER_CONFIG');
  }
  return {
    home,
    port: Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536 ? parsed.port : 8787,
    proxyConfigPath: parsed.proxyConfigPath || path.join(home, 'proxy-config.json'),
    proxyCommand: parsed.proxyCommand || process.execPath,
    proxyArgs: Array.isArray(parsed.proxyArgs) ? parsed.proxyArgs : null,
    proxyStartTimeoutMs: Number.isInteger(parsed.proxyStartTimeoutMs) ? parsed.proxyStartTimeoutMs : 10_000,
    museReal: parsed.museReal || realMuseCmd(),
    hookPath: parsed.hookPath || installedHookPath(home),
    hookConfigPath: parsed.hookConfigPath || hookConfigPath(home),
    aclStatePath: parsed.aclStatePath || aclStatePath(home),
    installStatePath: parsed.installStatePath || installStatePath(home),
    contributorMarkerPath: parsed.contributorMarkerPath || path.join(home, 'contributor-leak-test.ok'),
    contributor: { enabled: parsed.contributor?.enabled === true },
    apiKeyCommand: Array.isArray(parsed.apiKeyCommand)
      && parsed.apiKeyCommand.length > 0
      && parsed.apiKeyCommand.every((part) => typeof part === 'string' && part.length > 0)
      ? [...parsed.apiKeyCommand]
      : [...DEFAULT_API_KEY_COMMAND],
    scratchDir: parsed.scratchDir || null,
    gitIdentity: parsed.gitIdentity && typeof parsed.gitIdentity === 'object' ? parsed.gitIdentity : null,
  };
}

function quoteCmdArg(value) {
  const text = String(value);
  if (!text) return '""';
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

// Muse never runs a hook command containing quotes, and says nothing. So the command
// is unquoted: `node` is on PATH because bin/muse.cmd just started this launcher with
// it, and a hook path with a space can't be expressed, so the gate refuses that.
export function hookCommandFor(hookPath) {
  return `node ${String(hookPath).replace(/\\/g, '/')}`;
}

// `-c hooks=` replaces the hooks Orca registers through managed_hooks_path, and Orca uses
// those to see when an agent goes idle and wake it. So they're carried along. metaveil's
// check goes first, and the proxy enforces the same rules whatever a hook answers.
export function mergeHooks(hookCommand, managed = {}) {
  const merged = {};
  for (const [event, entries] of Object.entries(managed)) {
    if (Array.isArray(entries)) merged[event] = entries;
  }
  merged.PreToolUse = [{ hooks: [{ type: 'command', command: hookCommand, timeout: 15 }] }, ...(merged.PreToolUse || [])];
  return merged;
}

function hooksOverride(hookCommand, managedHooks) {
  // JSON's \\u0020 keeps the argument free of spaces, which PowerShell 5.1 can't carry alongside quotes.
  return `hooks=${JSON.stringify(mergeHooks(hookCommand, managedHooks)).replace(/ /g, '\\u0020')}`;
}

// Orca's hook file, as named in Muse's settings. A missing or broken one just means
// there are no hooks to carry.
export function readManagedHooks(settingsPath = museSettingsPath(os.homedir())) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (typeof settings.managed_hooks_path !== 'string') return {};
    const parsed = JSON.parse(fs.readFileSync(settings.managed_hooks_path, 'utf8'));
    return parsed && typeof parsed.hooks === 'object' && parsed.hooks ? parsed.hooks : {};
  } catch {
    return {};
  }
}

// Muse ignores hooks in settings.json, so `-c hooks=` is the only global route.
const PINNED_CONFIG = ['endpoint_transport.base_url', 'telemetry.enabled', 'hooks'];
const isPinnedConfig = (value) => PINNED_CONFIG.some((key) => value === key || value.startsWith(`${key}=`) || value.startsWith(`${key}.`));

export function buildMuseArgs({ userArgs, port, contributorMode = 'off', hookCommand = null, managedHooks = {} }) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new LauncherError(`invalid metaveil proxy port: ${port}`, 'BAD_PORT');
  }
  const filtered = [];
  for (let i = 0; i < userArgs.length; i += 1) {
    const arg = userArgs[i];
    if (arg === '--yolo' || arg === '--yolo=true') {
      filtered.push('--disable-approval', '--trust-workspace');
      continue;
    }
    if (arg === '--disable-sandbox' || arg === '--disable-sandbox=true') {
      throw new LauncherError('refusing --disable-sandbox: metaveil requires the Muse shell sandbox to stay on', 'UNSAFE_FLAG', 2);
    }
    if (arg === '--sandbox-network') {
      const value = userArgs[i + 1];
      if (value === 'unrestricted' || value === 'enabled') {
        throw new LauncherError(`refusing --sandbox-network ${value}: metaveil requires a restricted network`, 'UNSAFE_FLAG', 2);
      }
      filtered.push(arg);
      if (value !== undefined && !value.startsWith('--')) { filtered.push(value); i += 1; }
      continue;
    }
    if (arg.startsWith('--sandbox-network=')) {
      const value = arg.slice('--sandbox-network='.length);
      if (value === 'unrestricted' || value === 'enabled') {
        throw new LauncherError(`refusing --sandbox-network ${value}: metaveil requires a restricted network`, 'UNSAFE_FLAG', 2);
      }
      filtered.push(arg);
      continue;
    }
    if (arg === '--base-url') {
      if (userArgs[i + 1] !== undefined && !userArgs[i + 1].startsWith('--')) i += 1;
      continue;
    }
    if (arg.startsWith('--base-url=')) continue;
    if (arg === '-c') {
      const value = userArgs[i + 1];
      if (value !== undefined && isPinnedConfig(value)) {
        i += 1;
        continue;
      }
      filtered.push(arg);
      if (value !== undefined && !value.startsWith('--')) { filtered.push(value); i += 1; }
      continue;
    }
    if (arg.startsWith('-c=')) {
      const value = arg.slice(3);
      if (isPinnedConfig(value)) continue;
      filtered.push(arg);
      continue;
    }
    if (arg === '--contributor-mode') {
      if (userArgs[i + 1] !== undefined && !userArgs[i + 1].startsWith('--')) i += 1;
      continue;
    }
    if (arg.startsWith('--contributor-mode=')) continue;
    filtered.push(arg);
  }

  let insertAt = 0;
  for (let i = 0; i < filtered.length; i += 1) {
    const token = filtered[i];
    if (token === '--') { insertAt = i; break; }
    if (!token.startsWith('-')) {
      if (SUBCOMMANDS.has(token)) {
        if (!MODEL_SUBCOMMANDS.has(token)) return filtered;
        insertAt = i + 1;
      }
      break;
    }
  }
  // Auto-review's AI reviewer sends side requests the proxy refuses, so it falls back to
  // asking a person, which stalls an unattended run. The sandbox and proxy are the
  // boundary in Contributor mode, and an approval mode the user chose is respected.
  const approvalChosen = filtered.some((arg) => /^--(disable-approval|approval-mode)(=|$)/.test(arg));
  const ourFlags = [
    ...(contributorMode === 'on' && !approvalChosen ? ['--disable-approval'] : []),
    '--base-url', `http://127.0.0.1:${port}/v1`,
    '-c', 'telemetry.enabled=false',
    '--contributor-mode', contributorMode === 'on' ? 'on' : 'off',
    ...(contributorMode === 'on' && hookCommand ? ['-c', hooksOverride(hookCommand, managedHooks)] : []),
  ];
  return [...filtered.slice(0, insertAt), ...ourFlags, ...filtered.slice(insertAt)];
}

export function fetchProxyHealth(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (size < 8192) {
          chunks.push(chunk);
          size += chunk.length;
        }
      });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        const healthy = res.statusCode === 200;
        finish({ healthy, jevReady: healthy && body?.jevReady === true, body });
      });
    });
    req.on('timeout', () => { req.destroy(); finish({ healthy: false, jevReady: false, body: null }); });
    req.on('error', () => finish({ healthy: false, jevReady: false, body: null }));
  });
}

export async function checkProxyHealth(port, timeoutMs = 1000) {
  const health = await fetchProxyHealth(port, timeoutMs);
  return health.healthy;
}

function defaultCommandRunner(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options, shell: false });
  return {
    code: result.status == null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

export function resolveProxyApiKey(config, { env = process.env, runCommand = defaultCommandRunner } = {}) {
  const current = env.OPENROUTER_API_KEY;
  if (typeof current === 'string' && current.trim()) return { key: current.trim(), source: 'environment' };
  const command = Array.isArray(config.apiKeyCommand) && config.apiKeyCommand.length > 0
    ? config.apiKeyCommand
    : DEFAULT_API_KEY_COMMAND;
  let executable = command[0];
  if (typeof executable !== 'string' || executable.length === 0) {
    return { key: null, reason: 'apiKeyCommand has no executable' };
  }
  if (process.platform === 'win32' && executable.toLowerCase() === 'pi') executable = 'pi.exe';
  let result;
  try {
    result = runCommand(executable, command.slice(1), {
      encoding: 'utf8',
      windowsHide: true,
      env,
    });
  } catch (error) {
    return { key: null, reason: `apiKeyCommand could not run: ${error.message}` };
  }
  if (!result || result.code !== 0) {
    return { key: null, reason: `apiKeyCommand exited with code ${result && result.code != null ? result.code : 1}` };
  }
  const key = String(result.stdout || '').trim();
  if (!key) return { key: null, reason: 'apiKeyCommand returned an empty key' };
  return { key, source: 'apiKeyCommand' };
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Best effort.
  }
}

export async function ensureProxy(config, { env = process.env, runCommand, stderr = process.stderr } = {}) {
  const existing = await fetchProxyHealth(config.port);
  if (existing.healthy) return { started: false, healthy: true, jevReady: existing.jevReady };
  const args = config.proxyArgs || [path.join(repoRoot, 'src', 'cli.js'), 'serve', '--config', config.proxyConfigPath];
  const resolved = resolveProxyApiKey(config, { env, runCommand });
  if (!resolved.key) {
    stderr.write(`metaveil: ${resolved.reason}; starting the proxy without a Jev key\n`);
  }
  const childEnv = { ...env };
  if (resolved.key) childEnv.OPENROUTER_API_KEY = resolved.key;
  let child;
  try {
    child = spawn(config.proxyCommand, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: repoRoot,
      env: childEnv,
      shell: false,
    });
    child.unref();
  } catch (error) {
    throw new LauncherError(`could not start metaveil proxy: ${error.message}`, 'PROXY_START_FAILED');
  }
  const deadline = Date.now() + config.proxyStartTimeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchProxyHealth(config.port);
    if (health.healthy) return { started: true, healthy: true, jevReady: health.jevReady, pid: child.pid };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  killProcessTree(child.pid);
  throw new LauncherError(
    `metaveil proxy is not healthy at http://127.0.0.1:${config.port}/healthz; refusing to launch Muse`,
    'PROXY_UNHEALTHY',
  );
}

function readInstallState(config) {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.installStatePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function isJevReady(config, env = process.env) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(config.proxyConfigPath, 'utf8'));
  } catch {
    return false;
  }
  const jev = raw && typeof raw.jev === 'object' ? raw.jev : null;
  if (!jev || jev.enabled !== true) return false;
  const keyEnv = typeof jev.apiKeyEnv === 'string' && jev.apiKeyEnv ? jev.apiKeyEnv : 'OPENROUTER_API_KEY';
  return typeof env[keyEnv] === 'string' && env[keyEnv].trim().length > 0;
}

export function contributorGate(config, { proxyHealthy = true, jevReady, runCommand } = {}) {
  const reasons = [];
  if (!config.contributor || config.contributor.enabled !== true) reasons.push('contributor.enabled is false');
  if (!proxyHealthy) reasons.push('proxy is not healthy');
  const ready = jevReady === undefined ? isJevReady(config) : jevReady === true;
  if (!ready) reasons.push('jev key unavailable');
  const install = readInstallState(config);
  if (!install || install.hooksInstalled !== true) reasons.push('hook is not installed');
  if (!fs.existsSync(config.hookPath)) reasons.push('hook file is missing');
  if (/\s/.test(config.hookPath)) reasons.push('hook path contains a space');
  const acl = statusAcl({ statePath: config.aclStatePath, runCommand });
  if (!acl.ok) reasons.push(`acl status is not clean (${acl.reason || 'drift'})`);
  if (acl.checked < 1) reasons.push('acl has no applied entries');
  if (!fs.existsSync(config.contributorMarkerPath)) reasons.push('leak-test marker is missing');
  return { on: reasons.length === 0, reasons, acl, install, jevReady: ready };
}

const TEMP_DIR_NAME = '.metaveil-tmp';

function excludeFromGit(cwd, runCommand) {
  const found = runCommand('git', ['rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8', windowsHide: true, cwd });
  if (!found || found.code !== 0) return;
  const file = path.resolve(cwd, String(found.stdout || '').trim());
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* not created yet */ }
  if (current.split(/\r?\n/).includes(`${TEMP_DIR_NAME}/`)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${TEMP_DIR_NAME}/\n`);
}

// Keeps caches, which are worth reusing. Only this session's temp folder goes.
function removeSessionTemp(cwd) {
  try { fs.rmSync(path.join(cwd, TEMP_DIR_NAME, `temp-${process.pid}`), { recursive: true, force: true, maxRetries: 2 }); } catch { /* harmless */ }
}

function gitConfigValue(key, runCommand) {
  const result = runCommand('git', ['config', '--get', key], { encoding: 'utf8', windowsHide: true });
  return result && result.code === 0 ? String(result.stdout || '').trim() : '';
}

// Sandboxed shells run as a different Windows user. Without this, git refuses repos the
// real user owns, can't read the user's git identity, and tools fail writing to the
// user's temp and cache folders. Names set here stay on this machine; the proxy masks
// them in anything sent upstream.
export function sandboxEnv(config, { env = process.env, runCommand = defaultCommandRunner, cwd = process.cwd() } = {}) {
  const out = { ...env, CARGO_CARGO_NEW_VCS: 'none', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' };
  const name = gitConfigValue('user.name', runCommand) || config.gitIdentity?.name;
  const email = gitConfigValue('user.email', runCommand) || config.gitIdentity?.email;
  if (name) { out.GIT_AUTHOR_NAME = name; out.GIT_COMMITTER_NAME = name; }
  if (email) { out.GIT_AUTHOR_EMAIL = email; out.GIT_COMMITTER_EMAIL = email; }
  const root = path.join(cwd, TEMP_DIR_NAME);
  const temp = path.join(root, `temp-${process.pid}`);
  try {
    fs.mkdirSync(temp, { recursive: true });
    out.METAVEIL_SHELL_TEMP = temp;
    excludeFromGit(cwd, runCommand);
    out.npm_config_cache = path.join(root, 'npm-cache');
    out.PIP_CACHE_DIR = path.join(root, 'pip-cache');
  } catch {
    // A read-only project just keeps the normal temp folder.
  }
  return out;
}

// The proxy is shared, and Orca can kill it along with the tab whose launcher started it.
// So every running launcher brings it back, or the other tabs lose their connection.
const PROXY_WATCH_MS = 5000;

export function watchProxy(config, { env = process.env, runCommand, ensure = ensureProxy, intervalMs = PROXY_WATCH_MS } = {}) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await ensure(config, { env, runCommand, stderr: { write() {} } }); } catch { /* tried again next round */ }
    busy = false;
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function resolveRealMuse(config) {
  const real = path.resolve(config.museReal);
  if (!fs.existsSync(real)) {
    throw new LauncherError(`real Muse launcher not found: ${real}`, 'MUSE_NOT_FOUND');
  }
  const resolved = fs.realpathSync.native ? fs.realpathSync.native(real) : fs.realpathSync(real);
  const self = path.resolve(repoRoot, 'bin', 'muse.cmd');
  if (resolved.toLowerCase() === self.toLowerCase() || real.toLowerCase() === self.toLowerCase()) {
    throw new LauncherError(`refusing recursive launch: real Muse resolves to metaveil's own ${self}`, 'RECURSION');
  }
  if (path.basename(resolved).toLowerCase() === 'muse.cmd'
    && path.dirname(resolved).toLowerCase() === path.dirname(self).toLowerCase()) {
    throw new LauncherError('refusing recursive launch: real Muse is metaveil bin/muse.cmd', 'RECURSION');
  }
  return resolved;
}

const UNSAFE_CMD_ARG = /["&|<>^%\r\n]/;

// Muse's launcher runs `& $binary @args` in Windows PowerShell 5.1. It decides whether
// to wrap an argument by counting quotes naively, so one with both spaces and quotes
// can split, and a prompt's words could become real flags. That case is refused.
export function escapeForPowerShellNative(value) {
  const raw = String(value);
  if (/\s/.test(raw) && raw.includes('"')) {
    throw new LauncherError(
      'an argument has both spaces and double quotes, which Muse\'s launcher would split apart; use single quotes in the prompt',
      'UNSAFE_ARG',
      2,
    );
  }
  const text = raw.replace(/(\\*)"/g, '$1$1\\"');
  return /\s/.test(text) ? text.replace(/(\\+)$/, '$1$1') : text;
}

export function spawnRealMuse(real, args, {
  stdio = 'inherit',
  env = process.env,
  spawnImpl = spawn,
  powershellExe = 'powershell.exe',
} = {}) {
  return new Promise((resolve, reject) => {
    const isCmd = /\.(cmd|bat)$/i.test(real);
    let child;
    try {
      if (isCmd) {
        const siblingPs1 = path.join(path.dirname(real), '.muse-launcher.ps1');
        if (fs.existsSync(siblingPs1)) {
          child = spawnImpl(powershellExe, [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', siblingPs1, ...args.map(escapeForPowerShellNative),
          ], { stdio, env, windowsHide: true, shell: false });
        } else {
          const unsafe = args.find((arg) => UNSAFE_CMD_ARG.test(String(arg)));
          if (unsafe !== undefined) {
            reject(new LauncherError(
              'refusing to pass an argument containing a cmd.exe metacharacter to a .cmd Muse launcher',
              'UNSAFE_ARG',
              2,
            ));
            return;
          }
          const line = `${quoteCmdArg(real)} ${args.map(quoteCmdArg).join(' ')}`;
          child = spawnImpl(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { stdio, env, windowsHide: true });
        }
      } else {
        child = spawnImpl(real, args, { stdio, env, windowsHide: true, shell: false });
      }
    } catch (error) {
      reject(error instanceof LauncherError ? error : new LauncherError(`could not launch Muse: ${error.message}`, 'MUSE_SPAWN_FAILED'));
      return;
    }
    child.on('error', (error) => reject(new LauncherError(`could not launch Muse: ${error.message}`, 'MUSE_SPAWN_FAILED')));
    child.on('exit', (code, signal) => resolve({ code: code == null ? 1 : code, signal }));
  });
}

export async function runLauncher(argv = process.argv.slice(2), env = process.env, { runCommand } = {}) {
  const config = loadLauncherConfig(metaveilHome(env));
  const real = resolveRealMuse(config);
  // Validate unsafe flags before starting anything.
  buildMuseArgs({ userArgs: argv, port: config.port, contributorMode: 'off' });
  const proxy = await ensureProxy(config, { env, runCommand });
  const gate = contributorGate(config, { proxyHealthy: proxy.healthy, jevReady: proxy.jevReady, runCommand });
  if (gate.reasons.length > 0) {
    process.stderr.write(`metaveil: contributor mode off (${gate.reasons.join('; ')})\n`);
  }
  const museEnv = sandboxEnv(config, { env, runCommand });
  const args = buildMuseArgs({
    userArgs: argv,
    port: config.port,
    contributorMode: gate.on ? 'on' : 'off',
    hookCommand: hookCommandFor(config.hookPath),
    managedHooks: readManagedHooks(),
  });
  // Only an Orca tab has a runtime to talk to.
  const inOrca = Object.keys(env).some((key) => key.startsWith('ORCA_'));
  const bridge = inOrca && config.scratchDir && museEnv.METAVEIL_SHELL_TEMP
    ? startOrcaBridge({ contributor: gate.on, env, dir: path.join(path.dirname(museEnv.METAVEIL_SHELL_TEMP), `bridge-${process.pid}`) })
    : null;
  if (config.scratchDir) {
    const sandboxBin = prepareSandboxBin(config.scratchDir, env);
    const pathKey = Object.keys(museEnv).find((key) => key.toLowerCase() === 'path') || 'Path';
    museEnv[pathKey] = `${sandboxBin}${path.delimiter}${museEnv[pathKey] || ''}`;
  }
  if (bridge) {
    museEnv.METAVEIL_ORCA_DIR = bridge.dir;
    museEnv.METAVEIL_ORCA_TOKEN = bridge.token;
  }
  const stopWatching = watchProxy(config, { env, runCommand });
  const stopWakes = inOrca ? startWakeWatcher({ env }) : () => {};
  try {
    const result = await spawnRealMuse(real, args, { env: museEnv });
    return result.code;
  } finally {
    stopWatching();
    stopWakes();
    if (bridge) bridge.close();
    removeSessionTemp(process.cwd());
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const code = await runLauncher(argv);
    process.exit(code);
  } catch (error) {
    const message = error instanceof LauncherError ? error.message : (error && error.message ? error.message : String(error));
    process.stderr.write(`metaveil: ${message}\n`);
    process.exit(error instanceof LauncherError ? error.exitCode : 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
