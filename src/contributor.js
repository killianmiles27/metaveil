import { policyPatternMatches, globToRegExp, isObject } from './util.js';
import { toolNameOf } from './winpath.js';
import { checkFilePathArguments, evaluateReadSkill, isFileTool, hasPathArguments, isShellTool } from './confinement.js';

/**
 * Contributor mode is ON unless the header is exactly "0". A missing header
 * is therefore ON, as is any unexpected value (fail safe).
 */
export function isContributorModeOn(headers) {
  let value = headers ? headers['x-tbh-contributor-mode'] : undefined;
  if (Array.isArray(value)) value = value[0];
  return value !== '0';
}

// Tools whose arguments are text to store, show or search for, never a command to run on
// this machine. Their paths are still confined; only the denied command patterns are skipped.
// (A web_search query is redacted on its way out through /muse-code/search.)
const CONTENT_ONLY_TOOLS = new Set([
  'write_file', 'edit_file', 'write', 'edit', 'write_todos',
  'request_user_input', 'report_progress', 'create_goal', 'update_goal', 'web_search',
]);

/**
 * Muse writes long tool output to <home>\.local\share\muse\sessions\...\tool-outputs\ and reads
 * it back with read_file. That is this session's own output, already scanned on its way to the
 * model; refusing it cut off ordinary long build and test logs. Only read_file, only files
 * inside a tool-outputs folder there, and still confined to that root (no .. or links out).
 */
export function museToolOutputRead(lowerName, argumentsText, context) {
  if ((lowerName !== 'read_file' && lowerName !== 'read') || !context?.museSessionsRoot) return false;
  const root = context.museSessionsRoot;
  const verdict = checkFilePathArguments(argumentsText, { workspaceRoot: root, allowedRoots: [] });
  if (!verdict.allowed) return false;
  let parsed;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return false;
  }
  const paths = typeof parsed === 'string' ? [parsed] : Object.values(parsed || {}).filter((v) => typeof v === 'string');
  const candidates = paths.filter((p) => /[\\/]/.test(p));
  return candidates.length > 0 && candidates.every((p) => /[\\/]tool-outputs[\\/][^\\/]+$/i.test(p)
    && p.toLowerCase().replace(/\//g, '\\').startsWith(root.toLowerCase()));
}

export function isToolAllowed(name, allowedTools) {
  if (typeof name !== 'string' || name.length === 0) return false;
  return allowedTools.some((pattern) => {
    if (/[*?]/.test(pattern)) return globToRegExp(pattern).test(name);
    return name.toLowerCase() === String(pattern).toLowerCase();
  });
}

export function matchDeniedPattern(value, patterns) {
  const text = String(value ?? '');
  for (const pattern of patterns) {
    if (policyPatternMatches(text, pattern)) return pattern;
  }
  return null;
}

function stripAudit(audit, ctx, toolName) {
  audit?.record({
    requestId: ctx?.requestId,
    phase: 'request',
    action: 'stripped',
    category: 'CONTRIBUTOR_TOOL',
    toolName: String(toolName ?? 'unnamed').slice(0, 120),
  });
}

/**
 * Default-deny tool filtering. Nested namespace tools are filtered
 * recursively. Every stripped entry is audited by name/type only.
 */
export function filterTools(tools, policy, audit, ctx) {
  if (!Array.isArray(tools)) {
    stripAudit(audit, ctx, 'unnamed');
    return [];
  }
  const result = [];
  for (const tool of tools) {
    if (!isObject(tool)) {
      stripAudit(audit, ctx, 'unnamed');
      continue;
    }
    const nestedKey = Array.isArray(tool.tools) ? 'tools' : (Array.isArray(tool.functions) ? 'functions' : null);
    if (nestedKey) {
      const filtered = filterTools(tool[nestedKey], policy, audit, ctx);
      if (filtered.length > 0) result.push({ ...tool, [nestedKey]: filtered });
      continue;
    }
    const name = toolNameOf(tool);
    if (isToolAllowed(name, policy.allowedTools)) {
      result.push(tool);
    } else {
      stripAudit(audit, ctx, name);
    }
  }
  return result;
}

function skillIdFromAttributes(attributes) {
  const match = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes || '');
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * Remove <skill id="...">...</skill> blocks whose id or description matches
 * a deny pattern. Block bodies are never logged.
 */
export function filterSkillBlocks(text, policy, audit, ctx) {
  const source = String(text);
  if (!source.toLowerCase().includes('<skill')) return source;
  const re = /<skill\b([^>]*)>([\s\S]*?)<\/skill\s*>/gi;
  let result = '';
  let last = 0;
  let match;
  while ((match = re.exec(source)) !== null) {
    result += source.slice(last, match.index);
    const id = skillIdFromAttributes(match[1]);
    const body = match[2] || '';
    const idDenied = id ? matchDeniedPattern(id, policy.deniedSkillPatterns) : null;
    const attributeDenied = matchDeniedPattern(match[1] || '', policy.deniedSkillPatterns);
    const bodyDenied = matchDeniedPattern(body, policy.deniedSkillPatterns);
    if (idDenied || attributeDenied || bodyDenied) {
      audit?.record({
        requestId: ctx?.requestId,
        phase: 'request',
        action: 'stripped',
        category: 'CONTRIBUTOR_SKILL',
        // Log the matching policy pattern, not the request-supplied id or
        // description text.
        pattern: idDenied || attributeDenied || bodyDenied,
        matchedBy: idDenied ? 'id' : (attributeDenied ? 'attributes' : 'description'),
        byteOffset: Buffer.byteLength(source.slice(0, match.index), 'utf8'),
        field: ctx?.field,
      });
    } else {
      result += match[0];
    }
    last = re.lastIndex;
  }
  result += source.slice(last);
  return result;
}

// web_fetch runs as the real user outside the sandbox, so it could reach this machine's
// services and the home network. Only public http(s) addresses pass. Numeric forms of an
// address (2130706433, 0x7f.1) are normalized by URL parsing.
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.lan|.*\.localhost)$|^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^\[|^[^.]+$/i;

export function isPublicWebArgs(argumentsText) {
  let parsed;
  try { parsed = JSON.parse(argumentsText); } catch { return false; }
  const value = parsed?.url ?? parsed?.uri;
  if (typeof value !== 'string') return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !PRIVATE_HOST.test(url.hostname);
}

/**
 * Evaluate a model-issued function call against contributor policy.
 * `name` should be the restored tool name; `argumentsText` is the raw
 * arguments string (and optionally its restored form).
 */
export function evaluateFunctionCall({ name: calledName, argumentsText, restoredArgumentsText }, policy, context = {}) {
  if (typeof calledName !== 'string' || calledName.length === 0) {
    return { allowed: false, reason: 'tool', toolName: 'unnamed' };
  }
  // The tool list groups Muse's tools under a `muse` namespace, and real models call
  // them as muse.powershell. Only this namespace is unwrapped.
  const name = calledName.replace(/^muse\./i, '');
  if (!isToolAllowed(name, policy.allowedTools)) {
    return { allowed: false, reason: 'tool', toolName: name };
  }
  const restoredArgs = typeof restoredArgumentsText === 'string' ? restoredArgumentsText : '';
  const rawArgs = typeof argumentsText === 'string' ? argumentsText : '';
  const lowerName = name.toLowerCase();
  if (lowerName === 'web_fetch' && !isPublicWebArgs(restoredArgs || rawArgs)) {
    return { allowed: false, reason: 'command', toolName: name, pattern: 'web_fetch to a private address' };
  }
  if (lowerName === 'read_skill') {
    const verdict = evaluateReadSkill(restoredArgs || rawArgs, policy);
    if (!verdict.allowed) return { ...verdict, toolName: name };
  } else if (isFileTool(name, policy)
    || (!isShellTool(name) && hasPathArguments(restoredArgs || rawArgs))) {
    const verdict = checkFilePathArguments(restoredArgs || rawArgs, {
      workspaceRoot: context.workspaceRoot,
      allowedRoots: context.allowedRoots || [],
    });
    if (!verdict.allowed && !museToolOutputRead(lowerName, restoredArgs || rawArgs, context)) {
      return { ...verdict, toolName: name };
    }
  }
  // Denied command patterns guard things that run. File contents and notes only get written:
  // code that merely mentions "screenshot" was being refused, mid-edit, with no way forward.
  if (CONTENT_ONLY_TOOLS.has(lowerName)) return { allowed: true, toolName: name };
  const haystacks = [argumentsText, restoredArgumentsText].filter((value) => typeof value === 'string');
  for (const haystack of haystacks) {
    const pattern = matchDeniedPattern(haystack, policy.deniedCommandPatterns);
    if (pattern) return { allowed: false, reason: 'command', toolName: name, pattern };
  }
  return { allowed: true, toolName: name };
}

export function blockedCallAudit(audit, ctx, verdict) {
  audit?.record({
    requestId: ctx?.requestId,
    phase: 'response',
    action: 'blocked',
    category: verdict.category || 'CONTRIBUTOR_BLOCKED_CALL',
    toolName: String(verdict.toolName ?? 'unnamed').slice(0, 120),
    reason: verdict.reason,
    pattern: verdict.pattern ?? null,
  });
}

export function contributorErrorEvent(message = 'metaveil: function call blocked by contributor policy') {
  return {
    event: 'error',
    data: JSON.stringify({
      type: 'error',
      error: {
        type: 'metaveil_contributor_policy',
        code: 'blocked_function_call',
        message,
      },
    }),
  };
}

/** Inspect a non-streaming Responses API object for denied function calls. */
export function findBlockedFunctionCall(responseObject, policy) {
  if (!isObject(responseObject)) return null;
  const outputs = Array.isArray(responseObject.output)
    ? responseObject.output
    : (Array.isArray(responseObject.response?.output) ? responseObject.response.output : []);
  for (const item of outputs) {
    if (!isObject(item) || item.type !== 'function_call') continue;
    const verdict = evaluateFunctionCall({
      name: item.name,
      argumentsText: typeof item.arguments === 'string' ? item.arguments : '',
    }, policy);
    if (!verdict.allowed) return verdict;
  }
  return null;
}
