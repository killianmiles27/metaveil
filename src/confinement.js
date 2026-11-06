import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp, isObject, policyPatternMatches } from './util.js';

const PATH_KEYS = new Set([
  'path',
  'file',
  'files',
  'file_path',
  'filepath',
  'filename',
  'dir',
  'directory',
  'folder',
  'root',
  'cwd',
  'workdir',
  'working_directory',
  'target',
  'source',
  'dest',
  'destination',
  'output_path',
  'input_path',
  'old_path',
  'new_path',
  'workspace',
  'workspace_root',
  'location',
  'paths',
  'directories',
  'folders',
]);

// Values under these keys are user payload (file contents, search patterns),
// not paths to confine. Everything else may contain an embedded path.
const CONTENT_KEYS = new Set([
  'content',
  'text',
  'body',
  'data',
  'query',
  'pattern',
  'replacement',
  'old_string',
  'new_string',
  'old_content',
  'new_content',
  'old_text',
  'new_text',
]);

// Windows drive paths, UNC paths, traversal-relative paths, and MSYS /c/ paths.
const EMBEDDED_PATH_RE = /(?:(?<![A-Za-z])[A-Za-z]:[\\/][^\s"'`<>|,;)\]]*|\\\\[^\s"'`<>|,;)\]]*|\.\.[\\/][^\s"'`<>|,;)\]]*|\/c\/[^\s"'`<>|,;)\]]*)/gi;

function matchesNamePattern(value, patterns) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return (patterns || []).some((pattern) => {
    if (/[*?]/.test(pattern)) return globToRegExp(pattern).test(value);
    return value.toLowerCase() === String(pattern).toLowerCase();
  });
}

function matchPattern(value, patterns) {
  for (const pattern of patterns || []) {
    if (policyPatternMatches(value, pattern)) return pattern;
  }
  return null;
}

/**
 * Normalize a Windows-ish path for confinement checks.
 * Returns { kind: 'drive'|'unc', path, lower, hasShortName } or null.
 * Relative paths are resolved against baseDir when supplied.
 */
export function normalizeConfinedPath(raw, baseDir = null) {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;
  if ((text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))
    || (text.startsWith('`') && text.endsWith('`'))) {
    text = text.slice(1, -1).trim();
  }
  if (!text) return null;
  if (/[\0\r\n]/.test(text)) return null;
  if (/%[A-Za-z_][A-Za-z0-9_]*%|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(text)) return null;
  if (/(?:^|[\\/])~(?=$|[\\/])/.test(text)) return null;

  for (let pass = 0; pass < 2 && /%[0-9A-Fa-f]{2}/.test(text); pass += 1) {
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) break;
      text = decoded;
    } catch {
      return null;
    }
  }

  if (/^file:\/\/\//i.test(text)) {
    text = text.replace(/^file:\/\/\//i, '');
  }
  const fileUri = /^file:\/\/([^/]*)(\/.*)?$/i.exec(text);
  if (fileUri) {
    const authority = fileUri[1];
    const rest = fileUri[2] || '';
    if (/^[A-Za-z]:$/.test(authority)) text = `${authority}${rest}`;
    else if (!authority) text = rest;
    else text = `\\\\${authority}${rest}`;
  } else {
    text = text.replace(/^file:\/{2,3}/i, '');
  }
  let devicePath = false;
  if (/^\\\\\?\\UNC\\/i.test(text)) {
    text = `\\\\${text.slice(8)}`;
  } else if (/^\\\\\?\\/i.test(text) || /^\\\\.\\/i.test(text)) {
    text = text.slice(4);
    devicePath = true;
  }
  if (devicePath && !/^[A-Za-z]:[\\/]/.test(text) && !/^\\\\/.test(text)) return null;
  if (!text.trim()) return null;
  // MSYS/Git Bash drive spelling: /c/Users/... -> C:/Users/...
  text = text.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:');
  text = text.replace(/\//g, '\\');
  const hadUncPrefix = text.startsWith('\\\\');
  text = text.replace(/\\{2,}/g, '\\');
  if (hadUncPrefix) text = `\\\\${text.replace(/^\\+/, '')}`;

  if (/^[A-Za-z]:(?!\\)/.test(text)) return null;
  try {
    text = path.win32.normalize(text);
  } catch {
    return null;
  }

  let kind;
  if (/^[A-Za-z]:\\/.test(text)) kind = 'drive';
  else if (/^\\\\[^\\]+\\[^\\]+/.test(text)) kind = 'unc';
  else if (/^\\/.test(text)) return null;
  else kind = 'relative';

  if (kind === 'relative') {
    if (!baseDir) return null;
    const base = normalizeConfinedPath(baseDir);
    if (!base || (base.kind !== 'drive' && base.kind !== 'unc')) return null;
    text = path.win32.resolve(base.path, text);
    kind = /^[A-Za-z]:\\/.test(text) ? 'drive' : 'unc';
  }

  return {
    kind,
    path: text,
    lower: text.toLowerCase(),
    hasShortName: /(?:^|\\)[^\\]*~\d/.test(text),
  };
}

export function normalizeAllowedRoots(roots) {
  const result = [];
  for (const root of roots || []) {
    if (root && typeof root === 'object' && (root.kind === 'drive' || root.kind === 'unc')) {
      result.push(root);
      continue;
    }
    const normalized = normalizeConfinedPath(root);
    if (normalized && (normalized.kind === 'drive' || normalized.kind === 'unc')) {
      result.push(normalized);
    }
  }
  return result;
}

export function pathWithin(normalizedChild, normalizedRoot) {
  const child = normalizedChild.lower.replace(/\\+$/, '');
  const root = normalizedRoot.lower.replace(/\\+$/, '');
  return child === root || child.startsWith(`${root}\\`);
}

export function isFileTool(name, policy) {
  return matchesNamePattern(name, policy?.fileTools || []);
}

function collectPathArguments(parsed) {
  const out = [];
  const visit = (value, key) => {
    if (typeof value === 'string') {
      if (PATH_KEYS.has(key)) {
        out.push(value);
      } else if (!CONTENT_KEYS.has(key)) {
        const matches = value.match(EMBEDDED_PATH_RE);
        if (matches) out.push(...matches);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(parsed, null);
  return out;
}

// File tools run as the user and follow junctions, so a link a sandboxed shell made
// inside the workspace could reach denied folders. This runs on the same machine as
// Muse, so it can check where a path really goes. Paths that don't exist yet resolve
// through their deepest existing ancestor.
function realLocation(target) {
  let current = target;
  const tail = [];
  for (let i = 0; i < 128; i += 1) {
    try {
      return path.win32.join(fs.realpathSync.native(current), ...tail);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null;
      const parent = path.win32.dirname(current);
      if (parent === current) return target;
      tail.unshift(path.win32.basename(current));
      current = parent;
    }
  }
  return null;
}

function staysInsideRoots(normalized, roots) {
  // Skip UNC paths: resolving one can block on the network, and they need an explicit allowed root.
  if (normalized.kind !== 'drive') return true;
  const real = realLocation(normalized.path);
  if (!real) return false;
  const lower = real.toLowerCase();
  return roots.some((root) => {
    const realRoot = root.kind === 'drive' ? realLocation(root.path) : root.path;
    return realRoot && pathWithin({ lower }, { lower: realRoot.toLowerCase() });
  });
}

function deniedPath(reason) {
  return {
    allowed: false,
    reason: 'path',
    category: 'CONTRIBUTOR_BLOCKED_CALL',
    toolName: 'file',
    detail: reason,
  };
}

const SHELL_TOOLS = new Set(['powershell', 'shell', 'bash', 'cmd', 'terminal', 'run_command', 'exec', 'execute']);

/** True when restored arguments contain a recognizable path key or embedded path. */
export function hasPathArguments(argumentsText) {
  let parsed;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return false;
  }
  if (typeof parsed === 'string') return true;
  if (!isObject(parsed)) return false;
  return collectPathArguments(parsed).length > 0;
}

export function isShellTool(name) {
  return SHELL_TOOLS.has(String(name || '').toLowerCase());
}

/**
 * Parse restored tool-call arguments and require every path-like value to be
 * lexically inside the request's workspace root or a configured allowed root.
 */
export function checkFilePathArguments(argumentsText, { workspaceRoot, allowedRoots = [] } = {}) {
  const workspace = normalizeConfinedPath(workspaceRoot);
  if (!workspace || (workspace.kind !== 'drive' && workspace.kind !== 'unc')) {
    return deniedPath('workspace-unavailable');
  }
  let parsed;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return deniedPath('unparseable');
  }
  let paths;
  if (typeof parsed === 'string') {
    paths = [parsed, ...(parsed.match(EMBEDDED_PATH_RE) || [])];
  } else if (isObject(parsed)) {
    paths = collectPathArguments(parsed);
  } else {
    return deniedPath('unparseable');
  }
  const roots = [workspace, ...normalizeAllowedRoots(allowedRoots)];
  for (const raw of paths) {
    const normalized = normalizeConfinedPath(raw, workspace.path);
    if (!normalized) return deniedPath('invalid');
    if (normalized.hasShortName && !pathWithin(normalized, workspace)) {
      return deniedPath('short-name-outside-workspace');
    }
    if (!roots.some((root) => pathWithin(normalized, root))) return deniedPath('outside');
    if (!staysInsideRoots(normalized, roots)) return deniedPath('link-outside');
  }
  return { allowed: true };
}

/**
 * read_skill is allowlisted separately from general tools. Deny patterns win
 * over the allowlist; a missing/unparseable skill id fails closed.
 */
export function evaluateReadSkill(argumentsText, policy) {
  const deny = () => ({
    allowed: false,
    reason: 'skill',
    category: 'CONTRIBUTOR_BLOCKED_CALL',
    toolName: 'read_skill',
  });
  let parsed;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return deny();
  }
  let id = null;
  if (typeof parsed === 'string') {
    id = parsed;
  } else if (isObject(parsed)) {
    if (isObject(parsed.skill) && typeof parsed.skill.id === 'string' && parsed.skill.id) {
      id = parsed.skill.id;
    }
    if (!id) {
      for (const key of ['id', 'skill_id', 'skill', 'name']) {
        if (typeof parsed[key] === 'string' && parsed[key]) {
          id = parsed[key];
          break;
        }
      }
    }
  }
  if (!id) return deny();
  if (matchPattern(id, policy.deniedSkillPatterns)) return deny();
  const allowedSkills = [...(policy.allowedSkills || []), ...(policy.bundledSkills || [])];
  const bare = id.replace(/^bundled:/i, '');
  if (!matchesNamePattern(id, allowedSkills) && !matchesNamePattern(bare, allowedSkills)) return deny();
  return { allowed: true };
}

function pushText(value, out) {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) pushText(item, out);
    return;
  }
  if (isObject(value)) {
    if (typeof value.text === 'string') out.push(value.text);
    if (typeof value.content === 'string') out.push(value.content);
    else if (Array.isArray(value.content)) pushText(value.content, out);
  }
}

/** Only instructions and developer/system messages are trusted policy text. */
export function collectTrustedText(body) {
  const out = [];
  if (body && body.instructions !== undefined) pushText(body.instructions, out);
  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (!isObject(item) || item.type !== 'message') continue;
      const role = typeof item.role === 'string' ? item.role.toLowerCase() : '';
      if (role === 'developer' || role === 'system') pushText(item.content, out);
    }
  }
  return out;
}

export const PERMISSION_SCAN_CHARS = 20000;

/**
 * Return the first developer input message (or first system message if no
 * developer exists); top-level instructions are used only when there is no
 * developer/system input message. Later messages are never consulted.
 */
export function selectPermissionTexts(body) {
  if (Array.isArray(body?.input)) {
    let firstDeveloper = null;
    let firstSystem = null;
    for (const item of body.input) {
      if (!isObject(item)) continue;
      if (item.type !== undefined && item.type !== 'message') continue;
      const role = typeof item.role === 'string' ? item.role.toLowerCase() : '';
      if (role !== 'developer' && role !== 'system') continue;
      const texts = [];
      pushText(item.content, texts);
      const text = texts.join('\n');
      if (!text.trim()) continue;
      if (role === 'developer') {
        firstDeveloper = text;
        break;
      }
      if (firstSystem === null) firstSystem = text;
    }
    const inputText = firstDeveloper || firstSystem;
    if (inputText) return [inputText];
  }
  const texts = [];
  if (body && body.instructions !== undefined) pushText(body.instructions, texts);
  const text = texts.join('\n');
  return text.trim() ? [text] : [];
}

export function selectPermissionText(body) {
  const candidates = selectPermissionTexts(body);
  return candidates.find((text) => permissionBlockLines(text)) || candidates[0] || '';
}

function permissionBlockLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  let headerIndex = -1;
  let consumed = 0;
  for (let i = 0; i < lines.length && consumed <= PERMISSION_SCAN_CHARS; i += 1) {
    if (/session\s+permission\s+mode/i.test(lines[i])) {
      headerIndex = i;
      break;
    }
    consumed += lines[i].length + 1;
  }
  if (headerIndex === -1) return null;

  const block = [lines[headerIndex]];
  let i = headerIndex + 1;
  // The real block may have a blank line between its heading and bullets.
  while (i < lines.length && lines[i].trim() === '') i += 1;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*#{1,6}\s/.test(line)) break;
    if (!/^\s*[-*]\s+/.test(line)) break;
    block.push(line);
    i += 1;
  }
  return block;
}

/**
 * Sandbox permission is read only from the structured "Session permission mode"
 * block in the selected first developer message. Project rules, AGENTS.md
 * text, tool output and later messages cannot satisfy it.
 */
export function evaluateSandboxGuard(candidateTexts, policy) {
  const candidates = Array.isArray(candidateTexts) ? candidateTexts : [candidateTexts];
  let sawBlock = false;
  const sandboxLines = [];
  for (const text of candidates) {
    const block = permissionBlockLines(text);
    if (!block) continue;
    sawBlock = true;
    const lines = block.filter((line) => /^\s*[-*]?\s*Shell sandbox\s*:/i.test(line));
    if (lines.length === 0) {
      return {
        ok: false,
        reason: 'missing-line',
        message: 'metaveil: no "Shell sandbox:" line in the Session permission mode block; sandbox-off runs (such as --yolo) aren\'t allowed in contributor mode',
      };
    }
    sandboxLines.push(...lines);
  }
  if (!sawBlock) {
    return {
      ok: false,
      reason: 'missing-block',
      message: 'metaveil: "Session permission mode" block not found in Muse\'s first developer message; sandbox-off runs (such as --yolo) aren\'t allowed in contributor mode',
    };
  }
  let expected;
  try {
    expected = new RegExp(policy.sandboxLinePattern, 'i');
  } catch {
    return {
      ok: false,
      reason: 'invalid-policy',
      message: 'metaveil: the configured sandbox permission pattern is invalid; refusing to forward in contributor mode',
    };
  }
  if (!sandboxLines.every((line) => expected.test(line))) {
    return {
      ok: false,
      reason: 'off',
      message: 'metaveil: shell sandbox is not on; sandbox-off runs (such as --yolo) aren\'t allowed in contributor mode',
    };
  }
  return { ok: true };
}

export function extractWorkspaceRoot(trustedTexts, { maxChars = Infinity } = {}) {
  const values = [];
  for (const text of trustedTexts) {
    const source = maxChars === Infinity ? String(text) : String(text).slice(0, maxChars);
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*(?:[-*]\s*)?Workspace root\s*:\s*(.+?)\s*$/i.exec(line);
      if (!match) continue;
      const value = match[1].trim().replace(/^["'`]/, '').replace(/["'`]$/, '');
      if (value) values.push(value);
    }
  }
  if (values.length === 0) {
    return { ok: false, reason: 'missing', message: 'metaveil: workspace root is missing in contributor mode; refusing to forward' };
  }
  const normalized = [];
  for (const value of values) {
    const entry = normalizeConfinedPath(value);
    if (!entry || (entry.kind !== 'drive' && entry.kind !== 'unc')) {
      return { ok: false, reason: 'invalid', message: 'metaveil: workspace root is not an absolute Windows path; refusing to forward in contributor mode' };
    }
    normalized.push(entry);
  }
  if (new Set(normalized.map((entry) => entry.lower)).size !== 1) {
    return { ok: false, reason: 'ambiguous', message: 'metaveil: conflicting workspace root lines; refusing to forward in contributor mode' };
  }
  return { ok: true, path: normalized[0].path };
}

/**
 * Per-request contributor guard. Sandbox permission is checked before the
 * workspace root so a sandbox-off request produces the clearer error.
 */
export function buildContributorGuard(body, policy) {
  const permissionTexts = selectPermissionTexts(body);
  const sandbox = evaluateSandboxGuard(permissionTexts, policy);
  if (!sandbox.ok) return { ok: false, kind: 'sandbox', ...sandbox };
  const root = extractWorkspaceRoot(permissionTexts, { maxChars: PERMISSION_SCAN_CHARS });
  if (!root.ok) return { ok: false, kind: 'workspace', ...root };
  return {
    ok: true,
    workspaceRoot: root.path,
    allowedRoots: normalizeAllowedRoots(policy.allowedRoots),
  };
}

/**
 * Workspace root for non-contributor requests: Muse's per-request line wins;
 * config.workspaceRoot is only a fallback when the line is absent. A present
 * but invalid/ambiguous line fails closed.
 */
export function resolveRequestWorkspaceRoot(body, config) {
  const texts = selectPermissionTexts(body);
  const root = extractWorkspaceRoot(texts, { maxChars: PERMISSION_SCAN_CHARS });
  if (root.ok) return root;
  if (root.reason === 'missing') {
    if (config.workspaceRoot) {
      const fallback = normalizeConfinedPath(config.workspaceRoot);
      if (fallback && (fallback.kind === 'drive' || fallback.kind === 'unc')) {
        return { ok: true, path: fallback.path, fallback: true };
      }
    }
    return { ok: true, path: null };
  }
  return { ok: false, ...root };
}
