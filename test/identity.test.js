import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { TokenStore } from '../src/token-store.js';
import { createDetectors } from '../src/detectors/index.js';
import { createPipeline } from '../src/pipeline.js';
import { createRedactor } from '../src/redact.js';
import { NullAuditLog } from '../src/audit.js';
import { makeRuntimeConfig } from './helpers.js';

async function makeRedactor(overrides = {}) {
  const { config } = makeRuntimeConfig(overrides);
  const store = await TokenStore.open({ mapPath: config.mapPath, persist: false });
  const pipeline = createPipeline({ config, detectors: createDetectors(config) });
  const redactor = createRedactor({ config, store, pipeline, audit: new NullAuditLog() });
  return { redactor, store, config };
}

test('identity dictionary uses typed, word-boundary tokens', async () => {
  const { redactor } = await makeRedactor();
  const text = 'Avery Quill (sampleuser) avery.quill@example.test on sampleuser-laptop wrote Bluefin Cipher.';
  const output = await redactor.redactText(text, { requestId: 'identity' });
  assert.match(output, /PERSON_1/);
  assert.match(output, /USERNAME_1/);
  assert.match(output, /EMAIL_1/);
  assert.match(output, /HOST_1/);
  assert.match(output, /TERM_1/);
  assert.ok(!/avery|sampleuser|bluefin/i.test(output));
});

test('final verification redacts a configured username inside a larger identifier', async () => {
  const { redactor } = await makeRedactor();
  const output = await redactor.redactText('sampleuseren sampleuser_suffix prefix_sampleuser', { requestId: 'identity' });
  assert.ok(!output.includes('sampleuser'));
  assert.match(output, /USERNAME_1/);
});

test('the Windows account name inside longer unrecognized paths is still matched', async () => {
  const { redactor } = await makeRedactor();
  const output = await redactor.redactText(String.raw`D:\Profiles\sampleuser\data.bin`, { requestId: 'identity' });
  assert.equal(output, String.raw`D:\Profiles\USERNAME_1\data.bin`);
});

test('the whole name wins over its first-name/longer-form overlap', async () => {
  const { redactor } = await makeRedactor({ identity: { names: ['Avery Quill', 'Avery'] } });
  const output = await redactor.redactText('Avery Quill and Avery', { requestId: 'identity' });
  assert.equal(output, 'PERSON_1 and PERSON_2');
});

test('matching is case-insensitive but restoration keeps the configured form', async () => {
  const { redactor, store } = await makeRedactor();
  const output = await redactor.redactText('avery quill AVERY QUill', { requestId: 'identity' });
  assert.equal(output, 'PERSON_1 PERSON_1');
  assert.equal(store.restorableEntries().find((entry) => entry.token === 'PERSON_1').value, 'Avery Quill');
});

test('the same value gets the same token within a request and across store instances', async () => {
  const { config } = makeRuntimeConfig();
  const first = await TokenStore.open({ mapPath: config.mapPath });
  assert.equal(first.assign('PERSON', 'Avery Quill'), 'PERSON_1');
  assert.equal(first.assign('PERSON', 'avery quill'), 'PERSON_1');
  await first.flush();
  const second = await TokenStore.open({ mapPath: config.mapPath, persist: false });
  assert.equal(second.assign('PERSON', 'Avery Quill'), 'PERSON_1');
});

test('config validation rejects a home directory without a drive path', () => {
  assert.throws(() => normalizeConfig({ homeDir: 'relative/path' }), /homeDir/);
});
