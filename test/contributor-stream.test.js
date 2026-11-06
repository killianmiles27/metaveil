import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNTH,
  makeRuntimeConfig,
  startFakeUpstream,
  startProxy,
  postResponses,
  parseSse,
  readAudit,
  sse,
  contributorPreamble,
} from './helpers.js';

function responseForCall({ split, args, toolName }) {
  return sse([
    {
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: toolName, arguments: '' },
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
    {
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: toolName, arguments: args }],
        },
      },
    },
    { event: 'done', data: '[DONE]' },
  ]);
}

test('a denied function call is held and blocked at every argument split boundary', async (t) => {
  const args = JSON.stringify({ command: 'Get-Clipboard' });
  const fake = await startFakeUpstream(async (req, res, record) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(responseForCall({ split: record.index % (args.length + 1), args, toolName: 'computer_use' }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  for (let split = 0; split <= args.length; split += 1) {
    const response = await postResponses(
      proxy.url,
      { model: 'muse-code-test', input: [], instructions: contributorPreamble(), stream: true },
      { 'x-tbh-contributor-mode': '1' },
    );
    assert.equal(response.status, 200, `split ${split}`);
    assert.ok(!response.body.includes('Get-Clipboard'), `arguments leaked at split ${split}`);
    assert.ok(!response.body.includes('take_screenshot'), `arguments leaked at split ${split}`);
    assert.ok(!response.body.includes('computer_use'), `tool name leaked at split ${split}`);
    assert.ok(!response.body.includes('event: error'), `an error makes Muse retry, at split ${split}`);
    const events = parseSse(response.body);
    const done = events.find((event) => event.object?.type === 'response.function_call_arguments.done');
    assert.equal(JSON.parse(done.object.arguments).path, '.metaveil-blocked/tool', `split ${split}`);
    assert.ok(events.some((event) => event.object?.type === 'response.completed'), `split ${split}`);
  }

  const blocked = readAudit(config.auditPath).filter((entry) => entry.category === 'CONTRIBUTOR_BLOCKED_CALL');
  assert.equal(blocked.length, args.length + 1);
  assert.ok(blocked.every((entry) => entry.toolName === 'computer_use'));
  assert.ok(blocked.every((entry) => entry.reason === 'tool'));
});

test('an allowed tool with a denied shell command is blocked at every split boundary', async (t) => {
  const args = JSON.stringify({ command: 'Get-Clipboard' });
  const fake = await startFakeUpstream(async (req, res, record) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(responseForCall({ split: record.index % (args.length + 1), args, toolName: 'powershell' }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  for (let split = 0; split <= args.length; split += 1) {
    const response = await postResponses(
      proxy.url,
      { model: 'muse-code-test', input: [], instructions: contributorPreamble(), stream: true },
      { 'x-tbh-contributor-mode': '1' },
    );
    assert.equal(response.status, 200, `split ${split}`);
    assert.ok(!response.body.includes('Get-Clipboard'), `command leaked at split ${split}`);
    assert.match(response.body, /\.metaveil-blocked\/command/, `missing stand-in at split ${split}`);
  }
  const blocked = readAudit(config.auditPath).filter((entry) => entry.category === 'CONTRIBUTOR_BLOCKED_CALL');
  assert.ok(blocked.length >= args.length + 1);
  assert.ok(blocked.every((entry) => entry.toolName === 'powershell'));
  assert.ok(blocked.some((entry) => entry.reason === 'command'));
});

test('an allowed function call is held until complete and then released intact', async (t) => {
  const args = JSON.stringify({ command: 'Get-ChildItem', path: 'src' });
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(responseForCall({ split: 7, args, toolName: 'powershell' }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());

  const response = await postResponses(
    proxy.url,
    { model: 'muse-code-test', input: [], instructions: contributorPreamble(), stream: true },
    { 'x-tbh-contributor-mode': '1' },
  );
  assert.equal(response.status, 200);
  assert.ok(!response.body.includes('event: error'));
  const events = parseSse(response.body);
  const joined = events.map((event) => event.object?.delta ?? '').join('');
  assert.equal(joined, args);
  assert.ok(events.some((event) => event.object?.type === 'response.completed'));
});

test('an allowed call still restores its split tokens after being released', async (t) => {
  const bs = String.fromCharCode(92);
  const args = JSON.stringify({ command: 'Get-ChildItem', path: SYNTH.alias + bs + 'LOCAL_PATH_1' });
  const split = 24;
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(responseForCall({ split, args, toolName: 'powershell' }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, {
    model: 'muse-code-test',
    instructions: `${contributorPreamble()}Avery Quill ${String.raw`C:\Users\sampleuser\Downloads\tax_return.pdf`}`,
    input: [],
    stream: true,
  }, { 'x-tbh-contributor-mode': '1' });
  assert.equal(response.status, 200);
  assert.ok(!response.body.includes('event: error'));
  const events = parseSse(response.body);
  const joined = events.map((event) => event.object?.delta ?? '').join('');
  const expected = JSON.stringify({ command: 'Get-ChildItem', path: SYNTH.home + bs + 'Downloads' + bs + 'tax_return.pdf' });
  assert.equal(joined, expected);
  const done = events.find((event) => event.object?.type === 'response.function_call_arguments.done');
  const parsed = JSON.parse(done.object.arguments);
  assert.equal(parsed.path, String.raw`C:\Users\sampleuser\Downloads\tax_return.pdf`);
});

test('no original call detail survives in a blocked stream, including the completed response', async (t) => {
  const args = JSON.stringify({ path: 'C:/Users/someone/Downloads/secret-plan.pdf' });
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(responseForCall({ split: 9, args, toolName: 'read_file' }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const response = await postResponses(
    proxy.url,
    { model: 'muse-code-test', input: [], instructions: contributorPreamble(), stream: true },
    { 'x-tbh-contributor-mode': '1' },
  );
  assert.ok(!response.body.includes('secret-plan'), 'original path reached Muse');
  const events = parseSse(response.body);
  const joined = events.filter((event) => event.object?.type === 'response.function_call_arguments.delta').map((event) => event.object.delta).join('');
  assert.equal(JSON.parse(joined).path, '.metaveil-blocked/path');
  const completed = events.find((event) => event.object?.type === 'response.completed');
  for (const item of completed.object.response?.output || []) {
    if (item.type === 'function_call') assert.equal(JSON.parse(item.arguments).path, '.metaveil-blocked/path');
  }
});
