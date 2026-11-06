import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  buildMuseArgs,
  escapeForPowerShellNative,
  hookCommandFor,
  contributorGate,
  ensureProxy,
  fetchProxyHealth,
  loadLauncherConfig,
  resolveProxyApiKey,
  runLauncher,
  spawnRealMuse,
} from '../src/install/launcher.js';
import { statusAcl } from '../src/install/acl.js';
import { planInstall } from '../src/install/index.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startHealthProxy() {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"jevReady":true}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function writeFakeMuse(dir, argsFile) {
  const js = path.join(dir, 'fake-muse.cjs');
  fs.writeFileSync(js, "const fs=require('node:fs');fs.writeFileSync(process.env.FAKE_MUSE_ARGS, JSON.stringify(process.argv.slice(2)));\n");
  const cmd = path.join(dir, 'fake-muse.cmd');
  fs.writeFileSync(cmd, '@echo off\r\nnode "%~dp0fake-muse.cjs" %*\r\n');
  return { cmd, js, argsFile };
}

function writeLauncherConfig(home, { port, museReal, contributor = false, proxyArgs = null }) {
  const dir = path.join(home, 'metaveil');
  fs.mkdirSync(dir, { recursive: true });
  const proxyConfigPath = path.join(dir, 'proxy-config.json');
  fs.writeFileSync(proxyConfigPath, JSON.stringify({
    jev: { enabled: true, apiKeyEnv: 'METAVEIL_LAUNCHER_TEST_KEY' },
  }, null, 2));
  const config = {
    port,
    proxyConfigPath,
    museReal,
    hookPath: path.join(dir, 'hook', 'policy.cjs'),
    hookConfigPath: path.join(dir, 'hook', 'hook-policy.json'),
    aclStatePath: path.join(dir, 'acl-state.json'),
    installStatePath: path.join(dir, 'install-state.json'),
    contributorMarkerPath: path.join(dir, 'contributor-leak-test.ok'),
    contributor: { enabled: contributor },
    apiKeyCommand: [process.execPath, '-e', "process.stdout.write('test-key')"],
    proxyStartTimeoutMs: 1200,
  };
  if (proxyArgs) {
    config.proxyCommand = process.execPath;
    config.proxyArgs = proxyArgs;
  }
  fs.writeFileSync(path.join(dir, 'launcher.json'), JSON.stringify(config, null, 2));
  return { dir, config };
}

function fakeAclRunner(command, args) {
  if (command === 'icacls' && args.length === 1) {
    return { code: 0, stdout: 'MuseSandboxUsers:(OI)(CI)(DENY)(RX)', stderr: '' };
  }
  return { code: 0, stdout: '', stderr: '' };
}

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function writeFakeProxy(dir) {
  const file = path.join(dir, 'fake-proxy.cjs');
  fs.writeFileSync(file, `const http=require('node:http');
const fs=require('node:fs');
fs.writeFileSync(process.env.FAKE_PROXY_KEY_FILE, JSON.stringify({key: process.env.OPENROUTER_API_KEY || null}));
const server=http.createServer((req,res)=>{
  if(req.url==='/healthz'){res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true,"jevReady":true}');return;}
  res.writeHead(404);res.end();
});
server.listen(Number(process.env.FAKE_PROXY_PORT),'127.0.0.1');
setTimeout(()=>process.exit(0), 5000);
`);
  return file;
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  setImmediate(() => child.emit('exit', 0, null));
  return child;
}

import { mergeHooks, watchProxy } from '../src/install/launcher.js';

test('buildMuseArgs translates --yolo, pins the proxy and telemetry, and refuses unsafe flags', () => {
  const args = buildMuseArgs({ userArgs: ['--yolo', 'hello world'], port: 8787, contributorMode: 'off' });
  assert.deepEqual(args.slice(0, 6), ['--base-url', 'http://127.0.0.1:8787/v1', '-c', 'telemetry.enabled=false', '--contributor-mode', 'off']);
  assert.ok(args.includes('--disable-approval'));
  assert.ok(args.includes('--trust-workspace'));
  assert.ok(!args.includes('--yolo'));
  assert.throws(() => buildMuseArgs({ userArgs: ['--disable-sandbox'], port: 8787 }), (error) => error.code === 'UNSAFE_FLAG');
  assert.throws(() => buildMuseArgs({ userArgs: ['--sandbox-network', 'unrestricted'], port: 8787 }), (error) => error.code === 'UNSAFE_FLAG');
  const exec = buildMuseArgs({ userArgs: ['exec', '--yolo', 'hello'], port: 8787, contributorMode: 'on' });
  assert.equal(exec[0], 'exec');
  assert.ok(exec.includes('--contributor-mode') && exec.includes('on'));
});

test('the hook command has no quotes, because Muse silently never runs one that does', () => {
  assert.equal(hookCommandFor('C:\\Users\\me\\AppData\\Local\\metaveil\\hook\\policy.cjs'), 'node C:/Users/me/AppData/Local/metaveil/hook/policy.cjs');
});

test('only Contributor runs carry the hook, and users cannot override it', () => {
  const off = buildMuseArgs({ userArgs: ['hello'], port: 8787, contributorMode: 'off', hookCommand: '"node" "h.cjs"' });
  assert.ok(!off.some((arg) => arg.startsWith('hooks=')));
  const on = buildMuseArgs({ userArgs: ['-c', 'hooks={}', 'hello'], port: 8787, contributorMode: 'on', hookCommand: '"node" "h.cjs"' });
  assert.equal(on.filter((arg) => arg.startsWith('hooks=')).length, 1);
  assert.ok(!on.includes('hooks={}'));
});

test('arguments are escaped for the Windows PowerShell 5.1 native call', () => {
  assert.equal(escapeForPowerShellNative('plain'), 'plain');
  assert.equal(escapeForPowerShellNative('a"b'), 'a\\"b');
  assert.equal(escapeForPowerShellNative('a\\"b'), 'a\\\\\\"b');
  assert.throws(() => escapeForPowerShellNative('say "hi" --disable-sandbox'), (error) => error.code === 'UNSAFE_ARG');
  assert.equal(escapeForPowerShellNative('C:\\my dir\\'), 'C:\\my dir\\\\');
  assert.equal(escapeForPowerShellNative('C:\\dir\\'), 'C:\\dir\\');
});

test('buildMuseArgs leaves management commands free of model flags', () => {
  for (const sub of ['usage', 'skills', 'config', 'plugins', 'auth', 'sandbox', 'export', 'trace', 'model-profile']) {
    assert.deepEqual(buildMuseArgs({ userArgs: [sub, 'list'], port: 8787 }), [sub, 'list']);
  }
  assert.ok(buildMuseArgs({ userArgs: ['resume', '--last'], port: 8787 }).includes('--base-url'));
  assert.throws(() => buildMuseArgs({ userArgs: ['usage', '--disable-sandbox'], port: 8787 }), (error) => error.code === 'UNSAFE_FLAG');
});

test('runLauncher uses the fake Muse and passes the translated arguments', async () => {
  const home = tempDir('metaveil-launch-');
  const fakeDir = tempDir('metaveil-fake-muse-');
  const argsFile = path.join(fakeDir, 'args.json');
  const fake = writeFakeMuse(fakeDir, argsFile);
  const proxy = await startHealthProxy();
  const previousHome = process.env.METAVEIL_HOME;
  const previousArgs = process.env.FAKE_MUSE_ARGS;
  try {
    writeLauncherConfig(home, { port: proxy.port, museReal: fake.cmd, contributor: false });
    process.env.METAVEIL_HOME = path.join(home, 'metaveil');
    process.env.FAKE_MUSE_ARGS = argsFile;
    const code = await runLauncher(['--yolo', 'hello world']);
    assert.equal(code, 0);
    const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.ok(args.includes('--disable-approval'));
    assert.ok(args.includes('--trust-workspace'));
    assert.ok(args.includes('--base-url'));
    assert.ok(args.includes(`http://127.0.0.1:${proxy.port}/v1`));
    assert.ok(args.includes('-c') && args.includes('telemetry.enabled=false'));
    assert.ok(args.includes('--contributor-mode') && args.includes('off'));
    assert.ok(!args.includes('--yolo'));
  } finally {
    if (previousHome === undefined) delete process.env.METAVEIL_HOME; else process.env.METAVEIL_HOME = previousHome;
    if (previousArgs === undefined) delete process.env.FAKE_MUSE_ARGS; else process.env.FAKE_MUSE_ARGS = previousArgs;
    await new Promise((resolve) => proxy.server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

test('runLauncher refuses recursion and a dead proxy before starting Muse', async () => {
  const home = tempDir('metaveil-launch-bad-');
  const fakeDir = tempDir('metaveil-fake-muse-');
  const argsFile = path.join(fakeDir, 'args.json');
  const fake = writeFakeMuse(fakeDir, argsFile);
  const previousHome = process.env.METAVEIL_HOME;
  const previousArgs = process.env.FAKE_MUSE_ARGS;
  try {
    const self = path.join(repoRoot, 'bin', 'muse.cmd');
    writeLauncherConfig(home, { port: 9, museReal: self });
    process.env.METAVEIL_HOME = path.join(home, 'metaveil');
    process.env.FAKE_MUSE_ARGS = argsFile;
    await assert.rejects(() => runLauncher(['hello']), (error) => error.code === 'RECURSION');

    const failProxy = path.join(fakeDir, 'fail-proxy.cjs');
    fs.writeFileSync(failProxy, 'process.exit(1);\n');
    writeLauncherConfig(home, { port: 9, museReal: fake.cmd, proxyArgs: [failProxy] });
    await assert.rejects(() => runLauncher(['hello']), (error) => error.code === 'PROXY_UNHEALTHY');
    assert.equal(fs.existsSync(argsFile), false, 'Muse must not start when the proxy is down');
  } finally {
    if (previousHome === undefined) delete process.env.METAVEIL_HOME; else process.env.METAVEIL_HOME = previousHome;
    if (previousArgs === undefined) delete process.env.FAKE_MUSE_ARGS; else process.env.FAKE_MUSE_ARGS = previousArgs;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

test('contributor gate requires enabled + proxy + jev + hook + clean ACL and otherwise passes off', async () => {
  const home = tempDir('metaveil-gate-');
  const fakeDir = tempDir('metaveil-fake-muse-');
  const argsFile = path.join(fakeDir, 'args.json');
  const fake = writeFakeMuse(fakeDir, argsFile);
  const proxy = await startHealthProxy();
  const previousHome = process.env.METAVEIL_HOME;
  const previousArgs = process.env.FAKE_MUSE_ARGS;
  const documents = path.join(home, 'Documents');
  fs.mkdirSync(documents, { recursive: true });
  const aclState = path.join(home, 'metaveil', 'acl-state.json');
  try {
    const { config } = writeLauncherConfig(home, { port: proxy.port, museReal: fake.cmd, contributor: true });
    // Contributor runs pass a JSON argument, which only the PowerShell route can carry.
    fs.writeFileSync(path.join(path.dirname(fake.cmd), '.muse-launcher.ps1'), `& "${process.execPath}" "${fake.js}" @args\nexit $LASTEXITCODE\n`);
    process.env.METAVEIL_HOME = path.join(home, 'metaveil');
    process.env.FAKE_MUSE_ARGS = argsFile;
    let gate = contributorGate(config, { proxyHealthy: true, jevReady: true, runCommand: fakeAclRunner });
    assert.equal(gate.on, false);
    assert.ok(gate.reasons.length > 0);

    fs.mkdirSync(path.join(home, 'metaveil', 'hook'), { recursive: true });
    fs.writeFileSync(path.join(home, 'metaveil', 'hook', 'policy.cjs'), '');
    fs.writeFileSync(path.join(home, 'metaveil', 'install-state.json'), JSON.stringify({ hooksInstalled: true }));
    fs.writeFileSync(path.join(home, 'metaveil', 'contributor-leak-test.ok'), 'ok');
    fs.writeFileSync(aclState, JSON.stringify({
      version: 1,
      applied: [{ path: documents, kind: 'dir', principal: 'MuseSandboxUsers', ace: '(OI)(CI)(RX)' }],
    }));
    gate = contributorGate(config, { proxyHealthy: true, jevReady: true, runCommand: fakeAclRunner });
    assert.equal(gate.on, true, gate.reasons.join('; '));

    const code = await runLauncher(['hello'], process.env, { runCommand: fakeAclRunner });
    assert.equal(code, 0);
    const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.ok(args.includes('--contributor-mode') && args.includes('on'));
    const hooks = args.find((arg) => arg.startsWith('hooks='));
    assert.ok(hooks, 'Contributor runs must carry the hook');
    const handler = JSON.parse(hooks.slice('hooks='.length)).PreToolUse[0].hooks[0];
    assert.ok(handler.command.includes('policy.cjs'));

    gate = contributorGate(config, { proxyHealthy: true, jevReady: false, runCommand: fakeAclRunner });
    assert.equal(gate.on, false);
    assert.ok(gate.reasons.includes('jev key unavailable'));

    fs.rmSync(path.join(home, 'metaveil', 'contributor-leak-test.ok'));
    gate = contributorGate(config, { proxyHealthy: true, jevReady: true, runCommand: fakeAclRunner });
    assert.equal(gate.on, false);
    assert.ok(gate.reasons.includes('leak-test marker is missing'));
  } finally {
    if (previousHome === undefined) delete process.env.METAVEIL_HOME; else process.env.METAVEIL_HOME = previousHome;
    if (previousArgs === undefined) delete process.env.FAKE_MUSE_ARGS; else process.env.FAKE_MUSE_ARGS = previousArgs;
    await new Promise((resolve) => proxy.server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

test('bin/muse.cmd forwards to the launcher without recursing', async () => {
  const home = tempDir('metaveil-cmd-');
  const fakeDir = tempDir('metaveil-fake-muse-');
  const argsFile = path.join(fakeDir, 'args.json');
  const fake = writeFakeMuse(fakeDir, argsFile);
  const proxy = await startHealthProxy();
  const previousHome = process.env.METAVEIL_HOME;
  const previousArgs = process.env.FAKE_MUSE_ARGS;
  try {
    writeLauncherConfig(home, { port: proxy.port, museReal: fake.cmd, contributor: false });
    const env = { ...process.env, METAVEIL_HOME: path.join(home, 'metaveil'), FAKE_MUSE_ARGS: argsFile };
    const result = await new Promise((resolve) => {
      const child = spawn(path.join(repoRoot, 'bin', 'muse.cmd'), ['--yolo', 'hello'], { shell: true, env });
      let err = '';
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('exit', (code) => resolve({ code, stderr: err }));
    });
    assert.equal(result.code, 0, result.stderr);
    const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.ok(args.includes('--disable-approval'));
    assert.ok(args.includes('--base-url'));
    assert.ok(args.includes(`http://127.0.0.1:${proxy.port}/v1`));
  } finally {
    if (previousHome === undefined) delete process.env.METAVEIL_HOME; else process.env.METAVEIL_HOME = previousHome;
    if (previousArgs === undefined) delete process.env.FAKE_MUSE_ARGS; else process.env.FAKE_MUSE_ARGS = previousArgs;
    await new Promise((resolve) => proxy.server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

test('resolveProxyApiKey uses the configured command, maps pi to pi.exe, and never puts the key in argv', () => {
  const calls = [];
  const result = resolveProxyApiKey({
    apiKeyCommand: ['pi', 'auth', 'print-api-key', '--provider', 'openrouter'],
  }, {
    env: {},
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '  command-secret\n', stderr: '' };
    },
  });
  assert.equal(result.key, 'command-secret');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.platform === 'win32' ? 'pi.exe' : 'pi');
  assert.deepEqual(calls[0].args, ['auth', 'print-api-key', '--provider', 'openrouter']);
  assert.ok(!JSON.stringify(calls[0].args).includes('command-secret'));
  assert.equal(calls[0].options.env.OPENROUTER_API_KEY, undefined);
});

test('resolveProxyApiKey prefers the environment and reports command failure without leaking stdout', () => {
  const fromEnv = resolveProxyApiKey({ apiKeyCommand: ['pi'] }, {
    env: { OPENROUTER_API_KEY: 'env-secret' },
    runCommand: () => { throw new Error('must not run'); },
  });
  assert.equal(fromEnv.key, 'env-secret');
  const failed = resolveProxyApiKey({ apiKeyCommand: ['pi'] }, {
    env: {},
    runCommand: () => ({ code: 7, stdout: 'should-not-leak', stderr: 'nope' }),
  });
  assert.equal(failed.key, null);
  assert.match(failed.reason, /code 7/);
  assert.ok(!failed.reason.includes('should-not-leak'));
});

test('ensureProxy passes a command key only through the child proxy environment', async () => {
  const dir = tempDir('metaveil-proxy-key-');
  const keyFile = path.join(dir, 'child-key.json');
  const port = await freePort();
  const proxyScript = writeFakeProxy(dir);
  const stderr = [];
  try {
    const result = await ensureProxy({
      port,
      proxyCommand: process.execPath,
      proxyArgs: [proxyScript],
      proxyConfigPath: path.join(dir, 'proxy-config.json'),
      proxyStartTimeoutMs: 3000,
      apiKeyCommand: ['pi', 'auth', 'print-api-key', '--provider', 'openrouter'],
    }, {
      env: { FAKE_PROXY_KEY_FILE: keyFile, FAKE_PROXY_PORT: String(port) },
      runCommand: () => ({ code: 0, stdout: 'command-key\n', stderr: '' }),
      stderr: { write: (value) => stderr.push(value) },
    });
    assert.equal(result.healthy, true);
    assert.equal(result.jevReady, true);
    assert.equal(stderr.length, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(keyFile, 'utf8')), { key: 'command-key' });
    try { process.kill(result.pid); } catch {}
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureProxy starts without a key and reports the reason on stderr', async () => {
  const dir = tempDir('metaveil-proxy-nokey-');
  const keyFile = path.join(dir, 'child-key.json');
  const port = await freePort();
  const proxyScript = writeFakeProxy(dir);
  const stderr = [];
  try {
    const result = await ensureProxy({
      port,
      proxyCommand: process.execPath,
      proxyArgs: [proxyScript],
      proxyConfigPath: path.join(dir, 'proxy-config.json'),
      proxyStartTimeoutMs: 3000,
      apiKeyCommand: ['pi'],
    }, {
      env: { FAKE_PROXY_KEY_FILE: keyFile, FAKE_PROXY_PORT: String(port) },
      runCommand: () => ({ code: 1, stdout: '', stderr: 'no key' }),
      stderr: { write: (value) => stderr.push(value) },
    });
    assert.equal(result.healthy, true);
    assert.equal(result.jevReady, true);
    assert.match(stderr.join(''), /apiKeyCommand exited with code 1/);
    assert.match(stderr.join(''), /without a Jev key/);
    assert.deepEqual(JSON.parse(fs.readFileSync(keyFile, 'utf8')), { key: null });
    try { process.kill(result.pid); } catch {}
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawnRealMuse uses the sibling PowerShell launcher without a shell', async () => {
  const dir = tempDir('metaveil-spawn-ps1-');
  const cmd = path.join(dir, 'muse.cmd');
  const ps1 = path.join(dir, '.muse-launcher.ps1');
  fs.writeFileSync(cmd, '@echo off\r\n');
  fs.writeFileSync(ps1, '# fake\n');
  const calls = [];
  try {
    await assert.rejects(
      () => spawnRealMuse(cmd, ['prompt " & echo INJECTED'], { spawnImpl: () => { throw new Error('must not spawn'); } }),
      (error) => error.code === 'UNSAFE_ARG',
    );
    const result = await spawnRealMuse(cmd, ['plain words', 'a"b'], {
      spawnImpl: (command, args, options) => { calls.push({ command, args, options }); return fakeChild(); },
      powershellExe: 'fake-powershell.exe',
    });
    assert.equal(result.code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'fake-powershell.exe');
    assert.deepEqual(calls[0].args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, 'plain words', 'a\\"b']);
    assert.equal(calls[0].options.shell, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('spawnRealMuse refuses cmd metacharacters when a .cmd has no PowerShell sibling', async () => {
  const dir = tempDir('metaveil-spawn-unsafe-');
  const cmd = path.join(dir, 'muse.cmd');
  fs.writeFileSync(cmd, '@echo off\r\n');
  let spawned = false;
  try {
    await assert.rejects(
      () => spawnRealMuse(cmd, ['prompt " & echo INJECTED'], {
        spawnImpl: () => { spawned = true; return fakeChild(); },
      }),
      (error) => error.code === 'UNSAFE_ARG',
    );
    assert.equal(spawned, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadLauncherConfig reports a missing config clearly', () => {
  const home = tempDir('metaveil-missing-');
  try {
    assert.throws(() => loadLauncherConfig(path.join(home, 'nope')), (error) => error.code === 'NO_LAUNCHER_CONFIG');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('ACL status needs the deny on the sandbox group line, not any deny plus any mention', () => {
  const home = tempDir('metaveil-ace-');
  try {
    const target = path.join(home, 'Documents');
    fs.mkdirSync(target);
    const statePath = path.join(home, 'acl-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, applied: [{ path: target, kind: 'dir', principal: 'MuseSandboxUsers', ace: '(OI)(CI)(RX)' }] }));
    const output = (lines) => () => ({ code: 0, stdout: lines.join('\r\n'), stderr: '' });
    const misleading = output([`${target} PC\MuseSandboxUsers:(OI)(CI)(RX)`, '   PC\Guest:(OI)(CI)(DENY)(RX)']);
    assert.equal(statusAcl({ statePath, runCommand: misleading }).ok, false);
    const real = output([`${target} PC\MuseSandboxUsers:(OI)(CI)(DENY)(Rc,S,X,RA)`, '   PC\me:(OI)(CI)(F)']);
    assert.equal(statusAcl({ statePath, runCommand: real }).ok, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install plan denies metaveil home, Muse transcripts and Windows history to the sandbox', () => {
  const home = tempDir('metaveil-trail-');
  try {
    const metaveil = path.join(home, 'AppData', 'Local', 'metaveil');
    const wanted = [
      metaveil,
      path.join(home, '.config', 'muse'),
      path.join(home, '.local', 'share', 'muse', 'sessions'),
      path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent'),
    ];
    for (const dir of wanted) fs.mkdirSync(dir, { recursive: true });
    const plan = planInstall({ homeDir: home, workspaceRoot: path.join(home, 'project'), metaveilHome: metaveil, pathState: { value: '', kind: 'ExpandString' } });
    const denied = plan.aclPlan.entries.filter((entry) => entry.action === 'deny').map((entry) => entry.path.toLowerCase());
    for (const dir of wanted) assert.ok(denied.includes(dir.toLowerCase()), dir);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Contributor runs skip approval prompts unless a mode was chosen', () => {
  const on = buildMuseArgs({ userArgs: [], port: 8787, contributorMode: 'on' });
  assert.ok(on.includes('--disable-approval'));
  const chosen = buildMuseArgs({ userArgs: ['--approval-mode', 'on-request'], port: 8787, contributorMode: 'on' });
  assert.equal(chosen.filter((arg) => arg === '--disable-approval').length, 0);
  const yolo = buildMuseArgs({ userArgs: ['--yolo'], port: 8787, contributorMode: 'on' });
  assert.equal(yolo.filter((arg) => arg === '--disable-approval').length, 1);
  const off = buildMuseArgs({ userArgs: [], port: 8787, contributorMode: 'off' });
  assert.equal(off.includes('--disable-approval'), false);
});

test('Orca hooks are carried into the Contributor hook override, with metaveil first', () => {
  const orcaEntry = { hooks: [{ type: 'command', command: 'C:/x/muse-hook.cmd', timeout: 10 }] };
  const merged = mergeHooks('node C:/x/policy.cjs', { Stop: [orcaEntry], PreToolUse: [orcaEntry], Bad: 'ignored' });
  assert.deepEqual(merged.Stop, [orcaEntry]);
  assert.equal(merged.PreToolUse.length, 2);
  assert.equal(merged.PreToolUse[0].hooks[0].command, 'node C:/x/policy.cjs');
  assert.equal(merged.Bad, undefined);
  assert.equal(mergeHooks('node C:/x/policy.cjs').PreToolUse.length, 1);
});

test('a running launcher keeps checking the proxy, and a failed check does not stop it', async () => {
  let calls = 0;
  const stop = watchProxy({}, { intervalMs: 5, ensure: async () => { calls += 1; if (calls === 1) throw new Error('still down'); } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  const seen = calls;
  assert.ok(seen >= 2, `checked ${seen} times`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, seen, 'stops when told to');
});
