import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only JSONL audit log. Callers are responsible for never passing
 * original secret/identity values; this module only serializes the fields it
 * is given.
 */
export class AuditLog {
  constructor(auditPath) {
    this.auditPath = auditPath;
    this.enabled = Boolean(auditPath);
    this.onError = (error) => {
      // Deliberately no payload / headers / body in this message.
      process.stderr.write(`metaveil: audit write failed (${error.code || 'error'})\n`);
    };
  }

  record(entry) {
    if (!this.enabled) return;
    const record = { ts: new Date().toISOString(), ...entry };
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
      fs.appendFileSync(this.auditPath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      this.onError(error);
    }
  }
}

export class NullAuditLog {
  record() {}
}

export function readAuditEntries(auditPath) {
  if (!auditPath || !fs.existsSync(auditPath)) return [];
  const lines = fs.readFileSync(auditPath, 'utf8').split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ category: 'MALFORMED_AUDIT_LINE' });
    }
  }
  return entries;
}

export function summarizeAudit(entries) {
  const categories = new Map();
  const blockedPaths = new Map();
  let withheld = 0;
  let blocked = 0;
  let stripped = 0;
  let total = 0;
  let jevCalls = 0;
  let jevCacheHits = 0;
  let jevCostUsd = 0;
  let jevLatencyMs = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    total += 1;
    const category = entry.category || 'UNKNOWN';
    categories.set(category, (categories.get(category) || 0) + 1);
    if (category === 'JEV') {
      const calls = Number(entry.calls);
      if (Number.isFinite(calls)) jevCalls += calls;
      const cacheHits = Number(entry.cacheHits);
      if (Number.isFinite(cacheHits)) jevCacheHits += cacheHits;
      const cost = Number(entry.cost);
      if (Number.isFinite(cost)) jevCostUsd += cost;
      const latency = Number(entry.latencyMs);
      if (Number.isFinite(latency)) jevLatencyMs += latency;
    }
    if (entry.action === 'withheld') withheld += 1;
    if (entry.action === 'blocked') {
      blocked += 1;
      if (entry.category === 'BLOCKED_PATH' && entry.target) {
        const key = `${entry.method || '?'} ${entry.target}`;
        blockedPaths.set(key, (blockedPaths.get(key) || 0) + 1);
      }
    }
    if (entry.action === 'stripped') stripped += 1;
  }
  return {
    total,
    categories: Object.fromEntries([...categories.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    withheld,
    blocked,
    stripped,
    jev: {
      calls: jevCalls,
      cacheHits: jevCacheHits,
      costUsd: jevCostUsd,
      latencyMs: jevLatencyMs,
    },
    blockedPaths: Object.fromEntries([...blockedPaths.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

export function formatAuditSummary(summary, auditPath) {
  const lines = [];
  lines.push(`metaveil audit: ${auditPath || '(disabled)'}`);
  lines.push(`total entries: ${summary.total}`);
  lines.push('counts by category:');
  const categories = Object.entries(summary.categories);
  if (categories.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [category, count] of categories) lines.push(`  ${category}: ${count}`);
  }
  lines.push(`withheld items: ${summary.withheld}`);
  const jev = summary.jev || { calls: 0, cacheHits: 0, costUsd: 0, latencyMs: 0 };
  lines.push(`Jev calls: ${jev.calls}`);
  lines.push(`Jev cache hits: ${jev.cacheHits}`);
  lines.push(`Jev spend (usage.cost): $${Number(jev.costUsd || 0).toFixed(6)}`);
  lines.push(`Jev total latency: ${jev.latencyMs} ms`);
  lines.push(`stripped/blocked items: ${summary.stripped} stripped, ${summary.blocked} blocked`);
  lines.push('blocked paths:');
  const paths = Object.entries(summary.blockedPaths);
  if (paths.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [target, count] of paths) lines.push(`  ${target}: ${count}`);
  }
  return `${lines.join('\n')}\n`;
}

export function printAuditSummary(auditPath, write = (text) => process.stdout.write(text)) {
  const entries = readAuditEntries(auditPath);
  write(formatAuditSummary(summarizeAudit(entries), auditPath));
}
