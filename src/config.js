import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_ALLOWED_TOOLS = Object.freeze([
  'read_file',
  'search',
  'write_file',
  'edit_file',
  'powershell',
  'write_todos',
  'subagent_*',
  'work_*',
  'monitor',
  'workflow',
  'read_skill',
  'powershell_input',
  // Muse's own bookkeeping. These run nothing.
  'generate_summary',
  'submit_reminder_decision',
  'snooze_reminder',
  'report_progress',
  // Muse's approval judge returns a structured verdict through this tool. It
  // executes nothing; filtering it stalls even ordinary sandboxed coding calls.
  'submit_approval_assessment',
  'get_goal',
  'create_goal',
  'update_goal',
  // Runs outside the sandbox, so evaluateFunctionCall limits it to public addresses.
  'web_fetch',
]);

export const DEFAULT_DENIED_SKILL_PATTERNS = Object.freeze([
  'computer-use',
  'orca-computer-use',
  'built-in-browser',
  'chrome-browser',
  'claude-in-chrome',
  'browser',
  'gmail',
  'drive',
  'calendar',
  'password',
  'credential',
  // These read other AI sessions, this machine's settings or outside data.
  'read-session',
  'resume-claude',
  'resume-codex',
  'import',
  'manage-settings',
  'doctor',
]);

export const DEFAULT_DENIED_COMMAND_PATTERNS = Object.freeze([
  'orca computer',
  'orca-computer-use',
  'screenshot',
  'CopyFromScreen',
  'Get-Clipboard',
  'cmdkey',
  'reg query',
  'gh auth token',
  'printenv',
  'Get-ChildItem Env:',
]);

export const DEFAULT_FILE_TOOLS = Object.freeze([
  'read_file',
  'search',
  'write_file',
  'edit_file',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'list_files',
  'read_multiple_files',
  'subagent_*',
  'work_*',
  '*file*',
]);

export const DEFAULT_SANDBOX_LINE_PATTERN = '^\\s*[-*]?\\s*Shell sandbox:\\s*on\\.\\s*$';

// Named without their bundled: prefix, which is how models often ask for them.
export const DEFAULT_BUNDLED_SKILLS = Object.freeze(['blender', 'create-plugin', 'create-skill', 'durable-test-collateral', 'game-3d-visuals', 'git', 'greenfield-project-scaffolding', 'grill', 'migrate', 'plan', 'python-env', 'requirements-clarification', 'table-fit', 'taste', 'workflow-authoring']);

// How Muse learns to use Orca, like every other CLI in it.
export const DEFAULT_ALLOWED_SKILLS = Object.freeze(['orchestration', 'orca-cli']);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'CONFIG_ERROR';
  }
}

function defaultDataDir() {
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'metaveil');
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, 'metaveil');
  return path.join(process.cwd(), '.metaveil-data');
}

function resolvePath(value, baseDir) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function stringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError(`${field} must be an array of strings`);
  }
  return value.filter((entry) => entry.length > 0);
}

function validateUpstream(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('upstream must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('upstream must use http or https');
  }
  return url.toString().replace(/\/$/, '');
}

export function normalizeConfig(raw, { configPath } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('config must be a JSON object');
  }
  const baseDir = configPath ? path.dirname(path.resolve(configPath)) : process.cwd();

  const homeDir = raw.homeDir;
  if (typeof homeDir !== 'string' || !homeDir) {
    throw new ConfigError('homeDir is required (e.g. "C:\\\\Users\\\\sampleuser")');
  }
  if (!/^[A-Za-z]:[\\/]/.test(homeDir)) {
    throw new ConfigError('homeDir must be an absolute Windows drive path');
  }
  const homeAlias = raw.homeAlias ?? 'C:\\Users\\dev';
  if (typeof homeAlias !== 'string' || !/^[A-Za-z]:[\\/]/.test(homeAlias)) {
    throw new ConfigError('homeAlias must be an absolute Windows drive path');
  }

  let workspaceRoot = raw.workspaceRoot ?? null;
  if (workspaceRoot !== null) {
    if (typeof workspaceRoot !== 'string' || !/^[A-Za-z]:[\\/]/.test(workspaceRoot)) {
      throw new ConfigError('workspaceRoot must be an absolute Windows drive path');
    }
    workspaceRoot = workspaceRoot.replace(/[\\/]+$/, '');
  }
  const workspaceAlias = raw.workspaceAlias ?? `${homeAlias.replace(/[\\/]+$/, '')}\\workspace`;
  if (typeof workspaceAlias !== 'string' || !/^[A-Za-z]:[\\/]/.test(workspaceAlias)) {
    throw new ConfigError('workspaceAlias must be an absolute Windows drive path');
  }

  const port = raw.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError('port must be an integer between 0 and 65535');
  }

  const maxBodyBytes = raw.maxBodyBytes ?? 64 * 1024 * 1024;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new ConfigError('maxBodyBytes must be a positive integer');
  }

  const detectorFailure = raw.detectorFailure ?? 'withhold';
  if (detectorFailure !== 'withhold' && detectorFailure !== 'block') {
    throw new ConfigError('detectorFailure must be "withhold" or "block"');
  }

  const identity = raw.identity ?? {};
  if (typeof identity !== 'object' || Array.isArray(identity)) {
    throw new ConfigError('identity must be an object');
  }

  const contributor = raw.contributorPolicy ?? {};
  if (typeof contributor !== 'object' || Array.isArray(contributor)) {
    throw new ConfigError('contributorPolicy must be an object');
  }
  const sandboxLinePattern = contributor.sandboxLinePattern ?? DEFAULT_SANDBOX_LINE_PATTERN;
  if (typeof sandboxLinePattern !== 'string') {
    throw new ConfigError('contributorPolicy.sandboxLinePattern must be a string');
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(sandboxLinePattern, 'i');
  } catch {
    throw new ConfigError('contributorPolicy.sandboxLinePattern must be a valid regular expression');
  }

  const dataDir = defaultDataDir();
  const mapPath = resolvePath(raw.mapPath ?? path.join(dataDir, 'map.json'), baseDir);
  const auditPath = resolvePath(raw.auditPath ?? path.join(dataDir, 'audit.jsonl'), baseDir);

  const jev = raw.jev ?? {};
  if (typeof jev !== 'object' || Array.isArray(jev)) {
    throw new ConfigError('jev must be an object');
  }
  const jevModel = typeof jev.model === 'string' && jev.model ? jev.model : 'typesafe/jev-1.14';
  const validateJevModel = (value) => typeof value === 'string'
    && /^typesafe\/jev-[A-Za-z0-9._-]+$/.test(value)
    && !/router|auto|free|~/i.test(value);
  if (!validateJevModel(jevModel)) {
    throw new ConfigError('jev.model must be an exact typesafe/jev-* id without router, auto, free or ~ aliases');
  }
  const jevAllowedModels = jev.allowedModels === undefined
    ? [jevModel]
    : stringArray(jev.allowedModels, 'jev.allowedModels');
  if (jevAllowedModels.length === 0 || jevAllowedModels.some((candidate) => !validateJevModel(candidate))) {
    throw new ConfigError('jev.allowedModels must contain exact typesafe/jev-* ids without router, auto, free or ~ aliases');
  }
  if (!jevAllowedModels.includes(jevModel)) {
    throw new ConfigError('jev.model must be present in jev.allowedModels');
  }
  const jevProviders = jev.providers === undefined
    ? ['TypeSafe']
    : stringArray(jev.providers, 'jev.providers');
  if (jevProviders.length === 0) {
    throw new ConfigError('jev.providers must contain at least one exact provider name');
  }
  const jevThreshold = jev.threshold === undefined ? 0.5 : jev.threshold;
  if (typeof jevThreshold !== 'number' || !Number.isFinite(jevThreshold) || jevThreshold < 0 || jevThreshold > 1) {
    throw new ConfigError('jev.threshold must be a number between 0 and 1');
  }
  const jevMaxCallsPerChunk = jev.maxCallsPerChunk === undefined ? 32 : jev.maxCallsPerChunk;
  if (!Number.isInteger(jevMaxCallsPerChunk) || jevMaxCallsPerChunk < 1) {
    throw new ConfigError('jev.maxCallsPerChunk must be a positive integer');
  }
  const jevContributorOnly = jev.contributorOnly === undefined ? true : jev.contributorOnly;
  if (typeof jevContributorOnly !== 'boolean') {
    throw new ConfigError('jev.contributorOnly must be a boolean');
  }
  const jevBaseUrlRaw = jev.baseUrl ?? 'https://openrouter.ai';
  if (typeof jevBaseUrlRaw !== 'string') {
    throw new ConfigError('jev.baseUrl must be a string');
  }
  let jevBaseUrl;
  try {
    const parsed = new URL(jevBaseUrlRaw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
    jevBaseUrl = parsed.toString().replace(/\/$/, '').replace(/\/api\/v1$/i, '').replace(/\/v1$/i, '');
  } catch {
    throw new ConfigError('jev.baseUrl must be a valid http(s) URL');
  }
  const jevApiKeyEnv = typeof jev.apiKeyEnv === 'string' && jev.apiKeyEnv
    ? jev.apiKeyEnv
    : 'OPENROUTER_API_KEY';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(jevApiKeyEnv)) {
    throw new ConfigError('jev.apiKeyEnv must be an environment variable name');
  }
  const jevTimeoutMs = Number.isInteger(jev.timeoutMs) && jev.timeoutMs > 0 ? jev.timeoutMs : 15000;
  const jevConcurrency = Number.isInteger(jev.concurrency) && jev.concurrency > 0
    ? Math.min(jev.concurrency, 32)
    : 4;
  const jevChunkChars = Number.isInteger(jev.chunkChars) && jev.chunkChars >= 500
    ? jev.chunkChars
    : 8000;
  const jevOverlapChars = Number.isInteger(jev.overlapChars) && jev.overlapChars >= 0
    ? Math.min(jev.overlapChars, jevChunkChars - 1)
    : Math.min(200, jevChunkChars - 1);
  const jevCachePath = resolvePath(
    jev.cachePath ?? path.join(path.dirname(mapPath), 'jev-cache.json'),
    baseDir,
  );

  return {
    configPath: configPath ? path.resolve(configPath) : null,
    port,
    upstream: validateUpstream(raw.upstream ?? 'https://api.meta.ai'),
    homeDir: homeDir.replace(/[\\/]+$/, ''),
    homeAlias: homeAlias.replace(/[\\/]+$/, ''),
    workspaceRoot,
    workspaceAlias: workspaceAlias.replace(/[\\/]+$/, ''),
    mapPath,
    auditPath,
    maxBodyBytes,
    detectorFailure,
    identity: {
      names: stringArray(identity.names, 'identity.names'),
      usernames: stringArray(identity.usernames, 'identity.usernames'),
      emails: stringArray(identity.emails, 'identity.emails'),
      hostnames: stringArray(identity.hostnames, 'identity.hostnames'),
      terms: stringArray(identity.terms, 'identity.terms'),
    },
    contributorPolicy: {
      allowedTools: contributor.allowedTools === undefined
        ? [...DEFAULT_ALLOWED_TOOLS]
        : stringArray(contributor.allowedTools, 'contributorPolicy.allowedTools'),
      deniedSkillPatterns: contributor.deniedSkillPatterns === undefined
        ? [...DEFAULT_DENIED_SKILL_PATTERNS]
        : stringArray(contributor.deniedSkillPatterns, 'contributorPolicy.deniedSkillPatterns'),
      deniedCommandPatterns: contributor.deniedCommandPatterns === undefined
        ? [...DEFAULT_DENIED_COMMAND_PATTERNS]
        : stringArray(contributor.deniedCommandPatterns, 'contributorPolicy.deniedCommandPatterns'),
      allowedRoots: contributor.allowedRoots === undefined
        ? []
        : stringArray(contributor.allowedRoots, 'contributorPolicy.allowedRoots'),
      fileTools: contributor.fileTools === undefined
        ? [...DEFAULT_FILE_TOOLS]
        : stringArray(contributor.fileTools, 'contributorPolicy.fileTools'),
      allowedSkills: contributor.allowedSkills === undefined
        ? [...DEFAULT_ALLOWED_SKILLS]
        : stringArray(contributor.allowedSkills, 'contributorPolicy.allowedSkills'),
      bundledSkills: contributor.bundledSkills === undefined
        ? [...DEFAULT_BUNDLED_SKILLS]
        : stringArray(contributor.bundledSkills, 'contributorPolicy.bundledSkills'),
      sandboxLinePattern,
    },
    jev: {
      enabled: jev.enabled === true,
      configured: raw.jev !== undefined,
      baseUrl: jevBaseUrl,
      model: jevModel,
      apiKeyEnv: jevApiKeyEnv,
      allowedModels: jevAllowedModels,
      providers: jevProviders,
      threshold: jevThreshold,
      maxCallsPerChunk: jevMaxCallsPerChunk,
      contributorOnly: jevContributorOnly,
      timeoutMs: jevTimeoutMs,
      cachePath: jevCachePath,
      concurrency: jevConcurrency,
      chunkChars: jevChunkChars,
      overlapChars: jevOverlapChars,
    },
  };
}

export function loadConfig(configPath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new ConfigError(`config file not found: ${configPath}`);
    throw new ConfigError(`could not read config file: ${error.message}`);
  }
  return normalizeConfig(raw, { configPath });
}
