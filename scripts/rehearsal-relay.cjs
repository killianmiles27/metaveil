// Dress rehearsal for Contributor mode. Sits between the metaveil proxy and real Meta:
//   Muse (Contributor on) -> metaveil proxy (enforcing) -> this relay -> api.meta.ai
// The relay turns Contributor OFF on the way out, so nothing is offered for training,
// and records every outgoing body so it can be searched for leaks afterwards.
// It never records or prints request headers, because they carry the login.
const http = require('http'), https = require('https'), fs = require('fs');

const PORT = Number(process.argv[2] || 8805);
const LOG = process.argv[3];
if (!LOG) throw new Error('usage: rehearsal-relay.cjs <port> <log file>');
const UPSTREAM = 'api.meta.ai';
const SUFFIX = '-contributor';
// --passthrough records only: requests reach Meta exactly as metaveil sent them.
const PASSTHROUGH = process.argv.includes('--passthrough');

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    if (!PASSTHROUGH && body.length && /json/i.test(req.headers['content-type'] || '')) {
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        if (typeof parsed.model === 'string' && parsed.model.endsWith(SUFFIX)) parsed.model = parsed.model.slice(0, -SUFFIX.length);
        body = Buffer.from(JSON.stringify(parsed));
      } catch { /* forwarded as is */ }
    }
    fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), method: req.method, path: req.url, contributorHeaderFromMuse: req.headers['x-tbh-contributor-mode'] ?? null, body: body.toString('utf8') })}\n`);
    const headers = { ...req.headers, host: UPSTREAM, 'content-length': String(body.length) };
    if (!PASSTHROUGH) headers['x-tbh-contributor-mode'] = '0';
    delete headers['accept-encoding'];
    delete headers.connection;
    const out = https.request({ host: UPSTREAM, port: 443, path: req.url, method: req.method, headers }, (up) => {
      const isModels = !PASSTHROUGH && /\/models(\?|$)/.test(req.url) && up.statusCode === 200;
      if (!isModels) { res.writeHead(up.statusCode, up.headers); up.pipe(res); return; }
      // Muse asks for the -contributor model, so the list has to offer it.
      const parts = [];
      up.on('data', (d) => parts.push(d));
      up.on('end', () => {
        let text = Buffer.concat(parts).toString('utf8');
        try {
          const list = JSON.parse(text);
          const key = Array.isArray(list.data) ? 'data' : (Array.isArray(list.models) ? 'models' : null);
          if (key) {
            const ids = new Set(list[key].map((m) => m && m.id));
            const extra = list[key].filter((m) => m && typeof m.id === 'string' && !m.id.endsWith(SUFFIX) && !ids.has(`${m.id}${SUFFIX}`)).map((m) => ({ ...m, id: `${m.id}${SUFFIX}` }));
            list[key] = [...list[key], ...extra];
            text = JSON.stringify(list);
          }
        } catch { /* passed through */ }
        const h = { ...up.headers, 'content-length': String(Buffer.byteLength(text)) };
        res.writeHead(200, h);
        res.end(text);
      });
    });
    out.on('error', () => { res.writeHead(502); res.end('rehearsal relay: upstream error'); });
    out.end(body);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`relay on ${PORT}, ${PASSTHROUGH ? 'recording only' : 'Contributor forced off upstream'}`));
