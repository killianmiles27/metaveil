import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevDetector } from '../src/pipeline.js';
import {
  SYNTH,
  makeRuntimeConfig,
  startFakeUpstream,
  startProxy,
  postResponses,
  request,
  readAudit,
} from './helpers.js';

test('a path outside the allowlist gets a local 403 and zero upstream requests', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200);
    res.end('{}');
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  for (const [method, path] of [
    ['POST', '/v1/chat/completions'],
    ['GET', '/v1/responses'],
    ['POST', '/muse-code/models'],
    ['DELETE', '/muse-code/models'],
    ['GET', '/'],
  ]) {
    const response = await request(`${proxy.url}${path}`, { method });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.equal(fake.requests.length, 0);
  const blocked = readAudit(config.auditPath).filter((entry) => entry.category === 'BLOCKED_PATH');
  assert.equal(blocked.length, 5);
  assert.ok(blocked.every((entry) => entry.action === 'blocked'));
});

test('a body over the configured limit gets 413 and is not forwarded', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200);
    res.end('{}');
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url, maxBodyBytes: 200 });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, {
    model: 'muse-code-test',
    input: [{ type: 'message', role: 'user', content: 'x'.repeat(1000) }],
  }, { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 413);
  assert.equal(fake.requests.length, 0);
});

test('invalid JSON is rejected locally', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200);
    res.end('{}');
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const response = await request(`${proxy.url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"model":',
  });
  assert.equal(response.status, 400);
  assert.equal(fake.requests.length, 0);
});

test('a remote detector failure under the block policy returns 5xx and forwards nothing', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200);
    res.end('{}');
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url, detectorFailure: 'block' });
  const proxy = await startProxy(config, {
    remoteDetector: createJevDetector({ enabled: true, async scan() { throw new Error('boom'); } }),
  });
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, {
    model: 'muse-code-test',
    instructions: `${SYNTH.name} ${SYNTH.home}`,
    input: [],
  }, { 'x-tbh-contributor-mode': '0' });
  assert.ok(response.status >= 500 && response.status < 600, `status ${response.status}`);
  assert.equal(fake.requests.length, 0);
});

test('an internal redaction exception fails closed with zero upstream requests', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200);
    res.end('{}');
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config, {
    redactor: {
      async redactBody() { throw new Error('internal explosion'); },
    },
  });
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, {
    model: 'muse-code-test',
    instructions: SYNTH.name,
    input: [],
  }, { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 502);
  assert.equal(fake.requests.length, 0);
  assert.ok(!response.body.includes(SYNTH.name));
});

test('the default withhold policy replaces a failed remote chunk but forwards nothing original', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200);
    res.end('{}');
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config, {
    remoteDetector: createJevDetector({ enabled: true, async scan() { throw new Error('boom'); } }),
  });
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, {
    model: 'muse-code-test',
    instructions: `${SYNTH.name} ${SYNTH.home}`,
    input: [],
  }, { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  assert.equal(fake.requests.length, 1);
  const received = JSON.parse(fake.requests[0].body.toString('utf8'));
  assert.match(received.instructions, /content withheld by metaveil/);
  assert.ok(!received.instructions.includes(SYNTH.name));
  assert.ok(!received.instructions.includes(SYNTH.home));
});

test('a local detector exception is a hard pipeline error even under the default policy', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200);
    res.end('{}');
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config, {
    extraDetectors: [{ name: 'local-bug', async scan() { throw new Error('boom'); } }],
  });
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, {
    model: 'muse-code-test',
    instructions: `${SYNTH.name} ${SYNTH.home}`,
    input: [],
  }, { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 502);
  assert.equal(fake.requests.length, 0);
});
