import { findEncodedBlocks, splitIdentityFound } from './encoded.js';
import { JEV_WITHHELD_TEXT } from './detectors/jev.js';
import { isObject, escapeRegExp } from './util.js';
import { filterSkillBlocks } from './contributor.js';
import {
  buildPathFamily,
  parseWindowsPath,
  separatorDepth,
  formatWindowsPath,
} from './winpath.js';

export const WITHHELD_ATTACHMENT = '[attachment withheld by metaveil]';

const TEXT_PART_TYPES = new Set([
  'input_text',
  'output_text',
  'text',
  'summary_text',
  'refusal',
]);

const KNOWN_NON_TEXT_PART_TYPES = new Set([
  'input_image',
  'input_file',
  'input_audio',
  'computer_screenshot',
  'image_url',
  'image',
  'file',
  'audio',
]);

const SAFE_FIELD_KEYS = new Set([
  'instructions', 'input', 'tools', 'tool', 'function', 'namespace',
  'type', 'role', 'content', 'text', 'arguments', 'output', 'name',
  'description', 'parameters', 'properties', 'items', 'summary',
  'encrypted_content', 'required', 'enum', 'default', 'format', 'model',
  'stream', 'store', 'include', 'reasoning', 'prompt_cache_key',
  'max_output_tokens', 'call_id', 'item', 'response', 'delta', 'id', 'status',
]);

function fieldKey(key, index) {
  return SAFE_FIELD_KEYS.has(key) ? `.${key}` : `[${index}]`;
}

function withField(ctx, field, extra = {}) {
  return {
    ...ctx,
    field,
    chunk: (ctx.chunkRef.n += 1),
    ...extra,
  };
}

/**
 * Request-side redactor. `redactBody` walks instructions/input/tools (and
 * unknown top-level fields) and returns a new body; opaque `encrypted_content`
 * is copied through untouched.
 */
export function createRedactor({ config, store, pipeline, audit }) {
  const homeParsed = parseWindowsPath(config.homeDir);
  const homeAliasParsed = parseWindowsPath(config.homeAlias);
  const homeFamily = homeParsed ? buildPathFamily(homeParsed) : null;

  const identityEntries = [];
  const seenIdentity = new Set();
  for (const [field, category] of [
    ['names', 'PERSON'],
    ['usernames', 'USERNAME'],
    ['emails', 'EMAIL'],
    ['hostnames', 'HOST'],
    ['terms', 'TERM'],
  ]) {
    for (const raw of config.identity[field] || []) {
      const value = String(raw).trim();
      const lower = value.toLowerCase();
      if (!value || seenIdentity.has(lower)) continue;
      seenIdentity.add(lower);
      identityEntries.push({
        value,
        category,
        boundary: value.length < 4 || category === 'PERSON' || category === 'TERM',
      });
    }
  }
  identityEntries.sort((a, b) => b.value.length - a.value.length);

  function encodedValueVariants(value) {
    const variants = new Set([value]);
    try { variants.add(encodeURIComponent(value)); } catch { /* ignore */ }
    try { variants.add(encodeURI(value)); } catch { /* ignore */ }
    for (const variant of [...variants]) {
      if (variant.includes('%20')) variants.add(variant.replace(/%20/g, '+'));
      variants.add(variant.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase()));
    }
    return [...variants].filter(Boolean);
  }

  const encodedHomeValues = [];
  if (homeParsed) {
    for (const base of [homeParsed.canonical, homeParsed.canonical.replace(/\\/g, '/')]) {
      for (const variant of encodedValueVariants(base)) {
        if (variant !== base) encodedHomeValues.push(variant);
      }
    }
  }

  const protectedSource = [
    String.raw`\b(?:PERSON|USERNAME|EMAIL|HOST|TERM|LOCAL_PATH|SECRET)_\d+\b`,
    String.raw`<redacted-[a-z0-9-]+>`,
    String.raw`\[(?:line withheld by metaveil: possible personal details. Do not try to read it another way|content withheld by metaveil: scanner unavailable|attachment withheld by metaveil)\]`,
    escapeRegExp(config.homeAlias),
    escapeRegExp(config.workspaceAlias),
  ].join('|');
  const protectedRe = new RegExp(`(?:${protectedSource})`, 'gi');

  function protectedIntervals(text) {
    const intervals = [];
    const re = new RegExp(protectedRe.source, 'gi');
    let match;
    while ((match = re.exec(text)) !== null) {
      intervals.push([match.index, match.index + match[0].length]);
    }
    return intervals;
  }

  function overlapsProtected(start, end, intervals) {
    return intervals.some(([s, e]) => start < e && end > s);
  }

  function entryRegex(entry) {
    const alternatives = encodedValueVariants(entry.value)
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|');
    const body = `(?:${alternatives})`;
    return entry.boundary
      ? new RegExp(`(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`, 'gi')
      : new RegExp(body, 'gi');
  }

  function parseJsonCandidate(text) {
    const leading = /^\s*/.exec(text)[0];
    const trailing = /\s*$/.exec(text)[0];
    const core = text.slice(leading.length, text.length - trailing.length);
    if (!core || !/^[\[{"]/.test(core)) return null;
    let parsed;
    try {
      parsed = JSON.parse(core);
    } catch {
      return null;
    }
    if (parsed === null || (typeof parsed !== 'object' && typeof parsed !== 'string')) return null;
    return { leading, trailing, parsed };
  }

  async function redactJsonValue(value, ctx) {
    if (typeof value === 'string') return redactString(value, ctx);
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i += 1) {
        out.push(await redactJsonValue(value[i], withField(ctx, `${ctx.field}[${i}]`)));
      }
      return out;
    }
    if (isObject(value)) {
      const out = Object.create(null);
      let index = 0;
      for (const [key, child] of Object.entries(value)) {
        index += 1;
        if (key === 'encrypted_content' || key === 'type' || key === 'role') {
          out[key] = child;
          continue;
        }
        const nextKey = await redactString(key, withField(ctx, `${ctx.field}[key${index}]`, { jevKey: true }));
        out[nextKey] = await redactJsonValue(child, withField(ctx, `${ctx.field}[${index}]`));
      }
      return out;
    }
    return value;
  }

  function replaceFinal(text, regex, makeReplacement, ctx, category, field) {
    const intervals = protectedIntervals(text);
    let output = '';
    let cursor = 0;
    let changed = false;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      if (overlapsProtected(start, end, intervals)) continue;
      const replacement = makeReplacement(match);
      output += text.slice(cursor, start) + replacement;
      cursor = end;
      changed = true;
      audit?.record({
        requestId: ctx.requestId,
        phase: 'request',
        action: 'redacted',
        category,
        placeholder: replacement,
        byteOffset: Buffer.byteLength(text.slice(0, start), 'utf8'),
        field,
        chunk: ctx.chunk,
        finalPass: true,
      });
    }
    if (!changed) return text;
    return output + text.slice(cursor);
  }

  function scrubStringFinal(text, ctx) {
    if (!text) return text;
    let output = text;
    if (homeFamily) {
      output = replaceFinal(output, new RegExp(homeFamily.source, 'gi'), (match) => {
        const depth = Math.max(1, separatorDepth(match[0], homeParsed));
        return homeAliasParsed ? formatWindowsPath(homeAliasParsed, depth) : config.homeAlias;
      }, ctx, 'PATH_ALIAS', ctx.field);
    }
    if (encodedHomeValues.length > 0) {
      const source = encodedHomeValues
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|');
      output = replaceFinal(output, new RegExp(source, 'gi'), () => config.homeAlias, ctx, 'PATH_ALIAS', ctx.field);
    }
    for (const entry of identityEntries) {
      output = replaceFinal(
        output,
        entryRegex(entry),
        () => store.assign(entry.category, entry.value),
        ctx,
        entry.category,
        ctx.field,
      );
    }
    return output;
  }

  function assertNoResidual(text) {
    if (!text) return;
    const intervals = protectedIntervals(text);
    const checks = [];
    if (homeFamily) checks.push(new RegExp(homeFamily.source, 'gi'));
    for (const value of encodedHomeValues) checks.push(new RegExp(escapeRegExp(value), 'gi'));
    for (const entry of identityEntries) checks.push(entryRegex(entry));
    for (const re of checks) {
      let match;
      while ((match = re.exec(text)) !== null) {
        const end = match.index + match[0].length;
        if (overlapsProtected(match.index, end, intervals)) continue;
        throw new Error('metaveil: final identity verification failed');
      }
    }
  }

  function scrubFinal(value, ctx, topLevel = true) {
    if (typeof value === 'string') {
      const output = scrubStringFinal(value, ctx);
      assertNoResidual(output);
      return output;
    }
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i += 1) {
        out.push(scrubFinal(value[i], withField(ctx, `${ctx.field}[${i}]`), false));
      }
      return out;
    }
    if (isObject(value)) {
      const out = Object.create(null);
      let index = 0;
      for (const [key, child] of Object.entries(value)) {
        index += 1;
        if (key === 'encrypted_content') {
          out[key] = child;
          continue;
        }
        if (topLevel && (key === 'model' || key === 'prompt_cache_key')) {
          out[key] = child;
          continue;
        }
        if (key === 'type' || key === 'role') {
          out[key] = child;
          continue;
        }
        const nextKey = scrubStringFinal(key, ctx);
        out[nextKey] = scrubFinal(child, withField(ctx, `${ctx.field}[${index}]`), false);
      }
      return out;
    }
    return value;
  }

  // Encoded text is scanned as what it says. If that changes anything, the model gets the
  // decoded, redacted text instead, which also gives it no reason to try another encoding.
  async function decodeEncodedBlocks(text, ctx) {
    const depth = ctx.encodedDepth || 0;
    if (depth >= 2) return text;
    const blocks = findEncodedBlocks(text);
    if (blocks.length === 0) return text;
    let output = '';
    let cursor = 0;
    for (const block of blocks) {
      const clean = await redactString(block.decoded, { ...ctx, encodedDepth: depth + 1, field: `${ctx.field}.decoded` });
      if (clean === block.decoded) continue;
      output += `${text.slice(cursor, block.start)}[${block.kind} decoded by metaveil]\n${clean}\n`;
      cursor = block.end;
      audit?.record({ requestId: ctx.requestId, phase: 'request', action: 'decoded', category: 'ENCODED', kind: block.kind, field: ctx.field });
    }
    return output + text.slice(cursor);
  }

  async function redactString(text, ctx) {
    if (typeof text !== 'string' || text.length === 0) return text;
    const result = await redactPlainString(text, ctx);
    if (!splitIdentityFound(result, identityEntries.map((entry) => entry.value))) return result;
    audit?.record({ requestId: ctx.requestId, phase: 'request', action: 'withheld', category: 'SPLIT_IDENTITY', field: ctx.field });
    return JEV_WITHHELD_TEXT;
  }

  async function redactPlainString(text, ctx) {

    const json = parseJsonCandidate(text);
    if (json) {
      if ((ctx.jsonDepth || 0) >= 8) throw new Error('metaveil: JSON nesting too deep');
      const inner = withField(ctx, `${ctx.field}.json`, {
        jsonDepth: (ctx.jsonDepth || 0) + 1,
        jsonContext: false,
      });
      const redacted = await redactJsonValue(json.parsed, inner);
      return `${json.leading}${JSON.stringify(redacted)}${json.trailing}`;
    }

    let working = text;
    if (ctx.contributor) {
      working = filterSkillBlocks(working, config.contributorPolicy, audit, ctx);
      if (working.length === 0) return '';
    }
    working = await decodeEncodedBlocks(working, ctx);
    const spans = await pipeline.scan(working, ctx);
    if (spans.length === 0) return working;
    let output = '';
    let cursor = 0;
    for (const span of spans) {
      if (span.start < cursor) continue;
      output += working.slice(cursor, span.start);
      let replacement;
      if (span.category === 'SECRET') {
        replacement = store.assign('SECRET', span.value ?? working.slice(span.start, span.end), { restorable: false });
      } else if (span.category === 'LOCAL_PATH') {
        const token = store.assign('LOCAL_PATH', span.value ?? working.slice(span.start, span.end));
        replacement = `${span.prefix ?? ''}${token}`;
      } else if (span.replacement !== undefined && span.replacement !== null) {
        replacement = span.replacement;
      } else {
        const token = store.assign(span.category, span.value ?? working.slice(span.start, span.end));
        replacement = `${span.prefix ?? ''}${token}${span.suffix ?? ''}`;
      }
      output += replacement;
      audit?.record({
        requestId: ctx.requestId,
        phase: 'request',
        action: span.category === 'WITHHELD' ? 'withheld' : 'redacted',
        category: span.category,
        placeholder: span.placeholder ?? replacement,
        byteOffset: Buffer.byteLength(working.slice(0, span.start), 'utf8'),
        field: ctx.field,
        chunk: ctx.chunk,
        ...(span.detector ? { detector: span.detector } : {}),
      });
      cursor = span.end;
    }
    output += working.slice(cursor);
    return output;
  }

  async function walkContentPart(part, ctx) {
    if (typeof part === 'string') return redactString(part, ctx);
    if (!isObject(part)) {
      audit?.record({
        requestId: ctx.requestId,
        phase: 'request',
        action: 'withheld',
        category: 'UNKNOWN_PART_TYPE',
        placeholder: WITHHELD_ATTACHMENT,
        field: ctx.field,
        chunk: ctx.chunk,
      });
      return { type: 'input_text', text: WITHHELD_ATTACHMENT };
    }
    const type = typeof part.type === 'string' ? part.type : '';
    if (TEXT_PART_TYPES.has(type)) {
      return walkGeneric(part, ctx, { walkKeys: false });
    }
    audit?.record({
      requestId: ctx.requestId,
      phase: 'request',
      action: 'withheld',
      category: KNOWN_NON_TEXT_PART_TYPES.has(type) ? 'ATTACHMENT' : 'UNKNOWN_PART_TYPE',
      placeholder: WITHHELD_ATTACHMENT,
      field: ctx.field,
      chunk: ctx.chunk,
    });
    return { type: 'input_text', text: WITHHELD_ATTACHMENT };
  }

  async function walkContent(content, ctx) {
    if (typeof content === 'string') return redactString(content, ctx);
    if (Array.isArray(content)) {
      const out = [];
      for (let i = 0; i < content.length; i += 1) {
        out.push(await walkContentPart(content[i], withField(ctx, `${ctx.field}[${i}]`)));
      }
      return out;
    }
    if (isObject(content)) {
      if (typeof content.type === 'string') return walkContentPart(content, ctx);
      return walkGeneric(content, ctx, { walkKeys: false });
    }
    return content;
  }

  async function walkGeneric(value, ctx, { walkKeys = false } = {}) {
    if (typeof value === 'string') return redactString(value, ctx);
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i += 1) {
        out.push(await walkGeneric(value[i], withField(ctx, `${ctx.field}[${i}]`), { walkKeys }));
      }
      return out;
    }
    if (!isObject(value)) return value;
    const out = Object.create(null);
    let index = 0;
    for (const [key, child] of Object.entries(value)) {
      index += 1;
      if (key === 'encrypted_content') {
        out[key] = child;
        continue;
      }
      if (key === 'type' || key === 'role') {
        // Protocol enums are structural; redacting them would corrupt the
        // request even if a configured term happened to match one.
        out[key] = child;
        continue;
      }
      const childField = `${ctx.field}${fieldKey(key, index)}`;
      let nextKey = key;
      if (walkKeys && !SAFE_FIELD_KEYS.has(key)) {
        nextKey = await redactString(key, withField(ctx, `${ctx.field}[${index}]`, { jevKey: true }));
      }
      out[nextKey] = await walkGeneric(child, withField(ctx, childField), { walkKeys });
    }
    return out;
  }

  async function walkMessage(item, ctx) {
    const out = Object.create(null);
    for (const [key, value] of Object.entries(item)) {
      if (key === 'type' || key === 'role') {
        out[key] = value;
      } else if (key === 'content') {
        out[key] = await walkContent(value, withField(ctx, `${ctx.field}.content`));
      } else if (key === 'encrypted_content') {
        out[key] = value;
      } else {
        out[key] = await walkGeneric(value, withField(ctx, `${ctx.field}${fieldKey(key, 0)}`), { walkKeys: false });
      }
    }
    return out;
  }

  async function walkFunctionCall(item, ctx) {
    const out = Object.create(null);
    for (const [key, value] of Object.entries(item)) {
      if (key === 'type' || key === 'call_id' || key === 'id' || key === 'encrypted_content') {
        out[key] = value;
      } else if (key === 'arguments') {
        if (typeof value === 'string') {
          out[key] = await redactString(value, withField(ctx, `${ctx.field}.arguments`, { jsonContext: true }));
        } else {
          out[key] = await walkGeneric(value, withField(ctx, `${ctx.field}.arguments`), { walkKeys: false });
        }
      } else {
        out[key] = await walkGeneric(value, withField(ctx, `${ctx.field}${fieldKey(key, 0)}`), { walkKeys: false });
      }
    }
    return out;
  }

  async function walkFunctionCallOutput(item, ctx) {
    const out = Object.create(null);
    for (const [key, value] of Object.entries(item)) {
      if (key === 'type' || key === 'call_id' || key === 'id' || key === 'encrypted_content') {
        out[key] = value;
      } else if (key === 'output') {
        out[key] = await walkContent(value, withField(ctx, `${ctx.field}.output`));
      } else {
        out[key] = await walkGeneric(value, withField(ctx, `${ctx.field}${fieldKey(key, 0)}`), { walkKeys: false });
      }
    }
    return out;
  }

  async function walkReasoning(item, ctx) {
    const out = Object.create(null);
    for (const [key, value] of Object.entries(item)) {
      if (key === 'encrypted_content' || key === 'id') {
        out[key] = value;
      } else if (key === 'summary') {
        out[key] = await walkContent(value, withField(ctx, `${ctx.field}.summary`));
      } else if (key === 'type') {
        out[key] = value;
      } else {
        out[key] = await walkGeneric(value, withField(ctx, `${ctx.field}${fieldKey(key, 0)}`), { walkKeys: false });
      }
    }
    return out;
  }

  async function walkInputItem(item, ctx) {
    if (typeof item === 'string') return redactString(item, ctx);
    if (!isObject(item)) return walkGeneric(item, ctx);
    const type = item.type;
    if (type === 'message') return walkMessage(item, ctx);
    if (type === 'function_call') return walkFunctionCall(item, ctx);
    if (type === 'function_call_output') return walkFunctionCallOutput(item, ctx);
    if (type === 'reasoning') return walkReasoning(item, ctx);
    audit?.record({
      requestId: ctx.requestId,
      phase: 'request',
      action: 'audited',
      category: 'UNKNOWN_ITEM_TYPE',
      field: ctx.field,
      chunk: ctx.chunk,
    });
    // Fail closed in the sense that every string is walked (including keys)
    // before the item is forwarded. Content/output arrays still get the
    // attachment-withholding treatment.
    const out = Object.create(null);
    const unknownCtx = { unknownInputItem: true };
    let index = 0;
    for (const [key, value] of Object.entries(item)) {
      index += 1;
      if (key === 'encrypted_content') {
        out[key] = value;
        continue;
      }
      if (key === 'type' || key === 'id' || key === 'call_id') {
        out[key] = value;
        continue;
      }
      let nextKey = key;
      if (!SAFE_FIELD_KEYS.has(key)) {
        nextKey = await redactString(key, withField(ctx, `${ctx.field}[${index}]`, { ...unknownCtx, jevKey: true }));
      }
      if (key === 'content' || key === 'output') {
        out[nextKey] = await walkContent(value, withField(ctx, `${ctx.field}.${key}`, unknownCtx));
      } else {
        out[nextKey] = await walkGeneric(
          value,
          withField(ctx, `${ctx.field}${fieldKey(key, index)}`, unknownCtx),
          { walkKeys: true },
        );
      }
    }
    return out;
  }

  async function walkInput(input, ctx) {
    if (typeof input === 'string') return redactString(input, ctx);
    if (isObject(input) && typeof input.type === 'string') return walkInputItem(input, ctx);
    if (!Array.isArray(input)) return walkGeneric(input, ctx, { walkKeys: true });
    const out = [];
    for (let i = 0; i < input.length; i += 1) {
      out.push(await walkInputItem(input[i], withField(ctx, `${ctx.field}[${i}]`)));
    }
    return out;
  }

  async function redactBody(body, {
    requestId,
    contributor = false,
    workspaceRoot = config.workspaceRoot,
    workspaceAlias = config.workspaceAlias,
  }) {
    const ctx = {
      requestId,
      contributor: Boolean(contributor),
      phase: 'request',
      field: '',
      chunk: 0,
      chunkRef: { n: 0 },
      jsonContext: false,
      jsonDepth: 0,
      workspaceRoot,
      assignToken: (category, value) => store.assign(category, value, { restorable: category !== 'SECRET' }),
      workspaceAlias,
      audit,
    };
    const out = Object.create(null);
    for (const [key, value] of Object.entries(body)) {
      if (key === 'model' || key === 'prompt_cache_key' || key === 'encrypted_content') {
        out[key] = value;
        continue;
      }
      if (key === 'instructions') {
        out[key] = await walkContent(value, withField(ctx, 'instructions'));
      } else if (key === 'input') {
        out[key] = await walkInput(value, withField(ctx, 'input'));
      } else if (key === 'tools') {
        out[key] = await walkGeneric(value, withField(ctx, 'tools'), { walkKeys: true });
      } else {
        out[key] = await walkGeneric(value, withField(ctx, key), { walkKeys: true });
      }
    }
    return scrubFinal(out, ctx);
  }

  async function redactText(text, {
    requestId,
    contributor = false,
    field = 'text',
    jsonContext = false,
    workspaceRoot = config.workspaceRoot,
    workspaceAlias = config.workspaceAlias,
  }) {
    const ctx = {
      requestId,
      contributor: Boolean(contributor),
      phase: 'request',
      field,
      chunk: 0,
      chunkRef: { n: 0 },
      jsonContext,
      jsonDepth: 0,
      workspaceRoot,
      assignToken: (category, value) => store.assign(category, value, { restorable: category !== 'SECRET' }),
      workspaceAlias,
      audit,
    };
    const output = await redactString(text, ctx);
    const scrubbed = scrubStringFinal(output, ctx);
    assertNoResidual(scrubbed);
    return scrubbed;
  }

  return { redactBody, redactText, redactString };
}
