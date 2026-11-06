import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/config.js';
import { createProxyServer } from '../src/server.js';

export const SYNTH = Object.freeze({
  home: String.raw`C:\Users\sampleuser`,
  alias: String.raw`C:\Users\dev`,
  workspace: String.raw`C:\Users\sampleuser\projects\metaveil`,
  name: 'Avery Quill',
  username: 'sampleuser',
  email: 'avery.quill@example.test',
  hostname: 'sampleuser-laptop',
  term: 'Bluefin Cipher',
  ssn: '123-45-6789',
  phone: '555-123-4567',
  card: '4242 4242 4242 4242',
  awsKey: 'AKIAIOSFODNN7EXAMPLE',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdmVyeSJ9.c2lnbmF0dXJlLXRlc3Q',
  secretValue: 'sk-test-abcdefghijklmnop0123456789',
  privateKey: '-----BEGIN PRIVATE KEY-----\nMIIBVtest-only\n-----END PRIVATE KEY-----',
  filename: 'tax_return.pdf',
});

export function makeRuntimeConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metaveil-test-'));
  const identity = {
    names: [SYNTH.name],
    usernames: [SYNTH.username],
    emails: [SYNTH.email],
    hostnames: [SYNTH.hostname],
    terms: [SYNTH.term],
  };
  const raw = {
    port: 0,
    upstream: 'http://127.0.0.1:1',
    homeDir: SYNTH.home,
    homeAlias: SYNTH.alias,
    workspaceRoot: SYNTH.workspace,
    mapPath: path.join(dir, 'map.json'),
    auditPath: path.join(dir, 'audit.jsonl'),
    maxBodyBytes: 64 * 1024 * 1024,
    detectorFailure: 'withhold',
    identity,
    ...overrides,
  };
  if (overrides.identity) raw.identity = { ...identity, ...overrides.identity };
  raw.mapPath = overrides.mapPath || path.join(dir, 'map.json');
  raw.auditPath = overrides.auditPath || path.join(dir, 'audit.jsonl');
  const config = normalizeConfig(raw, { configPath: path.join(dir, 'config.json') });
  return { config, dir };
}

export async function startFakeUpstream(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks),
      index: requests.length,
    };
    requests.push(record);
    try {
      await handler(req, res, record);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('fake upstream error');
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function startProxy(config, options = {}) {
  const proxy = await createProxyServer({ config, ...options });
  const { url, port } = await proxy.listen(0);
  return {
    ...proxy,
    url,
    port,
    async stop() {
      await proxy.close();
    },
  };
}

export function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body === undefined ? undefined : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw,
          body: raw.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) {
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-length')) {
        req.setHeader('content-length', String(payload.length));
      }
      req.write(payload);
    }
    req.end();
  });
}

export async function postResponses(baseUrl, body, headers = {}) {
  return request(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

export function sse(events) {
  return events.map((entry) => {
    const eventName = entry.event ? `event: ${entry.event}\n` : '';
    const data = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data);
    return `${eventName}data: ${data}\n\n`;
  }).join('');
}

export function parseSse(text) {
  const events = [];
  for (const block of String(text).split(/\n\n/)) {
    if (!block.trim()) continue;
    let eventName;
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n');
    let object;
    try {
      object = JSON.parse(data);
    } catch {
      object = undefined;
    }
    events.push({ event: eventName, data, object });
  }
  return events;
}

export function jsonBody(response) {
  return JSON.parse(response.body);
}

export function deltaText(events) {
  return events
    .map((event) => {
      const obj = event.object;
      if (!obj) return '';
      if (typeof obj.delta === 'string') return obj.delta;
      if (typeof obj.arguments === 'string') return obj.arguments;
      return '';
    })
    .join('');
}

export function sensitiveValues() {
  return [
    SYNTH.name,
    SYNTH.username,
    SYNTH.email,
    SYNTH.hostname,
    SYNTH.term,
    SYNTH.ssn,
    SYNTH.phone,
    SYNTH.card,
    SYNTH.awsKey,
    SYNTH.jwt,
    SYNTH.secretValue,
    'MIIBVtest-only',
    SYNTH.filename,
    'notes.txt',
    SYNTH.home,
    'C:/Users/sampleuser',
    '/c/Users/sampleuser',
    String.raw`C:\\Users\\sampleuser`,
  ];
}

export function assertNoSensitiveBytes(raw, values = sensitiveValues()) {
  const text = String(raw).toLowerCase();
  for (const value of values) {
    if (!value) continue;
    if (text.includes(String(value).toLowerCase())) {
      throw new Error(`sensitive value leaked: ${JSON.stringify(value)}`);
    }
  }
}

export function readAudit(auditPath) {
  if (!fs.existsSync(auditPath)) return [];
  return fs.readFileSync(auditPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function canaryBody() {
  return {
    model: 'muse-code-1.4.14',
    instructions: [
      'You are Muse Code.',
      `Workspace root: ${SYNTH.workspace}`,
      `The user is ${SYNTH.name}, account ${SYNTH.username}, email ${SYNTH.email}, host ${SYNTH.hostname}.`,
      `Downloads: ${SYNTH.home}\\Downloads\\${SYNTH.filename}`,
      `term: ${SYNTH.term}`,
      `ssn ${SYNTH.ssn} phone ${SYNTH.phone} card ${SYNTH.card}`,
      `aws ${SYNTH.awsKey}`,
      `jwt ${SYNTH.jwt}`,
      `env API_KEY=${SYNTH.secretValue}`,
      SYNTH.privateKey,
    ].join('\n'),
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: `My name is ${SYNTH.name} (${SYNTH.username}) and my email is ${SYNTH.email}.` },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAABBBBCCCC' },
        ],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: JSON.stringify({
          path: `${SYNTH.home}\\Downloads\\${SYNTH.filename}`,
          note: `${SYNTH.name} / ${SYNTH.username} / ${SYNTH.email}`,
        }),
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: `host ${SYNTH.hostname} term ${SYNTH.term} path C:/Users/sampleuser/Desktop/notes.txt`,
      },
      {
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'OPAQUE-ENCRYPTED-CONTENT-XYZ',
        summary: [{ type: 'summary_text', text: `${SYNTH.name} looked at files.` }],
      },
      {
        type: 'mystery_item',
        payload: {
          deep: { value: SYNTH.name },
          paths: [String.raw`\\?\C:\Users\sampleuser\Downloads\tax_return.pdf`],
          tokenish: SYNTH.secretValue,
        },
      },
    ],
    tools: [
      {
        type: 'namespace',
        name: 'workspace',
        tools: [
          {
            type: 'function',
            name: 'read_file',
            description: `Read files for ${SYNTH.name} on ${SYNTH.hostname}`,
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: `e.g. ${SYNTH.home}\\Downloads\\${SYNTH.filename}`,
                },
              },
              required: ['path'],
            },
          },
        ],
      },
      {
        type: 'function',
        name: 'search',
        description: `Search for ${SYNTH.term}`,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: `query; user ${SYNTH.email}` },
          },
        },
      },
    ],
    max_output_tokens: 1000,
    store: false,
    reasoning: { effort: 'low' },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'prompt-cache-key-unchanged',
    stream: true,
    metadata: { contact: SYNTH.email, owner: SYNTH.name },
  };
}

export function contributorPreamble({ workspace = SYNTH.workspace, sandbox = 'on' } = {}) {
  const sandboxLine = sandbox === 'off'
    ? '- Shell sandbox: off — shell commands run unsandboxed.'
    : `- Shell sandbox: ${sandbox}.`;
  return [
    '## Session permission mode',
    '- Approval: bypassed at launch (--disable-approval / --yolo) — tool calls will not ask the user for approval in this session.',
    sandboxLine,
    '- Workspace trust: trusted — project-local instructions, skills, and hooks are eligible to load.',
    `Workspace root: ${workspace}`,
    '',
  ].join('\n');
}
