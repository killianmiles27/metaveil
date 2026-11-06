// Finds text a tool printed in encoded form, so it can be scanned as what it really says.
// A model that hits a withheld line may reasonably read the file again as a hex dump, and
// neither identity matching nor a line-by-line scan can see through that.
//
// This covers common encodings, not every possible one: rot13 or a homemade cipher still
// get through. splitIdentityFound below catches identity values spread out by separators.

const MIN_DECODED = 6;
const PRINTABLE_RATIO = 0.85;

function readable(buffer) {
  // UTF-16 text decodes with a NUL after each character.
  const bytes = buffer.filter((byte) => byte !== 0);
  if (bytes.length < MIN_DECODED) return null;
  let printable = 0;
  for (const byte of bytes) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 128) printable += 1;
  }
  if (printable / bytes.length < PRINTABLE_RATIO) return null;
  const text = Buffer.from(bytes).toString('utf8');
  // Random bytes decode to replacement characters. Text doesn't.
  if ((text.match(/�/g) || []).length > text.length * 0.05) return null;
  return text;
}

const hexPairs = (value) => Buffer.from(value.replace(/[^0-9a-fA-F]/g, ''), 'hex');

// 00000010   69 6C 64 20 ...  ild from   (Format-Hex, hexdump -C)
// 00000010: 696c 6420 ...      ild from   (xxd)
const DUMP_LINE = /^[ \t]*(?:0x)?[0-9A-Fa-f]{4,16}:?[ \t]+((?:[0-9A-Fa-f]{2}[ \t]+){1,16}|(?:[0-9A-Fa-f]{4}[ \t]+){1,8}|(?:[0-9A-Fa-f]{2}[ \t]*){1,16}$)/;

function findHexDumps(text) {
  const blocks = [];
  const lineRe = /[^\r\n]*(?:\r?\n|$)/g;
  let current = null;
  let match;
  while ((match = lineRe.exec(text)) !== null) {
    if (match[0].length === 0) break;
    const dump = DUMP_LINE.exec(match[0].replace(/\r?\n$/, ''));
    if (dump) {
      if (!current) current = { start: match.index, end: match.index, bytes: [], lines: 0 };
      current.end = match.index + match[0].length;
      current.lines += 1;
      current.bytes.push(hexPairs(dump[1]));
    } else if (current) {
      blocks.push(current);
      current = null;
    }
  }
  if (current) blocks.push(current);
  return blocks
    .map((block) => ({ start: block.start, end: block.end, decoded: readable(Buffer.concat(block.bytes)), kind: 'hex dump' }))
    .filter((block) => block.decoded);
}

function findByPattern(text, re, decode, kind) {
  const blocks = [];
  for (const match of text.matchAll(re)) {
    const decoded = decode(match[0]);
    if (decoded) blocks.push({ start: match.index, end: match.index + match[0].length, decoded, kind });
  }
  return blocks;
}

const decodeBase64 = (value) => {
  const compact = value.replace(/\s/g, '');
  if (compact.length < 16) return null;
  return readable(Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
};

// Standard base64 may be wrapped across lines, as certutil -encode does. All its lines but
// the last have one width, which keeps a following word or a PEM footer out of the data.
const BASE64_LINE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/]{4,}={0,2}(?![A-Za-z0-9+/=_-])/g;
const URL_SAFE_BASE64 = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9_-]{16,}={0,2}/g;

function findWrappedBase64(text) {
  const blocks = [];
  const lines = [...text.matchAll(/[^\r\n]*(?:\r?\n|$)/g)].filter((m) => m[0].length > 0);
  for (let i = 0; i < lines.length; i += 1) {
    for (const match of lines[i][0].matchAll(BASE64_LINE)) {
      if (match[0].length < 16) continue;
      const startsLine = lines[i][0].slice(0, match.index).trim() === '';
      const endsLine = lines[i][0].slice(match.index + match[0].length).trim() === '';
      let value = match[0];
      let end = lines[i].index + match.index + match[0].length;
      let next = i + 1;
      // Only a token alone on its line can continue on the next one.
      while (startsLine && endsLine && next < lines.length && !value.endsWith('=')) {
        const piece = lines[next][0].trim();
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(piece) || piece.length > match[0].length) break;
        value += piece;
        end = lines[next].index + lines[next][0].trimEnd().length;
        next += 1;
        if (piece.length < match[0].length) break;
      }
      const decoded = decodeBase64(value);
      if (decoded) blocks.push({ start: lines[i].index + match.index, end, decoded, kind: 'base64' });
      if (next > i + 1) i = next - 1;
    }
  }
  return blocks;
}

const HEX_STRING = /(?<![0-9A-Za-z])(?:[0-9A-Fa-f]{2}[ :-]?){8,}(?![0-9A-Za-z])/g;
const BYTE_LIST = /(?<![\d.])(?:\d{1,3}[,\s]+){7,}\d{1,3}(?![\d.])/g;

const decodeByteList = (value) => {
  const numbers = value.split(/[,\s]+/).filter(Boolean).map(Number);
  if (numbers.some((n) => n > 255)) return null;
  return readable(Buffer.from(numbers));
};

// Returns blocks that don't overlap, in order. Hex dumps win, since the offset column and
// bytes of a dump would otherwise also look like the other forms.
export function findEncodedBlocks(text) {
  if (typeof text !== 'string' || text.length < MIN_DECODED) return [];
  const all = [
    ...findHexDumps(text),
    ...findByPattern(text, HEX_STRING, (value) => readable(hexPairs(value)), 'hex'),
    ...findWrappedBase64(text),
    ...findByPattern(text, URL_SAFE_BASE64, decodeBase64, 'base64'),
    ...findByPattern(text, BYTE_LIST, decodeByteList, 'byte list'),
  ];
  const kept = [];
  for (const block of all) {
    if (!kept.some((other) => block.start < other.end && other.start < block.end)) kept.push(block);
  }
  return kept.sort((a, b) => a.start - b.start);
}

const compact = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const MIN_SPLIT_LENGTH = 10;

// K I L L I A N, one letter a line, or written backwards. Short values are skipped,
// because they turn up by chance once separators are gone.
export function splitIdentityFound(text, values) {
  if (typeof text !== 'string' || text.length < MIN_SPLIT_LENGTH) return false;
  const squeezed = compact(text);
  const backwards = [...squeezed].reverse().join('');
  return values.some((value) => {
    const needle = compact(value);
    return needle.length >= MIN_SPLIT_LENGTH && (squeezed.includes(needle) || backwards.includes(needle));
  });
}
