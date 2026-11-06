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

function roundTripBody() {
  const args = JSON.stringify({
    path: `${SYNTH.home}\\projects\\metaveil\\src\\index.js`,
    download: `${SYNTH.home}\\Downloads\\${SYNTH.filename}`,
    name: SYNTH.name,
  });
  return {
    model: 'muse-code-test',
    input: [
      { type: 'message', role: 'user', content: 'edit the file' },
      { type: 'function_call', call_id: 'call_prev', name: 'edit_file', arguments: args },
    ],
    stream: true,
  };
}

function upstreamArgs(record) {
  const body = JSON.parse(record.body.toString('utf8'));
  return body.input.find((item) => item.type === 'function_call').arguments;
}

test('file-edit arguments round trip to the real Windows path in a stream', async (t) => {
  const fake = await startFakeUpstream(async (req, res, record) => {
    const args = upstreamArgs(record);
    const split = Math.floor(args.length / 2);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'edit_file', arguments: '' },
        },
      },
      {
        event: 'response.function_call_arguments.delta',
        data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: args.slice(0, split) },
      },
      {
        event: 'response.function_call_arguments.delta',
        data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: args.slice(split) },
      },
      {
        event: 'response.function_call_arguments.done',
        data: { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: args },
      },
      { event: 'done', data: '[DONE]' },
    ]));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const response = await postResponses(proxy.url, roundTripBody(), { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const upstream = upstreamArgs(fake.requests[0]);
  assert.ok(!upstream.includes('sampleuser'));
  assert.match(upstream, /LOCAL_PATH_/);

  const events = parseSse(response.body);
  const streamed = events.map((event) => event.object?.delta ?? '').join('');
  const parsed = JSON.parse(streamed);
  assert.equal(parsed.path, `${SYNTH.home}\\projects\\metaveil\\src\\index.js`);
  assert.equal(parsed.download, `${SYNTH.home}\\Downloads\\${SYNTH.filename}`);
  assert.equal(parsed.name, SYNTH.name);
});

test('file-edit arguments round trip in a non-streaming JSON response', async (t) => {
  const fake = await startFakeUpstream(async (req, res, record) => {
    const args = upstreamArgs(record);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'resp_1',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `done by ${SYNTH.name}` }] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'edit_file', arguments: args },
      ],
    }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const body = roundTripBody();
  body.stream = false;
  const response = await postResponses(proxy.url, body, { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const parsed = JSON.parse(response.body);
  const call = parsed.output.find((item) => item.type === 'function_call');
  const args = JSON.parse(call.arguments);
  assert.equal(args.path, `${SYNTH.home}\\projects\\metaveil\\src\\index.js`);
  assert.equal(args.download, `${SYNTH.home}\\Downloads\\${SYNTH.filename}`);
  assert.equal(args.name, SYNTH.name);
  assert.match(parsed.output[0].content[0].text, /Avery Quill/);
});
