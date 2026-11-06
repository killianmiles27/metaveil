import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenStore } from '../src/token-store.js';
import { createDetectors } from '../src/detectors/index.js';
import { createPipeline } from '../src/pipeline.js';
import { createRedactor } from '../src/redact.js';
import { NullAuditLog } from '../src/audit.js';
import { makeRuntimeConfig, SYNTH } from './helpers.js';

async function redactorFor(overrides = {}) {
  const { config } = makeRuntimeConfig(overrides);
  const store = await TokenStore.open({ mapPath: config.mapPath, persist: false });
  const pipeline = createPipeline({ config, detectors: createDetectors(config) });
  return createRedactor({ config, store, pipeline, audit: new NullAuditLog() });
}

test('secret patterns become one-way SECRET tokens', async () => {
  const redactor = await redactorFor();
  const text = [
    `ssn ${SYNTH.ssn}`,
    `phone ${SYNTH.phone}`,
    `card ${SYNTH.card}`,
    `ip 192.168.10.25`,
    `aws ${SYNTH.awsKey}`,
    `jwt ${SYNTH.jwt}`,
    `env API_KEY=${SYNTH.secretValue}`,
    SYNTH.privateKey,
  ].join('\n');
  const output = await redactor.redactText(text, { requestId: 'secrets' });
  assert.ok(!output.includes(SYNTH.ssn));
  assert.ok(!output.includes(SYNTH.phone));
  assert.ok(!output.includes(SYNTH.card));
  assert.ok(!output.includes('192.168.10.25'));
  assert.ok(!output.includes(SYNTH.awsKey));
  assert.ok(!output.includes(SYNTH.jwt));
  assert.ok(!output.includes(SYNTH.secretValue));
  assert.ok(!output.includes('MIIBVtest-only'));
  assert.ok((output.match(/SECRET_\d+/g) || []).length >= 7);
});

test('loopback IPv4 is left alone and version-like dotted quads are not treated as IPs', async () => {
  const redactor = await redactorFor();
  const text = 'localhost 127.0.0.1 version 1.2.3.4 and "version": "1.2.3.4"';
  const output = await redactor.redactText(text, { requestId: 'ip' });
  assert.equal(output, text);
});

test('ordinary code does not look like a secret', async () => {
  const redactor = await redactorFor();
  const text = [
    'commit 3f786850e387550fdab836ed7e6dc881de23001b',
    'base64 dGVzdCBkYXRhIHNhbXBsZQ==',
    'uuid 123e4567-e89b-12d3-a456-426614174000',
    'version 1.2.3',
    'semver ^1.2.3',
    "import { readFile } from 'node:fs/promises';",
    'color: #a1b2c3;',
    'doc address user@example.com',
    '{"version": "1.2.3.4"}',
  ].join('\n');
  const output = await redactor.redactText(text, { requestId: 'false-positive' });
  assert.equal(output, text);
});

test('high-entropy values are only treated as secrets next to secret-ish keys', async () => {
  const redactor = await redactorFor();
  const value = 'Xk9fQ2mZ7pL4vN8sR1tW6yB3cD5eH0jK';
  const secretText = `client_secret: "${value}"`;
  const ordinary = `note: "${value}"`;
  assert.match(await redactor.redactText(secretText, { requestId: 'entropy' }), /SECRET_\d+/);
  assert.equal(await redactor.redactText(ordinary, { requestId: 'entropy' }), ordinary);
});

test('placeholder values in .env-style assignments are not treated as secrets', async () => {
  const redactor = await redactorFor();
  const text = [
    'API_KEY=${API_KEY}',
    'PASSWORD=changeme',
    'TOKEN=<your-token-here>',
    'SECRET=example',
  ].join('\n');
  assert.equal(await redactor.redactText(text, { requestId: 'env' }), text);
});
