import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { museLooksIdle, museStuckPaste, refusalFor, startOrcaBridge, startWakeWatcher, unreadIn } from '../src/install/orca-bridge.js';

const CLIENT = path.resolve(import.meta.dirname, '..', 'src', 'install', 'sandbox-bin', 'orca-client.cjs');

test('Contributor mode refuses computer use, the browser, session search and accounts', () => {
  for (const command of ['computer', 'browser', 'search', 'account']) {
    assert.ok(refusalFor([command, 'list'], true), command);
    assert.ok(refusalFor(['--json', command], true), `${command} after a flag`);
  }
});

test('Contributor mode refuses computer use requested through a terminal or worker', () => {
  assert.ok(refusalFor(['terminal', 'create', '--command', 'orca computer list'], true));
  assert.ok(refusalFor(['orchestration', 'worker-start', '--spec', 'use computer use to look around'], true));
});

test('Contributor mode refuses workers aimed at personal folders', () => {
  for (const text of [
    'cat C:\\Users\\someone\\Downloads\\x.txt',
    'summarize my downloads folder',
    'dir %USERPROFILE%',
    'ls ~/Documents',
    'Get-ChildItem $env:USERPROFILE',
    'read D:\\stuff',
    'open .ssh/config',
  ]) {
    assert.ok(refusalFor(['terminal', 'create', '--command', text], true), text);
  }
});

test('ordinary Orca work is allowed in Contributor mode', () => {
  for (const args of [
    ['status', '--json'],
    ['skills', 'get', 'orchestration'],
    ['terminal', 'create', '--command', 'pi --model opencode-go/deepseek-v4.1-flash:max'],
    ['orchestration', 'worker-start', '--agent', 'codex', '--spec', 'parse the documents table and fix src/search.js'],
    ['terminal', 'read', '--terminal', 'term_1'],
  ]) {
    assert.equal(refusalFor(args, true), null, args.join(' '));
  }
});

test('outside Contributor mode nothing is refused', () => {
  assert.equal(refusalFor(['computer', 'list'], false), null);
  assert.equal(refusalFor(['terminal', 'create', '--command', 'dir %USERPROFILE%'], false), null);
});

function runClient(env, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLIENT, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('the sandbox client runs a command through the bridge and gets its output and exit code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metaveil-bridge-'));
  const fake = path.join(dir, 'fake-orca.cjs');
  fs.writeFileSync(fake, "console.log('out:' + process.argv.slice(2).join('|')); console.error('err'); process.exit(3);");
  const spawnImpl = (_cmd, args, options) => spawn(process.execPath, [fake, ...args], options);
  const bridge = startOrcaBridge({ contributor: true, dir: path.join(dir, 'b'), spawnImpl });
  const env = { METAVEIL_ORCA_DIR: bridge.dir, METAVEIL_ORCA_TOKEN: bridge.token };
  try {
    const ran = await runClient(env, ['terminal', 'list', 'line one\nsays "hi"']);
    assert.equal(ran.code, 3);
    assert.equal(ran.stdout.trim(), 'out:terminal|list|line one\nsays "hi"');
    assert.equal(ran.stderr.trim(), 'err');
    const refused = await runClient(env, ['computer', 'list']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /not available in Contributor mode/);
    assert.deepEqual(fs.readdirSync(bridge.dir), [], 'requests and replies are cleaned up');
  } finally {
    bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a request with the wrong token is ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metaveil-bridge-'));
  let ran = false;
  const spawnImpl = () => { ran = true; throw new Error('must not run'); };
  const bridge = startOrcaBridge({ contributor: false, dir: path.join(dir, 'b'), spawnImpl });
  try {
    const request = path.join(bridge.dir, 'req-0123456789abcdef.json');
    fs.writeFileSync(request, JSON.stringify({ token: 'wrong', args: ['status'] }));
    for (let i = 0; i < 30 && fs.existsSync(request); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(request), false);
    assert.equal(ran, false);
    assert.equal(fs.existsSync(path.join(bridge.dir, 'res-0123456789abcdef.json')), false);
  } finally {
    bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the PowerShell wrapper passes a single argument whole', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metaveil-bridge-'));
  const fake = path.join(dir, 'fake-orca.cjs');
  fs.writeFileSync(fake, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const spawnImpl = (_cmd, args, options) => spawn(process.execPath, [fake, ...args], options);
  const bridge = startOrcaBridge({ contributor: false, dir: path.join(dir, 'b'), spawnImpl });
  const wrapper = path.resolve(import.meta.dirname, '..', 'src', 'install', 'sandbox-bin', 'orca.ps1');
  try {
    const result = await new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper, '--help'], {
        env: { ...process.env, METAVEIL_ORCA_DIR: bridge.dir, METAVEIL_ORCA_TOKEN: bridge.token },
      });
      let out = '';
      child.stdin.end();
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out));
    });
    assert.deepEqual(JSON.parse(result), ['--help']);
  } finally {
    bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the PowerShell wrapper keeps quotes and newlines intact', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metaveil-bridge-'));
  const fake = path.join(dir, 'fake-orca.cjs');
  fs.writeFileSync(fake, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const spawnImpl = (_cmd, args, options) => spawn(process.execPath, [fake, ...args], options);
  const bridge = startOrcaBridge({ contributor: false, dir: path.join(dir, 'b'), spawnImpl });
  const wrapper = path.resolve(import.meta.dirname, '..', 'src', 'install', 'sandbox-bin', 'orca.ps1');
  const script = path.join(dir, 'call.ps1');
  fs.writeFileSync(script, `& '${wrapper}' terminal create --spec "line one\`nsays \`"hi\`" & done"\n`);
  try {
    const result = await new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
        env: { ...process.env, METAVEIL_ORCA_DIR: bridge.dir, METAVEIL_ORCA_TOKEN: bridge.token },
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out));
    });
    assert.deepEqual(JSON.parse(result), ['terminal', 'create', '--spec', 'line one\nsays "hi" & done']);
  } finally {
    bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Muse counts as idle only with an empty prompt and nothing running', () => {
  assert.equal(museLooksIdle('◆ done\n───\n❯ \n───\n  muse-spark'), true);
  assert.equal(museLooksIdle('◆ done\n───\n❯ half a sentence\n───'), false);
  assert.equal(museLooksIdle('❯ old prompt\n◇ Thinking (3s · esc to interrupt)\n❯ \n'), false);
  assert.equal(museLooksIdle('Would you like to run the following command?\n❯ '), false);
  assert.equal(museLooksIdle('no prompt on screen'), false);
});

test('messages from check --peek count as unread', () => {
  // The shape real Orca returns.
  assert.deepEqual(unreadIn(JSON.stringify({ ok: true, result: { messages: [{ id: 'a', type: 'status', from: 't', subject: 's', body: 'b' }, { id: 'b', handled: true }] } })).map((m) => m.id), ['a']);
  assert.deepEqual(unreadIn('not json'), []);
  assert.deepEqual(unreadIn(null), []);
});

function fakeOrca({ unread, screen }) {
  const sent = [];
  const run = async (_command, args) => {
    if (args[1] === 'check') return JSON.stringify({ result: { messages: unread() } });
    if (args[1] === 'read') return screen();
    if (args[1] === 'send') sent.push(args.includes('--enter') ? 'ENTER' : args[args.indexOf('--text') + 1]);
    return '{}';
  };
  return { run, sent };
}

test('the notice waits out the grace period, then goes once and repeats slowly', async () => {
  let clock = 1000;
  const { run, sent } = fakeOrca({ unread: () => [{ id: 'm1' }], screen: () => '❯ ' });
  const stop = startWakeWatcher({ env: { ORCA_TERMINAL_HANDLE: 't' }, pollMs: 3, graceMs: 100, repeatMs: 1000, run, now: () => clock });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent, [], 'still inside the grace period');
  clock += 150;
  for (let i = 0; i < 60 && sent.length < 2; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sent, ['You have 1 orchestration message. Run orca orchestration check.', 'ENTER']);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 2, 'not repeated right away');
  stop();
});

test('no notice while Muse is busy, or outside an Orca tab', async () => {
  let clock = 1000;
  const { run, sent } = fakeOrca({ unread: () => [{ id: 'm1' }], screen: () => '◇ Thinking (esc to interrupt)\n❯ ' });
  const stop = startWakeWatcher({ env: { ORCA_TERMINAL_HANDLE: 't' }, pollMs: 3, graceMs: 0, repeatMs: 0, run, now: () => (clock += 1) });
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.deepEqual(sent, []);
  let called = false;
  startWakeWatcher({ env: {}, pollMs: 1, run: async () => { called = true; return ''; } })();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(called, false);
});

test('a large dispatched paste left unsent in an idle Muse prompt is recognized; drafts and busy screens are not', () => {
  assert.equal(museStuckPaste('  Muse Code 1.4.15\n❯ [Pasted Content 5871 chars]\n───\n  muse-wonder-1.0 · medium'), 5871);
  assert.equal(museStuckPaste('❯ [Pasted Content 240 chars]'), null, 'a short paste is a person drafting');
  assert.equal(museStuckPaste('❯ [Pasted Content 5871 chars] and my note'), null, 'something typed after it');
  assert.equal(museStuckPaste('◈ Thinking (esc to interrupt)\n❯ [Pasted Content 5871 chars]'), null, 'busy');
  assert.equal(museStuckPaste('❯ '), null);
});

test('a stuck paste gets exactly one Enter, only after it is seen twice', async () => {
  let screen = '❯ [Pasted Content 5871 chars]';
  const { run, sent } = fakeOrca({ unread: () => [], screen: () => screen });
  const stop = startWakeWatcher({ env: { ORCA_TERMINAL_HANDLE: 't' }, pollMs: 5, graceMs: 0, repeatMs: 0, run });
  for (let i = 0; i < 60 && sent.length < 1; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent, ['\r']);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(sent, ['\r'], 'never a second Enter for the same paste');
  screen = '◈ Thinking (esc to interrupt)\n❯ ';
  await new Promise((r) => setTimeout(r, 30));
  stop();
  assert.deepEqual(sent, ['\r']);
});
