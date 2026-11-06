const fs = require('fs');
let s = '';
process.stdin.on('data', d => s += d);
process.stdin.on('end', () => {
  const rec = {ts: new Date().toISOString(), argv: process.argv, cwd: process.cwd(), env: {MUSE_SESSION_ID: process.env.MUSE_SESSION_ID || null}, body: s};
  fs.appendFileSync('C:/Users/devuser/orca/metaveil/spikes/capture/hook-payloads.jsonl', JSON.stringify(rec) + '\n');
  process.stdout.write('{}');
});
