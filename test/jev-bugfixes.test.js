import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNTH,
  makeRuntimeConfig,
  startFakeUpstream,
  startProxy,
  postResponses,
  parseSse,
  sse,
} from './helpers.js';

const BS = String.fromCharCode(92);
const WORKSPACE_ALIAS = String.raw`C:\Users\dev\workspace`;

function body(instructions, input = []) {
  return { model: 'muse-code-test', instructions, input, stream: false };
}

function toolSse(aliasPath) {
  const args = JSON.stringify({ path: aliasPath });
  const split = Math.floor(args.length / 2);
  const item = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: args, status: 'completed' };
  const response = {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    output: [item],
  };
  return sse([
    { event: 'response.created', data: { type: 'response.created', response: { ...response, status: 'in_progress', output: [] }, sequence_number: 0 } },
    { event: 'response.in_progress', data: { type: 'response.in_progress', response: { ...response, status: 'in_progress', output: [] }, sequence_number: 1 } },
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' }, sequence_number: 2 } },
    { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: args.slice(0, split), sequence_number: 3 } },
    { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: args.slice(split), sequence_number: 3 } },
    { event: 'response.function_call_arguments.done', data: { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: args, sequence_number: 4 } },
    { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 0, item, sequence_number: 5 } },
    { event: 'response.completed', data: { type: 'response.completed', response, sequence_number: 6 } },
    { event: 'done', data: '[DONE]' },
  ]);
}

function textSse(text) {
  const item = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, refusal: null, annotations: [], logprobs: [] }] };
  const response = { id: 'resp_1', object: 'response', status: 'completed', output: [item] };
  return sse([
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] }, sequence_number: 2 } },
    { event: 'response.content_part.added', data: { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', refusal: null, annotations: [], logprobs: [] }, sequence_number: 3 } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text, sequence_number: 4 } },
    { event: 'response.output_text.done', data: { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text, sequence_number: 5 } },
    { event: 'response.content_part.done', data: { type: 'response.content_part.done', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text, refusal: null, annotations: [], logprobs: [] }, sequence_number: 6 } },
    { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 0, item, sequence_number: 7 } },
    { event: 'response.completed', data: { type: 'response.completed', response, sequence_number: 8 } },
    { event: 'done', data: '[DONE]' },
  ]);
}

test('nested JSON-in-string identity, host and path are fully redacted', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [] }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url, workspaceRoot: null });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const inner = JSON.stringify({
    output: `muse-sbx-r1\n${SYNTH.username}\n${SYNTH.hostname}\r\n${SYNTH.home}\\Downloads\\${SYNTH.filename}`,
  });
  const response = await postResponses(proxy.url, body('', [
    { type: 'function_call_output', call_id: 'call_1', output: inner },
  ]), { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const raw = fake.requests[0].body.toString('utf8');
  for (const value of [SYNTH.username, SYNTH.hostname, 'muse-sbx-r1', SYNTH.filename, SYNTH.home]) {
    assert.ok(!raw.toLowerCase().includes(value.toLowerCase()), `leaked ${value}`);
  }
  const received = JSON.parse(raw);
  const nested = JSON.parse(received.input[0].output);
  assert.match(nested.output, /USERNAME_1/);
  assert.match(nested.output, /HOST_1/);
  assert.match(nested.output, /SECRET_1/);
  assert.match(nested.output, /LOCAL_PATH_1/);
});

test('literal escape sequences still act as identity and path boundaries', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [] }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url, workspaceRoot: null });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const literal = [
    `muse-sbx-r1\\n${SYNTH.username}\\n${SYNTH.hostname}\\r\\n${SYNTH.home}\\Downloads\\${SYNTH.filename}`,
    `\\r\\n${SYNTH.home}\\Desktop\\notes.txt`,
  ].join('');
  const response = await postResponses(proxy.url, body(literal), { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const raw = fake.requests[0].body.toString('utf8');
  for (const value of [SYNTH.username, SYNTH.hostname, 'muse-sbx-r1', SYNTH.filename, 'notes.txt', SYNTH.home]) {
    assert.ok(!raw.toLowerCase().includes(value.toLowerCase()), `leaked ${value}`);
  }
  assert.match(raw, /LOCAL_PATH_1/);
  assert.match(raw, /LOCAL_PATH_2/);
});

test('percent-encoded identities and paths are redacted', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [] }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url, workspaceRoot: null });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const encoded = `Avery%20Quill C%3A%5CUsers%5Csampleuser%5CDownloads%5C${SYNTH.filename}`;
  const response = await postResponses(proxy.url, body(encoded), { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const raw = fake.requests[0].body.toString('utf8');
  assert.ok(!raw.includes(SYNTH.name));
  assert.ok(!raw.toLowerCase().includes(SYNTH.username.toLowerCase()));
  assert.ok(!raw.includes(SYNTH.filename));
  assert.ok(!raw.includes('C%3A%5CUsers%5Csampleuser'));
  assert.match(raw, /PERSON_1/);
});

test('workspaceAlias round trips through exact responses SSE frames', async (t) => {
  const realRoot = String.raw`C:\Users\sampleuser\projects\roundtrip`;
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(toolSse(`${WORKSPACE_ALIAS}\\notes.txt`));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url, workspaceRoot: null });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const response = await postResponses(proxy.url, body(`Workspace root: ${realRoot}\nhello`, []), {
    'x-tbh-contributor-mode': '0',
  });
  assert.equal(response.status, 200);
  const forwarded = JSON.parse(fake.requests[0].body.toString('utf8'));
  assert.ok(forwarded.instructions.includes(WORKSPACE_ALIAS));
  assert.ok(!forwarded.instructions.includes(realRoot));
  const events = parseSse(response.body);
  const done = events.find((event) => event.object?.type === 'response.function_call_arguments.done');
  assert.ok(done);
  assert.deepEqual(JSON.parse(done.object.arguments), { path: `${realRoot}\\notes.txt` });
  const completed = events.find((event) => event.object?.type === 'response.completed');
  assert.deepEqual(JSON.parse(completed.object.response.output[0].arguments), { path: `${realRoot}\\notes.txt` });
});

test('workspaceAlias round trips through exact output_text SSE frames', async (t) => {
  const realRoot = String.raw`C:\Users\sampleuser\projects\roundtrip-text`;
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(textSse(`edited ${WORKSPACE_ALIAS}\\notes.txt`));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url, workspaceRoot: null });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, body(`Workspace root: ${realRoot}\nhello`, []), {
    'x-tbh-contributor-mode': '0',
  });
  assert.equal(response.status, 200);
  const events = parseSse(response.body);
  const delta = events.filter((event) => event.object?.type === 'response.output_text.delta')
    .map((event) => event.object.delta)
    .join('');
  assert.equal(delta, `edited ${realRoot}\\notes.txt`);
  const done = events.find((event) => event.object?.type === 'response.output_text.done');
  assert.equal(done.object.text, `edited ${realRoot}\\notes.txt`);
});

test('concurrent sessions with different workspace roots restore independently', async (t) => {
  const alpha = String.raw`C:\Users\sampleuser\projects\alpha`;
  const beta = String.raw`C:\Users\sampleuser\projects\beta`;
  const fake = await startFakeUpstream(async (req, res, record) => {
    const bodyJson = JSON.parse(record.body.toString('utf8'));
    const text = bodyJson.instructions.includes('alpha') ? `${WORKSPACE_ALIAS}\\alpha.txt` : `${WORKSPACE_ALIAS}\\beta.txt`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(textSse(text));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url, workspaceRoot: null });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const [alphaResponse, betaResponse] = await Promise.all([
    postResponses(proxy.url, body(`Workspace root: ${alpha}\nalpha`, []), { 'x-tbh-contributor-mode': '0' }),
    postResponses(proxy.url, body(`Workspace root: ${beta}\nbeta`, []), { 'x-tbh-contributor-mode': '0' }),
  ]);
  assert.equal(alphaResponse.status, 200);
  assert.equal(betaResponse.status, 200);
  const alphaText = parseSse(alphaResponse.body)
    .filter((event) => event.object?.type === 'response.output_text.delta')
    .map((event) => event.object.delta)
    .join('');
  const betaText = parseSse(betaResponse.body)
    .filter((event) => event.object?.type === 'response.output_text.delta')
    .map((event) => event.object.delta)
    .join('');
  assert.equal(alphaText, `${alpha}\\alpha.txt`);
  assert.equal(betaText, `${beta}\\beta.txt`);
  for (const request of fake.requests) {
    const forwarded = JSON.parse(request.body.toString('utf8'));
    assert.ok(forwarded.instructions.includes(WORKSPACE_ALIAS));
    assert.ok(!forwarded.instructions.includes(alpha));
    assert.ok(!forwarded.instructions.includes(beta));
  }
});

test('sandbox account and group names are one-way redacted', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [] }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url, workspaceRoot: null });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const text = `muse-sbx-r1 DESKTOP-ABC${BS}${'MuseSandboxUsers'} CodexSandboxUsers`;
  const response = await postResponses(proxy.url, body(text), { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const raw = fake.requests[0].body.toString('utf8');
  assert.ok(!raw.includes('muse-sbx-r1'));
  assert.ok(!raw.includes('MuseSandboxUsers'));
  assert.ok(!raw.includes('CodexSandboxUsers'));
  assert.ok(!raw.includes('DESKTOP-ABC'));
  assert.match(raw, /SECRET_/);
});

test('short configured values keep word-boundary matching in the final pass', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [] }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({
    upstream: fake.url,
    workspaceRoot: null,
    identity: { usernames: ['abc'] },
  });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, body('xabcx abc'), { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const raw = fake.requests[0].body.toString('utf8');
  assert.ok(raw.includes('xabcx'));
  assert.ok(!raw.includes(' abc'));
});
