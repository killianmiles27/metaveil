import { isPublicWebArgs } from '../src/contributor.js';
import { evaluateFunctionCall } from '../src/contributor.js';
import { normalizeConfig } from '../src/config.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNTH,
  makeRuntimeConfig,
  startFakeUpstream,
  startProxy,
  postResponses,
  jsonBody,
  readAudit,
  contributorPreamble,
} from './helpers.js';

async function setup(t, handler = null) {
  const fake = await startFakeUpstream(handler || (async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output: [] }));
  }));
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  return { fake, config, proxy };
}

function bodyWithTools() {
  return {
    model: 'muse-code-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: `hello ${SYNTH.name}` },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
    ],
    instructions: [
      contributorPreamble().trim(),
      '<skill id="computer-use"><description>Drive the GUI with screenshots</description></skill>',
      '<skill id="coding"><description>Write and edit code</description></skill>',
    ].join('\n'),
    tools: [
      {
        type: 'namespace',
        name: 'computer',
        tools: [
          { type: 'function', name: 'computer_use', description: 'GUI control', parameters: { type: 'object', properties: {} } },
          { type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
        ],
      },
      { type: 'mcp', name: 'browser_navigate', server_label: 'browser' },
      { type: 'function', name: 'powershell', description: 'Managed shell', parameters: { type: 'object', properties: {} } },
      { type: 'function', name: 'send_gmail', description: 'Gmail', parameters: { type: 'object', properties: {} } },
    ],
    stream: false,
  };
}

test('missing contributor header is treated as ON and strips nested/MCP/plugin tools', async (t) => {
  const { fake, config, proxy } = await setup(t);
  const response = await postResponses(proxy.url, bodyWithTools());
  assert.equal(response.status, 200);
  assert.equal(fake.requests[0].headers['x-tbh-contributor-mode'], undefined);

  const received = JSON.parse(fake.requests[0].body.toString('utf8'));
  assert.equal(received.tools.length, 2);
  assert.equal(received.tools[0].tools.length, 1);
  assert.equal(received.tools[0].tools[0].name, 'read_file');
  assert.equal(received.tools[1].name, 'powershell');

  const audit = readAudit(config.auditPath);
  const stripped = audit.filter((entry) => entry.category === 'CONTRIBUTOR_TOOL');
  const names = stripped.map((entry) => entry.toolName);
  assert.deepEqual(names.sort(), ['browser_navigate', 'computer_use', 'send_gmail']);

  // Contributor mode has no setting to allow images.
  const content = received.input[0].content;
  assert.deepEqual(content[1], { type: 'input_text', text: '[attachment withheld by metaveil]' });
});

test('an unexpected contributor header value is also treated as ON', async (t) => {
  const { fake, proxy } = await setup(t);
  const response = await postResponses(proxy.url, bodyWithTools(), { 'x-tbh-contributor-mode': 'unexpected-value' });
  assert.equal(response.status, 200);
  assert.equal(fake.requests[0].headers['x-tbh-contributor-mode'], 'unexpected-value');
  const received = JSON.parse(fake.requests[0].body.toString('utf8'));
  assert.equal(received.tools.length, 2);
  assert.equal(received.tools[0].tools.length, 1);
});

test('exactly "0" turns the contributor policy off while redaction continues', async (t) => {
  const { fake, proxy } = await setup(t);
  const response = await postResponses(proxy.url, bodyWithTools(), { 'x-tbh-contributor-mode': '0' });
  assert.equal(response.status, 200);
  const received = JSON.parse(fake.requests[0].body.toString('utf8'));
  assert.equal(received.tools.length, 4);
  assert.equal(received.tools[0].tools.length, 2);
  assert.ok(!received.input[0].content[0].text.includes(SYNTH.name));
  assert.ok(received.instructions.includes('computer-use'));
});

test('denied skill blocks are removed before the request is forwarded', async (t) => {
  const { fake, config, proxy } = await setup(t);
  const response = await postResponses(proxy.url, bodyWithTools());
  assert.equal(response.status, 200);
  const received = JSON.parse(fake.requests[0].body.toString('utf8'));
  assert.ok(!received.instructions.includes('computer-use'));
  assert.ok(!received.instructions.includes('screenshots'));
  assert.ok(received.instructions.includes('coding'));
  assert.ok(received.instructions.includes('Write and edit code'));

  const skills = readAudit(config.auditPath).filter((entry) => entry.category === 'CONTRIBUTOR_SKILL');
  assert.equal(skills.length, 1);
  assert.equal(skills[0].pattern, 'computer-use');
});

test('a non-streaming response with a denied function call is replaced by an error', async (t) => {
  const { fake, config, proxy } = await setup(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'resp_1',
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'computer_use',
          arguments: '{"action":"take_screenshot"}',
        },
      ],
    }));
  });
  const response = await postResponses(proxy.url, { model: 'muse-code-test', input: [], instructions: contributorPreamble(), stream: false });
  assert.equal(response.status, 502);
  assert.ok(!response.body.includes('take_screenshot'));
  assert.ok(!response.body.includes('computer_use'));
  const blocked = readAudit(config.auditPath).filter((entry) => entry.category === 'CONTRIBUTOR_BLOCKED_CALL');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].toolName, 'computer_use');
  assert.equal(blocked[0].reason, 'tool');
});

test('a non-streaming allowed function call passes through', async (t) => {
  const { proxy } = await setup(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'resp_1',
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'powershell',
          arguments: JSON.stringify({ command: 'Get-ChildItem' }),
        },
      ],
    }));
  });
  const response = await postResponses(proxy.url, { model: 'muse-code-test', input: [], instructions: contributorPreamble(), stream: false });
  assert.equal(response.status, 200);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.output[0].arguments, JSON.stringify({ command: 'Get-ChildItem' }));
});

test('tool calls namespaced as real models send them follow the same rules', () => {
  const policy = normalizeConfig({ homeDir: 'C:\\Users\\someone' }).contributorPolicy;
  const context = { workspaceRoot: 'C:\\Users\\someone\\project', allowedRoots: [] };
  const call = (name, args) => evaluateFunctionCall({ name, argumentsText: JSON.stringify(args), restoredArgumentsText: JSON.stringify(args) }, policy, context);
  assert.equal(call('muse.powershell', { command: 'git status' }).allowed, true);
  assert.equal(call('muse.read_file', { path: 'C:\\Users\\someone\\project\\a.txt' }).allowed, true);
  assert.equal(call('muse.read_file', { path: 'C:\\Users\\someone\\Downloads\\a.txt' }).allowed, false);
  assert.equal(call('muse.powershell', { command: 'orca computer list' }).allowed, false);
  assert.equal(call('muse.read_skill', { name: 'orca-computer-use' }).allowed, false);
  assert.equal(call('muse.read_skill', { name: 'orchestration' }).allowed, true);
  assert.equal(call('muse.computer_use', { action: 'screenshot' }).allowed, false);
  assert.equal(call('other.read_file', { path: 'a.txt' }).allowed, false);
});

test('web_fetch only reaches public http(s) addresses', () => {
  const ok = (url) => isPublicWebArgs(JSON.stringify({ url }));
  for (const url of ['https://example.com', 'http://docs.rs/serde', 'https://8.8.8.8/']) assert.equal(ok(url), true, url);
  for (const url of [
    'http://127.0.0.1:8787/healthz', 'http://localhost:8787', 'http://LOCALHOST', 'http://[::1]/', 'http://192.168.1.50/', 'http://10.0.0.1/',
    'http://172.20.0.1/', 'http://169.254.169.254/', 'http://nas/', 'http://nas.local/', 'file:///C:/Windows/win.ini', 'ftp://example.com/',
    'http://2130706433/', 'http://0x7f.1/', 'http://0/', 'http://100.64.0.1/', 'not a url',
  ]) assert.equal(ok(url), false, url);
  assert.equal(isPublicWebArgs('{}'), false);
});
