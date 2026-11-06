import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNTH,
  canaryBody,
  makeRuntimeConfig,
  startFakeUpstream,
  startProxy,
  postResponses,
  jsonBody,
  assertNoSensitiveBytes,
  readAudit,
  sse,
} from './helpers.js';

test('canary: no synthetic identity, secret or private filename reaches upstream', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'ok' } },
      { event: 'done', data: '[DONE]' },
    ]));
  });
  t.after(() => fake.close());

  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const body = canaryBody();
  const authorization = 'Bearer test-authorization-not-real';
  const response = await postResponses(proxy.url, body, {
    authorization,
    'x-tbh-contributor-mode': '0',
    'x-client-id': 'client-test',
    'x-tbh-session': 'tbh-session-test',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    'user-agent': 'Muse-Code-Test/1.0',
  });
  assert.equal(response.status, 200);

  assert.equal(fake.requests.length, 1);
  const record = fake.requests[0];
  const raw = record.body.toString('utf8');
  assertNoSensitiveBytes(raw);

  // Headers that must be forwarded verbatim, and ones that must not go up.
  assert.equal(record.headers.authorization, authorization);
  assert.equal(record.headers['x-tbh-contributor-mode'], '0');
  assert.equal(record.headers['x-client-id'], 'client-test');
  assert.equal(record.headers['x-tbh-session'], 'tbh-session-test');
  assert.equal(record.headers['accept-encoding'], undefined);

  const received = JSON.parse(raw);
  assert.equal(received.model, body.model);
  assert.equal(received.prompt_cache_key, body.prompt_cache_key);
  assert.equal(received.max_output_tokens, body.max_output_tokens);
  assert.equal(received.include[0], body.include[0]);

  // Opaque content passes through byte-for-byte.
  const reasoning = received.input.find((item) => item.type === 'reasoning');
  assert.equal(reasoning.encrypted_content, 'OPAQUE-ENCRYPTED-CONTENT-XYZ');

  // Attachments become withheld text parts.
  const message = received.input.find((item) => item.type === 'message');
  assert.deepEqual(message.content[1], { type: 'input_text', text: '[attachment withheld by metaveil]' });

  // The workspace is readable through the alias; sibling home paths are tokens.
  assert.match(received.instructions, /C:\\Users\\dev\\workspace/);
  assert.match(received.instructions, /LOCAL_PATH_1/);
  assert.ok(!/tax_return/.test(received.instructions));

  // Tool descriptions and nested tool schema strings were walked too.
  assert.match(received.tools[0].tools[0].description, /PERSON_1/);
  assert.match(received.tools[0].tools[0].parameters.properties.path.description, /LOCAL_PATH_1/);
  assert.match(received.tools[1].description, /TERM_1/);
  assert.match(received.input[2].output, /C:\\Users\\dev\\LOCAL_PATH_/);

  // Unknown item types are still walked.
  const mystery = received.input.find((item) => item.type === 'mystery_item');
  assert.match(JSON.stringify(mystery), /PERSON_1/);
  assert.ok(!/sampleuser|tax_return/i.test(JSON.stringify(mystery)));

  const audit = readAudit(config.auditPath);
  const auditText = JSON.stringify(audit).toLowerCase();
  for (const value of [SYNTH.name, SYNTH.username, SYNTH.email, SYNTH.hostname, SYNTH.term, SYNTH.ssn, SYNTH.phone, SYNTH.card, SYNTH.awsKey, SYNTH.jwt, SYNTH.secretValue, SYNTH.filename, 'MIIBVtest-only', authorization]) {
    assert.ok(!auditText.includes(value.toLowerCase()), `audit leaked ${value}`);
  }
  const categories = new Set(audit.map((entry) => entry.category));
  for (const expected of ['PERSON', 'EMAIL', 'USERNAME', 'HOST', 'TERM', 'SECRET', 'LOCAL_PATH', 'ATTACHMENT', 'UNKNOWN_ITEM_TYPE']) {
    assert.ok(categories.has(expected), `missing audit category ${expected}`);
  }
  assert.ok(audit.every((entry) => typeof entry.requestId === 'string' && entry.requestId.length > 0));
  assert.ok(audit.every((entry) => entry.byteOffset === undefined || Number.isInteger(entry.byteOffset)));
});
