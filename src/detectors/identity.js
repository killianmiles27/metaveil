import { escapeRegExp, decodePercentWithMap, mapDecodedRange } from '../util.js';

const CATEGORY_GROUPS = [
  ['names', 'PERSON'],
  ['usernames', 'USERNAME'],
  ['emails', 'EMAIL'],
  ['hostnames', 'HOST'],
  ['terms', 'TERM'],
];

function normalizeForLookup(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

export function createIdentityDetector(config) {
  const entries = [];
  const seen = new Set();
  for (const [field, category] of CATEGORY_GROUPS) {
    for (const value of config.identity[field] || []) {
      const trimmed = String(value).trim();
      if (!trimmed) continue;
      const lower = normalizeForLookup(trimmed);
      if (seen.has(lower)) continue;
      seen.add(lower);
      entries.push({
        category,
        value: trimmed,
        lower,
        boundary: trimmed.length < 4 || category === 'PERSON' || category === 'TERM',
      });
    }
  }
  if (entries.length === 0) {
    return { name: 'identity', scan: () => [] };
  }
  entries.sort((a, b) => b.lower.length - a.lower.length || a.lower.localeCompare(b.lower));
  const byLower = new Map(entries.map((entry) => [entry.lower, entry]));
  const alternation = entries.map((entry) => escapeRegExp(entry.value)).join('|');
  const source = `(?:${alternation})`;

  function escapeBoundaryBefore(text, index) {
    const prefix = text.slice(Math.max(0, index - 6), index);
    return /(?:\\[nrtbf"'\\/])$/.test(prefix) || /\\u[0-9A-Fa-f]{4}$/.test(prefix);
  }

  function scanVariant(text, map) {
    const re = new RegExp(source, 'gi');
    const found = [];
    let match;
    while ((match = re.exec(text)) !== null) {
      const lower = normalizeForLookup(match[0]);
      const entry = byLower.get(lower);
      if (!entry) continue;
      let start = match.index;
      let end = match.index + match[0].length;
      if (entry.boundary) {
        const before = start === 0 ? null : text[start - 1];
        const beforeOk = before === null
          || !/[A-Za-z0-9_]/.test(before)
          || escapeBoundaryBefore(text, start);
        const after = end >= text.length ? null : text[end];
        const afterOk = after === null || !/[A-Za-z0-9_]/.test(after);
        if (!beforeOk || !afterOk) continue;
      }
      if (map) {
        const mapped = mapDecodedRange(map, start, end, map[map.length - 1]);
        start = mapped.start;
        end = mapped.end;
      }
      found.push({
        start,
        end,
        category: entry.category,
        value: entry.value,
      });
    }
    return found;
  }

  return {
    name: 'identity',
    scan(text) {
      const found = scanVariant(text, null);
      const decoded = decodePercentWithMap(text);
      if (decoded.text !== text) {
        found.push(...scanVariant(decoded.text, decoded.map));
      }
      found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
      const accepted = [];
      for (const span of found) {
        if (accepted.some((other) => span.start < other.end && span.end > other.start)) continue;
        accepted.push(span);
      }
      return accepted;
    },
  };
}
