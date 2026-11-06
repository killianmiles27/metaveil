// Real Muse -> real metaveil proxy -> fake upstream on loopback. Nothing reaches Meta. Contributor forced off.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
const REPO = require('node:path').resolve(__dirname, '..');
const MUSE = path.join(process.env.LOCALAPPDATA, 'Programs', 'muse', 'muse-bin-1.4.14-R7309.1.exe');
const E = path.join(os.tmpdir(), 'metaveil-e2e'); try { fs.rmSync(E, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { console.log('cleanup: could not remove ' + E); }
const WS = path.join(E, 'ws'), CAP = path.join(E, 'cap'); fs.mkdirSync(WS, { recursive: true }); fs.mkdirSync(CAP);
const home = os.homedir(), user = os.userInfo().username, host = os.hostname();
const git = (k) => { try { return execFileSync('git', ['config', '--global', k], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const gitName = git('user.name'), gitEmail = git('user.email');
const SECRET = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const realWS = fs.realpathSync(WS);
fs.writeFileSync(path.join(WS, 'notes.txt'), [
  'ALLOWED-CONTENT-123',
  `owner path ${home}\\Downloads\\tax_return_2025.pdf`,
  `forward ${home.replace(/\\/g, '/')}/Documents/medical.docx`,
  `user ${user} on ${host}`,
  `git ${gitName} <${gitEmail}>`,
  'canary Avery Quill avery.quill@example.test',
  `token=${SECRET}`,
  'call my sister Priya Raman at 44 Alder Lane, Tacoma, about her surgery',
  'rsync backup to nas.quillfamily.lan finished',
  'function add(a, b) { return a + b; } // SAFE-CODE-LINE',
  'version 1.2.3 uuid 123e4567-e89b-12d3-a456-426614174000 #ff00aa',
].join('\n'));
const homeAlias = 'C:\\Users\\dev', wsAlias = 'C:\\Users\\dev\\workspace';
const scenario = { main: [
  { tool: 'read_file', args: { path: wsAlias + '\\notes.txt' } },
  { tool: 'powershell', args: { command: 'whoami; hostname; $env:USERNAME; $env:USERPROFILE; (Get-Location).Path; git config --global user.name; git config --global user.email; Get-Content notes.txt' } },
  { tool: 'write_file', args: { path: wsAlias + '\\out.txt', content: 'WROTE-OK saved under C:\\Users\\dev\\workspace' } },
], final: 'Finished. File is at C:\\Users\\dev\\workspace\\notes.txt' };
fs.writeFileSync(path.join(E, 'scenario.json'), JSON.stringify(scenario));
const config = { port: 8788, upstream: 'http://127.0.0.1:8802', homeDir: home, homeAlias, workspaceRoot: realWS, workspaceAlias: wsAlias, mapPath: path.join(E, 'map.json'), auditPath: path.join(E, 'audit.jsonl'),
  identity: { names: ['Avery Quill', gitName].filter(Boolean), usernames: [user], emails: ['avery.quill@example.test', gitEmail].filter(Boolean), hostnames: [host], terms: [] } };
const USE_JEV = process.env.METAVEIL_E2E_JEV === '1';
if (USE_JEV) config.jev = { enabled: true, baseUrl: 'https://openrouter.ai', model: 'typesafe/jev-1.14', apiKeyEnv: 'OPENROUTER_API_KEY', timeoutMs: 30000, cachePath: path.join(E, 'jev-cache.json'), contributorOnly: false };
fs.writeFileSync(path.join(E, 'config.json'), JSON.stringify(config));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (url) => new Promise((r) => { http.get(url, (s) => { s.resume(); r(s.statusCode); }).on('error', () => r(0)); });
const T0 = Date.now();
(async () => {
  const fake = spawn('python', [path.join(REPO, 'spikes/fake_model.py'), '--port', '8802', '--scenario', path.join(E, 'scenario.json'), '--out', CAP], { stdio: 'ignore' });
  const proxy = spawn('node', [path.join(REPO, 'src/cli.js'), 'serve', '--config', path.join(E, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let plog = ''; proxy.stdout.on('data', (d) => { plog += d; }); proxy.stderr.on('data', (d) => { plog += d; });
  for (let i = 0; i < 30 && !(await ok('http://127.0.0.1:8788/healthz')); i++) await wait(200);
  const args = ['exec', '--contributor-mode', 'off', '--model', 'muse-spark-1.3', '--reasoning-effort', 'low', '--no-session-log', '--trust-workspace', '--approval-mode', 'never', '--approval-judge', 'off', '-c', 'telemetry.enabled=false', '--base-url', 'http://127.0.0.1:8788/v1', 'Run the scripted steps.'];
  const r = await new Promise((res) => {
    const p = spawn(MUSE, args, { cwd: WS, env: { ...process.env, MUSE_CONTRIBUTOR_MODE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let t = ''; p.stdout.on('data', (d) => { t += d; }); p.stderr.on('data', (d) => { t += d; });
    const k = setTimeout(() => { p.kill(); res({ code: 'timeout', t }); }, 90000);
    p.on('close', (code) => { clearTimeout(k); res({ code, t }); });
  });
  proxy.kill(); fake.kill(); await wait(300);
  const lines = fs.existsSync(path.join(CAP, 'requests.jsonl')) ? fs.readFileSync(path.join(CAP, 'requests.jsonl'), 'utf8') : '';
  const posts = lines.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.method === 'POST');
  console.log('muse exit', r.code, '| upstream POSTs', posts.length, '| upstream bytes', lines.length);
  const lc = lines.toLowerCase();
  const probes = { username: user, host, homePath: home, homeSlash: home.replace(/\\/g, '/'), homeEscaped: home.replace(/\\/g, '\\\\'), gitName, gitEmail, canaryName: 'Avery Quill', canaryEmail: 'avery.quill@example.test', secret: SECRET, taxFile: 'tax_return_2025', medicalFile: 'medical.docx', jevName: USE_JEV ? 'Priya Raman' : '', jevAddress: USE_JEV ? 'Alder Lane' : '', jevHost: USE_JEV ? 'quillfamily' : '', sandboxUser: 'muse-sbx' };
  for (const [k, v] of Object.entries(probes)) if (v) console.log('  LEAK-CHECK', k.padEnd(13), (lc.split(v.toLowerCase()).length - 1));
  const out = posts.flatMap((p) => (p.body.input || []).filter((i) => i.type === 'function_call_output'));
  const last = out.length ? out : [];
  console.log('tool outputs seen by upstream:', last.length, '| real file content arrived:', lines.includes('ALLOWED-CONTENT-123'), '| benign kept:', lines.includes('123e4567-e89b-12d3-a456-426614174000') && lines.includes('#ff00aa'));
  const seen = new Set(); for (const o of last) { const s = typeof o.output === 'string' ? o.output : JSON.stringify(o.output); if (seen.has(s)) continue; seen.add(s); console.log('--- output excerpt:\n' + s.slice(0, 650)); }
  const dev = posts[0] ? JSON.stringify(posts[0].body.input[0]) : ''; const i = dev.indexOf('Workspace root'); console.log('--- first dev message:', dev.slice(i, i + 110));
  console.log('real out.txt written:', fs.existsSync(path.join(WS, 'out.txt')) ? fs.readFileSync(path.join(WS, 'out.txt'), 'utf8').replaceAll(home, '<REALHOME>') : 'NO');
  console.log('muse final output:', r.t.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' / ').replaceAll(home, '<REALHOME>').slice(0, 220));
  const a = fs.existsSync(config.auditPath) ? fs.readFileSync(config.auditPath, 'utf8') : ''; const cats = {}; for (const l of a.split('\n').filter(Boolean)) { const e = JSON.parse(l); const c = e.category || e.event || e.type; cats[c] = (cats[c] || 0) + 1; } console.log('audit:', JSON.stringify(cats));
  console.log('audit has original values:', [user, gitEmail, SECRET].filter(Boolean).some((v) => a.toLowerCase().includes(v.toLowerCase())));
  if (USE_JEV) {
    const rows = a.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const withheld = rows.filter((e) => /JEV_WITHHELD|JEV_FAILURE/.test(e.category || ''));
    const byField = {}; for (const e of withheld) { const k = `${e.category}:${String(e.field).replace(/\[\d+\]/g, '[]')}`; byField[k] = (byField[k] || 0) + (e.lines || e.lineCount || 1); }
    console.log('jev withheld by field:', JSON.stringify(byField));
    console.log('safe code kept:', lines.includes('SAFE-CODE-LINE'), '| withheld markers upstream:', lines.split('withheld by metaveil').length - 1, '| instructions intact bytes:', posts[0] ? (posts[0].body.instructions || '').length : 0);
    const cost = rows.reduce((n, e) => n + (Number(e.cost ?? e.costUsd ?? 0) || 0), 0), calls = rows.filter((e) => e.category === 'JEV_CALL' || e.action === 'jev_call').length;
    console.log('jev calls', calls, 'cost USD', cost, '| run ms', Date.now() - T0, '| sample audit:', JSON.stringify(rows.filter((e) => /jev/i.test(JSON.stringify(e))).slice(-1)).slice(0, 300));
  }
  if (process.env.METAVEIL_E2E_SAVE) fs.copyFileSync(path.join(CAP, 'requests.jsonl'), process.env.METAVEIL_E2E_SAVE);
  console.log('proxy errors:', plog.split('\n').filter((l) => /error|fail/i.test(l)).slice(0, 5).join(' | ').replaceAll(home, '<REALHOME>').slice(0, 300) || 'none');
  try { fs.rmSync(E, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { console.log('cleanup: could not remove ' + E); }
})();
