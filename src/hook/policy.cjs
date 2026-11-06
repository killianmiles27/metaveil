#!/usr/bin/env node
/*
 * metaveil PreToolUse hook.
 *
 * Muse treats a crashing/timing-out hook as an allow. This hook is therefore
 * fail-closed by construction: every internal error, invalid config, malformed
 * payload, or internal timeout prints a valid permissionDecision=deny and exits
 * 0. The proxy remains the hard stop; this hook is a clean refusal so the agent
 * can keep working instead of seeing a leaked tool result.
 *
 * No dependencies. Plain CommonJS because Muse hooks are launched as .cjs.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_FILE_TOOLS = [
  'read_file', 'search', 'write_file', 'edit_file',
  'read', 'write', 'edit', 'glob', 'grep',
  'list_files', 'read_multiple_files',
];

function deny(reason) {
  const text = String(reason || 'denied by metaveil hook').replace(/[\r\n]+/g, ' ').slice(0, 500);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `metaveil: ${text}`,
    },
  }));
}

function fail(reason) {
  try {
    deny(reason);
  } catch {
    process.stdout.write('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"metaveil: hook failure"}}');
  }
  process.exitCode = 0;
}

function readConfig() {
  const explicit = process.env.METAVEIL_HOOK_CONFIG;
  const candidates = [];
  if (explicit) candidates.push(explicit);
  candidates.push(path.join(__dirname, 'hook-policy.json'));
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('hook config must be a JSON object');
      }
      return parsed;
    } catch (error) {
      throw new Error(`invalid hook config ${candidate}: ${error.message}`);
    }
  }
  return {};
}

function normalize(value) {
  let text = String(value == null ? '' : value).trim();
  if (!text) return '';
  text = text.replace(/^file:\/{2,3}/i, '');
  text = text.replace(/^[\\/]{2,4}\?[\\/]+/, '');
  text = text.replace(/[\\/]+/g, '\\');
  if (/^[A-Za-z]:$/.test(text)) text += '\\';
  return text;
}

function isAbsoluteWindows(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\/.test(value);
}

function lower(value) {
  return normalize(value).toLowerCase();
}

function isUnder(child, parent) {
  const c = lower(child).replace(/\\+$/, '');
  const p = lower(parent).replace(/\\+$/, '');
  if (!c || !p) return false;
  return c === p || c.startsWith(`${p}\\`);
}

function resolvePath(value, workspaceRoot) {
  const normalized = normalize(value);
  if (!normalized) return '';
  // win32.resolve collapses `..`, so <workspace>\..\..\Downloads can't pass as inside.
  return normalize(path.win32.resolve(workspaceRoot || process.cwd(), normalized));
}

// Follows junctions and symlinks. File tools run as the user, so a link a
// sandboxed shell made inside the workspace would otherwise reach denied folders.
// Paths that don't exist yet resolve through their deepest existing ancestor.
function realOf(target) {
  let current = target;
  const tail = [];
  for (let i = 0; i < 128; i += 1) {
    try {
      return path.win32.join(fs.realpathSync.native(current), ...tail);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.win32.dirname(current);
      if (parent === current) return target;
      tail.unshift(path.win32.basename(current));
      current = parent;
    }
  }
  throw new Error('path is too deep to resolve');
}

function stripGlob(value) {
  const normalized = normalize(value);
  const index = normalized.search(/[*?]/);
  if (index === -1) return normalized;
  return normalized.slice(0, index).replace(/[\\/]+$/, '');
}

const PATH_KEYS = new Set([
  'path', 'paths', 'file', 'files', 'file_path', 'filepath', 'filename',
  'target', 'targets', 'cwd', 'workdir', 'working_directory', 'directory',
  'dir', 'root', 'roots', 'source', 'destination', 'old_path', 'new_path',
  'from', 'to', 'input_path', 'output_path', 'include', 'includes',
]);

function collectPaths(value, key, out, depth) {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') {
    if (PATH_KEYS.has(String(key || '').toLowerCase()) && value.trim()) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, key, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectPaths(childValue, childKey, out, depth + 1);
    }
  }
}

function toolNameOf(payload) {
  const raw = payload && (payload.tool_name || payload.toolName || payload.tool);
  if (typeof raw !== 'string') return '';
  return raw.replace(/^muse\./i, '').toLowerCase();
}

function protectedWorkspaceWrite(workspaceRoot, target) {
  if (!workspaceRoot || !target) return false;
  if (!isUnder(target, workspaceRoot)) return false;
  const relative = lower(target).slice(lower(workspaceRoot).replace(/\\+$/, '').length).replace(/^\\/, '');
  const first = relative.split('\\')[0];
  return first === '.git' || first === '.muse' || first === '.agents';
}

const SKILL_DENY_PATTERNS = [
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
  'read-session',
  'resume-claude',
  'resume-codex',
  'import',
  'manage-settings',
  'doctor',
];

function skillDenied(name) {
  const lower = String(name).toLowerCase();
  return SKILL_DENY_PATTERNS.some((pattern) => lower.includes(pattern));
}

function skillAllowed(name, config) {
  const trimmed = String(name).trim();
  if (!trimmed || skillDenied(trimmed)) return false;
  const bare = trimmed.replace(/^bundled:/i, '').toLowerCase();
  const allowedSkills = Array.isArray(config.allowedSkills) ? config.allowedSkills : [];
  const bundledSkills = Array.isArray(config.bundledSkills) ? config.bundledSkills : [];
  return [...allowedSkills, ...bundledSkills]
    .some((entry) => [trimmed.toLowerCase(), bare].includes(String(entry).trim().toLowerCase()));
}

const BLOCKED_PREFIX = /^\.metaveil-blocked[\\/]([a-z-]+)$/;
const BLOCKED_REASONS = {
  path: 'that path is outside this project, and Contributor mode keeps file tools inside it. Work within the project.',
  tool: 'that tool is not available in Contributor mode. Use another approach.',
  skill: 'that skill is not available in Contributor mode. Continue without it.',
  command: 'that command is not allowed in Contributor mode. Use another approach.',
};

// Muse only loads this hook on Contributor runs (the launcher passes it per run),
// and its payload names the plain model even then, so there is no mode check here.
function decide(payload, config) {
  const tool = toolNameOf(payload);
  if (!tool) return { allow: true };
  const input = (payload && (payload.tool_input || payload.toolInput)) || {};
  const blocked = typeof input.path === 'string' ? BLOCKED_PREFIX.exec(input.path) : null;
  if (blocked) return { allow: false, reason: BLOCKED_REASONS[blocked[1]] || BLOCKED_REASONS.tool };
  const rawCwd = payload && typeof payload.cwd === 'string' ? normalize(payload.cwd) : '';
  const payloadCwd = rawCwd && isAbsoluteWindows(rawCwd) ? rawCwd : '';
  const configRoot = normalize(config.workspaceRoot || '');
  const workspaceRoot = payloadCwd || (isAbsoluteWindows(configRoot) ? configRoot : '');
  if (!workspaceRoot) {
    return { allow: false, reason: 'no workspace root: payload.cwd is missing and config.workspaceRoot is unset' };
  }
  const allowedRoots = Array.isArray(config.allowedRoots) ? config.allowedRoots.map(normalize).filter(Boolean) : [];
  const roots = [workspaceRoot, ...allowedRoots].filter(Boolean);

  if (tool === 'read_skill') {
    const name = typeof input.name === 'string' ? input.name : (typeof input.skill === 'string' ? input.skill : '');
    if (!name) return { allow: false, reason: 'read_skill without a skill name' };
    return skillAllowed(name, config)
      ? { allow: true }
      : { allow: false, reason: `read_skill outside allowlist: ${name}` };
  }

  const configured = Array.isArray(config.fileTools) ? config.fileTools.map((v) => String(v).toLowerCase()) : [];
  const fileTools = new Set([...DEFAULT_FILE_TOOLS, ...configured]);
  const isFileTool = fileTools.has(tool) || /(^|_)(read|write|edit|file|glob|grep|list_files)(_|$)/.test(tool);
  if (!isFileTool) return { allow: true };

  const paths = [];
  collectPaths(input, '', paths, 0);
  const cleaned = [...new Set(paths.map((entry) => stripGlob(entry)).filter(Boolean))];
  if (cleaned.length === 0) {
    if (tool === 'search') return { allow: true };
    return { allow: false, reason: `${tool} without a path` };
  }
  for (const candidate of cleaned) {
    const resolved = resolvePath(candidate, workspaceRoot);
    if (!resolved) return { allow: false, reason: `unresolvable path in ${tool}` };
    const inside = roots.some((root) => isUnder(resolved, root));
    if (!inside) return { allow: false, reason: `${tool} path outside workspace/allowedRoots: ${candidate}` };
    const realTarget = realOf(resolved);
    if (!roots.some((root) => isUnder(realTarget, realOf(root)))) {
      return { allow: false, reason: `${tool} path leaves the workspace through a link: ${candidate}` };
    }
    if ((tool === 'write_file' || tool === 'edit_file' || tool === 'write' || tool === 'edit')
      && protectedWorkspaceWrite(workspaceRoot, resolved)) {
      return { allow: false, reason: `${tool} path is protected inside the workspace: ${candidate}` };
    }
  }
  return { allow: true };
}

function main() {
  const config = readConfig();
  const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0
    ? Math.min(config.timeoutMs, 60_000)
    : DEFAULT_TIMEOUT_MS;
  let finished = false;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    try { clearTimeout(watchdog); } catch {}
    if (result && result.allow) process.stdout.write('{}');
    else deny(result && result.reason ? result.reason : 'denied');
  };
  const watchdog = setTimeout(() => finish({ allow: false, reason: 'hook internal timeout' }), timeoutMs);
  watchdog.unref?.();

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 1_000_000) raw = raw.slice(0, 1_000_000);
  });
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(raw || '{}');
      finish(decide(payload, config));
    } catch (error) {
      finish({ allow: false, reason: `hook internal error: ${error && error.message ? error.message : 'unknown'}` });
    }
  });
  process.stdin.on('error', (error) => finish({ allow: false, reason: `hook stdin error: ${error && error.message ? error.message : 'unknown'}` }));
}

try {
  main();
} catch (error) {
  fail(`hook internal error: ${error && error.message ? error.message : 'unknown'}`);
}
