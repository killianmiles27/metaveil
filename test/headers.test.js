import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNTH,
  makeRuntimeConfig,
  startFakeUpstream,
  startProxy,
  postResponses,
  request,
  jsonBody,
  parseSse,
  sse,
} from './helpers.js';

const AUTH = 'Bearer header-test-token';

test('authorization, contributor mode, model and prompt_cache_key arrive unmodified', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [] }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const body = {
    model: 'muse-code-exact-model-name',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    instructions: 'hello',
    max_output_tokens: 77,
    store: false,
    stream: false,
    prompt_cache_key: 'exact-prompt-cache-key',
  };
  const response = await postResponses(proxy.url, body, {
    authorization: AUTH,
    'x-tbh-contributor-mode': '0',
    'x-tbh-extra': 'extra-value',
    'x-meta-ai-gateway-session-id': 'gateway-session-1',
  });
  assert.equal(response.status, 200);
  const record = fake.requests[0];
  assert.equal(record.headers.authorization, AUTH);
  assert.equal(record.headers['x-tbh-contributor-mode'], '0');
  assert.equal(record.headers['x-tbh-extra'], 'extra-value');
  assert.equal(record.headers['x-meta-ai-gateway-session-id'], 'gateway-session-1');
  assert.equal(record.headers['accept-encoding'], undefined);
  const received = JSON.parse(record.body.toString('utf8'));
  assert.equal(received.model, body.model);
  assert.equal(received.prompt_cache_key, body.prompt_cache_key);
  assert.equal(received.max_output_tokens, body.max_output_tokens);
});

test('upstream status codes and error text pass through with restoration only', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: `slow down; workspace ${SYNTH.alias}\\projects\\metaveil is busy`,
      },
    }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const response = await postResponses(proxy.url, {
    model: 'muse-code-test',
    input: [{ type: 'message', role: 'user', content: SYNTH.name }],
    stream: true,
  }, { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 429);
  const parsed = JSON.parse(response.body);
  assert.match(parsed.error.message, /C:\\Users\\sampleuser\\projects\\metaveil/);
  assert.ok(!parsed.error.message.includes('C:\\Users\\dev'));
});

test('the model catalog is forwarded as-is and healthz answers locally', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ id: 'muse-code' }] }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const health = await request(`${proxy.url}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);
  assert.equal(fake.requests.length, 0);

  const models = await request(`${proxy.url}/muse-code/models`, { headers: { authorization: AUTH } });
  assert.equal(models.status, 200);
  assert.deepEqual(JSON.parse(models.body), { models: [{ id: 'muse-code' }] });
  assert.equal(fake.requests[0].headers.authorization, AUTH);
});

test('server binds loopback only', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200);
    res.end('{}');
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  assert.equal(proxy.server.address().address, '127.0.0.1');
});

test('SSE error events do not get contributor treatment when the policy is off', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([
      { event: 'error', data: { type: 'error', error: { type: 'upstream_error', message: `see ${SYNTH.alias}\\projects\\metaveil` } } },
    ]));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, {
    model: 'muse-code-test',
    input: [],
    stream: true,
  }, { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const events = parseSse(response.body);
  assert.ok(events.some((event) => event.event === 'error'));
  assert.match(JSON.stringify(events), /C:\\\\Users\\\\sampleuser/);
});
