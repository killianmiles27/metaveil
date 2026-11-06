import test from 'node:test';
import assert from 'node:assert/strict';
import { findEncodedBlocks, splitIdentityFound } from '../src/encoded.js';
import {
  SYNTH,
  makeRuntimeConfig,
  startFakeUpstream,
  startProxy,
  postResponses,
  contributorPreamble,
  sse,
} from './helpers.js';

const SECRET_TEXT = `Maintainer: ${SYNTH.name} <${SYNTH.email}> on ${SYNTH.hostname}.`;
const buffer = Buffer.from(SECRET_TEXT);

function formatHex(buf) {
  const lines = ['           00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F'];
  for (let i = 0; i < buf.length; i += 16) {
    const row = buf.subarray(i, i + 16);
    lines.push(`${i.toString(16).toUpperCase().padStart(8, '0')}   ${[...row].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}  ${row.toString('latin1')}`);
  }
  return lines.join('\n');
}

function xxd(buf) {
  const lines = [];
  for (let i = 0; i < buf.length; i += 16) {
    const hex = buf.subarray(i, i + 16).toString('hex').match(/.{1,4}/g).join(' ');
    lines.push(`${i.toString(16).padStart(8, '0')}: ${hex}  ${buf.subarray(i, i + 16).toString('latin1')}`);
  }
  return lines.join('\n');
}

const forms = {
  'Format-Hex': formatHex(buffer),
  xxd: xxd(buffer),
  base64: buffer.toString('base64'),
  'wrapped base64': `-----BEGIN CERTIFICATE-----\n${buffer.toString('base64').match(/.{1,20}/g).join('\n')}\n-----END CERTIFICATE-----`,
  'UTF-16 base64': Buffer.from(SECRET_TEXT, 'utf16le').toString('base64'),
  'hex string': buffer.toString('hex'),
  'spaced hex': [...buffer].map((b) => b.toString(16).padStart(2, '0')).join(' '),
  'byte list': [...buffer].join('\n'),
  'comma bytes': [...buffer].join(', '),
};

for (const [name, encoded] of Object.entries(forms)) {
  test(`${name} decodes back to its text`, () => {
    const blocks = findEncodedBlocks(`before\n${encoded}\nafter`);
    assert.ok(blocks.some((block) => block.decoded.includes(SYNTH.hostname)), JSON.stringify(blocks).slice(0, 300));
  });
}

test('wrapped base64 decodes at any length and wrap width', () => {
  for (let pad = 0; pad < 6; pad += 1) {
    for (const width of [16, 20, 64, 76]) {
      const encoded = Buffer.from(`${'x'.repeat(pad)}${SECRET_TEXT}`).toString('base64').match(new RegExp(`.{1,${width}}`, 'g')).join('\n');
      const pem = `before\n-----BEGIN CERTIFICATE-----\n${encoded}\n-----END CERTIFICATE-----\nafter`;
      assert.ok(findEncodedBlocks(pem).some((block) => block.decoded.includes(SYNTH.hostname)), `pad ${pad} width ${width}`);
    }
  }
});

test('ordinary developer text is not treated as encoded', () => {
  const samples = [
    'commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
    'sha512-Z1Xq8fN3vY2bK5mP9wR7tH4jL6sD0cA8eG1uI3oQ5xV7nM2yB4zT6kW9pJ0hF8dS3gE5rU1aC7lO4iN6qX2vMg==',
    'const version = "1.2.3"; for (let i = 0; i < 10; i += 1) sum += i;',
    '1 2 3',
    'Ran 31 tests in 0.162s',
    'this_is_a_long_snake_case_identifier_name_in_code',
    '10.0.0.1 192.168.1.1 172.16.0.1',
  ];
  for (const sample of samples) assert.deepEqual(findEncodedBlocks(sample), [], sample);
  // A dump of binary data stays as it is.
  const binary = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 3) % 32));
  assert.deepEqual(findEncodedBlocks(formatHex(binary)), []);
});

test('identity values split up by separators are found', () => {
  const values = [SYNTH.hostname, 'short'];
  const spaced = [...SYNTH.hostname].join(' ');
  assert.equal(splitIdentityFound(`name: ${spaced}`, values), true);
  assert.equal(splitIdentityFound([...SYNTH.hostname].join('\n'), values), true);
  assert.equal(splitIdentityFound([...SYNTH.hostname].reverse().join(''), values), true);
  assert.equal(splitIdentityFound('s h o r t text', values), false, 'short values are skipped');
  assert.equal(splitIdentityFound('nothing to see in this line', values), false);
});

async function forwardedFor(t, output, remoteDetector) {
  const fake = await startFakeUpstream(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([{ event: 'response.completed', data: { type: 'response.completed', response: { id: 'r', output: [] } } }]));
  });
  t.after(() => fake.close());
  const { config } = makeRuntimeConfig({ upstream: fake.url, jev: { enabled: true, baseUrl: fake.url } });
  const proxy = await startProxy(config, remoteDetector ? { remoteDetector } : { remoteDetector: { scan: async () => [] } });
  t.after(() => proxy.stop());
  const result = await postResponses(proxy.url, {
    model: 'muse-spark-1.3-contributor',
    stream: true,
    input: [
      { type: 'message', role: 'developer', content: contributorPreamble() },
      { type: 'function_call', call_id: 'c1', name: 'muse.powershell', arguments: '{"command":"Format-Hex notes.md"}' },
      { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ exit_code: 0, output }) },
    ],
  }, { 'x-tbh-contributor-mode': '1', 'x-tbh-session-id': 's' });
  assert.equal(result.status, 200);
  return fake.requests[fake.requests.length - 1].body.toString('utf8');
}

const decodeEverything = (text) => {
  const plain = JSON.parse(text).input.map((i) => i.output || '').join('\n');
  let inner = plain;
  try { inner = JSON.parse(plain.trim()).output; } catch { /* plain text */ }
  return `${inner}\n${findEncodedBlocks(inner).map((block) => block.decoded).join('\n')}`;
};

for (const [name, encoded] of Object.entries(forms)) {
  test(`${name}: nothing identifying reaches the upstream in any form`, async (t) => {
    const forwarded = await forwardedFor(t, encoded);
    const readable = decodeEverything(forwarded);
    for (const value of [SYNTH.name, SYNTH.email, SYNTH.hostname]) {
      assert.equal(readable.toLowerCase().includes(value.toLowerCase()), false, `${value} in: ${readable.slice(0, 300)}`);
    }
    assert.match(forwarded, /decoded by metaveil|withheld by metaveil/);
  });
}

test('personal text the identity list misses is judged as a whole, not line by line', async (t) => {
  const note = Buffer.from('Call my sister at 44 Alder Lane, Tacoma, about her surgery. Then fix the build.');
  const seen = [];
  const remoteDetector = {
    scan: async (text) => {
      seen.push(text);
      const at = text.indexOf('Call my sister');
      return at === -1 ? [] : [{ start: at, end: text.length, category: 'WITHHELD', replacement: '[line withheld by metaveil: possible personal details]', detector: 'jev' }];
    },
  };
  const forwarded = await forwardedFor(t, formatHex(note), remoteDetector);
  assert.ok(seen.some((text) => text.includes('Call my sister at 44 Alder Lane')), 'the scanner saw the decoded sentence');
  assert.equal(decodeEverything(forwarded).includes('Alder Lane'), false);
  assert.equal(forwarded.includes('41 6C 64 65 72'), false, 'the encoded bytes are gone');
});

test('harmless encoded data passes through unchanged', async (t) => {
  const dump = formatHex(Buffer.from('function add(a, b) { return a + b; }'));
  const forwarded = await forwardedFor(t, dump);
  assert.ok(forwarded.includes('66 75 6E 63 74 69 6F 6E'), 'the dump is untouched');
  assert.equal(forwarded.includes('decoded by metaveil'), false);
});
