import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from './util.js';

const CATEGORY_PREFIX = {
  PERSON: 'PERSON',
  USERNAME: 'USERNAME',
  EMAIL: 'EMAIL',
  HOST: 'HOST',
  TERM: 'TERM',
  SECRET: 'SECRET',
  LOCAL_PATH: 'LOCAL_PATH',
};

const RESTORABLE = new Set(['PERSON', 'USERNAME', 'EMAIL', 'HOST', 'TERM', 'LOCAL_PATH']);

function normalizeIdentity(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizePathValue(value) {
  return String(value).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

function normalizeKey(category, value) {
  switch (category) {
    case 'PERSON':
    case 'USERNAME':
    case 'EMAIL':
    case 'HOST':
    case 'TERM':
      return normalizeIdentity(value);
    case 'LOCAL_PATH':
      return normalizePathValue(value);
    case 'SECRET':
      return sha256Hex(value);
    default:
      return normalizeIdentity(value);
  }
}

function entryKey(category, value) {
  return `${category}\u0000${normalizeKey(category, value)}`;
}

function maxCounter(entries, category) {
  let max = 0;
  for (const entry of Object.values(entries)) {
    if (entry.category !== category) continue;
    const match = new RegExp(`^${category}_(\\d+)$`).exec(entry.token);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

export class TokenStore {
  constructor({ mapPath, persist = true } = {}) {
    this.mapPath = mapPath || null;
    this.persist = persist && Boolean(mapPath);
    this.entries = {};
    this.next = {};
    this.dirty = false;
    this.writeChain = Promise.resolve();
    this.loaded = false;
  }

  static async open(options) {
    const store = new TokenStore(options);
    await store.load();
    return store;
  }

  async load() {
    if (!this.mapPath || !fs.existsSync(this.mapPath)) {
      this.loaded = true;
      return this;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.mapPath, 'utf8'));
    } catch (error) {
      throw new Error(`metaveil: token map is unreadable (${error.code || 'parse error'}); refusing to start`);
    }
    if (!parsed || parsed.version !== 1 || typeof parsed.entries !== 'object') {
      throw new Error('metaveil: token map has an unsupported format; refusing to start');
    }
    this.entries = parsed.entries;
    this.next = parsed.next && typeof parsed.next === 'object' ? { ...parsed.next } : {};
    for (const category of Object.keys(CATEGORY_PREFIX)) {
      const stored = Number(this.next[category] ?? 0);
      this.next[category] = Math.max(stored, maxCounter(this.entries, category));
    }
    this.loaded = true;
    return this;
  }

  assign(category, value, { restorable = RESTORABLE.has(category), canonicalValue } = {}) {
    const prefix = CATEGORY_PREFIX[category];
    if (!prefix) throw new Error(`metaveil: unknown token category ${category}`);
    const key = entryKey(category, value);
    const existing = this.entries[key];
    if (existing) return existing.token;

    const nextNumber = Number(this.next[category] ?? 0) + 1;
    this.next[category] = nextNumber;
    const token = `${prefix}_${nextNumber}`;
    const storesValue = restorable && category !== 'SECRET';
    this.entries[key] = {
      token,
      category,
      key: normalizeKey(category, value),
      value: storesValue ? String(canonicalValue ?? value) : null,
    };
    this.dirty = true;
    return token;
  }

  get(token) {
    for (const entry of Object.values(this.entries)) {
      if (entry.token === token) return entry;
    }
    return null;
  }

  restorableEntries() {
    return Object.values(this.entries).filter(
      (entry) => entry.category !== 'SECRET' && typeof entry.value === 'string' && entry.value.length > 0,
    );
  }

  maxTokenLength() {
    let max = 0;
    for (const entry of this.restorableEntries()) {
      if (entry.token.length > max) max = entry.token.length;
    }
    return max;
  }

  async flush() {
    if (!this.persist) return;
    if (!this.dirty) return this.writeChain;
    this.dirty = false;
    const snapshot = JSON.stringify({ version: 1, next: this.next, entries: this.entries });
    this.writeChain = this.writeChain.then(() => atomicWrite(this.mapPath, snapshot)).catch((error) => {
      this.dirty = true;
      throw error;
    });
    return this.writeChain;
  }

  snapshot() {
    return JSON.parse(JSON.stringify({ version: 1, next: this.next, entries: this.entries }));
  }
}

async function atomicWrite(target, contents) {
  const dir = path.dirname(target);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await fs.promises.writeFile(tmp, contents, 'utf8');
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.promises.rename(tmp, target);
      return;
    } catch (error) {
      lastError = error;
      if (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES') {
        try {
          await fs.promises.unlink(target);
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') {
            lastError = unlinkError;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        continue;
      }
      break;
    }
  }
  try {
    await fs.promises.unlink(tmp);
  } catch {
    // best effort
  }
  throw lastError || new Error('metaveil: failed to persist token map');
}
