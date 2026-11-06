import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  contributorPreamble,
  makeRuntimeConfig,
  postResponses,
  request,
  startFakeUpstream,
  startProxy,
} from './helpers.js';
import {
  applyInstall,
  mergeSettings,
  planInstall,
  planPath,
  removeSettings,
  uninstall,
} from '../src/install/index.js';
import { removePathEntry, splitSavedPath } from '../src/install/path-registry.js';

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metaveil-security-test-'));
  fs.mkdirSync(path.join(home, '.config', 'muse'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'muse', 'settings.json'), JSON.stringify({
    schema_version: 1,
    keep_me: true,
  }, null, 2));
  return home;
}

function fakeRegistry(initial) {
  let saved = { ...initial };
  const writes = [];
  const runner = (command, args, options = {}) => {
    const script = args.join(' ');
    if (script.includes('DoNotExpandEnvironmentNames')) {
      return { code: 0, stdout: JSON.stringify(saved), stderr: '' };
    }
    if (script.includes('METAVEIL_USER_PATH_VALUE')) {
      writes.push({ command, args, options });
      saved = {
        value: options.env.METAVEIL_USER_PATH_VALUE,
        kind: options.env.METAVEIL_USER_PATH_KIND,
      };
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, writes, get saved() { return saved; } };
}

function startJevStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        provider: 'TypeSafe',
        answers: { has_personal: { type: 'noul', noul: 0.01 } },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

test('planPath prepends only bin, keeps %VAR% literal and defaults to ExpandString', () => {
  const original = '%USERPROFILE%\\bin;C:\\Windows;C:\\Tools\\;';
  const plan = planPath({ binDir: 'C:\\metaveil\\bin', currentPath: original });
  assert.equal(plan.currentKind, 'ExpandString');
  assert.equal(plan.newPath, 'C:\\metaveil\\bin;%USERPROFILE%\\bin;C:\\Windows;C:\\Tools\\;');
  assert.equal(plan.changed, true);
  assert.deepEqual(splitSavedPath(original), ['%USERPROFILE%\\bin', 'C:\\Windows', 'C:\\Tools\\', '']);
  assert.equal(planPath({ binDir: 'C:\\metaveil\\bin', currentPath: 'C:\\Metaveil\\BIN\\;C:\\Windows' }).changed, false);
});

test('removePathEntry removes only the case-insensitive bin entry and preserves the rest byte-for-byte', () => {
  const bin = 'C:\\Metaveil\\BIN';
  const current = `C:\\Windows;c:\\metaveil\\bin;C:\\Tools\\;%USERPROFILE%\\x`;
  const removal = removePathEntry(current, bin);
  assert.equal(removal.removed, true);
  assert.equal(removal.value, 'C:\\Windows;C:\\Tools\\;%USERPROFILE%\\x');
});

test('install reads the saved registry PATH, not process.env.PATH, and uninstall restores the exact raw value and kind', () => {
  const home = tempHome();
  const original = { value: '%USERPROFILE%\\bin;C:\\Windows;C:\\Tools\\;', kind: 'ExpandString' };
  const registry = fakeRegistry(original);
  try {
    const plan = planInstall({
      homeDir: home,
      workspaceRoot: path.join(home, 'Downloads', 'project'),
      runCommand: registry.runner,
    });
    assert.equal(plan.pathPlan.currentPath, original.value);
    assert.equal(plan.installState.previousPath.value, original.value);
    assert.equal(plan.installState.previousPath.kind, original.kind);
    assert.equal(plan.pathPlan.newPath, `${plan.pathPlan.binDir};${original.value}`);

    const applied = applyInstall(plan, { runCommand: registry.runner, applyAcl: false, applyPath: true });
    assert.equal(applied.state.hooksInstalled, true);
    assert.equal(registry.writes.length, 1);
    assert.equal(registry.writes[0].options.env.METAVEIL_USER_PATH_VALUE, plan.pathPlan.newPath);
    assert.equal(registry.writes[0].options.env.METAVEIL_USER_PATH_KIND, original.kind);
    assert.ok(registry.writes[0].options.env.METAVEIL_USER_PATH_VALUE.includes('%USERPROFILE%'));
    assert.ok(!registry.writes[0].args.join(' ').includes('%USERPROFILE%\\bin'));
    assert.ok(!registry.writes[0].args.join(' ').includes(original.value));
    assert.match(registry.writes[0].args.join(' '), /DoNotExpandEnvironmentNames|METAVEIL_USER_PATH_VALUE/);
    assert.match(registry.writes[0].args.join(' '), /SendMessageTimeout/);
    assert.equal(registry.saved.value, plan.pathPlan.newPath);

    fs.writeFileSync(path.join(plan.metaveilHome, 'identity.json'), '{"names":["kept"]}\n');
    fs.writeFileSync(path.join(plan.metaveilHome, 'audit.jsonl'), '{}\n');
    fs.writeFileSync(path.join(plan.metaveilHome, 'jev-cache.json'), '{}\n');
    const removed = uninstall({ homeDir: home }, { runCommand: registry.runner, applyAcl: false, applyPath: true });
    assert.equal(registry.writes.length, 2);
    assert.deepEqual(registry.saved, original);
    assert.equal(removed.path.restored, true);
    assert.ok(removed.remaining.some((file) => file.endsWith('identity.json')));
    assert.ok(removed.remaining.some((file) => file.endsWith('audit.jsonl')));
    assert.ok(removed.remaining.some((file) => file.endsWith('jev-cache.json')));
    assert.equal(fs.existsSync(path.join(plan.metaveilHome, 'launcher.json')), false);
    assert.equal(fs.existsSync(path.join(plan.metaveilHome, 'install-state.json')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('installer writes identity, aliases and Jev config but no fixed workspaceRoot', () => {
  const home = tempHome();
  const source = path.join(home, 'identity-source.json');
  fs.writeFileSync(source, JSON.stringify({
    names: ['Avery Example'],
    usernames: ['avery'],
    emails: ['avery@example.test'],
    hostnames: ['avery-pc'],
    terms: ['Project Blue'],
  }));
  try {
    const plan = planInstall({
      homeDir: home,
      workspaceRoot: path.join(home, 'Downloads', 'project'),
      currentPath: 'C:\\Windows',
      identity: source,
    });
    assert.equal(plan.proxyConfig.homeAlias, 'C:\\Users\\dev');
    assert.equal(plan.proxyConfig.workspaceAlias, 'C:\\Users\\dev\\workspace');
    assert.equal(plan.proxyConfig.workspaceRoot, undefined);
    assert.equal(plan.hookConfig.workspaceRoot, undefined);
    assert.deepEqual(plan.proxyConfig.identity.names, ['Avery Example']);
    assert.equal(plan.proxyConfig.jev.enabled, true);
    assert.equal(plan.proxyConfig.jev.baseUrl, 'https://openrouter.ai');
    assert.equal(plan.proxyConfig.jev.model, 'typesafe/jev-1.14');
    assert.equal(plan.proxyConfig.jev.apiKeyEnv, 'OPENROUTER_API_KEY');
    assert.equal(plan.proxyConfig.jev.contributorOnly, true);
    assert.equal(plan.proxyConfig.jev.cachePath, path.join(plan.metaveilHome, 'jev-cache.json'));
    assert.ok(Array.isArray(plan.launcherConfig.apiKeyCommand));

    applyInstall(plan, { applyAcl: false, applyPath: false });
    assert.equal(fs.readFileSync(plan.identityPath, 'utf8'), fs.readFileSync(source, 'utf8'));
    const written = JSON.parse(fs.readFileSync(plan.proxyConfigPath, 'utf8'));
    assert.equal(written.identity.usernames[0], 'avery');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a bad identity file fails at plan time before settings are written', () => {
  const home = tempHome();
  const source = path.join(home, 'bad-identity.json');
  fs.writeFileSync(source, JSON.stringify({ names: 'not-an-array' }));
  const settingsPath = path.join(home, '.config', 'muse', 'settings.json');
  const before = fs.readFileSync(settingsPath, 'utf8');
  try {
    assert.throws(
      () => planInstall({
        homeDir: home,
        workspaceRoot: path.join(home, 'Downloads', 'project'),
        currentPath: 'C:\\Windows',
        identity: source,
      }),
      (error) => error.code === 'CONFIG_INVALID',
    );
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), before);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('telemetry is disabled without dropping other keys and is undone on removal', () => {
  const entry = { type: 'command', command: 'node hook.cjs' };
  const merged = mergeSettings({
    telemetry: { keep: 'value', enabled: true },
    endpoint_transport: { other: true },
  }, { baseUrl: 'http://127.0.0.1:8787/v1', entry });
  assert.equal(merged.telemetry.enabled, false);
  assert.equal(merged.telemetry.keep, 'value');
  assert.equal(merged.endpoint_transport.other, true);

  const removed = removeSettings(merged, {
    baseUrl: 'http://127.0.0.1:8787/v1',
    entry,
    telemetryPrevious: { present: true, value: true },
  });
  assert.equal(removed.telemetry.enabled, true);
  assert.equal(removed.telemetry.keep, 'value');
});

test('metaveil status works read-only when nothing is installed', () => {
  const home = tempHome();
  const cli = path.join(path.resolve(import.meta.dirname, '..'), 'src', 'install', 'cli.js');
  try {
    const result = spawnSync(process.execPath, [cli, 'status', '--home', home, '--port', '1'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /metaveil status \(not installed\)/);
    assert.match(result.stdout, /proxy: (healthy|unhealthy)/);
    assert.match(result.stdout, /hook: (present|missing)/);
    assert.match(result.stdout, /gate: off/);
    assert.equal(fs.existsSync(path.join(home, 'AppData', 'Local', 'metaveil')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('healthz reports jevReady without exposing the key', async (t) => {
  const keyEnv = `METAVEIL_SECURITY_HEALTH_KEY_${process.pid}`;
  delete process.env[keyEnv];
  const { config } = makeRuntimeConfig({
    jev: { enabled: true, apiKeyEnv: keyEnv },
  });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  try {
    let health = await request(`${proxy.url}/healthz`);
    assert.equal(JSON.parse(health.body).jevReady, false);
    process.env[keyEnv] = 'health-secret-value';
    health = await request(`${proxy.url}/healthz`);
    const parsed = JSON.parse(health.body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.jevReady, true);
    assert.ok(!health.body.includes('health-secret-value'));
  } finally {
    delete process.env[keyEnv];
  }
});

test('jev.contributorOnly skips Jev when Contributor is off and scans when it is on', async (t) => {
  const muse = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"output":[]}');
  });
  t.after(() => muse.close());
  const jev = await startJevStub();
  t.after(() => jev.close());
  const keyEnv = `METAVEIL_SECURITY_JEV_KEY_${process.pid}`;
  process.env[keyEnv] = 'test-key';
  t.after(() => { delete process.env[keyEnv]; });
  const { config } = makeRuntimeConfig({
    upstream: muse.url,
    jev: {
      enabled: true,
      baseUrl: jev.url,
      apiKeyEnv: keyEnv,
      contributorOnly: true,
    },
  });
  const proxy = await startProxy(config);
  t.after(() => proxy.stop());
  const marker = 'Zephyrine Quill';

  const off = await postResponses(proxy.url, {
    model: 'muse-code-test',
    instructions: marker,
    input: [],
    stream: false,
  }, { 'x-tbh-contributor-mode': '0' });
  assert.equal(off.status, 200);
  assert.equal(jev.requests.length, 0, 'contributor off must make no Jev calls');
  assert.ok(muse.requests[0].body.toString('utf8').includes(marker));

  const on = await postResponses(proxy.url, {
    model: 'muse-code-test',
    instructions: `${contributorPreamble()}${marker}`,
    input: [],
    stream: false,
  }, { 'x-tbh-contributor-mode': '1' });
  assert.equal(on.status, 200);
  assert.ok(jev.requests.length >= 1, 'contributor on must always call Jev');
  assert.ok(muse.requests[1].body.toString('utf8').includes(marker));
});
