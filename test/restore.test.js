import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenStore } from '../src/token-store.js';
import { createDetectors } from '../src/detectors/index.js';
import { createPipeline } from '../src/pipeline.js';
import { createRedactor } from '../src/redact.js';
import { NullAuditLog } from '../src/audit.js';
import { createRestorer } from '../src/restore.js';
import { SseTransformer } from '../src/sse.js';
import { makeRuntimeConfig, SYNTH, sse } from './helpers.js';

async function fixture() {
  const { config } = makeRuntimeConfig();
  const store = await TokenStore.open({ mapPath: config.mapPath, persist: false });
  const pipeline = createPipeline({ config, detectors: createDetectors(config) });
  const redactor = createRedactor({ config, store, pipeline, audit: new NullAuditLog() });
  return { config, store, redactor };
}

function runTransformer(restorer, serialized, byteChunks = 0) {
  const transformer = new SseTransformer({ restorer });
  let output = '';
  if (byteChunks > 0) {
    for (let i = 0; i < serialized.length; i += byteChunks) {
      output += transformer.push(serialized.slice(i, i + byteChunks));
    }
  } else {
    output += transformer.push(serialized);
  }
  output += transformer.finish();
  return output;
}

function deltasFrom(serializedOutput) {
  const values = [];
  for (const line of String(serializedOutput).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') continue;
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof obj.delta === 'string') values.push(obj.delta);
  }
  return values.join('');
}

test('a token split across every possible output_text delta boundary restores', async () => {
  const { config, store, redactor } = await fixture();
  const original = `${SYNTH.name} ${SYNTH.email} ${SYNTH.home}\\Downloads\\${SYNTH.filename}`;
  const redacted = await redactor.redactText(original, { requestId: 'split' });
  const expected = `${SYNTH.name} ${SYNTH.email} ${SYNTH.home}\\Downloads\\${SYNTH.filename}`;
  const restorer = createRestorer({ config, store });

  for (let split = 0; split <= redacted.length; split += 1) {
    const events = [
      {
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: redacted.slice(0, split) },
      },
      {
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: redacted.slice(split) },
      },
      { event: 'done', data: '[DONE]' },
    ];
    const serialized = sse(events);
    const out = runTransformer(restorer, serialized);
    assert.equal(deltasFrom(out), expected, `split at ${split}`);
  }
});

test('a token split across every possible function-call argument delta boundary restores valid JSON', async () => {
  const { config, store, redactor } = await fixture();
  const originalArgs = JSON.stringify({
    path: `${SYNTH.home}\\projects\\metaveil\\src\\a.js`,
    other: `${SYNTH.home}\\Downloads\\${SYNTH.filename}`,
    who: SYNTH.name,
  });
  const redactedArgs = await redactor.redactText(originalArgs, { requestId: 'split-args', jsonContext: true });
  const restorer = createRestorer({ config, store });
  const expected = JSON.parse(originalArgs);

  for (let split = 0; split <= redactedArgs.length; split += 1) {
    const events = [
      {
        event: 'response.function_call_arguments.delta',
        data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: redactedArgs.slice(0, split) },
      },
      {
        event: 'response.function_call_arguments.delta',
        data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: redactedArgs.slice(split) },
      },
      {
        event: 'response.function_call_arguments.done',
        data: { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: redactedArgs },
      },
      { event: 'done', data: '[DONE]' },
    ];
    const serialized = sse(events);
    const out = runTransformer(restorer, serialized);
    const joined = deltasFrom(out);
    assert.doesNotThrow(() => JSON.parse(joined), `split at ${split}: ${joined}`);
    assert.deepEqual(JSON.parse(joined), expected, `split at ${split}`);
  }
});

test('SSE network chunk boundaries do not affect restoration', async () => {
  const { config, store, redactor } = await fixture();
  const original = `${SYNTH.name} ${SYNTH.email} token LOCAL_PATH`;
  const redacted = await redactor.redactText(original, { requestId: 'chunks' });
  const restorer = createRestorer({ config, store });
  const events = [
    {
      event: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: redacted },
    },
    { event: 'done', data: '[DONE]' },
  ];
  const serialized = sse(events);
  const expected = `${SYNTH.name} ${SYNTH.email} token LOCAL_PATH`;
  for (let chunkSize = 1; chunkSize <= 7; chunkSize += 1) {
    const out = runTransformer(restorer, serialized, chunkSize);
    assert.equal(deltasFrom(out), expected, `chunk size ${chunkSize}`);
  }
});

test('SECRET tokens are never restored', async () => {
  const { config, store, redactor } = await fixture();
  const original = `API_KEY=${SYNTH.secretValue}`;
  const redacted = await redactor.redactText(original, { requestId: 'secret' });
  assert.match(redacted, /SECRET_1/);
  const restorer = createRestorer({ config, store });
  assert.equal(restorer.restoreText(redacted), redacted);
  assert.equal(restorer.restoreText(redacted, { argsContext: true }), redacted);
});

test('encrypted_content is untouched while sibling reasoning text is restored', async () => {
  const { config, store, redactor } = await fixture();
  const redacted = await redactor.redactText(SYNTH.name, { requestId: 'reasoning' });
  const restorer = createRestorer({ config, store });
  const transformer = new SseTransformer({ restorer });
  const event = {
    event: 'response.output_item.added',
    data: {
      type: 'response.output_item.added',
      item: { type: 'reasoning', encrypted_content: 'OPAQUE sampleuser bytes', summary: [{ type: 'summary_text', text: redacted }] },
    },
  };
  const out = transformer.push(sse([event]));
  transformer.finish();
  const parsed = out.split('\n').find((line) => line.startsWith('data:'));
  const obj = JSON.parse(parsed.slice(5).trim());
  assert.equal(obj.item.encrypted_content, 'OPAQUE sampleuser bytes');
  assert.equal(obj.item.summary[0].text, SYNTH.name);
});
