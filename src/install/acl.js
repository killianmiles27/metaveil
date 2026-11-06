import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const PRINCIPAL = 'MuseSandboxUsers';
export const DIR_ACE = '(OI)(CI)(RX)';
export const FILE_ACE = '(RX)';

const HOME_DIRS = [
  'Downloads', 'Documents', 'Desktop', 'Pictures', 'Videos', 'Music',
  '.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.claude', '.codex', '.pi',
];

const HOME_FILES = [
  '.git-credentials', '.netrc', '_netrc',
  '.config\\muse\\auth.json',
];

const BROWSER_DIRS = [
  'AppData\\Local\\Google\\Chrome\\User Data',
  'AppData\\Local\\Microsoft\\Edge\\User Data',
  'AppData\\Roaming\\Mozilla\\Firefox\\Profiles',
  'AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data',
  'AppData\\Local\\Chromium\\User Data',
];

const PASSWORD_MANAGER_DIRS = [
  'AppData\\Roaming\\Bitwarden', 'AppData\\Local\\Bitwarden',
  'AppData\\Roaming\\1Password', 'AppData\\Local\\1Password',
  'AppData\\Roaming\\KeePassXC', 'AppData\\Local\\KeePassXC',
  'AppData\\Roaming\\Dashlane', 'AppData\\Local\\Dashlane',
  'AppData\\Roaming\\NordPass', 'AppData\\Local\\NordPass',
];

const WINDOWS_SECRET_DIRS = [
  'AppData\\Roaming\\Microsoft\\Credentials',
  'AppData\\Local\\Microsoft\\Credentials',
  'AppData\\Roaming\\Microsoft\\Vault',
  'AppData\\Local\\Microsoft\\Vault',
  'AppData\\Roaming\\Microsoft\\Protect',
  'AppData\\Local\\Microsoft\\Protect',
];

const AUTH_FILES = [
  'AppData\\Roaming\\GitHub CLI\\hosts.yml',
  'AppData\\Roaming\\gh\\hosts.yml',
  '.config\\gh\\hosts.yml',
  '.config\\gcloud\\application_default_credentials.json',
  '.config\\gcloud\\credentials.db',
  '.aws\\credentials',
  '.aws\\config',
  '.kube\\config',
  '.docker\\config.json',
];

// Muse's own transcripts and trust list, plus Windows and app histories that name
// the user's files and messages. Only the sandbox group is denied; the user and
// Muse itself keep access.
const PERSONAL_TRAIL_DIRS = [
  '.config\\muse',
  '.local\\share\\muse\\sessions',
  '.local\\share\\muse\\local-tracing',
  'AppData\\Roaming\\Microsoft\\Windows\\Recent',
  'AppData\\Local\\Microsoft\\Windows\\History',
  'AppData\\Local\\Microsoft\\Windows\\Explorer',
  'AppData\\Roaming\\Microsoft\\Windows\\PowerShell\\PSReadLine',
  'AppData\\Roaming\\discord',
  'AppData\\Local\\Packages\\Microsoft.OutlookForWindows_8wekyb3d8bbwe',
];

const PERSONAL_TRAIL_FILES = [
  '.local\\share\\muse\\tui-history.jsonl',
  '.local\\share\\muse\\session-index.db',
];

// What sandboxed shells need that Windows would otherwise refuse: Python, which lives
// under the user's private program folder, and the folder holding the sandbox's orca
// command.
export function grantTargets({ homeDir, localAppData } = {}) {
  const local = normalizePath(localAppData || winJoin(homeDir, 'AppData', 'Local'));
  return [
    { path: winJoin(local, 'Programs', 'Python'), ace: '(OI)(CI)(RX)' },
    { path: scratchDirFor(homeDir), ace: '(OI)(CI)(RX)', create: true },
  ];
}

export function scratchDirFor(homeDir) {
  return winJoin(normalizePath(homeDir), '.metaveil-sandbox');
}

export function applyGrants(targets, { statePath, dryRun = true, runCommand = defaultRunCommand } = {}) {
  if (!statePath) throw new Error('statePath is required');
  const state = readAclState(statePath);
  const known = new Set(state.grants.map((entry) => lowerPath(entry.path)));
  const applied = [];
  const errors = [];
  for (const target of targets) {
    if (dryRun) { applied.push(target); continue; }
    if (target.create) fs.mkdirSync(target.path, { recursive: true });
    if (!fs.existsSync(target.path)) continue;
    const result = runCommand('icacls', [target.path, '/grant', `${PRINCIPAL}:${target.ace}`]);
    if (result.code !== 0) {
      errors.push({ path: target.path, code: result.code, stderr: result.stderr || result.stdout || '' });
      continue;
    }
    applied.push(target);
    if (!known.has(lowerPath(target.path))) state.grants.push({ path: target.path, ace: target.ace, principal: PRINCIPAL, create: target.create === true });
  }
  if (!dryRun) writeAclState(statePath, state);
  return { dryRun, applied, errors };
}

function winJoin(base, ...parts) {
  return path.win32.join(base, ...parts);
}

export function normalizePath(value) {
  let text = String(value == null ? '' : value).trim();
  if (!text) return '';
  text = text.replace(/^file:\/{2,3}/i, '');
  text = text.replace(/^[\\/]{2,4}\?[\\/]+/, '');
  text = text.replace(/[\\/]+/g, '\\');
  if (/^[A-Za-z]:$/.test(text)) text += '\\';
  return text;
}

export function lowerPath(value) {
  return normalizePath(value).toLowerCase();
}

export function isUnderPath(child, parent) {
  const c = lowerPath(child).replace(/\\+$/, '');
  const p = lowerPath(parent).replace(/\\+$/, '');
  if (!c || !p) return false;
  return c === p || c.startsWith(`${p}\\`);
}

function pathExists(value) {
  try {
    const stat = fs.statSync(value);
    return stat.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

function pushTarget(out, seen, value, label, kindHint = null) {
  const normalized = normalizePath(value);
  if (!normalized) return;
  const key = lowerPath(normalized);
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ path: normalized, label, kindHint });
}

export function defaultAclTargets({ homeDir, appData, localAppData, extras = [] } = {}) {
  if (!homeDir) throw new Error('homeDir is required');
  const home = normalizePath(homeDir);
  const roaming = normalizePath(appData || winJoin(home, 'AppData', 'Roaming'));
  const local = normalizePath(localAppData || winJoin(home, 'AppData', 'Local'));
  const out = [];
  const seen = new Set();

  for (const name of HOME_DIRS) pushTarget(out, seen, winJoin(home, name), name);
  for (const name of HOME_FILES) pushTarget(out, seen, winJoin(home, name), name, 'file');

  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (/^OneDrive/i.test(entry.name)) pushTarget(out, seen, winJoin(home, entry.name), entry.name);
    }
  } catch {
    // A missing synthetic home simply has no OneDrive* targets.
  }

  for (const rel of BROWSER_DIRS) pushTarget(out, seen, winJoin(home, rel), rel);
  for (const rel of PASSWORD_MANAGER_DIRS) pushTarget(out, seen, winJoin(home, rel), rel);
  for (const rel of WINDOWS_SECRET_DIRS) pushTarget(out, seen, winJoin(home, rel), rel);
  for (const rel of AUTH_FILES) pushTarget(out, seen, winJoin(home, rel), rel, 'file');
  for (const rel of PERSONAL_TRAIL_DIRS) pushTarget(out, seen, winJoin(home, rel), rel);
  for (const rel of PERSONAL_TRAIL_FILES) pushTarget(out, seen, winJoin(home, rel), rel, 'file');

  // Explicit appData/localAppData overrides are honored even when they are not
  // under the synthetic home (useful for tests).
  if (roaming !== winJoin(home, 'AppData', 'Roaming')) {
    for (const rel of BROWSER_DIRS.filter((r) => r.startsWith('AppData\\Roaming\\'))) {
      pushTarget(out, seen, winJoin(roaming, rel.slice('AppData\\Roaming\\'.length)), rel);
    }
    for (const rel of PASSWORD_MANAGER_DIRS.filter((r) => r.startsWith('AppData\\Roaming\\'))) {
      pushTarget(out, seen, winJoin(roaming, rel.slice('AppData\\Roaming\\'.length)), rel);
    }
  }
  if (local !== winJoin(home, 'AppData', 'Local')) {
    for (const rel of BROWSER_DIRS.filter((r) => r.startsWith('AppData\\Local\\'))) {
      pushTarget(out, seen, winJoin(local, rel.slice('AppData\\Local\\'.length)), rel);
    }
  }

  for (const extra of extras || []) {
    if (typeof extra !== 'string' || !extra.trim()) continue;
    const resolved = path.isAbsolute(extra) ? extra : winJoin(home, extra);
    pushTarget(out, seen, resolved, 'extra');
  }

  return out;
}

export function planAcl(options = {}) {
  const {
    homeDir, appData, localAppData, extras = [], workspaceRoots = [], targets,
  } = options;
  const list = targets || defaultAclTargets({ homeDir, appData, localAppData, extras });
  const roots = (workspaceRoots.length > 0 ? workspaceRoots : [process.cwd()]).map(normalizePath).filter(Boolean);
  const entries = [];
  const skipped = [];

  for (const target of list) {
    const entry = {
      path: normalizePath(target.path),
      label: target.label || target.path,
      kind: target.kindHint === 'file' ? 'file' : null,
      action: 'deny',
      reason: null,
      exists: false,
    };
    const actualKind = pathExists(entry.path);
    entry.exists = actualKind !== null;
    if (actualKind) entry.kind = actualKind;
    if (!entry.kind) entry.kind = target.kindHint || 'dir';

    const containingRoot = roots.find((root) => isUnderPath(root, entry.path));
    if (containingRoot) {
      entry.action = 'skip';
      entry.reason = `contains workspace/project root: ${containingRoot}`;
      skipped.push(entry);
      entries.push(entry);
      continue;
    }
    const insideRoot = roots.find((root) => isUnderPath(entry.path, root));
    if (insideRoot) {
      entry.action = 'skip';
      entry.reason = `inside workspace/project root: ${insideRoot}`;
      skipped.push(entry);
      entries.push(entry);
      continue;
    }
    if (!entry.exists) {
      entry.action = 'skip';
      entry.reason = 'path does not exist';
      skipped.push(entry);
      entries.push(entry);
      continue;
    }
    entries.push(entry);
  }

  return { homeDir: normalizePath(homeDir), workspaceRoots: roots, entries, skipped };
}

export function aclCommand(entry) {
  const ace = entry.kind === 'file' ? FILE_ACE : DIR_ACE;
  return { command: 'icacls', args: [entry.path, '/deny', `${PRINCIPAL}:${ace}`] };
}

export function removeAclCommand(entry) {
  return { command: 'icacls', args: [entry.path, '/remove:d', PRINCIPAL] };
}

export function formatCommand(spec) {
  const quote = (value) => (/[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
  return [spec.command, ...spec.args.map(quote)].join(' ');
}

export function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return {
    code: result.status == null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: `${result.stderr || ''}${result.error ? result.error.message : ''}`,
  };
}

export function statePathFor(metaveilHome) {
  return path.join(metaveilHome, 'acl-state.json');
}

export function readAclState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.applied)) {
      return { version: 1, applied: [], grants: [] };
    }
    const valid = (list) => (Array.isArray(list) ? list : []).filter((entry) => entry && typeof entry.path === 'string');
    return { version: 1, applied: valid(parsed.applied), grants: valid(parsed.grants) };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, applied: [], grants: [] };
    throw new Error(`could not read ACL state ${statePath}: ${error.message}`);
  }
}

export function writeAclState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, applied: state.applied, grants: state.grants || [] }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, statePath);
}

function acePresent(output, entry) {
  // The deny must be on the sandbox group's own line. A separate Allow for the group
  // plus a Deny for someone else isn't protection.
  return String(output || '').split(/\r?\n/).some((line) => line.toLowerCase().includes(PRINCIPAL.toLowerCase())
    && /\(DENY\)/i.test(line)
    && (entry.kind === 'file' || /\(OI\)\(CI\)/i.test(line)));
}

export function applyAcl(plan, {
  statePath,
  dryRun = true,
  runCommand = defaultRunCommand,
} = {}) {
  if (!statePath) throw new Error('statePath is required');
  const state = readAclState(statePath);
  const byPath = new Map(state.applied.map((entry) => [lowerPath(entry.path), entry]));
  const applied = [];
  const alreadyApplied = [];
  const commands = [];
  const errors = [];

  for (const entry of plan.entries) {
    if (entry.action !== 'deny' || !entry.exists) continue;
    const key = lowerPath(entry.path);
    const existing = byPath.get(key);
    if (existing && existing.ace === (entry.kind === 'file' ? FILE_ACE : DIR_ACE)) {
      alreadyApplied.push(entry);
      continue;
    }
    const spec = aclCommand(entry);
    commands.push(spec);
    if (dryRun) continue;

    // If the deny ACE is already present (state lost / manual apply), record it
    // instead of issuing a duplicate ACE.
    const check = runCommand('icacls', [entry.path]);
    if (check.code === 0 && acePresent(check.stdout, entry)) {
      const record = {
        path: entry.path,
        kind: entry.kind,
        label: entry.label,
        principal: PRINCIPAL,
        ace: entry.kind === 'file' ? FILE_ACE : DIR_ACE,
        appliedAt: new Date().toISOString(),
      };
      state.applied.push(record);
      byPath.set(key, record);
      alreadyApplied.push(entry);
      continue;
    }

    const result = runCommand(spec.command, spec.args);
    if (result.code !== 0) {
      errors.push({ path: entry.path, code: result.code, stderr: result.stderr || result.stdout || '' });
      continue;
    }
    const record = {
      path: entry.path,
      kind: entry.kind,
      label: entry.label,
      principal: PRINCIPAL,
      ace: entry.kind === 'file' ? FILE_ACE : DIR_ACE,
      appliedAt: new Date().toISOString(),
    };
    state.applied.push(record);
    byPath.set(key, record);
    applied.push(entry);
  }

  if (!dryRun && (applied.length > 0 || alreadyApplied.length > 0)) writeAclState(statePath, state);
  return { dryRun, commands, applied, alreadyApplied, errors, state };
}

export function removeAcl({
  statePath,
  dryRun = true,
  runCommand = defaultRunCommand,
} = {}) {
  if (!statePath) throw new Error('statePath is required');
  const state = readAclState(statePath);
  const commands = [];
  const removed = [];
  const errors = [];
  const remaining = [];

  for (const entry of state.applied) {
    const spec = removeAclCommand(entry);
    commands.push(spec);
    if (dryRun) {
      remaining.push(entry);
      continue;
    }
    const exists = pathExists(entry.path) !== null;
    if (!exists) {
      removed.push({ ...entry, missing: true });
      continue;
    }
    const result = runCommand(spec.command, spec.args);
    if (result.code !== 0) {
      errors.push({ path: entry.path, code: result.code, stderr: result.stderr || result.stdout || '' });
      remaining.push(entry);
      continue;
    }
    removed.push(entry);
  }

  const remainingGrants = [];
  for (const entry of state.grants) {
    const spec = { command: 'icacls', args: [entry.path, '/remove:g', PRINCIPAL] };
    commands.push(spec);
    if (dryRun) { remainingGrants.push(entry); continue; }
    if (pathExists(entry.path) === null) continue;
    const result = runCommand(spec.command, spec.args);
    if (result.code !== 0) {
      errors.push({ path: entry.path, code: result.code, stderr: result.stderr || result.stdout || '' });
      remainingGrants.push(entry);
      continue;
    }
    // That folder only holds files the launcher copied there.
    if (entry.create) fs.rmSync(entry.path, { recursive: true, force: true });
  }

  if (!dryRun) writeAclState(statePath, { applied: remaining, grants: remainingGrants });
  return { dryRun, commands, removed, errors, remaining };
}

export function statusAcl({
  statePath,
  runCommand = defaultRunCommand,
} = {}) {
  if (!statePath) throw new Error('statePath is required');
  let state;
  try {
    state = readAclState(statePath);
  } catch (error) {
    return { ok: false, reason: 'unreadable-state', detail: error.message, checked: 0, drift: [], entries: [] };
  }
  if (state.applied.length === 0) {
    return { ok: false, reason: 'no-state', checked: 0, drift: [], entries: [] };
  }
  const entries = [];
  const drift = [];
  for (const entry of state.applied) {
    const exists = pathExists(entry.path) !== null;
    if (!exists) {
      entries.push({ ...entry, status: 'missing-path' });
      drift.push({ path: entry.path, reason: 'missing-path' });
      continue;
    }
    const result = runCommand('icacls', [entry.path]);
    if (result.code !== 0) {
      entries.push({ ...entry, status: 'icacls-error', detail: result.stderr || result.stdout || '' });
      drift.push({ path: entry.path, reason: 'icacls-error' });
      continue;
    }
    if (!acePresent(result.stdout, entry)) {
      entries.push({ ...entry, status: 'deny-missing' });
      drift.push({ path: entry.path, reason: 'deny-missing' });
      continue;
    }
    entries.push({ ...entry, status: 'ok' });
  }
  return {
    ok: drift.length === 0,
    reason: drift.length === 0 ? null : 'drift',
    checked: entries.length,
    drift,
    entries,
  };
}

export function formatPlan(plan) {
  const lines = [];
  for (const entry of plan.entries) {
    if (entry.action === 'deny') {
      lines.push(`deny  ${entry.path}  (${entry.kind}, ${entry.label})`);
    } else {
      lines.push(`skip  ${entry.path}  (${entry.reason})`);
    }
  }
  return lines.join('\n');
}
