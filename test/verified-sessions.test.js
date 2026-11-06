import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRuntimeConfig,
  startFakeUpstream,
  startProxy,
  postResponses,
  contributorPreamble,
  sse,
} from './helpers.js';

const ok = sse([{ event: 'response.completed', data: { type: 'response.completed', response: { id: 'r', output: [] } } }]);
const main = (sandbox = 'on') => ({
  model: 'muse-spark-1.3-contributor',
  stream: true,
  input: [
    { type: 'message', role: 'developer', content: contributorPreamble({ sandbox }) },
    { type: 'message', role: 'user', content: 'hello' },
  ],
});
// The shape Muse sends to compact a conversation.
const compaction = { model: 'muse-spark-1.3-contributor', stream: true, input: [{ type: 'message', role: 'user', content: 'summarize this' }] };
const headers = (id) => ({ 'x-tbh-contributor-mode': '1', 'x-tbh-session-id': id });

async function setup(t) {
  const fake = await startFakeUpstream(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(ok);
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url, jev: { enabled: true, baseUrl: fake.url } });
  const proxy = await startProxy(config, { remoteDetector: { scan: async () => [] } });
  t.after(() => proxy.stop());
  return { fake, url: proxy.url };
}

test('a side request passes once its session has shown the sandbox is on', async (t) => {
  const { fake, url } = await setup(t);
  assert.equal((await postResponses(url, compaction, headers('s1'))).status, 403, 'nothing verified yet');
  assert.equal(fake.requests.length, 0);
  assert.equal((await postResponses(url, main('on'), headers('s1'))).status, 200);
  assert.equal((await postResponses(url, compaction, headers('s1'))).status, 200);
  assert.equal(fake.requests.length, 2);
  assert.equal((await postResponses(url, compaction, headers('other'))).status, 403, 'another session is not verified');
  assert.equal((await postResponses(url, compaction, { 'x-tbh-contributor-mode': '1' })).status, 403, 'no session id');
});

test('a session that turns the sandbox off can no longer send side requests', async (t) => {
  const { fake, url } = await setup(t);
  await postResponses(url, main('on'), headers('s2'));
  assert.equal((await postResponses(url, main('off'), headers('s2'))).status, 403);
  assert.equal((await postResponses(url, compaction, headers('s2'))).status, 403);
  assert.equal(fake.requests.length, 1);
});

test('the summarizer needs one verified session, since its session id links to nothing', async (t) => {
  const { fake, url } = await setup(t);
  const summarizer = { 'x-tbh-contributor-mode': '1', 'x-tbh-session-id': 'fresh', 'x-tbh-invocation-kind': 'side_call:summarizer' };
  assert.equal((await postResponses(url, compaction, summarizer)).status, 403, 'nothing verified yet');
  await postResponses(url, main('off'), headers('s3'));
  assert.equal((await postResponses(url, compaction, summarizer)).status, 403, 'a sandbox-off session verifies nothing');
  assert.equal(fake.requests.length, 0);
  await postResponses(url, main('on'), headers('s4'));
  assert.equal((await postResponses(url, compaction, summarizer)).status, 200);
  assert.equal((await postResponses(url, compaction, { ...summarizer, 'x-tbh-invocation-kind': 'side_call:other' })).status, 403, 'only the summarizer');
});

test('tips are refused without costing the session its verified status', async (t) => {
  const { fake, url } = await setup(t);
  await postResponses(url, main('on'), headers('s5'));
  assert.equal((await postResponses(url, compaction, { ...headers('s5'), 'x-tbh-invocation-kind': 'side_call:prompt_hint' })).status, 403);
  assert.equal(fake.requests.length, 1);
  assert.equal((await postResponses(url, compaction, headers('s5'))).status, 200);
});

test('a real email address missing from the identity list is still masked', async (t) => {
  const { fake, url } = await setup(t);
  const body = main('on');
  body.input.push({ type: 'function_call_output', call_id: 'c', output: 'dead link: mailto:jordan.okafor@gmail.com and mailto:fixture@example.com' });
  await postResponses(url, body, headers('s6'));
  const sent = fake.requests[fake.requests.length - 1].body.toString('utf8');
  assert.equal(sent.includes('jordan.okafor@gmail.com'), false);
});
