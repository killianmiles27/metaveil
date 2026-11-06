import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  SYNTH,
  makeRuntimeConfig,
  startFakeUpstream,
  startProxy,
  postResponses,
  parseSse,
  sse,
} from './helpers.js';

function requestWithSecrets() {
  return {
    model: 'muse-code-test',
    instructions: `${SYNTH.name} ${SYNTH.home}\\Downloads\\${SYNTH.filename} API_KEY=${SYNTH.secretValue}`,
    input: [],
    stream: true,
  };
}

test('gzip SSE responses are decoded, transformed and sent without content-encoding', async (t) => {
  const fake = await startFakeUpstream(async (req, res, record) => {
    const body = JSON.parse(record.body.toString('utf8'));
    assert.ok(body.instructions.includes('PERSON_1'));
    assert.ok(!body.instructions.includes(SYNTH.name));
    const payload = sse([
      {
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          delta: `hello PERSON_1 at C:\\Users\\dev\\LOCAL_PATH_1`,
        },
      },
      { event: 'done', data: '[DONE]' },
    ]);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'content-encoding': 'gzip',
    });
    res.end(zlib.gzipSync(Buffer.from(payload)));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const response = await postResponses(proxy.url, requestWithSecrets(), { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], undefined);
  const events = parseSse(response.body);
  const text = events.map((event) => event.object?.delta ?? '').join('');
  assert.equal(text, `hello ${SYNTH.name} at ${SYNTH.home}\\Downloads\\${SYNTH.filename}`);
  assert.ok(!text.includes(SYNTH.secretValue));
});

test('gzip JSON responses are decoded and restored', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    });
    res.end(zlib.gzipSync(Buffer.from(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: `workspace C:\\Users\\dev\\projects\\metaveil` }] }],
    }))));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, {
    model: 'muse-code-test',
    input: [],
    stream: false,
  }, { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.match(JSON.parse(response.body).output[0].content[0].text, /C:\\Users\\sampleuser\\projects\\metaveil/);
});

test('output_item added/done, arguments.done and completed are all restored', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'message',
            id: 'msg_1',
            content: [{ type: 'output_text', text: `intro PERSON_1 C:\\Users\\dev\\LOCAL_PATH_1` }],
          },
        },
      },
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'msg_1',
            content: [{ type: 'output_text', text: `intro PERSON_1 C:\\Users\\dev\\LOCAL_PATH_1` }],
          },
        },
      },
      {
        event: 'response.function_call_arguments.done',
        data: {
          type: 'response.function_call_arguments.done',
          item_id: 'fc_1',
          output_index: 1,
          arguments: `{"path":"C:\\\\Users\\\\dev\\\\LOCAL_PATH_1","who":"PERSON_1"}`,
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            output: [
              {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'edit_file',
                arguments: `{"path":"C:\\\\Users\\\\dev\\\\LOCAL_PATH_1","who":"PERSON_1"}`,
              },
            ],
          },
        },
      },
      { event: 'done', data: '[DONE]' },
    ]));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const response = await postResponses(proxy.url, requestWithSecrets(), { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const events = parseSse(response.body);
  const added = events.find((event) => event.object?.type === 'response.output_item.added');
  assert.equal(
    added.object.item.content[0].text,
    `intro ${SYNTH.name} C:\\Users\\sampleuser\\Downloads\\${SYNTH.filename}`,
  );
  const done = events.find((event) => event.object?.type === 'response.output_item.done');
  assert.match(done.object.item.content[0].text, /Avery Quill/);
  const argsDone = events.find((event) => event.object?.type === 'response.function_call_arguments.done');
  const doneArgs = JSON.parse(argsDone.object.arguments);
  assert.equal(doneArgs.path, `${SYNTH.home}\\Downloads\\${SYNTH.filename}`);
  assert.equal(doneArgs.who, SYNTH.name);
  const completed = events.find((event) => event.object?.type === 'response.completed');
  const completedArgs = JSON.parse(completed.object.response.output[0].arguments);
  assert.equal(completedArgs.path, `${SYNTH.home}\\Downloads\\${SYNTH.filename}`);
  assert.equal(completedArgs.who, SYNTH.name);
});

test('SECRET tokens stay secret inside function-call arguments', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([
      {
        event: 'response.function_call_arguments.done',
        data: {
          type: 'response.function_call_arguments.done',
          item_id: 'fc_1',
          output_index: 0,
          arguments: '{"api":"SECRET_1","who":"PERSON_1"}',
        },
      },
      { event: 'done', data: '[DONE]' },
    ]));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, requestWithSecrets(), { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const events = parseSse(response.body);
  const argsDone = events.find((event) => event.object?.type === 'response.function_call_arguments.done');
  assert.equal(argsDone.object.arguments, `{"api":"SECRET_1","who":"${SYNTH.name}"}`);
  assert.ok(!response.body.includes(SYNTH.secretValue));
});

test('an SSE body without a content-type is recognized and transformed', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('event: response.output_text.delta\ndata: ' + JSON.stringify({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: String.raw`C:\Users\dev\projects\metaveil`,
    }) + '\n\nevent: done\ndata: [DONE]\n\n');
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, { model: 'muse-code-test', input: [], stream: true }, { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const events = parseSse(response.body);
  const text = events.map((event) => event.object?.delta ?? '').join('');
  assert.equal(text, String.raw`C:\Users\sampleuser\projects\metaveil`);
});

test('function_call item arguments in output_item events are restored', async (t) => {
  const bs = String.fromCharCode(92);
  const aliasArgs = JSON.stringify({ path: SYNTH.alias + bs + 'LOCAL_PATH_1', who: 'PERSON_1' });
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'edit_file',
            arguments: aliasArgs,
          },
        },
      },
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'edit_file',
            arguments: aliasArgs,
          },
        },
      },
      { event: 'done', data: '[DONE]' },
    ]));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, requestWithSecrets(), { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const events = parseSse(response.body);
  for (const name of ['response.output_item.added', 'response.output_item.done']) {
    const event = events.find((entry) => entry.object?.type === name);
    const args = JSON.parse(event.object.item.arguments);
    assert.equal(args.path, SYNTH.home + String.fromCharCode(92) + 'Downloads' + String.fromCharCode(92) + SYNTH.filename);
    assert.equal(args.who, SYNTH.name);
  }
});
