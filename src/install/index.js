import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeConfig, DEFAULT_ALLOWED_SKILLS, DEFAULT_BUNDLED_SKILLS } from '../config.js';
import { applyAcl, applyGrants, grantTargets, planAcl, removeAcl, scratchDirFor, statusAcl, formatCommand } from './acl.js';
import {
  aclStatePath,
  contributorMarkerPath,
  DEFAULT_API_KEY_COMMAND,
  hookConfigPath,
  installStatePath,
  installedHookPath,
  launcherConfigPath,
  metaveilHome as defaultMetaveilHome,
  museSettingsPath,
  realMuseCmd,
  userHome,
} from './paths.js';
import {
  DEFAULT_PATH_KIND,
  pathEntryEquals,
  readSavedUserPath,
  removePathEntry,
  writeSavedUserPath,
} from './path-registry.js';

export const repoRoot = path.resolve(import.meta.dirname, '..', '..');
export const HOOK_SOURCE = path.join(repoRoot, 'src', 'hook', 'policy.cjs');
export const HOOK_INTERNAL_TIMEOUT_MS = 8000;

export class InstallError extends Error {
  constructor(message, code = 'INSTALL_ERROR') {
    super(message);
    this.name = 'InstallError';
    this.code = code;
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new InstallError(`could not read ${file}: ${error.message}`, 'READ_FAILED');
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function lineDiff(beforeText, afterText) {
  const a = String(beforeText).split(/\r?\n/);
  const b = String(afterText).split(/\r?\n/);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${a[i]}`);
      i += 1;
    } else {
      out.push(`+${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length) { out.push(`-${a[i]}`); i += 1; }
  while (j < b.length) { out.push(`+${b[j]}`); j += 1; }
  return out.join('\n');
}

export function mergeSettings(current, { baseUrl }) {
  const settings = clone(current && typeof current === 'object' ? current : {});
  if (settings.schema_version === undefined) settings.schema_version = 1;
  if (!settings.endpoint_transport || typeof settings.endpoint_transport !== 'object' || Array.isArray(settings.endpoint_transport)) {
    settings.endpoint_transport = {};
  }
  settings.endpoint_transport.base_url = baseUrl;
  if (!settings.telemetry || typeof settings.telemetry !== 'object' || Array.isArray(settings.telemetry)) {
    settings.telemetry = {};
  }
  settings.telemetry.enabled = false;
  return settings;
}

export function removeSettings(current, { baseUrl, telemetryPrevious } = {}) {
  const settings = clone(current && typeof current === 'object' ? current : {});
  if (settings.telemetry && typeof settings.telemetry === 'object' && !Array.isArray(settings.telemetry)) {
    if (telemetryPrevious && telemetryPrevious.present) settings.telemetry.enabled = telemetryPrevious.value;
    else if (settings.telemetry.enabled === false) delete settings.telemetry.enabled;
    if (Object.keys(settings.telemetry).length === 0) delete settings.telemetry;
  }
  if (settings.endpoint_transport && typeof settings.endpoint_transport === 'object') {
    if (settings.endpoint_transport.base_url === baseUrl) delete settings.endpoint_transport.base_url;
    if (Object.keys(settings.endpoint_transport).length === 0) delete settings.endpoint_transport;
  }
  return settings;
}

export function metaveilHomeFor(homeDir, explicit) {
  if (explicit) return path.resolve(explicit);
  const real = path.resolve(userHome());
  if (path.resolve(homeDir).toLowerCase() !== real.toLowerCase()) {
    return path.join(path.resolve(homeDir), 'AppData', 'Local', 'metaveil');
  }
  return defaultMetaveilHome();
}

export function planPath({ binDir, currentPath = '', currentKind = DEFAULT_PATH_KIND } = {}) {
  if (!binDir) throw new InstallError('binDir is required');
  const normalizedBin = path.resolve(binDir);
  const raw = String(currentPath == null ? '' : currentPath);
  const entries = raw.split(';');
  const present = entries.some((entry) => pathEntryEquals(entry, normalizedBin));
  let newPath;
  if (present) newPath = raw;
  else if (raw.length === 0) newPath = normalizedBin;
  else newPath = `${normalizedBin};${raw}`;
  return {
    binDir: normalizedBin,
    currentPath: raw,
    currentKind: currentKind || DEFAULT_PATH_KIND,
    newPath,
    changed: !present,
  };
}

function isRealHomeDir(homeDir) {
  return path.resolve(homeDir).toLowerCase() === path.resolve(userHome()).toLowerCase();
}

function identityObject(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const key of ['names', 'usernames', 'emails', 'hostnames', 'terms']) {
    out[key] = source[key] === undefined ? [] : source[key];
  }
  return out;
}

function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(target));
    else out.push(target);
  }
  return out;
}

export function planInstall(options = {}) {
  const homeDir = path.resolve(options.homeDir || userHome());
  const workspaceRoot = path.resolve(options.workspaceRoot || options.workspace || process.cwd());
  const port = Number.isInteger(options.port) && options.port > 0 && options.port < 65536 ? options.port : 8787;
  const metaveilHome = metaveilHomeFor(homeDir, options.metaveilHome);
  const settingsPath = museSettingsPath(homeDir);
  const settingsExists = fs.existsSync(settingsPath);
  const currentSettings = readJson(settingsPath, { schema_version: 1 }) || { schema_version: 1 };
  const hookPath = installedHookPath(metaveilHome);
  const hookConfigFile = hookConfigPath(metaveilHome);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const after = mergeSettings(currentSettings, { baseUrl });
  const beforeText = settingsExists ? `${JSON.stringify(currentSettings, null, 2)}\n` : '';
  const afterText = `${JSON.stringify(after, null, 2)}\n`;
  const pathPlanPath = path.join(metaveilHome, 'path-plan.json');
  const proxyConfigPath = path.join(metaveilHome, 'proxy-config.json');
  const telemetryPrevious = currentSettings.telemetry && typeof currentSettings.telemetry === 'object'
    && !Array.isArray(currentSettings.telemetry)
    && Object.prototype.hasOwnProperty.call(currentSettings.telemetry, 'enabled')
    ? { present: true, value: currentSettings.telemetry.enabled }
    : { present: false, value: null };
  const injectedReader = typeof options.runCommand === 'function';
  let savedPath;
  if (options.pathState && typeof options.pathState === 'object') {
    savedPath = {
      value: String(options.pathState.value == null ? '' : options.pathState.value),
      kind: options.pathState.kind || DEFAULT_PATH_KIND,
    };
  } else if (injectedReader) {
    savedPath = readSavedUserPath({ runCommand: options.runCommand });
  } else if (options.currentPath !== undefined) {
    savedPath = {
      value: String(options.currentPath == null ? '' : options.currentPath),
      kind: options.currentKind || DEFAULT_PATH_KIND,
    };
  } else if (!isRealHomeDir(homeDir)) {
    // A synthetic home must never cause a read of the real user registry.
    savedPath = { value: '', kind: DEFAULT_PATH_KIND };
  } else {
    savedPath = readSavedUserPath({ runCommand: defaultRunner });
  }
  const pathPlan = planPath({
    binDir: path.join(repoRoot, 'bin'),
    currentPath: savedPath.value,
    currentKind: savedPath.kind,
  });
  const aclPlan = planAcl({
    homeDir,
    workspaceRoots: [workspaceRoot],
    // Its identity list and token map must stay out of a sandboxed shell's reach.
    extras: [...(options.extras || []), metaveilHome],
    appData: options.appData,
    localAppData: options.localAppData,
  });
  const existingLauncher = readJson(launcherConfigPath(metaveilHome), null);
  const contributorEnabled = existingLauncher?.contributor?.enabled === true;
  const identityPath = path.join(metaveilHome, 'identity.json');
  let identitySource = null;
  let rawIdentity = {};
  if (options.identity !== undefined && typeof options.identity !== 'string') {
    throw new InstallError('identity must be a file path', 'IDENTITY_INVALID');
  }
  if (options.identity) {
    identitySource = path.resolve(options.identity);
    rawIdentity = readJson(identitySource, null);
    if (rawIdentity === null) throw new InstallError(`identity file not found: ${identitySource}`, 'IDENTITY_MISSING');
  } else {
    rawIdentity = readJson(identityPath, {}) || {};
  }
  const identity = identityObject(rawIdentity);
  const hookConfig = {
    allowedRoots: options.allowedRoots || [],
    allowedSkills: options.allowedSkills && options.allowedSkills.length > 0 ? options.allowedSkills : [...DEFAULT_ALLOWED_SKILLS],
    bundledSkills: options.bundledSkills && options.bundledSkills.length > 0 ? options.bundledSkills : [...DEFAULT_BUNDLED_SKILLS],
    fileTools: options.fileTools || ['read_file', 'search', 'write_file', 'edit_file', 'glob', 'grep', 'list_files', 'read_multiple_files'],
    timeoutMs: HOOK_INTERNAL_TIMEOUT_MS,
  };
  const proxyConfig = {
    port,
    upstream: options.upstream || 'https://api.meta.ai',
    homeDir,
    homeAlias: 'C:\\Users\\dev',
    workspaceAlias: 'C:\\Users\\dev\\workspace',
    mapPath: path.join(metaveilHome, 'map.json'),
    auditPath: path.join(metaveilHome, 'audit.jsonl'),
    identity,
    jev: {
      enabled: true,
      baseUrl: 'https://openrouter.ai',
      model: 'typesafe/jev-1.14',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      cachePath: path.join(metaveilHome, 'jev-cache.json'),
      contributorOnly: true,
    },
  };
  try {
    normalizeConfig(proxyConfig, { configPath: proxyConfigPath });
  } catch (error) {
    throw new InstallError(`proxy config is invalid: ${error.message}`, 'CONFIG_INVALID');
  }
  const launcherConfig = {
    port,
    proxyConfigPath,
    museReal: options.museReal || realMuseCmd(),
    hookPath,
    hookConfigPath: hookConfigFile,
    aclStatePath: aclStatePath(metaveilHome),
    installStatePath: installStatePath(metaveilHome),
    contributorMarkerPath: contributorMarkerPath(metaveilHome),
    contributor: { enabled: contributorEnabled },
    apiKeyCommand: options.apiKeyCommand || [...DEFAULT_API_KEY_COMMAND],
    scratchDir: scratchDirFor(homeDir),
    ...(existingLauncher?.gitIdentity ? { gitIdentity: existingLauncher.gitIdentity } : {}),
  };
  const installState = {
    version: 1,
    settingsPath,
    settingsBackupPath: null,
    settingsApplied: after,
    hookPath,
    hookConfigPath: hookConfigFile,
    baseUrl,
    binDir: pathPlan.binDir,
    pathPlanPath,
    pathChanged: pathPlan.changed,
    installedPathValue: pathPlan.newPath,
    previousPath: { value: pathPlan.currentPath, kind: pathPlan.currentKind },
    telemetryPrevious,
    aclStatePath: aclStatePath(metaveilHome),
    launcherConfigPath: launcherConfigPath(metaveilHome),
    proxyConfigPath,
    identityPath,
    installedAt: new Date().toISOString(),
  };
  return {
    homeDir,
    workspaceRoot,
    metaveilHome,
    port,
    settingsPath,
    settingsExists,
    currentSettings,
    afterSettings: after,
    settingsDiff: lineDiff(beforeText, afterText),
    hookPath,
    hookConfigPath: hookConfigFile,
    hookConfig,
    baseUrl,
    pathPlan,
    pathPlanPath,
    aclPlan,
    proxyConfig,
    proxyConfigPath,
    identity,
    identityPath,
    identitySource,
    launcherConfig,
    installState,
  };
}

function writeHookFiles(plan) {
  fs.mkdirSync(path.dirname(plan.hookPath), { recursive: true });
  fs.copyFileSync(HOOK_SOURCE, plan.hookPath);
  writeJson(plan.hookConfigPath, plan.hookConfig);
}

function writePathPlanRecord(plan, applied, reason) {
  writeJson(plan.pathPlanPath || path.join(plan.metaveilHome, 'path-plan.json'), {
    applied,
    reason,
    binDir: plan.pathPlan.binDir,
    previousPath: plan.pathPlan.currentPath,
    previousKind: plan.pathPlan.currentKind,
    newPath: plan.pathPlan.newPath,
  });
}

function applyPathPlan(plan, { homeDir, runCommand, applyPath = true, allowSynthetic = false }) {
  const synthetic = !isRealHomeDir(homeDir);
  if (synthetic && !allowSynthetic) {
    writePathPlanRecord(plan, false, 'synthetic home: real user PATH was not modified');
    return { applied: false, synthetic: true };
  }
  if (!applyPath) {
    if (synthetic) writePathPlanRecord(plan, false, 'PATH application was disabled');
    return { applied: false, synthetic };
  }
  if (!plan.pathPlan.changed) return { applied: false, synthetic };
  try {
    writeSavedUserPath({ value: plan.pathPlan.newPath, kind: plan.pathPlan.currentKind }, { runCommand });
  } catch (error) {
    throw new InstallError(`could not update saved user PATH: ${error.message}`, 'PATH_FAILED');
  }
  return { applied: true, synthetic };
}

function removePathPlan(plan, { homeDir, runCommand, applyPath = true, state = null, allowSynthetic = false }) {
  const synthetic = !isRealHomeDir(homeDir);
  if (synthetic && !allowSynthetic) return { applied: false, synthetic: true };
  if (!applyPath) return { applied: false, synthetic };
  if (state && state.pathChanged === false) return { applied: false, synthetic, reason: 'PATH unchanged at install' };
  let current;
  try {
    current = readSavedUserPath({ runCommand });
  } catch (error) {
    throw new InstallError(`could not read saved user PATH: ${error.message}`, 'PATH_FAILED');
  }
  const binDir = (state && state.binDir) || plan.pathPlan.binDir;
  try {
    if (state && state.previousPath && state.installedPathValue !== undefined
      && current.value === state.installedPathValue) {
      writeSavedUserPath({ value: state.previousPath.value, kind: state.previousPath.kind }, { runCommand });
      return { applied: true, synthetic, restored: true };
    }
    const removal = removePathEntry(current.value, binDir);
    if (!removal.removed) return { applied: false, synthetic };
    writeSavedUserPath({ value: removal.value, kind: current.kind }, { runCommand });
    return { applied: true, synthetic, restored: false };
  } catch (error) {
    throw new InstallError(`could not update saved user PATH: ${error.message}`, 'PATH_FAILED');
  }
}

function defaultRunner(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    env: options.env || process.env,
  });
  return { code: result.status == null ? 1 : result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

export function applyInstall(plan, { runCommand, applyAcl: shouldApplyAcl = true, applyPath: shouldApplyPath = true, now = new Date() } = {}) {
  const injectedRunner = typeof runCommand === 'function';
  const runner = runCommand || defaultRunner;
  let backupPath = null;
  if (plan.settingsExists) {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    backupPath = `${plan.settingsPath}.metaveil-backup-${stamp}`;
    fs.mkdirSync(path.dirname(plan.settingsPath), { recursive: true });
    fs.copyFileSync(plan.settingsPath, backupPath);
  }
  writeJson(plan.settingsPath, plan.afterSettings);
  if (plan.identitySource && path.resolve(plan.identitySource) !== path.resolve(plan.identityPath)) {
    fs.mkdirSync(path.dirname(plan.identityPath), { recursive: true });
    fs.copyFileSync(plan.identitySource, plan.identityPath);
  }
  writeJson(plan.proxyConfigPath || plan.launcherConfig.proxyConfigPath, plan.proxyConfig);
  writeJson(launcherConfigPath(plan.metaveilHome), plan.launcherConfig);
  writeHookFiles(plan);
  const state = { ...plan.installState, settingsBackupPath: backupPath, hooksInstalled: true };
  writeJson(installStatePath(plan.metaveilHome), state);
  const pathResult = applyPathPlan(plan, {
    homeDir: plan.homeDir,
    runCommand: runner,
    applyPath: shouldApplyPath,
    allowSynthetic: injectedRunner,
  });
  const aclResult = shouldApplyAcl
    ? applyAcl(plan.aclPlan, { statePath: state.aclStatePath, dryRun: false, runCommand: runner })
    : { dryRun: true, applied: [], alreadyApplied: [], errors: [], commands: [] };
  if (shouldApplyAcl) {
    const granted = applyGrants(grantTargets({ homeDir: plan.homeDir, localAppData: plan.localAppData }), { statePath: state.aclStatePath, dryRun: false, runCommand: runner });
    aclResult.errors = [...(aclResult.errors || []), ...granted.errors];
  }
  return { backupPath, path: pathResult, acl: aclResult, state };
}

export function uninstall(options = {}, { runCommand, applyAcl: shouldApplyAcl = true, applyPath: shouldApplyPath = true } = {}) {
  const homeDir = path.resolve(options.homeDir || userHome());
  const metaveilHome = metaveilHomeFor(homeDir, options.metaveilHome);
  const statePath = installStatePath(metaveilHome);
  const state = readJson(statePath, null);
  if (!state) throw new InstallError(`install state not found: ${statePath}`, 'NO_INSTALL_STATE');
  const injectedRunner = typeof runCommand === 'function';
  const runner = runCommand || defaultRunner;
  const settingsPath = state.settingsPath || museSettingsPath(homeDir);
  const current = readJson(settingsPath, null);
  if (current) {
    if (state.settingsBackupPath && fs.existsSync(state.settingsBackupPath) && state.settingsApplied && deepEqual(current, state.settingsApplied)) {
      fs.copyFileSync(state.settingsBackupPath, settingsPath);
    } else {
      writeJson(settingsPath, removeSettings(current, { baseUrl: state.baseUrl, telemetryPrevious: state.telemetryPrevious }));
    }
  }
  const aclResult = shouldApplyAcl
    ? removeAcl({ statePath: state.aclStatePath || aclStatePath(metaveilHome), dryRun: false, runCommand: runner })
    : { dryRun: true, removed: [], errors: [], commands: [] };
  const pathResult = removePathPlan(
    { pathPlan: { binDir: state.binDir || path.join(repoRoot, 'bin') }, metaveilHome },
    { homeDir, runCommand: runner, applyPath: shouldApplyPath, state, allowSynthetic: injectedRunner },
  );
  const removeFiles = [
    state.hookPath,
    state.hookConfigPath,
    state.launcherConfigPath,
    state.proxyConfigPath,
    state.pathPlanPath,
    // Blocks on drive roots need an Administrator terminal to remove. Keep the record
    // of anything that couldn't be removed so a second uninstall can finish the job.
    ...(aclResult.errors && aclResult.errors.length > 0 ? [] : [state.aclStatePath || aclStatePath(metaveilHome)]),
    statePath,
  ].filter(Boolean);
  for (const file of new Set(removeFiles)) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  const remaining = listFilesRecursive(metaveilHome);
  return { state, acl: aclResult, path: pathResult, remaining };
}

export function contributorSet(options = {}, enabled) {
  const homeDir = path.resolve(options.homeDir || userHome());
  const metaveilHome = metaveilHomeFor(homeDir, options.metaveilHome);
  const configPath = launcherConfigPath(metaveilHome);
  const config = readJson(configPath, null);
  if (!config) throw new InstallError(`launcher config not found: ${configPath}; run metaveil install --apply first`, 'NO_LAUNCHER_CONFIG');
  if (enabled) {
    const marker = config.contributorMarkerPath || contributorMarkerPath(metaveilHome);
    if (!fs.existsSync(marker)) {
      throw new InstallError(`contributor mode refused: leak-test marker is missing (${marker})`, 'CONTRIBUTOR_MARKER_MISSING');
    }
  }
  config.contributor = { ...(config.contributor || {}), enabled: Boolean(enabled) };
  writeJson(configPath, config);
  return config;
}

export function aclStatusFor(options = {}) {
  const homeDir = path.resolve(options.homeDir || userHome());
  const metaveilHome = metaveilHomeFor(homeDir, options.metaveilHome);
  return statusAcl({ statePath: aclStatePath(metaveilHome) });
}

export function aclPlanFor(options = {}) {
  const homeDir = path.resolve(options.homeDir || userHome());
  const workspaceRoot = path.resolve(options.workspaceRoot || options.workspace || process.cwd());
  return planAcl({ homeDir, workspaceRoots: [workspaceRoot], extras: options.extras || [], appData: options.appData, localAppData: options.localAppData });
}

export function aclApplyFor(plan, options = {}) {
  const homeDir = path.resolve(options.homeDir || userHome());
  const metaveilHome = metaveilHomeFor(homeDir, options.metaveilHome);
  return applyAcl(plan, { statePath: aclStatePath(metaveilHome), dryRun: options.dryRun !== false, runCommand: options.runCommand });
}

export function aclRemoveFor(options = {}) {
  const homeDir = path.resolve(options.homeDir || userHome());
  const metaveilHome = metaveilHomeFor(homeDir, options.metaveilHome);
  return removeAcl({ statePath: aclStatePath(metaveilHome), dryRun: options.dryRun !== false, runCommand: options.runCommand });
}

export { formatCommand };
