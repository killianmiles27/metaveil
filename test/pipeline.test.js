import test from 'node:test';
import assert from 'node:assert/strict';
import { DetectorPipeline, createJevDetector } from '../src/pipeline.js';
import { summarizeAudit, formatAuditSummary, readAuditEntries } from '../src/audit.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const span = (start, end, category = 'TEST') => ({ start, end, category });

test('later detector layers can only add spans, never remove earlier ones', async () => {
  const pipeline = new DetectorPipeline({
    detectors: [
      { name: 'first', async scan() { return [span(0, 5, 'FIRST')]; } },
      { name: 'second', async scan() { return [span(2, 8, 'SECOND'), span(10, 12, 'SECOND')]; } },
    ],
  });
  const spans = await pipeline.scan('abcdefghijkl');
  assert.deepEqual(spans.map((entry) => [entry.start, entry.end, entry.category]), [[0, 5, 'FIRST'], [10, 12, 'SECOND']]);
});

test('a remote detector failure with the withhold policy replaces the whole chunk', async () => {
  const audit = [];
  const pipeline = new DetectorPipeline({
    failurePolicy: 'withhold',
    detectors: [
      { name: 'ok', async scan() { return [span(0, 3)]; } },
      createJevDetector({ enabled: true, async scan() { throw new Error('boom'); } }),
      { name: 'after', async scan() { return [span(4, 5)]; } },
    ],
  });
  const spans = await pipeline.scan('abcdef', { audit: { record: (entry) => audit.push(entry) }, requestId: 'r' });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].category, 'WITHHELD');
  assert.match(spans[0].replacement, /scanner unavailable/);
  assert.equal(audit[0].category, 'DETECTOR_FAILURE');
  assert.equal(audit[0].action, 'withheld');
});

test('a remote detector failure with the block policy throws a pipeline error', async () => {
  const pipeline = new DetectorPipeline({
    failurePolicy: 'block',
    detectors: [createJevDetector({ enabled: true, async scan() { throw new Error('boom'); } })],
  });
  await assert.rejects(() => pipeline.scan('abcdef'), (error) => error.code === 'PIPELINE_ERROR');
});

test('an unexpected local detector exception always throws, even with withhold configured', async () => {
  const pipeline = new DetectorPipeline({
    failurePolicy: 'withhold',
    detectors: [{ name: 'local-bug', async scan() { throw new Error('boom'); } }],
  });
  await assert.rejects(() => pipeline.scan('abcdef'), (error) => error.code === 'PIPELINE_ERROR');
});

test('invalid detector spans fail closed', async () => {
  const pipeline = new DetectorPipeline({
    detectors: [{ name: 'bad', async scan() { return [{ start: 0, end: 999, category: 'X' }]; } }],
  });
  await assert.rejects(() => pipeline.scan('abcdef'), (error) => error.code === 'PIPELINE_ERROR');
});

test('the Jev registration point caches by SHA-256 and skips unchanged text', async () => {
  let scans = 0;
  const remote = createJevDetector({
    enabled: true,
    async scan(text) {
      scans += 1;
      return text.includes('secret') ? [span(0, 6, 'JEV')] : [];
    },
  });
  const pipeline = new DetectorPipeline({ detectors: [remote] });
  assert.equal((await pipeline.scan('clean chunk')).length, 0);
  assert.equal((await pipeline.scan('clean chunk')).length, 0);
  assert.equal(scans, 1);
  assert.equal((await pipeline.scan('secret chunk')).length, 1);
  assert.equal(scans, 2);
  assert.equal((await pipeline.scan('secret chunk')).length, 1);
  assert.equal(scans, 2);
  assert.equal(remote.cacheStats.hits, 2);
});

test('the Jev placeholder is a no-op until enabled', async () => {
  const remote = createJevDetector({ enabled: false, scan: async () => { throw new Error('should not run'); } });
  const pipeline = new DetectorPipeline({ detectors: [remote] });
  assert.deepEqual(await pipeline.scan('anything'), []);
});

test('audit summary counts categories, withheld items and blocked paths', () => {
  const entries = [
    { category: 'PERSON', action: 'redacted' },
    { category: 'PERSON', action: 'redacted' },
    { category: 'SECRET', action: 'redacted' },
    { category: 'ATTACHMENT', action: 'withheld' },
    { category: 'BLOCKED_PATH', action: 'blocked', method: 'POST', target: '/nope' },
    { category: 'CONTRIBUTOR_TOOL', action: 'stripped', toolName: 'computer_use' },
  ];
  const summary = summarizeAudit(entries);
  assert.equal(summary.total, 6);
  assert.equal(summary.categories.PERSON, 2);
  assert.equal(summary.withheld, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.stripped, 1);
  assert.equal(summary.blockedPaths['POST /nope'], 1);
  const text = formatAuditSummary(summary, 'audit.jsonl');
  assert.match(text, /PERSON: 2/);
  assert.match(text, /withheld items: 1/);
  assert.match(text, /POST \/nope: 1/);
});

test('audit reader tolerates a missing file', () => {
  assert.deepEqual(readAuditEntries(path.join(os.tmpdir(), 'metaveil-does-not-exist.jsonl')), []);
  assert.ok(fs.existsSync(os.tmpdir()));
});
