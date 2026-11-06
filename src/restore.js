import {
  buildPathFamily,
  buildLiteralFamily,
  parseWindowsPath,
  separatorDepth,
  formatWindowsPath,
} from './winpath.js';
import { jsonEscape, isObject } from './util.js';

const TOKEN_PREFIXES = 'PERSON|USERNAME|EMAIL|HOST|TERM|LOCAL_PATH';

function aliasSpecs(config, workspaceRoot) {
  const specs = [];
  const add = (alias, target) => {
    if (!alias || !target) return;
    const aliasParsed = parseWindowsPath(alias);
    const targetParsed = parseWindowsPath(target);
    const family = aliasParsed ? buildPathFamily(aliasParsed) : buildLiteralFamily(alias);
    specs.push({
      alias,
      target,
      aliasParsed,
      targetParsed,
      source: family.source,
      maxLength: family.maxLength,
    });
  };
  add(config.homeAlias, config.homeDir);
  if (workspaceRoot && config.workspaceAlias
    && config.workspaceAlias.toLowerCase() !== config.homeAlias.toLowerCase()) {
    add(config.workspaceAlias, workspaceRoot);
  }
  specs.sort((a, b) => b.maxLength - a.maxLength || b.alias.length - a.alias.length);
  return specs;
}

function boundaryOkay(leftChar) {
  return leftChar === null || leftChar === undefined || !/[A-Za-z0-9_]/.test(leftChar);
}

/**
 * Build a restorer bound to the current token map snapshot. The same
 * restorer serves whole-text (non-streaming) and incremental (SSE) use.
 */
export function createRestorer({ config, store, workspaceRoot = config.workspaceRoot }) {
  const specs = aliasSpecs(config, workspaceRoot);
  const tokenMap = new Map(store.restorableEntries().map((entry) => [entry.token, entry.value]));
  let maxTokenLength = 0;
  for (const token of tokenMap.keys()) maxTokenLength = Math.max(maxTokenLength, token.length);

  const alternatives = [];
  specs.forEach((spec, index) => alternatives.push(`(?<a${index}>${spec.source})`));
  alternatives.push(`(?<tok>(?:${TOKEN_PREFIXES})_\\d+)(?![A-Za-z0-9_])`);
  const regexSource = alternatives.join('|');

  const maxAliasLength = specs.reduce((max, spec) => Math.max(max, spec.maxLength), 0);
  const hold = Math.max(1, Math.max(maxAliasLength, maxTokenLength) - 1);

  function regexFactory() {
    return new RegExp(regexSource, 'gi');
  }

  function replaceMatch(match, leftChar, argsContext) {
    if (!boundaryOkay(leftChar)) return match[0];
    const groups = match.groups || {};
    if (groups.tok !== undefined) {
      const value = tokenMap.get(groups.tok);
      if (value === undefined) return match[0];
      return argsContext ? jsonEscape(value) : value;
    }
    for (let i = 0; i < specs.length; i += 1) {
      if (groups[`a${i}`] === undefined) continue;
      const spec = specs[i];
      const depth = separatorDepth(match[0], spec.aliasParsed);
      const outDepth = argsContext ? Math.max(2, depth) : Math.max(1, depth);
      return spec.targetParsed ? formatWindowsPath(spec.targetParsed, outDepth) : spec.target;
    }
    return match[0];
  }

  function restoreText(text, { argsContext = false } = {}) {
    if (typeof text !== 'string' || text.length === 0) return text;
    const re = regexFactory();
    let output = '';
    let cursor = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const leftChar = match.index > 0 ? text[match.index - 1] : null;
      output += text.slice(cursor, match.index);
      output += replaceMatch(match, leftChar, argsContext);
      cursor = match.index + match[0].length;
    }
    output += text.slice(cursor);
    return output;
  }

  class Stream {
    constructor({ argsContext = false } = {}) {
      this.argsContext = argsContext;
      this.buffer = '';
      this.leftChar = null;
    }

    push(chunk) {
      if (typeof chunk !== 'string' || chunk.length === 0) return '';
      this.buffer += chunk;
      return this.drain(false);
    }

    end() {
      return this.drain(true);
    }

    drain(final) {
      if (this.buffer.length === 0) return '';
      const limit = final ? this.buffer.length : this.buffer.length - hold;
      if (!final && limit <= 0) return '';
      const re = regexFactory();
      let output = '';
      let cursor = 0;
      let stopAt = null;
      let match;
      while ((match = re.exec(this.buffer)) !== null) {
        const end = match.index + match[0].length;
        if (!final && end > limit) {
          stopAt = match.index;
          break;
        }
        const leftChar = match.index > 0 ? this.buffer[match.index - 1] : this.leftChar;
        output += this.buffer.slice(cursor, match.index);
        output += replaceMatch(match, leftChar, this.argsContext);
        cursor = end;
      }

      if (final) {
        output += this.buffer.slice(cursor);
        this.buffer = '';
        if (output.length > 0) this.leftChar = output[output.length - 1];
        return output;
      }

      const safeEnd = stopAt !== null ? stopAt : Math.max(cursor, limit);
      output += this.buffer.slice(cursor, safeEnd);
      if (output.length > 0) this.leftChar = output[output.length - 1];
      this.buffer = this.buffer.slice(safeEnd);
      return output;
    }
  }

  function createStream(options = {}) {
    return new Stream(options);
  }

  return {
    restoreText,
    createStream,
    specs,
    tokenMap,
    hold,
    maxTokenLength,
  };
}

/**
 * Restore strings in a parsed JSON response. A `function_call.arguments`
 * string is JSON-in-a-string, so replacements are JSON-escaped there.
 * `encrypted_content` is opaque and never touched.
 */
export function restoreResponseObject(value, restorer) {
  function walk(node, key, parentType) {
    if (typeof node === 'string') {
      if (key === 'encrypted_content') return node;
      const argsContext = key === 'arguments' && parentType === 'function_call';
      return restorer.restoreText(node, { argsContext });
    }
    if (Array.isArray(node)) {
      return node.map((child) => walk(child, null, parentType));
    }
    if (isObject(node)) {
      const type = typeof node.type === 'string' ? node.type : parentType;
      const out = {};
      for (const [childKey, child] of Object.entries(node)) {
        if (childKey === 'encrypted_content') {
          out[childKey] = child;
        } else {
          out[childKey] = walk(child, childKey, type);
        }
      }
      return out;
    }
    return node;
  }
  return walk(value, null, null);
}
