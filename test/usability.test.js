// Contributor-mode usability fixes found in real Muse sessions (2026-11-06..10): file
// contents that merely mention a denied capability, Muse's own tool-output spill files,
// web search, and the tools Muse lost. Every case keeps the privacy gates that matter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFunctionCall, museToolOutputRead } from '../src/contributor.js';
import { normalizeConfig, DEFAULT_ALLOWED_TOOLS } from '../src/config.js';
import { CONTRIBUTOR_GUIDANCE } from '../src/guidance.js';
import {
  SYNTH, makeRuntimeConfig, startFakeUpstream, startProxy, postResponses, request, contributorPreamble,
} from './helpers.js';

const policy = normalizeConfig({ homeDir: SYNTH.home }).contributorPolicy;
const ctx = {
  workspaceRoot: SYNTH.workspace,
  allowedRoots: [],
  museSessionsRoot: `${SYNTH.home}\\.local\\share\\muse\\sessions`,
};
const call = (name, args) => evaluateFunctionCall({ name, argumentsText: JSON.stringify(args), restoredArgumentsText: JSON.stringify(args) }, policy, ctx);

test('writing code that mentions a denied capability is allowed; running it is not', () => {
  const file = `${SYNTH.workspace}\\src\\capture.rs`;
  assert.equal(call('write_file', { path: file, content: 'fn screenshot() {} // uses CopyFromScreen' }).allowed, true);
  assert.equal(call('edit_file', { path: file, old_string: 'a', new_string: 'reg query HKCU' }).allowed, true);
  assert.equal(call('write_todos', { todos: ['add screenshot test'] }).allowed, true);
  // Shell calls keep every denied pattern.
  assert.equal(call('powershell', { command: 'orca computer screenshot' }).allowed, false);
  assert.equal(call('powershell', { command: 'Get-Clipboard' }).allowed, false);
  assert.equal(call('powershell_input', { input: 'cmdkey /list' }).allowed, false);
  // Paths stay confined for content tools.
  assert.equal(call('write_file', { path: `${SYNTH.home}\\Documents\\x.txt`, content: 'x' }).allowed, false);
});

test('read_file of a Muse tool-output spill file is allowed, nothing else in the sessions folder', () => {
  const spill = `${ctx.museSessionsRoot}\\2026\\11\\10\\01a1\\tool-outputs\\call_1-tool_patch.json`;
  assert.equal(call('read_file', { path: spill }).allowed, true);
  assert.equal(call('read_file', { path: `${ctx.museSessionsRoot}\\2026\\11\\10\\01a1\\session.jsonl` }).allowed, false);
  assert.equal(call('read_file', { path: `${ctx.museSessionsRoot}\\..\\..\\..\\..\\Documents\\tool-outputs\\x` }).allowed, false);
  assert.equal(call('write_file', { path: spill, content: 'x' }).allowed, false);
  assert.equal(museToolOutputRead('read_file', JSON.stringify({ path: spill }), { museSessionsRoot: null }), false);
});

test('request_user_input and web_search are available in Contributor mode', () => {
  assert.ok(DEFAULT_ALLOWED_TOOLS.includes('request_user_input'));
  assert.ok(DEFAULT_ALLOWED_TOOLS.includes('web_search'));
  assert.ok(DEFAULT_ALLOWED_TOOLS.includes('powershell_input'));
  assert.equal(call('request_user_input', { question: 'Which screenshot library?' }).allowed, true);
  assert.equal(call('web_search', { query: 'rust tauri screenshot crate' }).allowed, true);
});

test('POST /muse-code/search is forwarded redacted, without guidance, for a verified session only', async (t) => {
  const upstream = await startFakeUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'ok' }] }));
  });
  t.after(() => upstream.close());
  const { config } = makeRuntimeConfig({ upstream: upstream.url });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const headers = { 'x-tbh-contributor-mode': '1', 'x-tbh-session-id': 'search-parent' };
  const search = (h) => request(`${proxy.url}/muse-code/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...h },
    body: JSON.stringify({ query: `${SYNTH.name} ${SYNTH.email} tauri` }),
  });

  // No verified session yet: refused, nothing sent.
  assert.equal((await search({ ...headers, 'x-tbh-session-id': 'never-seen' })).status, 403);
  assert.equal(upstream.requests.length, 0);

  const first = await postResponses(proxy.url, { model: 'muse-wonder-1.0', instructions: contributorPreamble(), input: [], stream: false }, headers);
  assert.equal(first.status, 200);
  const response = await search(headers);
  assert.equal(response.status, 200);
  const sent = upstream.requests.at(-1);
  assert.equal(sent.url, '/muse-code/search');
  const body = sent.body.toString('utf8');
  assert.doesNotMatch(body, new RegExp(`${SYNTH.name}|${SYNTH.email}`));
  assert.ok(!body.includes(CONTRIBUTOR_GUIDANCE));
  assert.ok(!('instructions' in JSON.parse(body)));
});

test('asset names like icon@2x.png and reserved-TLD addresses are not emails; real ones still are', async () => {
  const { createPatternDetectors } = await import('../src/detectors/patterns.js');
  const emails = createPatternDetectors().find((d) => d.name === 'emails');
  const found = (text) => emails.scan(text).map((s) => s.value);
  assert.deepEqual(found('icons: appicon-60x60@3x.png, logo@2x.webp, bench@example.invalid, ci@host.test'), []);
  assert.deepEqual(found('mail jane.roe@mailhost.co or j@site.io'), ['jane.roe@mailhost.co', 'j@site.io']);
});
