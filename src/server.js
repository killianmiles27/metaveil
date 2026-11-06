import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { AuditLog, NullAuditLog } from './audit.js';
import { TokenStore } from './token-store.js';
import { createDetectors } from './detectors/index.js';
import { createPipeline } from './pipeline.js';
import { createRedactor } from './redact.js';
import { createRestorer, restoreResponseObject } from './restore.js';
import { SseTransformer } from './sse.js';
import { isContributorModeOn, filterTools, evaluateFunctionCall, blockedCallAudit } from './contributor.js';
import { buildContributorGuard, resolveRequestWorkspaceRoot } from './confinement.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const ALLOWED_PATHS = [
  { method: 'GET', path: '/muse-code/models', kind: 'models' },
  { method: 'POST', path: '/v1/responses', kind: 'responses' },
];

class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.code = 'BODY_TOO_LARGE';
  }
}

function sendJson(res, status, object, requestId) {
  if (res.writableEnded) return;
  const body = JSON.stringify(object);
  const headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  };
  if (requestId) headers['x-metaveil-request-id'] = requestId;
  if (!res.headersSent) res.writeHead(status, headers);
  res.end(body);
}

function errorBody(type, message) {
  return { error: { type, message } };
}

function requestHeaderObject(req) {
  return req.headers || {};
}

function upstreamTarget(config, requestUrl) {
  const base = new URL(config.upstream);
  const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
  return {
    protocol: base.protocol,
    hostname: base.hostname,
    port: base.port || undefined,
    host: base.host,
    path: `${prefix}${requestUrl.pathname}${requestUrl.search}` || '/',
  };
}

function buildUpstreamHeaders(incomingHeaders, bodyLength, target) {
  const headers = {};
  for (const [name, value] of Object.entries(incomingHeaders)) {
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'content-length' || lower === 'accept-encoding' || HOP_BY_HOP.has(lower)) continue;
    headers[name] = value;
  }
  headers.host = target.host;
  headers['content-length'] = String(bodyLength);
  return headers;
}

function copyResponseHeaders(upstreamHeaders, { keepLength = false, keepEncoding = false } = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (!keepLength && lower === 'content-length') continue;
    if (!keepEncoding && lower === 'content-encoding') continue;
    headers[name] = value;
  }
  return headers;
}

function readBodyLimited(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.off('data', onData);
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSource(upstreamRes) {
  const encoding = String(upstreamRes.headers['content-encoding'] || '').toLowerCase().trim();
  if (!encoding) return { stream: upstreamRes, decoded: false, supported: true };
  if (encoding === 'identity') return { stream: upstreamRes, decoded: false, supported: true };
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    return { stream: upstreamRes.pipe(zlib.createGunzip()), decoded: true, supported: true };
  }
  if (encoding === 'deflate') {
    return { stream: upstreamRes.pipe(zlib.createInflate()), decoded: true, supported: true };
  }
  if (encoding === 'br') {
    return { stream: upstreamRes.pipe(zlib.createBrotliDecompress()), decoded: true, supported: true };
  }
  return { stream: upstreamRes, decoded: false, supported: false };
}

async function writeWithBackpressure(res, text) {
  if (!text) return;
  if (res.writableEnded || res.destroyed) return;
  if (!res.write(text)) await once(res, 'drain');
}

// Muse's side requests, such as compaction and its goal reminders, carry no permission
// block, so they can't show the sandbox is on. They do carry the session id. One passes
// only if a main request of that session already showed it, and a session that reports
// anything else loses that. Side requests go through the same redaction and scanning.
const MAX_VERIFIED_SESSIONS = 500;

export function createVerifiedSessions() {
  const sessions = new Map();
  const idsOf = (headers) => ['x-tbh-session-id', 'x-tbh-root-session-id']
    .map((name) => headers?.[name])
    .filter((id) => typeof id === 'string' && id);
  return {
    check(guard, headers) {
      // Tips send the conversation to Meta to pick a UI hint, and their ghost text in the
      // prompt box stops Orca waking the agent, as if someone were mid-sentence.
      if (headers?.['x-tbh-invocation-kind'] === 'side_call:prompt_hint') {
        return { ok: false, kind: 'sandbox', reason: 'prompt-hint', message: 'metaveil: tips are off in contributor mode' };
      }
      const ids = idsOf(headers);
      if (guard.ok) {
        for (const id of ids) {
          sessions.delete(id);
          sessions.set(id, { workspaceRoot: guard.workspaceRoot, allowedRoots: guard.allowedRoots });
          if (sessions.size > MAX_VERIFIED_SESSIONS) sessions.delete(sessions.keys().next().value);
        }
        return guard;
      }
      if (guard.kind === 'sandbox' && guard.reason === 'missing-block') {
        const known = ids.map((id) => sessions.get(id)).find(Boolean);
        if (known) return { ok: true, ...known };
        // The summarizer gets a new session id with no link to its parent. It can't run
        // anything, and a sandbox-off session has no work to summarize, because its main
        // requests never pass. So any verified session is enough.
        const latest = [...sessions.values()].pop();
        if (latest && headers?.['x-tbh-invocation-kind'] === 'side_call:summarizer') return { ok: true, ...latest };
        return guard;
      }
      for (const id of ids) sessions.delete(id);
      return guard;
    },
  };
}

function findBlockedCallInResponse(responseObject, restorer, contributor) {
  if (!responseObject || typeof responseObject !== 'object') return null;
  const response = responseObject.response && typeof responseObject.response === 'object'
    ? responseObject.response
    : responseObject;
  const outputs = Array.isArray(response.output) ? response.output : [];
  for (const item of outputs) {
    if (!item || item.type !== 'function_call') continue;
    const name = typeof item.name === 'string' ? restorer.restoreText(item.name) : '';
    const args = typeof item.arguments === 'string' ? item.arguments : '';
    const verdict = evaluateFunctionCall({
      name,
      argumentsText: args,
      restoredArgumentsText: args ? restorer.restoreText(args, { argsContext: true }) : '',
    }, contributor.policy, contributor);
    if (!verdict.allowed) return verdict;
  }
  return null;
}

function jevReady(config) {
  const keyEnv = config?.jev?.apiKeyEnv;
  return config?.jev?.enabled === true
    && typeof keyEnv === 'string'
    && typeof process.env[keyEnv] === 'string'
    && process.env[keyEnv].trim().length > 0;
}

async function handleProxyRequest(ctx, req, res) {
  const { config, audit, store, redactor, pipeline, contributorPolicy } = ctx;
  const requestId = `req_${crypto.randomUUID()}`;
  res.setHeader('x-metaveil-request-id', requestId);
  let requestUrl;
  try {
    requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  } catch {
    sendJson(res, 400, errorBody('metaveil_bad_request', 'metaveil: invalid request URL'), requestId);
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, service: 'metaveil', jevReady: jevReady(config) }, requestId);
    return;
  }

  const allowed = ALLOWED_PATHS.find((entry) => entry.method === req.method && entry.path === requestUrl.pathname);
  if (!allowed) {
    audit.record({
      requestId,
      phase: 'request',
      action: 'blocked',
      category: 'BLOCKED_PATH',
      method: req.method,
      target: requestUrl.pathname,
      status: 403,
    });
    sendJson(res, 403, errorBody('metaveil_blocked_path', 'metaveil: path is not allowed'), requestId);
    return;
  }

  if (allowed.kind === 'models') {
    await forwardModels(ctx, req, res, requestUrl, requestId);
    return;
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > config.maxBodyBytes) {
    req.resume();
    audit.record({
      requestId,
      phase: 'request',
      action: 'blocked',
      category: 'BODY_TOO_LARGE',
      status: 413,
      method: req.method,
      target: requestUrl.pathname,
    });
    sendJson(res, 413, errorBody('metaveil_body_too_large', 'metaveil: request body exceeds configured limit'), requestId);
    return;
  }

  let bodyBuffer;
  try {
    bodyBuffer = await readBodyLimited(req, config.maxBodyBytes);
  } catch (error) {
    if (error.code === 'BODY_TOO_LARGE') {
      audit.record({
        requestId,
        phase: 'request',
        action: 'blocked',
        category: 'BODY_TOO_LARGE',
        status: 413,
        method: req.method,
        target: requestUrl.pathname,
      });
      sendJson(res, 413, errorBody('metaveil_body_too_large', 'metaveil: request body exceeds configured limit'), requestId);
      return;
    }
    sendJson(res, 400, errorBody('metaveil_bad_request', 'metaveil: could not read request body'), requestId);
    return;
  }

  let body;
  try {
    body = JSON.parse(bodyBuffer.toString('utf8'));
  } catch {
    audit.record({
      requestId,
      phase: 'request',
      action: 'blocked',
      category: 'INVALID_REQUEST',
      status: 400,
      method: req.method,
      target: requestUrl.pathname,
    });
    sendJson(res, 400, errorBody('metaveil_invalid_json', 'metaveil: request body is not valid JSON'), requestId);
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, errorBody('metaveil_invalid_json', 'metaveil: request body must be a JSON object'), requestId);
    return;
  }

  const contributorOn = isContributorModeOn(requestHeaderObject(req));
  let contributor = null;
  let requestRestorer;
  let requestWorkspaceRoot = null;

  if (contributorOn && config.jev.configured && !config.jev.enabled) {
    audit.record({
      requestId,
      phase: 'request',
      action: 'blocked',
      category: 'CONTRIBUTOR_JEV_REQUIRED',
      status: 503,
      method: req.method,
      target: requestUrl.pathname,
    });
    sendJson(res, 503, errorBody(
      'metaveil_contributor_requires_jev',
      'metaveil: contributor mode requires the Jev scanner, but jev.enabled is false; nothing was forwarded',
    ), requestId);
    return;
  }

  if (contributorOn) {
    const guard = ctx.verifiedSessions.check(buildContributorGuard(body, contributorPolicy), req.headers);
    if (!guard.ok) {
      audit.record({
        requestId,
        phase: 'request',
        action: 'blocked',
        category: guard.kind === 'sandbox' ? 'CONTRIBUTOR_SANDBOX' : 'CONTRIBUTOR_WORKSPACE_ROOT',
        status: 403,
        reason: guard.reason,
        method: req.method,
        target: requestUrl.pathname,
      });
      sendJson(
        res,
        403,
        errorBody(
          guard.kind === 'sandbox' ? 'metaveil_contributor_sandbox' : 'metaveil_workspace_root',
          guard.message,
        ),
        requestId,
      );
      return;
    }
    requestWorkspaceRoot = guard.workspaceRoot;
    contributor = {
      enabled: true,
      policy: contributorPolicy,
      audit,
      requestId,
      workspaceRoot: guard.workspaceRoot,
      allowedRoots: guard.allowedRoots,
    };
  } else {
    const workspace = resolveRequestWorkspaceRoot(body, config);
    if (!workspace.ok) {
      audit.record({
        requestId,
        phase: 'request',
        action: 'blocked',
        category: 'WORKSPACE_ROOT',
        status: 400,
        reason: workspace.reason,
        method: req.method,
        target: requestUrl.pathname,
      });
      sendJson(res, 400, errorBody(
        'metaveil_workspace_root',
        'metaveil: request workspace root is invalid or ambiguous; nothing was forwarded',
      ), requestId);
      return;
    }
    requestWorkspaceRoot = workspace.path;
  }

  try {
    if (contributorOn && Object.prototype.hasOwnProperty.call(body, 'tools')) {
      body.tools = filterTools(body.tools, contributorPolicy, audit, { requestId });
    }
    body = await redactor.redactBody(body, {
      requestId,
      contributor: contributorOn,
      workspaceRoot: requestWorkspaceRoot,
      workspaceAlias: config.workspaceAlias,
    });
    await store.flush();
    // The restorer needs the tokens that this request just created, so it is
    // built per request rather than once at startup.
    requestRestorer = createRestorer({ config, store, workspaceRoot: requestWorkspaceRoot });
  } catch (error) {
    audit.record({
      requestId,
      phase: 'request',
      action: 'blocked',
      category: 'PIPELINE_ERROR',
      status: 502,
      method: req.method,
      target: requestUrl.pathname,
      detector: error.detector || undefined,
    });
    sendJson(res, 502, errorBody('metaveil_pipeline_error', 'metaveil: request redaction failed; nothing was forwarded'), requestId);
    return;
  }

  const outgoing = Buffer.from(JSON.stringify(body), 'utf8');
  const target = upstreamTarget(config, requestUrl);
  const headers = buildUpstreamHeaders(requestHeaderObject(req), outgoing.length, target);
  const transport = target.protocol === 'https:' ? https : http;

  let upstreamReq;
  try {
    upstreamReq = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: target.path,
      headers,
      agent: false,
    });
  } catch {
    sendJson(res, 502, errorBody('metaveil_upstream_error', 'metaveil: could not create upstream request'), requestId);
    return;
  }

  req.on('aborted', () => upstreamReq.destroy());
  res.on('close', () => {
    if (!res.writableEnded) upstreamReq.destroy();
  });

  upstreamReq.on('error', (error) => {
    audit.record({
      requestId,
      phase: 'response',
      action: 'blocked',
      category: 'UPSTREAM_ERROR',
      status: 502,
      method: req.method,
      target: requestUrl.pathname,
      code: error.code || 'UPSTREAM_ERROR',
    });
    if (!res.headersSent) {
      sendJson(res, 502, errorBody('metaveil_upstream_error', 'metaveil: upstream request failed'), requestId);
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  upstreamReq.on('response', (upstreamRes) => {
    handleUpstreamResponse(ctx, {
      req,
      res,
      requestId,
      requestUrl,
      upstreamRes,
      contributor,
      kind: allowed.kind,
      upstreamReq,
      restorer: requestRestorer,
    }).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 502, errorBody('metaveil_upstream_error', 'metaveil: response handling failed'), requestId);
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  upstreamReq.end(outgoing);
}

async function forwardModels(ctx, req, res, requestUrl, requestId) {
  const { config, audit } = ctx;
  const target = upstreamTarget(config, requestUrl);
  const headers = buildUpstreamHeaders(requestHeaderObject(req), 0, target);
  req.resume();
  const transport = target.protocol === 'https:' ? https : http;
  const upstreamReq = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: 'GET',
    path: target.path,
    headers,
    agent: false,
  });
  req.on('aborted', () => upstreamReq.destroy());
  upstreamReq.on('error', (error) => {
    audit.record({
      requestId,
      phase: 'response',
      action: 'blocked',
      category: 'UPSTREAM_ERROR',
      status: 502,
      method: 'GET',
      target: requestUrl.pathname,
      code: error.code || 'UPSTREAM_ERROR',
    });
    if (!res.headersSent) {
      sendJson(res, 502, errorBody('metaveil_upstream_error', 'metaveil: upstream request failed'), requestId);
    } else if (!res.writableEnded) {
      res.end();
    }
  });
  upstreamReq.on('response', (upstreamRes) => {
    const status = upstreamRes.statusCode || 502;
    const headersOut = copyResponseHeaders(upstreamRes.headers, { keepLength: true, keepEncoding: true });
    res.writeHead(status, headersOut);
    upstreamRes.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    upstreamRes.pipe(res);
  });
  upstreamReq.end();
}

async function handleUpstreamResponse(ctx, options) {
  const { config, audit, contributorPolicy } = ctx;
  const { req, res, requestId, requestUrl, upstreamRes, contributor, kind, upstreamReq, restorer } = options;
  const status = upstreamRes.statusCode || 502;
  const contentType = String(upstreamRes.headers['content-type'] || '').toLowerCase();

  if (kind === 'models') {
    const headers = copyResponseHeaders(upstreamRes.headers, { keepLength: true, keepEncoding: true });
    res.writeHead(status, headers);
    upstreamRes.pipe(res);
    return;
  }

  const { stream, decoded, supported } = decodeSource(upstreamRes);

  const passthrough = () => {
    const headers = copyResponseHeaders(upstreamRes.headers, { keepLength: true, keepEncoding: true });
    res.writeHead(status, headers);
    stream.pipe(res);
  };

  if (!supported) {
    // Unknown content-encoding: pass through untouched rather than corrupt
    // opaque bytes. No secret material is added by a response.
    passthrough();
    return;
  }

  const isSse = contentType.includes('text/event-stream');
  if (isSse) {
    const headers = copyResponseHeaders(upstreamRes.headers, {
      keepLength: false,
      keepEncoding: !decoded,
    });
    res.writeHead(status, headers);
    res.flushHeaders?.();
    res.socket?.setNoDelay(true);

    const transformer = new SseTransformer({ restorer, contributor });

    try {
      for await (const chunk of stream) {
        if (res.destroyed) break;
        const output = transformer.push(chunk);
        await writeWithBackpressure(res, output);
        if (transformer.terminated) {
          upstreamRes.destroy();
          break;
        }
      }
      if (!transformer.terminated) {
        const tail = transformer.finish();
        await writeWithBackpressure(res, tail);
      }
    } catch {
      // Client or upstream went away. Never log response bodies.
    } finally {
      if (!res.writableEnded) res.end();
      if (!upstreamRes.destroyed) upstreamRes.destroy();
    }
    return;
  }

  const chunks = [];
  try {
    for await (const chunk of stream) chunks.push(chunk);
  } catch {
    if (!res.headersSent) {
      sendJson(res, 502, errorBody('metaveil_upstream_error', 'metaveil: could not read upstream response'), requestId);
    } else if (!res.writableEnded) {
      res.end();
    }
    return;
  }
  const raw = Buffer.concat(chunks);

  const headers = copyResponseHeaders(upstreamRes.headers, {
    keepLength: false,
    keepEncoding: !decoded,
  });

  const isJson = contentType.includes('application/json') || contentType.includes('+json');
  const isText = contentType.startsWith('text/') || contentType.includes('application/x-ndjson');

  if (isJson && raw.length > 0) {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      if (contributor && status >= 200 && status < 300) {
        const verdict = findBlockedCallInResponse(parsed, restorer, contributor);
        if (verdict) {
          blockedCallAudit(audit, { requestId, phase: 'response' }, verdict);
          sendJson(res, 502, errorBody(
            'metaveil_contributor_policy',
            'metaveil: upstream function call blocked by contributor policy',
          ), requestId);
          return;
        }
      }
      const restored = restoreResponseObject(parsed, restorer);
      const body = Buffer.from(JSON.stringify(restored), 'utf8');
      headers['content-type'] = upstreamRes.headers['content-type'] || 'application/json';
      headers['content-length'] = String(body.length);
      res.writeHead(status, headers);
      res.end(body);
      return;
    }
  }

  const looksLikeSse = raw.length > 0 && /^(?:event|data):/.test(raw.toString('utf8').trimStart());
  if (looksLikeSse) {
    headers['content-type'] = 'text/event-stream';
    const transformer = new SseTransformer({ restorer, contributor });
    let output = transformer.push(raw);
    if (!transformer.terminated) output += transformer.finish();
    headers['content-length'] = String(Buffer.byteLength(output));
    res.writeHead(status, headers);
    res.end(output);
    return;
  }

  if (isText && raw.length > 0) {
    const restored = Buffer.from(restorer.restoreText(raw.toString('utf8'), { argsContext: false }), 'utf8');
    headers['content-length'] = String(restored.length);
    res.writeHead(status, headers);
    res.end(restored);
    return;
  }

  headers['content-length'] = String(raw.length);
  res.writeHead(status, headers);
  res.end(raw);
  void req;
  void requestUrl;
  void upstreamReq;
}

export async function createProxyServer(options = {}) {
  const config = options.config;
  if (!config) throw new Error('createProxyServer requires a normalized config');
  const audit = options.audit || (config.auditPath ? new AuditLog(config.auditPath) : new NullAuditLog());
  const store = options.store || await TokenStore.open({ mapPath: config.mapPath, persist: true });
  const pipeline = options.pipeline || createPipeline({
    config,
    detectors: createDetectors(config),
    extraDetectors: options.extraDetectors || [],
    remoteDetector: options.remoteDetector || null,
  });
  const redactor = options.redactor || createRedactor({ config, store, pipeline, audit });
  const ctx = {
    config,
    audit,
    store,
    pipeline,
    redactor,
    contributorPolicy: config.contributorPolicy,
    verifiedSessions: createVerifiedSessions(),
  };

  const server = http.createServer((req, res) => {
    handleProxyRequest(ctx, req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, errorBody('metaveil_internal_error', 'metaveil: internal error'), null);
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  return {
    server,
    runtime: ctx,
    async listen(port = config.port) {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      return { port: actualPort, url: `http://127.0.0.1:${actualPort}` };
    },
    async close() {
      try {
        await store.flush();
      } catch {
        // ignore flush failures on shutdown
      }
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
