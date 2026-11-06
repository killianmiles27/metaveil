import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeRuntimeConfig, SYNTH } from './helpers.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('scan CLI prints redacted text without persisting a map', () => {
  const { config, dir } = makeRuntimeConfig();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const inputPath = path.join(dir, 'input.txt');
  fs.writeFileSync(inputPath, `${SYNTH.name} ${SYNTH.home}\\Downloads\\${SYNTH.filename} API_KEY=${SYNTH.secretValue}\n`);
  const output = execFileSync(process.execPath, ['src/cli.js', 'scan', inputPath, '--config', configPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.ok(!output.includes(SYNTH.name));
  assert.ok(!output.includes(SYNTH.username));
  assert.ok(!output.includes(SYNTH.filename));
  assert.ok(!output.includes(SYNTH.secretValue));
  assert.match(output, /PERSON_1/);
  assert.match(output, /LOCAL_PATH_1/);
  assert.match(output, /SECRET_1/);
  assert.equal(fs.existsSync(config.mapPath), false, 'scan must not persist a map');
});

test('audit CLI prints a summary', () => {
  const { dir } = makeRuntimeConfig();
  const auditPath = path.join(dir, 'sample.jsonl');
  fs.writeFileSync(auditPath, [
    JSON.stringify({ category: 'PERSON', action: 'redacted', placeholder: 'PERSON_1' }),
    JSON.stringify({ category: 'ATTACHMENT', action: 'withheld', placeholder: '[attachment withheld by metaveil]' }),
    JSON.stringify({ category: 'BLOCKED_PATH', action: 'blocked', method: 'POST', target: '/nope' }),
  ].join('\n'));
  const output = execFileSync(process.execPath, ['src/cli.js', 'audit', '--audit-path', auditPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.match(output, /PERSON: 1/);
  assert.match(output, /withheld items: 1/);
  assert.match(output, /POST \/nope: 1/);
});
