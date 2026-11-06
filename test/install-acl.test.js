import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planAcl, applyAcl, statusAcl, removeAcl, aclCommand, DIR_ACE, FILE_ACE } from '../src/install/acl.js';

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metaveil-acl-test-'));
  fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.git-credentials'), 'x');
  return home;
}

test('acl plan skips a folder that contains the workspace and reports it', () => {
  const home = tempHome();
  try {
    const plan = planAcl({ homeDir: home, workspaceRoots: [path.join(home, 'Downloads', 'project')] });
    const downloads = plan.entries.find((entry) => entry.path.toLowerCase() === path.join(home, 'Downloads').toLowerCase());
    assert.equal(downloads.action, 'skip');
    assert.match(downloads.reason, /contains workspace/);
    assert.ok(plan.skipped.some((entry) => /contains workspace/.test(entry.reason)));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('acl plan includes files and only targets MuseSandboxUsers', () => {
  const home = tempHome();
  try {
    const plan = planAcl({ homeDir: home, workspaceRoots: [path.join(home, 'elsewhere')] });
    const file = plan.entries.find((entry) => entry.path.endsWith('.git-credentials'));
    assert.equal(file.kind, 'file');
    assert.equal(aclCommand(file).args[1], '/deny');
    assert.equal(aclCommand(file).args[2], `MuseSandboxUsers:${FILE_ACE}`);
    const dir = plan.entries.find((entry) => entry.path.endsWith('Documents'));
    assert.equal(aclCommand(dir).args[2], `MuseSandboxUsers:${DIR_ACE}`);
    assert.ok(!JSON.stringify(plan).includes('CodexSandboxUsers'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('acl apply is idempotent, status reports drift, and remove only touches recorded entries', () => {
  const home = tempHome();
  const statePath = path.join(home, 'acl-state.json');
  const commands = [];
  const runCommand = (command, args) => {
    commands.push([command, ...args]);
    if (args[0] && args[1] === '/deny') return { code: 0, stdout: '', stderr: '' };
    if (args[0] && args[1] === '/remove:d') return { code: 0, stdout: '', stderr: '' };
    // read check before apply: no deny yet
    return { code: 1, stdout: '', stderr: 'not found' };
  };
  try {
    const plan = planAcl({ homeDir: home, workspaceRoots: [path.join(home, 'elsewhere')] });
    const first = applyAcl(plan, { statePath, dryRun: false, runCommand });
    assert.ok(first.applied.length >= 2);
    assert.equal(first.errors.length, 0);
    const second = applyAcl(plan, { statePath, dryRun: false, runCommand });
    assert.equal(second.applied.length, 0);
    assert.ok(second.alreadyApplied.length >= 2);
    const status = statusAcl({ statePath, runCommand: (command, args) => ({ code: 0, stdout: 'MuseSandboxUsers:(OI)(CI)(DENY)(RX)', stderr: '' }) });
    assert.equal(status.ok, true);
    assert.equal(status.checked, first.applied.length);
    const drift = statusAcl({ statePath, runCommand: () => ({ code: 0, stdout: 'NT AUTHORITY\SYSTEM:(F)', stderr: '' }) });
    assert.equal(drift.ok, false);
    assert.ok(drift.drift.length > 0);
    const removed = removeAcl({ statePath, dryRun: false, runCommand });
    assert.equal(removed.removed.length, first.applied.length);
    assert.equal(removed.errors.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).applied.length, 0);
    assert.ok(commands.every((command) => !command.includes('CodexSandboxUsers')));
    assert.ok(commands.every((command) => command[0] === 'icacls'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('extras with spaces stay one icacls argument and never pass through a shell', () => {
  const home = tempHome();
  const statePath = path.join(home, 'acl-state.json');
  const savedGames = path.join(home, 'Saved Games');
  fs.mkdirSync(savedGames, { recursive: true });
  const commands = [];
  try {
    const plan = planAcl({
      homeDir: home,
      workspaceRoots: [path.join(home, 'elsewhere')],
      extras: ['Saved Games'],
    });
    const extra = plan.entries.find((entry) => entry.label === 'extra');
    assert.equal(extra.path, savedGames);
    assert.equal(aclCommand(extra).args[0], savedGames);
    assert.equal(aclCommand(extra).args.length, 3);
    const result = applyAcl(plan, {
      statePath,
      dryRun: false,
      runCommand: (command, args) => {
        commands.push({ command, args });
        if (args.length === 2) return { code: 1, stdout: '', stderr: 'not found' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.errors.length, 0);
    const denied = commands.find((entry) => entry.args[0] === savedGames && entry.args[1] === '/deny');
    assert.ok(denied);
    assert.deepEqual(denied.args, [savedGames, '/deny', `MuseSandboxUsers:${DIR_ACE}`]);
    assert.equal(commands.some((entry) => typeof entry === 'string'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
