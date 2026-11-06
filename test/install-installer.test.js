import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyInstall,
  contributorSet,
  lineDiff,
  mergeSettings,
  planInstall,
  removeSettings,
  uninstall,
} from '../src/install/index.js';

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metaveil-inst-test-'));
  fs.mkdirSync(path.join(home, '.config', 'muse'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'muse', 'settings.json'), JSON.stringify({
    schema_version: 1,
    provider: 'meta',
    model: 'muse-spark-1.3',
    keep_me: { nested: true },
  }, null, 2));
  return home;
}

test('lineDiff marks the settings additions without dropping existing keys', () => {
  const diff = lineDiff('{"a":1}\n', '{"a":1,"b":2}\n');
  assert.match(diff, /\+/);
  assert.match(diff, /a/);
});

test('mergeSettings adds base_url and telemetry, no hook, and keeps other keys', () => {
  const merged = mergeSettings({ schema_version: 1, keep: true, endpoint_transport: { proxy: 'x' } }, {
    baseUrl: 'http://127.0.0.1:8787/v1',
  });
  assert.equal(merged.keep, true);
  assert.equal(merged.endpoint_transport.proxy, 'x');
  assert.equal(merged.endpoint_transport.base_url, 'http://127.0.0.1:8787/v1');
  assert.equal(merged.hooks, undefined);
  const removed = removeSettings(merged, { baseUrl: 'http://127.0.0.1:8787/v1' });
  assert.equal(removed.keep, true);
  assert.equal(removed.endpoint_transport.proxy, 'x');
  assert.equal(removed.endpoint_transport.base_url, undefined);
});

test('planInstall prints the settings diff, PATH plan and ACL plan without writing', () => {
  const home = tempHome();
  try {
    const before = fs.readFileSync(path.join(home, '.config', 'muse', 'settings.json'), 'utf8');
    const plan = planInstall({ homeDir: home, workspaceRoot: path.join(home, 'Downloads', 'project'), port: 8787, currentPath: 'C:/Windows' });
    assert.match(plan.settingsDiff, /endpoint_transport/);
    assert.doesNotMatch(plan.settingsDiff, /PreToolUse/);
    assert.match(plan.pathPlan.newPath, /bin/);
    assert.ok(plan.aclPlan.entries.some((entry) => entry.action === 'skip' && /contains workspace/.test(entry.reason)));
    assert.equal(fs.readFileSync(path.join(home, '.config', 'muse', 'settings.json'), 'utf8'), before);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('applyInstall backs up settings, writes hook/config/state, and uninstall restores exactly', () => {
  const home = tempHome();
  try {
    const settingsPath = path.join(home, '.config', 'muse', 'settings.json');
    const original = fs.readFileSync(settingsPath, 'utf8');
    const plan = planInstall({ homeDir: home, workspaceRoot: path.join(home, 'Downloads', 'project'), port: 8787, currentPath: 'C:/Windows' });
    const result = applyInstall(plan, { applyAcl: false, applyPath: false });
    assert.ok(result.backupPath && fs.existsSync(result.backupPath));
    const applied = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(applied.keep_me.nested, true);
    assert.equal(applied.telemetry.enabled, false);
    assert.equal(applied.endpoint_transport.base_url, 'http://127.0.0.1:8787/v1');
    const state = JSON.parse(fs.readFileSync(path.join(plan.metaveilHome, 'install-state.json'), 'utf8'));
    assert.equal(state.hooksInstalled, true);
    assert.equal(state.previousPath.value, 'C:/Windows');
    assert.ok(fs.existsSync(plan.hookPath));
    assert.ok(fs.existsSync(plan.hookConfigPath));
    assert.ok(fs.existsSync(path.join(plan.metaveilHome, 'launcher.json')));
    assert.ok(fs.existsSync(path.join(plan.metaveilHome, 'install-state.json')));
    assert.ok(fs.existsSync(path.join(plan.metaveilHome, 'path-plan.json')));

    uninstall({ homeDir: home }, { applyAcl: false, applyPath: false });
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
    assert.equal(fs.existsSync(path.join(plan.metaveilHome, 'launcher.json')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('uninstall removes only metaveil keys when the user changed settings after install', () => {
  const home = tempHome();
  try {
    const settingsPath = path.join(home, '.config', 'muse', 'settings.json');
    const plan = planInstall({ homeDir: home, workspaceRoot: path.join(home, 'Downloads', 'project'), port: 8787, currentPath: 'C:/Windows' });
    applyInstall(plan, { applyAcl: false, applyPath: false });
    const changed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    changed.user_after_install = true;
    fs.writeFileSync(settingsPath, JSON.stringify(changed, null, 2));
    uninstall({ homeDir: home }, { applyAcl: false, applyPath: false });
    const restored = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(restored.user_after_install, true);
    assert.equal(restored.endpoint_transport, undefined);
    assert.equal(restored.hooks, undefined);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('contributor on refuses without the leak-test marker and writes with it', () => {
  const home = tempHome();
  try {
    const plan = planInstall({ homeDir: home, workspaceRoot: path.join(home, 'Downloads', 'project'), port: 8787, currentPath: 'C:/Windows' });
    applyInstall(plan, { applyAcl: false, applyPath: false });
    assert.throws(() => contributorSet({ homeDir: home }, true), (error) => error.code === 'CONTRIBUTOR_MARKER_MISSING');
    fs.writeFileSync(plan.launcherConfig.contributorMarkerPath, 'ok');
    const config = contributorSet({ homeDir: home }, true);
    assert.equal(config.contributor.enabled, true);
    const off = contributorSet({ homeDir: home }, false);
    assert.equal(off.contributor.enabled, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
