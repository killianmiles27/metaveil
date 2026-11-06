import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TokenStore } from '../src/token-store.js';
import { createDetectors } from '../src/detectors/index.js';
import { createPipeline } from '../src/pipeline.js';
import { createRedactor } from '../src/redact.js';
import { NullAuditLog } from '../src/audit.js';
import { makeRuntimeConfig, SYNTH } from './helpers.js';

async function redactWith(config, text) {
  const store = await TokenStore.open({ mapPath: config.mapPath });
  const pipeline = createPipeline({ config, detectors: createDetectors(config) });
  const redactor = createRedactor({ config, store, pipeline, audit: new NullAuditLog() });
  const output = await redactor.redactText(text, { requestId: 'determinism' });
  await store.flush();
  return { output, store };
}

test('two separate fresh stores assign identical tokens in identical order', async () => {
  const text = `${SYNTH.name} ${SYNTH.email} ${SYNTH.home}\\Downloads\\${SYNTH.filename}`;
  const firstConfig = makeRuntimeConfig().config;
  const secondConfig = makeRuntimeConfig().config;
  const first = await redactWith(firstConfig, text);
  const second = await redactWith(secondConfig, text);
  assert.equal(first.output, second.output);
  assert.match(first.output, /PERSON_1/);
  assert.match(first.output, /EMAIL_1/);
  assert.match(first.output, /LOCAL_PATH_1/);
});

test('a restart reuses the persisted map and never renumbers values', async () => {
  const { config } = makeRuntimeConfig();
  const first = await redactWith(config, `${SYNTH.name} ${SYNTH.email}`);
  assert.match(first.output, /PERSON_1/);
  const second = await redactWith(config, `${SYNTH.name} ${SYNTH.email}`);
  assert.equal(first.output, second.output);
  const third = await redactWith(config, `${SYNTH.hostname} ${SYNTH.email}`);
  assert.match(third.output, /HOST_1/);
  assert.match(third.output, /EMAIL_1/);
});

test('the token map is written atomically and does not persist secret values', async () => {
  const { config } = makeRuntimeConfig();
  const store = await TokenStore.open({ mapPath: config.mapPath });
  store.assign('PERSON', SYNTH.name);
  store.assign('SECRET', SYNTH.secretValue, { restorable: false });
  await store.flush();
  assert.ok(fs.existsSync(config.mapPath));
  const raw = fs.readFileSync(config.mapPath, 'utf8');
  assert.ok(!raw.includes(SYNTH.secretValue), 'secret value must not be in the map');
  assert.ok(!raw.includes('MIIBVtest-only'));
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  const secretEntry = Object.values(parsed.entries).find((entry) => entry.category === 'SECRET');
  assert.equal(secretEntry.value, null);
  assert.equal(secretEntry.token, 'SECRET_1');
  const leftovers = fs.readdirSync(path.dirname(config.mapPath)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('a corrupt token map fails closed instead of silently resetting', async () => {
  const { config } = makeRuntimeConfig();
  fs.writeFileSync(config.mapPath, '{not json');
  await assert.rejects(() => TokenStore.open({ mapPath: config.mapPath }), /token map/);
});
