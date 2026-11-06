import crypto from 'node:crypto';

export function decodePercentWithMap(value) {
  const text = String(value);
  let decoded = '';
  const map = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '%' && i + 2 < text.length && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      const code = parseInt(text.slice(i + 1, i + 3), 16);
      if (code < 128) {
        decoded += String.fromCharCode(code);
        map.push(i);
        i += 2;
        continue;
      }
    }
    decoded += text[i];
    map.push(i);
  }
  map.push(text.length);
  return { text: decoded, map };
}

/** Map a decoded [start,end) range back to the original percent-encoded text. */
export function mapDecodedRange(map, start, end, originalLength) {
  const safeStart = Math.max(0, Math.min(start, map.length - 1));
  const safeEnd = Math.max(safeStart, Math.min(end, map.length - 1));
  return { start: map[safeStart], end: safeEnd >= map.length - 1 ? originalLength : map[safeEnd] };
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Escape a value so it can be embedded inside a JSON string literal. */
export function jsonEscape(value) {
  const quoted = JSON.stringify(String(value));
  return quoted.slice(1, -1);
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function shannonEntropy(value) {
  const text = String(value);
  if (!text) return 0;
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Case-insensitive glob match: `*` matches any run, `?` one character. */
export function globToRegExp(pattern) {
  const escaped = escapeRegExp(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function globMatches(value, pattern) {
  return globToRegExp(pattern).test(String(value));
}

/**
 * Pattern language for contributor policy:
 *  - patterns containing `*` or `?` are globs (full match)
 *  - other patterns are case-insensitive substrings
 */
export function policyPatternMatches(value, pattern) {
  const text = String(value);
  if (/[*?]/.test(pattern)) return globToRegExp(pattern).test(text);
  return text.toLowerCase().includes(String(pattern).toLowerCase());
}

export function truncate(value, max = 120) {
  const text = String(value);
  return text.length <= max ? text : text.slice(0, max);
}
