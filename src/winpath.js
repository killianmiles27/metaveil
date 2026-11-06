import { escapeRegExp, isObject } from './util.js';

/** Parse a Windows drive path into a drive letter and path segments. */
export function parseWindowsPath(value) {
  const text = String(value ?? '').trim();
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(text);
  if (!match) return null;
  const segments = match[2].split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return null;
  return {
    drive: match[1].toUpperCase(),
    segments,
    canonical: `${match[1].toUpperCase()}:\\${segments.join('\\')}`,
    lower: `${match[1].toUpperCase()}:\\${segments.join('\\')}`.toLowerCase(),
  };
}

/** Parse a path, tolerating file:// and \\?\ prefixes. */
export function parseAnyWindowsPath(value) {
  return parseWindowsPath(normalizeWindowsPath(value));
}

export function normalizeWindowsPath(value) {
  let text = String(value ?? '').trim();
  text = text.replace(/^file:\/{2,3}/i, '');
  text = text.replace(/^[\\/]{2,4}\?[\\/]+/, '');
  text = text.replace(/^[\\/]([A-Za-z])(?=[\\/])/, '$1:');
  text = text.replace(/[\\/]+/g, '\\');
  if (/^[A-Za-z]:$/.test(text)) text += '\\';
  return text;
}

export function lowerPath(value) {
  return normalizeWindowsPath(value).toLowerCase();
}

export function isUnderPath(child, parent) {
  const c = lowerPath(child);
  const p = lowerPath(parent).replace(/\\+$/, '');
  return c === p || c.startsWith(`${p}\\`);
}

export function formatWindowsPath(parsed, depth = 1) {
  const sep = '\\'.repeat(Math.max(1, depth));
  return `${parsed.drive}:${sep}${parsed.segments.join(sep)}`;
}

export function applyDepthToTail(tail, depth = 1) {
  const text = String(tail ?? '');
  if (!text) return '';
  return text.replace(/\\/g, '\\'.repeat(Math.max(1, depth)));
}

/**
 * Build a regular expression source that matches the common Windows path
 * spellings of `parsed`:
 *   C:\Users\dev, C:/Users/dev, /c/Users/dev, \\?\C:\Users\dev,
 *   file:///C:/Users/dev, and escaped (doubled-backslash) forms.
 * The match stops at the end of the path itself; callers extend it.
 */
export function buildPathFamily(parsed) {
  if (!parsed) return null;
  const sep = '[\\\\/]{1,4}';
  const prefix = '(?:file:[\\\\/]{2,3}|[\\\\/]{2,4}\\?[\\\\/]{1,4}|[\\\\/]{2,4})?';
  const drive = '(?:[A-Za-z]:|[\\\\/][A-Za-z](?=[\\\\/]))';
  const body = parsed.segments.map((segment) => escapeRegExp(segment)).join(sep);
  const source = `${prefix}${drive}${sep}${body}(?![A-Za-z0-9_.-])`;
  const segmentLengths = parsed.segments.reduce((sum, segment) => sum + segment.length, 0);
  const maxLength = 10 + 2 + parsed.segments.length * 4 + segmentLengths + 4;
  return { source, maxLength };
}

/** Build a literal fallback family for non-drive placeholders. */
export function buildLiteralFamily(literal) {
  const source = `${escapeRegExp(literal)}(?![A-Za-z0-9_.-])`;
  return { source, maxLength: String(literal).length + 4 };
}

/**
 * Determine how many literal backslashes separate segments in a matched path.
 * This is the JSON escaping depth: 1 in plain text, 2 in ordinary
 * JSON-in-a-string arguments, 4 in doubly nested JSON-in-a-string values.
 */
export function separatorDepth(matched, parsed) {
  if (!parsed) return 1;
  const join = parsed.segments.map((segment) => escapeRegExp(segment)).join('([\\\\/]{1,4})');
  const re = new RegExp(join, 'i');
  const match = re.exec(String(matched));
  if (!match) return 1;
  let depth = 1;
  for (let i = 1; i < match.length; i += 1) {
    const run = match[i] || '';
    const backslashes = (run.match(/\\/g) || []).length;
    if (backslashes > depth) depth = backslashes;
  }
  return Math.min(depth, 4);
}

/**
 * True when a backslash run is a literal JSON-style escape boundary rather
 * than a path separator. This is intentionally conservative: a raw folder
 * starting with n/r/t is kept unless the escape is followed by a new path,
 * quote or line boundary (e.g. "\\r\\nC:\\...").
 */
function literalEscapeBoundary(text, start, afterRun) {
  if (text[start] !== '\\') return false;
  const run = afterRun - start;
  if (run % 2 === 0) return false;
  const next = text[afterRun];
  if (next === undefined) return false;
  if (next === '"' || next === "'") return true;
  if (next === 'u') return /^\\u[0-9A-Fa-f]{4}$/.test(text.slice(afterRun - 1, afterRun + 5));
  if (next === 'R' || next === 'r' || next === 'N' || next === 'n' || next === 'T' || next === 't') {
    let after = afterRun + 1;
    while (after < text.length && text[after] === '\\' && 'rnt'.includes(text[after + 1] || '')) after += 2;
    const rest = text.slice(after);
    return /^(?:[A-Za-z]:[\\/]|\\\\|\/c\/|file:)/i.test(rest)
      || /^(?:"|'|\r|\n|$)/.test(rest);
  }
  return false;
}

/**
 * Read a path tail starting at `pos`. Stops at whitespace, quotes and
 * common punctuation, literal JSON escape sequences, control characters and
 * newlines.
 */
export function readPathTail(text, pos, { jsonContext = false } = {}) {
  let i = pos;
  const segmentChar = /[^\s"'`<>|,;*?:()[\]{}\r\n#]/;
  while (i < text.length) {
    let j = i;
    while (j < text.length && (text[j] === '\\' || text[j] === '/')) j += 1;
    if (j === i) break;
    const run = j - i;
    if (text[i] === '\\' && run % 2 === 1) {
      if (jsonContext) {
        const next = text[j];
        if (next === undefined || '"\\/nrtbfu'.includes(next)) break;
      } else if (literalEscapeBoundary(text, i, j)) {
        break;
      }
    }
    let k = j;
    while (k < text.length && segmentChar.test(text[k]) && text[k] !== '\\' && text[k] !== '/') {
      k += 1;
    }
    if (k === j) break;
    i = k;
  }
  return i;
}

export function canonicalTail(rawTail) {
  const value = String(rawTail ?? '').replace(/[\\/]+/g, '\\');
  return value.replace(/\\+$/, '');
}

/**
 * Normalize a path fragment found in text (which may use escaped
 * backslashes) into a canonical single-backslash Windows path, without
 * changing case.
 */
export function canonicalPathText(raw) {
  let text = String(raw ?? '');
  text = text.replace(/^file:\/{2,3}/i, '');
  text = text.replace(/^[\\/]{2,4}\?[\\/]+/, '');
  text = text.replace(/^[\\/]([A-Za-z])(?=[\\/])/, '$1:');
  text = text.replace(/[\\/]+/g, '\\');
  return text;
}

export function ownPathValue(parsed) {
  return parsed ? parsed.canonical : null;
}

export function toolNameOf(tool) {
  if (!isObject(tool)) return null;
  if (typeof tool.name === 'string' && tool.name) return tool.name;
  if (isObject(tool.function) && typeof tool.function.name === 'string') return tool.function.name;
  if (typeof tool.type === 'string' && tool.type) return tool.type;
  return null;
}
