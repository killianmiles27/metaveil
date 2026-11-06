// `orca` inside Muse's shell sandbox. Hands the command to the metaveil launcher through
// files in the project's ignored temp folder and prints what comes back.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.METAVEIL_ORCA_DIR;
const token = process.env.METAVEIL_ORCA_TOKEN;
if (!dir || !token) {
  process.stderr.write('orca is only available when Muse runs through metaveil in an Orca tab\n');
  process.exit(1);
}
const args = process.argv.slice(2);
const POLL_MS = 100;

function send(stdin) {
  const id = crypto.randomBytes(8).toString('hex');
  const request = path.join(dir, `req-${id}.json`);
  const reply = path.join(dir, `res-${id}.json`);
  fs.writeFileSync(`${request}.tmp`, JSON.stringify({ token, args, cwd: process.cwd(), stdin }));
  fs.renameSync(`${request}.tmp`, request);
  const check = () => {
    let text;
    try {
      text = fs.readFileSync(reply, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') { setTimeout(check, POLL_MS); return; }
      process.stderr.write(`orca: could not read the reply: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    const result = JSON.parse(text);
    try { fs.rmSync(reply, { force: true }); } catch { /* removed when the session ends */ }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code == null ? 1 : result.code;
  };
  check();
}

// Orca reads stdin only for `--spec-file -` and the like.
if (args.includes('-')) {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { text += chunk; });
  process.stdin.on('end', () => send(text));
} else {
  send('');
}
