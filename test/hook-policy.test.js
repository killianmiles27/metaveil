import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const hookPath = path.join(repoRoot, 'src', 'hook', 'policy.cjs');

function tempConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metaveil-hook-'));
  const config = {
    workspaceRoot: 'C:/work/ws',
    allowedRoots: ['C:/work/shared'],
    allowedSkills: ['safe-skill'],
    bundledSkills: [],
    fileTools: ['read_file', 'search', 'write_file', 'edit_file'],
    timeoutMs: 2000,
    ...overrides,
  };
  const file = path.join(dir, 'hook-policy.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return { dir, file, config };
}

function runHook(payload, configFile) {
  const result = spawnSync(process.execPath, [hookPath], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, METAVEIL_HOOK_CONFIG: configFile },
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function decision(output) {
  return output?.hookSpecificOutput?.permissionDecision;
}

test('hook denies `..` that climbs out of the workspace in an absolute path', () => {
  const { dir, file } = tempConfig();
  try {
    const out = runHook({ tool_name: 'read_file', cwd: 'C:/work/ws', tool_input: { path: 'C:/work/ws/../../Users/x/Downloads/a.txt' } }, file);
    assert.equal(decision(out), 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook denies a junction inside the workspace that points outside it, and allows new files', () => {
  const { dir, file } = tempConfig();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metaveil-link-')));
  try {
    const ws = path.join(base, 'ws');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(ws);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'private.txt'), 'x');
    fs.symlinkSync(outside, path.join(ws, 'link'), 'junction');
    const read = (target) => runHook({ tool_name: 'read_file', cwd: ws, tool_input: { path: target } }, file);
    assert.equal(decision(read(path.join(ws, 'link', 'private.txt'))), 'deny');
    assert.equal(decision(read(path.join(ws, 'link', 'not-yet.txt'))), 'deny');
    assert.equal(decision(read(path.join(ws, 'new', 'file.txt'))), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('hook allows a file inside the workspace', () => {
  const { dir, file } = tempConfig();
  try {
    const out = runHook({ tool_name: 'read_file', tool_input: { path: 'C:/work/ws/a.txt' } }, file);
    assert.deepEqual(out, {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook denies a file outside workspace and allowedRoots', () => {
  const { dir, file } = tempConfig();
  try {
    const out = runHook({ tool_name: 'read_file', tool_input: { path: 'C:/Users/me/secret.txt' } }, file);
    assert.equal(decision(out), 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /outside workspace\/allowedRoots/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook allows an allowedRoot and denies a search outside it', () => {
  const { dir, file } = tempConfig();
  try {
    assert.deepEqual(runHook({ tool_name: 'read_file', tool_input: { path: 'C:/work/shared/x.txt' } }, file), {});
    const out = runHook({ tool_name: 'search', tool_input: { pattern: 'x', paths: ['C:/Users/me'] } }, file);
    assert.equal(decision(out), 'deny');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook allows search with no paths (workspace default)', () => {
  const { dir, file } = tempConfig();
  try {
    assert.deepEqual(runHook({ tool_name: 'search', tool_input: { pattern: 'x' } }, file), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook denies write/edit outside the workspace and protected workspace dirs', () => {
  const { dir, file } = tempConfig();
  try {
    assert.equal(decision(runHook({ tool_name: 'write_file', tool_input: { path: 'C:/Users/me/x', content: 'x' } }, file)), 'deny');
    assert.equal(decision(runHook({ tool_name: 'edit_file', tool_input: { path: 'C:/work/ws/.git/config', find: 'a', replace: 'b' } }, file)), 'deny');
    assert.deepEqual(runHook({ tool_name: 'write_file', tool_input: { path: 'C:/work/ws/x', content: 'x' } }, file), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook enforces the read_skill allowlist', () => {
  const { dir, file } = tempConfig();
  try {
    assert.deepEqual(runHook({ tool_name: 'read_skill', tool_input: { name: 'safe-skill' } }, file), {});
    assert.equal(decision(runHook({ tool_name: 'read_skill', tool_input: { name: 'orca-computer-use' } }, file)), 'deny');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook uses payload.cwd per call and config.workspaceRoot only as fallback', () => {
  const { dir, file } = tempConfig();
  try {
    assert.deepEqual(runHook({
      model: 'muse-code-contributor',
      cwd: 'C:/payload/ws',
      tool_name: 'read_file',
      tool_input: { path: 'C:/payload/ws/a.txt' },
    }, file), {});
    assert.equal(decision(runHook({
      model: 'muse-code-contributor',
      cwd: 'C:/payload/ws',
      tool_name: 'read_file',
      tool_input: { path: 'C:/work/ws/a.txt' },
    }, file)), 'deny');
    assert.deepEqual(runHook({
      model: 'muse-code-contributor',
      tool_name: 'read_file',
      tool_input: { path: 'C:/work/ws/a.txt' },
    }, file), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook denies when neither payload.cwd nor config.workspaceRoot exists', () => {
  const { dir, file } = tempConfig({ workspaceRoot: undefined });
  try {
    const out = runHook({ model: 'muse-code-contributor', tool_name: 'read_file', tool_input: { path: 'C:/work/ws/a' } }, file);
    assert.equal(decision(out), 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /no workspace root/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook enforces whatever model the payload names, because Muse reports the plain model', () => {
  const { dir, file } = tempConfig({ workspaceRoot: undefined });
  try {
    for (const model of ['muse-spark-1.3', 'muse-spark-1.3-contributor', undefined]) {
      assert.equal(decision(runHook({
        model,
        cwd: 'C:/work/ws',
        tool_name: 'read_file',
        tool_input: { path: 'C:/Users/me/secret.txt' },
      }, file)), 'deny', String(model));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook refuses the proxy stand-in with the reason, and a look-alike path is still confined', () => {
  const { dir, file } = tempConfig();
  try {
    const out = runHook({ cwd: 'C:/work/ws', tool_name: 'read_file', tool_input: { path: '.metaveil-blocked/path' } }, file);
    assert.equal(decision(out), 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /outside this project/);
    const other = runHook({ cwd: 'C:/work/ws', tool_name: 'read_file', tool_input: { path: '.metaveil-blocked/../../../x' } }, file);
    assert.equal(decision(other), 'deny');
    assert.doesNotMatch(other.hookSpecificOutput.permissionDecisionReason, /outside this project\./);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook allows only listed skills, with or without the bundled prefix, unless a deny pattern matches', () => {
  const { dir, file } = tempConfig({ allowedSkills: ['safe-skill'], bundledSkills: ['notes', 'read-session'] });
  try {
    for (const name of ['bundled:notes', 'notes', 'safe-skill', ' bundled:notes ']) {
      assert.deepEqual(runHook({ tool_name: 'read_skill', tool_input: { name } }, file), {}, name);
    }
    for (const name of ['bundled:computer-use', 'bundled:orca-computer-use', 'bundled:gmail', 'bundled:credential-store', 'bundled:unlisted', 'other-skill', ' bundled:orca-computer-use ', 'bundled:read-session', 'bundled:resume-claude']) {
      assert.equal(decision(runHook({ tool_name: 'read_skill', tool_input: { name } }, file)), 'deny', name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook fails closed on malformed JSON and invalid config', () => {
  const { dir, file } = tempConfig();
  try {
    assert.equal(decision(runHook('not json', file)), 'deny');
    fs.writeFileSync(file, '{broken');
    assert.equal(decision(runHook({ tool_name: 'read_file', tool_input: { path: 'C:/work/ws/a' } }, file)), 'deny');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook internal watchdog prints a deny before Muse can fail open', async () => {
  const { dir, file } = tempConfig({ timeoutMs: 80 });
  const child = spawn(process.execPath, [hookPath], {
    env: { ...process.env, METAVEIL_HOOK_CONFIG: file },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const output = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', reject);
      const timer = setTimeout(() => { child.kill(); resolve(out); }, 1000);
      child.on('exit', () => { clearTimeout(timer); resolve(out); });
    });
    assert.equal(decision(JSON.parse(output)), 'deny');
    assert.match(output, /internal timeout/);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop refusal explains coding can continue without a bypass', () => {
  const { dir, file } = tempConfig();
  try {
    const out = runHook({ tool_name: 'read_file', cwd: 'C:/work/ws', tool_input: { path: '.metaveil-blocked/desktop' } }, file);
    assert.equal(decision(out), 'deny');
    const reason = out.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /privacy refusal, not a shell failure/);
    assert.match(reason, /do NOT retry/);
    assert.match(reason, /do NOT stop to ask/);
    // The user's standing fallback: a temporary Codex worker through Orca, sanitized report.
    assert.match(reason, /Codex worker through Orca/);
    assert.match(reason, /--agent codex --model gpt-6\.1-terra --effort medium/);
    assert.match(reason, /ONLY a sanitized summary/);
    assert.match(reason, /no personal names, user paths, screenshots/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a write or edit that would put a privacy marker into a file is refused, paths aside', () => {
  const { dir, file } = tempConfig();
  try {
    const marked = runHook({ tool_name: 'edit_file', cwd: 'C:/work/ws', tool_input: { path: 'C:/work/ws/BUG_REVIEW.md', old_string: 'x', new_string: 'a\n[line withheld by metaveil: possible personal details. Do not try to read it another way]\nb' } }, file);
    assert.equal(decision(marked), 'deny');
    assert.match(marked.hookSpecificOutput.permissionDecisionReason, /METAVEIL_MARKER_WRITE/);
    const written = runHook({ tool_name: 'write_file', cwd: 'C:/work/ws', tool_input: { path: 'C:/work/ws/a.txt', content: 'see .metaveil-blocked/path' } }, file);
    assert.equal(decision(written), 'deny');
    const clean = runHook({ tool_name: 'write_file', cwd: 'C:/work/ws', tool_input: { path: 'C:/work/ws/a.txt', content: 'take_screenshot() is a normal function name' } }, file);
    assert.deepEqual(clean, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file of Muse\'s own tool-output spill files is allowed; other session files are not', () => {
  const { dir, file } = tempConfig();
  const prior = process.env.USERPROFILE;
  try {
    process.env.USERPROFILE = 'C:\\Users\\devuser';
    const spill = 'C:\\Users\\devuser\\.local\\share\\muse\\sessions\\2026\\11\\10\\abc\\tool-outputs\\call_1.txt';
    assert.deepEqual(runHook({ tool_name: 'read_file', cwd: 'C:/work/ws', tool_input: { path: spill } }, file), {});
    const transcript = 'C:\\Users\\devuser\\.local\\share\\muse\\sessions\\2026\\11\\10\\abc\\session.jsonl';
    assert.equal(decision(runHook({ tool_name: 'read_file', cwd: 'C:/work/ws', tool_input: { path: transcript } }, file)), 'deny');
    assert.equal(decision(runHook({ tool_name: 'write_file', cwd: 'C:/work/ws', tool_input: { path: spill, content: 'x' } }, file)), 'deny');
  } finally {
    process.env.USERPROFILE = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('all refusal categories explain their boundary without implying broken shell tools', () => {
  const {dir,file}=tempConfig();
  try {
    for (const category of ['path','tool','skill','command','desktop']) {
      const out=runHook({tool_name:'read_file',cwd:'C:/work/ws',tool_input:{path:'.metaveil-blocked/'+category}},file);
      assert.equal(decision(out),'deny');
      assert.match(out.hookSpecificOutput.permissionDecisionReason,/not a shell failure|not a file or a shell failure/);
    }
    for (const marker of ['./.metaveil-blocked/path/detail','.METAVEIL-BLOCKED/TOOL']) {
      assert.equal(decision(runHook({tool_name:'read_file',cwd:'C:/work/ws',tool_input:{path:marker}},file)),'deny');
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
