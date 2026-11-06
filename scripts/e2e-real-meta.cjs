// One real Spark run through the proxy to real Meta, Contributor off.
// Chain: Muse -> metaveil proxy -> local recording tap -> https://api.meta.ai
// The tap refuses any POST not marked x-tbh-contributor-mode: 0 and stores bodies only, never headers.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), https = require('https');
const { spawn, execFile } = require('child_process');
const REPO = path.resolve(__dirname, '..');
const MUSE = path.join(process.env.LOCALAPPDATA, 'Programs', 'muse', 'muse-bin-1.4.14-R7309.1.exe');
const E = path.join(os.tmpdir(), 'metaveil-real');
fs.rmSync(E, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
const WS = path.join(E, 'ws'); fs.mkdirSync(WS, { recursive: true });
const home = os.homedir(), user = os.userInfo().username, host = os.hostname();
const SECRET = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
fs.writeFileSync(path.join(WS, 'notes.txt'), [
  'ALLOWED-CONTENT-123',
  `owner path ${home}\\Downloads\\tax_return_2025.pdf`,
  `user ${user} on ${host}`,
  'canary Avery Quill avery.quill@example.test',
  `token=${SECRET}`,
  'call my sister Priya Raman at 44 Alder Lane, Tacoma, about her surgery',
  'function add(a, b) { return a + b; } // SAFE-CODE-LINE',
].join('\n'));
const config = { port: 8788, upstream: 'http://127.0.0.1:8805', homeDir: home, homeAlias: 'C:\\Users\\dev', workspaceAlias: 'C:\\Users\\dev\\workspace', mapPath: path.join(E, 'map.json'), auditPath: path.join(E, 'audit.jsonl'),
  identity: { names: ['Avery Quill'], usernames: [user], emails: ['avery.quill@example.test'], hostnames: [host], terms: [] },
  jev: { enabled: true, baseUrl: 'https://openrouter.ai', model: 'typesafe/jev-1.14', apiKeyEnv: 'OPENROUTER_API_KEY', timeoutMs: 30000, cachePath: path.join(E, 'jev-cache.json'), contributorOnly: false } };
fs.writeFileSync(path.join(E, 'config.json'), JSON.stringify(config));

const posts = [], seen = { get: [], refused: 0, headers: new Set(), contributor: new Set(), statuses: [] };
const tap = http.createServer((q, s) => {
  const chunks = []; q.on('data', (d) => chunks.push(d));
  q.on('end', () => {
    const body = Buffer.concat(chunks);
    if (q.method === 'POST') {
      seen.contributor.add(String(q.headers['x-tbh-contributor-mode']));
      if (q.headers['x-tbh-contributor-mode'] !== '0') { seen.refused++; s.writeHead(403); s.end('{"error":{"message":"tap refused: contributor not off"}}'); return; }
      posts.push(body.toString('utf8'));
    } else seen.get.push(q.url);
    const headers = { ...q.headers, host: 'api.meta.ai' }; delete headers.connection;
    const up = https.request({ host: 'api.meta.ai', path: q.url, method: q.method, headers }, (r) => { seen.statuses.push(r.statusCode); s.writeHead(r.statusCode, r.headers); r.pipe(s); });
    up.on('error', (e) => { s.writeHead(502); s.end(String(e.code)); });
    up.end(body);
  });
});
const remotes = new Set();
const sample = (pid) => new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -OwningProcess ${pid} -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -notmatch '^(127\\.|::1|0\\.0\\.0\\.0|::$)' } | ForEach-Object { "$($_.RemoteAddress):$($_.RemotePort)" }`], { timeout: 4000 }, (e, o) => res((o || '').split(/\r?\n/).filter(Boolean))));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (url) => new Promise((r) => { http.get(url, (s) => { s.resume(); r(s.statusCode); }).on('error', () => r(0)); });
(async () => {
  await new Promise((r) => tap.listen(8805, '127.0.0.1', r));
  const proxy = spawn('node', [path.join(REPO, 'src/cli.js'), 'serve', '--config', path.join(E, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let plog = ''; proxy.stdout.on('data', (d) => { plog += d; }); proxy.stderr.on('data', (d) => { plog += d; });
  for (let i = 0; i < 30 && !(await ok('http://127.0.0.1:8788/healthz')); i++) await wait(200);
  const prompt = 'Read notes.txt in this folder. Then create a file named result.txt containing a one-sentence summary of what notes.txt is, using only what you can see. Then say DONE.';
  const args = ['exec', '--contributor-mode', 'off', '--model', 'muse-spark-1.3', '--reasoning-effort', 'low', '--no-session-log', '--trust-workspace', '--disable-approval', '-c', 'telemetry.enabled=false', '--base-url', 'http://127.0.0.1:8788/v1', prompt];
  const t0 = Date.now();
  const p = spawn(MUSE, args, { cwd: WS, env: { ...process.env, MUSE_CONTRIBUTOR_MODE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let t = ''; p.stdout.on('data', (d) => { t += d; }); p.stderr.on('data', (d) => { t += d; });
  let done = false;
  const poll = (async () => { while (!done) for (const r of await sample(p.pid)) remotes.add(r); })();
  const code = await new Promise((res) => { const k = setTimeout(() => { p.kill(); res('timeout'); }, 240000); p.on('close', (c) => { clearTimeout(k); res(c); }); });
  done = true; await poll; proxy.kill(); tap.close(); await wait(300);
  const all = posts.join('\n'), lc = all.toLowerCase();
  console.log('muse exit', code, '| seconds', Math.round((Date.now() - t0) / 1000), '| POSTs to Meta', posts.length, '| bytes', all.length, '| GETs', seen.get.join(','));
  console.log('contributor header values:', [...seen.contributor].join(','), '| refused by tap:', seen.refused, '| upstream statuses:', [...new Set(seen.statuses)].join(','));
  console.log('non-loopback connections from the Muse process:', [...remotes].join(', ') || 'none seen');
  for (const [k, v] of Object.entries({ username: user, host, homePath: home, homeSlash: home.replace(/\\/g, '/'), homeEscaped: home.replace(/\\/g, '\\\\'), canaryName: 'Avery Quill', canaryEmail: 'avery.quill@example.test', secret: SECRET, taxFile: 'tax_return_2025', sister: 'Priya Raman', address: 'Alder Lane', sandboxUser: 'muse-sbx' })) console.log('  LEAK-CHECK', k.padEnd(12), lc.split(v.toLowerCase()).length - 1);
  console.log('safe code reached model:', all.includes('SAFE-CODE-LINE'), '| withheld markers:', all.split('withheld by metaveil').length - 1);
  const rf = path.join(WS, 'result.txt');
  console.log('result.txt:', fs.existsSync(rf) ? fs.readFileSync(rf, 'utf8').replaceAll(home, '<REALHOME>').slice(0, 300) : 'NOT CREATED');
  console.log('muse output tail:', t.split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join(' / ').replaceAll(home, '<REALHOME>').replaceAll(user, '<USER>').slice(0, 500));
  const rows = fs.readFileSync(config.auditPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const cats = {}; let cost = 0; for (const e of rows) { cats[e.category] = (cats[e.category] || 0) + 1; cost += Number(e.cost || 0); }
  console.log('audit:', JSON.stringify(cats), '| jev cost USD', cost.toFixed(5));
  console.log('proxy log errors:', plog.split('\n').filter((l) => /error|fail/i.test(l)).slice(0, 4).join(' | ').slice(0, 300) || 'none');
  try { fs.rmSync(E, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { console.log('cleanup: could not remove ' + E); }
  process.exit(0);
})();
