import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNTH,
  makeRuntimeConfig,
  startFakeUpstream,
  startProxy,
  postResponses,
  jsonBody,
  parseSse,
} from './helpers.js';

async function runRedaction(t, instructions) {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, {
    model: 'muse-code-1.4.14',
    instructions,
    input: [],
    stream: false,
    prompt_cache_key: 'keep-me',
  }, { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const received = jsonBody({ body: fake.requests[0].body.toString('utf8') });
  return received.instructions;
}

const workspaceVariants = [
  String.raw`C:\Users\sampleuser\projects\metaveil\src\a.js`,
  String.raw`C:/Users/sampleuser/projects/metaveil/src/a.js`,
  String.raw`/c/Users/sampleuser/projects/metaveil/src/a.js`,
  String.raw`\\?\C:\Users\sampleuser\projects\metaveil\src\a.js`,
  String.raw`file:///C:/Users/sampleuser/projects/metaveil/src/a.js`,
  String.raw`C:\\Users\\sampleuser\\projects\\metaveil\\src\\a.js`,
  String.raw`c:/USERS/SAMPLEUSER/projects/metaveil/src/a.js`,
];

const downloadsVariants = [
  String.raw`C:\Users\sampleuser\Downloads\tax_return.pdf`,
  String.raw`C:/Users/sampleuser/Downloads/tax_return.pdf`,
  String.raw`/c/Users/sampleuser/Downloads/tax_return.pdf`,
  String.raw`\\?\C:\Users\sampleuser\Downloads\tax_return.pdf`,
  String.raw`file:///C:/Users/sampleuser/Downloads/tax_return.pdf`,
  String.raw`C:\\Users\\sampleuser\\Downloads\\tax_return.pdf`,
];

test('every home path variant is aliased and never sent to upstream', async (t) => {
  const text = workspaceVariants.map((value, index) => `variant ${index}: ${value}`).join('\n');
  const received = await runRedaction(t, text);
  assert.ok(!/sampleuser/i.test(received), `original account name leaked: ${received}`);
  for (const value of workspaceVariants) {
    assert.ok(!received.includes(value), `original variant leaked: ${value}`);
  }
  assert.match(received, /C:\\Users\\dev\\workspace\\src\\a\.js/);
  assert.ok(received.includes('workspace'), 'workspace tail should stay readable');
});

test('six path spellings of a Downloads file share one stable LOCAL_PATH token', async (t) => {
  const text = downloadsVariants.map((value, index) => `dl ${index}: ${value}`).join('\n');
  const received = await runRedaction(t, text);
  assert.ok(!/sampleuser/i.test(received));
  assert.ok(!received.includes('tax_return.pdf'), 'filename must not leak');
  assert.equal((received.match(/LOCAL_PATH_1/g) || []).length, downloadsVariants.length);
  assert.ok(!received.includes('LOCAL_PATH_2'), 'identical tails must share a token');
  assert.ok(received.includes(String.raw`C:\Users\dev`), 'alias must be visible');
});

test('workspace paths stay readable while sibling home paths are tokenized', async (t) => {
  const text = [
    String.raw`workspace C:\Users\sampleuser\projects\metaveil\src\index.js`,
    String.raw`downloads C:\Users\sampleuser\Downloads\tax_return.pdf`,
    String.raw`desktop C:\Users\sampleuser\Desktop\notes.txt`,
  ].join('\n');
  const received = await runRedaction(t, text);
  assert.match(received, /workspace C:\\Users\\dev\\workspace\\src\\index\.js/);
  assert.match(received, /downloads C:\\Users\\dev\\LOCAL_PATH_1/);
  assert.match(received, /desktop C:\\Users\\dev\\LOCAL_PATH_2/);
  assert.ok(!received.includes('tax_return.pdf'));
  assert.ok(!received.includes('notes.txt'));
});

test('a home-prefix lookalike is not path-aliased but its username is scrubbed', async (t) => {
  const received = await runRedaction(t, String.raw`C:\Users\sampleuser2\Downloads\other.txt`);
  assert.ok(!received.includes('sampleuser'));
  assert.match(received, /USERNAME_1/);
});

test('a workspace outside home maps to workspaceAlias and restores', async (t) => {
  const fake = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: response.output_text.delta\ndata: ' + JSON.stringify({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: String.raw`C:\Users\dev\ws\src\a.js`,
    }) + '\n\nevent: done\ndata: [DONE]\n\n');
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({
    upstream: fake.url,
    homeDir: SYNTH.home,
    workspaceRoot: String.raw`D:\work\demo`,
    workspaceAlias: String.raw`C:\Users\dev\ws`,
  });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const response = await postResponses(proxy.url, {
    model: 'muse-code-test',
    instructions: String.raw`workspace D:\work\demo\src\a.js`,
    input: [],
    stream: true,
  }, { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const received = JSON.parse(fake.requests[0].body.toString('utf8'));
  assert.equal(received.instructions, String.raw`workspace C:\Users\dev\ws\src\a.js`);
  assert.ok(!received.instructions.includes('D:\work'));
  const events = parseSse(response.body);
  assert.equal(
    events.map((entry) => entry.object?.delta ?? '').join(''),
    ['D:', 'work', 'demo', 'src', 'a.js'].join(String.fromCharCode(92)),
  );
});
