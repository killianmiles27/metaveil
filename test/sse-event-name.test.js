import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRuntimeConfig,
  startFakeUpstream,
  startProxy,
  postResponses,
  sse,
  contributorPreamble,
} from './helpers.js';

function callFrames(name, args, { withEventLine = true } = {}) {
  const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name, arguments: args, status: 'completed' };
  const frame = (event, data) => (withEventLine ? { event, data } : { data });
  return sse([
    frame('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }),
    frame('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 0, delta: args }),
    frame('response.function_call_arguments.done', { item_id: 'fc_1', output_index: 0, arguments: args }),
    frame('response.output_item.done', { output_index: 0, item }),
    frame('response.completed', { response: { id: 'resp_1', output: [item] } }),
  ]);
}

async function setup(t, body) {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  return { proxy, config };
}

test('frames named only by the event line get their aliases restored', async (t) => {
  const args = JSON.stringify({ path: 'C:\\Users\\dev\\notes.txt' });
  const { proxy, config } = await setup(t, callFrames('read_file', args));
  const response = await postResponses(
    proxy.url,
    { model: 'muse-code-test', input: [], instructions: '', stream: true },
    { 'x-tbh-contributor-mode': '0' },
  );
  assert.equal(response.status, 200);
  assert.ok(!response.body.includes('Users\\\\\\\\dev'), 'alias must not survive');
  const home = config.homeDir.replace(/\\/g, '\\\\\\\\');
  assert.ok(response.body.includes(home), 'real home path must be restored');
});

test('sequence numbers stay gapless when a short delta is held back', async (t) => {
  const args = JSON.stringify({ path: 'C:\\Users\\dev\\notes.txt' });
  const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: args };
  const { proxy } = await setup(t, sse([
    { event: 'response.created', data: { response: { id: 'r' }, sequence_number: 0 } },
    { event: 'response.function_call_arguments.delta', data: { item_id: 'fc_1', output_index: 0, delta: args, sequence_number: 1 } },
    { event: 'response.function_call_arguments.done', data: { item_id: 'fc_1', output_index: 0, arguments: args, sequence_number: 2 } },
    { event: 'response.completed', data: { response: { id: 'r', output: [item] }, sequence_number: 3 } },
    { data: '[DONE]' },
  ]));
  const response = await postResponses(
    proxy.url,
    { model: 'muse-code-test', input: [], instructions: '', stream: true },
    { 'x-tbh-contributor-mode': '0' },
  );
  const numbers = response.body.split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)).sequence_number);
  assert.deepEqual(numbers, numbers.map((_, index) => index));
  assert.ok(response.body.includes('data: [DONE]'), '[DONE] must still pass through');
});

test('a denied tool named only by the event line never reaches the client in contributor mode', async (t) => {
  const args = JSON.stringify({ command: 'Get-Clipboard' });
  const { proxy } = await setup(t, callFrames('computer_use', args));
  const response = await postResponses(
    proxy.url,
    { model: 'muse-code-test', input: [], instructions: contributorPreamble(), stream: true },
    { 'x-tbh-contributor-mode': '1' },
  );
  assert.ok(!response.body.includes('Get-Clipboard'), 'arguments must not reach the client');
});

test('a tool call frame with no name at all is dropped in contributor mode', async (t) => {
  const args = JSON.stringify({ command: 'Get-Clipboard' });
  const { proxy } = await setup(t, callFrames('computer_use', args, { withEventLine: false }));
  const response = await postResponses(
    proxy.url,
    { model: 'muse-code-test', input: [], instructions: contributorPreamble(), stream: true },
    { 'x-tbh-contributor-mode': '1' },
  );
  assert.ok(!response.body.includes('Get-Clipboard'), 'arguments must not reach the client');
});
