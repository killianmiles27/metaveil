import { shannonEntropy, escapeRegExp } from '../util.js';

function collect(text, regex, spans, category = 'SECRET', valueFor = (match) => match[0], spanFor = null) {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    if (spanFor) {
      const span = spanFor(match);
      if (span && span.start < span.end) spans.push({ ...span, category });
    } else {
      spans.push({ start: match.index, end: match.index + match[0].length, category, value: valueFor(match) });
    }
  }
}

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0;
}

function looksLikeVersionContext(text, start) {
  const before = text.slice(Math.max(0, start - 28), start).toLowerCase();
  return /(?:version|ver\.?|v)["']?\s*[:=]?\s*["']?\s*$/.test(before);
}

const SECRET_KEY_RE = /(?<![A-Za-z0-9])(?:secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|credentials|session|cookie|signing[_-]?key|encryption[_-]?key|auth)(?![A-Za-z0-9])/i;

export function looksLikeSecretKey(key) {
  return SECRET_KEY_RE.test(key);
}

function placeholderValue(value) {
  const text = String(value).trim();
  if (!text) return true;
  if (/^(?:\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*)$/.test(text)) return true;
  if (/^<[^>]*>$/.test(text)) return true;
  if (/^(?:changeme|change_me|example|placeholder|your[_-].*[_-]here|xxx+|redacted|todo)$/i.test(text)) return true;
  if (/^(?:true|false|null|undefined|none)$/i.test(text)) return true;
  return false;
}

function emailDetector() {
  return {
    name: 'emails',
    scan(text) {
      const spans = [];
      const re = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9._-])/g;
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const domain = match[0].slice(match[0].lastIndexOf('@') + 1).toLowerCase();
        if (domain === 'example.com' || domain === 'example.org' || domain === 'example.net') continue;
        spans.push({ start: match.index, end: match.index + match[0].length, category: 'EMAIL', value: match[0] });
      }
      return spans;
    },
  };
}

function privateKeyDetector() {
  return {
    name: 'private-keys',
    scan(text) {
      const spans = [];
      const re = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
      collect(text, re, spans);
      return spans;
    },
  };
}

function tokenPatternDetector() {
  return {
    name: 'token-patterns',
    scan(text) {
      const spans = [];
      // Tool output can be embedded as JSON inside a larger developer message,
      // rather than be a standalone JSON value the redactor can parse. The n
      // in a literal \\n must not hide a following token from its left boundary.
      // Equal-length masking preserves original offsets and token values.
      const boundaryText = text.replace(/\\+(?:[nrtbfv]|u(?:000[89a-f]|0020))/gi,
        match => ' '.repeat(match.length));
      const re = /(?<![A-Za-z0-9_])(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{16,})(?![A-Za-z0-9_])/g;
      collect(boundaryText, re, spans);
      const jwt = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;
      collect(boundaryText, jwt, spans);
      return spans;
    },
  };
}

function ssnDetector() {
  return {
    name: 'ssn',
    scan(text) {
      const spans = [];
      collect(text, /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g, spans);
      return spans;
    },
  };
}

function phoneDetector() {
  return {
    name: 'phones',
    scan(text) {
      const spans = [];
      collect(text, /(?<![\d+])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g, spans);
      collect(text, /(?<![\d+])\+[1-9]\d{0,2}[\s.-]?(?:\d{1,4}[\s.-]){2,3}\d{1,4}(?!\d)/g, spans);
      return spans;
    },
  };
}

function ipv4Detector() {
  return {
    name: 'ipv4',
    scan(text) {
      const spans = [];
      const re = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const parts = match[0].split('.').map(Number);
        if (parts.some((part) => part > 255)) continue;
        if (parts[0] === 127) continue;
        if (looksLikeVersionContext(text, match.index)) continue;
        spans.push({ start: match.index, end: match.index + match[0].length, category: 'SECRET', value: match[0] });
      }
      return spans;
    },
  };
}

function cardDetector() {
  return {
    name: 'payment-cards',
    scan(text) {
      const spans = [];
      const re = /(?<![\d.])(?:\d[ -]?){12,18}\d(?![\d.])/g;
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const digits = match[0].replace(/[ -]/g, '');
        if (!luhnValid(digits)) continue;
        spans.push({ start: match.index, end: match.index + match[0].length, category: 'SECRET', value: match[0] });
      }
      return spans;
    },
  };
}

function envDetector() {
  return {
    name: 'env-assignments',
    scan(text) {
      const spans = [];
      const re = /^[ \t]*([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*(.*)$/gm;
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const key = match[1];
        if (!looksLikeSecretKey(key)) continue;
        const rawValue = match[2];
        const lineValueOffset = match.index + match[0].length - rawValue.length;
        const leading = (rawValue.match(/^[ \t]*/) || [''])[0].length;
        let innerStart = leading;
        let innerEnd = rawValue.length;
        const first = rawValue[innerStart];
        if (first === '"' || first === "'" || first === '`') {
          const close = rawValue.indexOf(first, innerStart + 1);
          if (close === -1) {
            innerStart += 1;
          } else {
            innerStart += 1;
            innerEnd = close;
          }
        } else {
          const comment = rawValue.slice(innerStart).search(/\s|#/);
          if (comment !== -1) innerEnd = innerStart + comment;
        }
        const value = rawValue.slice(innerStart, innerEnd).trim();
        if (placeholderValue(value)) continue;
        const start = lineValueOffset + innerStart;
        spans.push({ start, end: start + value.length, category: 'SECRET', value });
      }
      return spans;
    },
  };
}

function highEntropyDetector() {
  return {
    name: 'high-entropy',
    scan(text) {
      const spans = [];
      const re = /(?<![A-Za-z0-9])(?<q1>["']?)(?<key>[A-Za-z_][A-Za-z0-9_.-]{0,63})\k<q1>\s*(?:=|:)\s*(?<q2>["'`]?)(?<value>[A-Za-z0-9+/=_.\-]{20,300})\k<q2>/g;
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const key = match.groups.key;
        const value = match.groups.value;
        if (!looksLikeSecretKey(key)) continue;
        if (placeholderValue(value)) continue;
        if (new Set(value).size < 6) continue;
        if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) continue;
        if (shannonEntropy(value) < 3.5) continue;
        if (/^(?:https?|ftp|file):/i.test(value)) continue;
        const closing = match.groups.q2 ? 1 : 0;
        const start = match.index + match[0].length - closing - value.length;
        spans.push({ start, end: start + value.length, category: 'SECRET', value });
      }
      return spans;
    },
  };
}


function sandboxAccountDetector() {
  return {
    name: 'sandbox-accounts',
    scan(text) {
      const spans = [];
      const patterns = [
        /muse-sbx-[A-Za-z0-9._-]+/gi,
        /(?:[A-Za-z0-9._-]+[\\/]+)?(?:Muse|Codex)SandboxUsers(?![A-Za-z0-9_-])/gi,
      ];
      for (const re of patterns) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(text)) !== null) {
          spans.push({
            start: match.index,
            end: match.index + match[0].length,
            category: 'SECRET',
            value: match[0],
          });
        }
      }
      spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
      const accepted = [];
      for (const span of spans) {
        if (accepted.some((other) => span.start < other.end && span.end > other.start)) continue;
        accepted.push(span);
      }
      return accepted;
    },
  };
}

export function createPatternDetectors() {
  return [
    privateKeyDetector(),
    sandboxAccountDetector(),
    emailDetector(),
    tokenPatternDetector(),
    ssnDetector(),
    phoneDetector(),
    ipv4Detector(),
    cardDetector(),
    envDetector(),
    highEntropyDetector(),
  ];
}

export { lookLikeDocAddress as _lookLikeDocAddress };

function lookLikeDocAddress(address) {
  return /@example\.(?:com|org|net)$/i.test(String(address));
}

export function buildIdentityRegex(values) {
  return new RegExp(values.map((value) => escapeRegExp(value)).join('|'), 'gi');
}
