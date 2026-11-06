const fs = require('fs');
let s = '';
process.stdin.on('data', d => s += d);
process.stdin.on('end', () => {
  fs.appendFileSync('C:/Users/devuser/orca/metaveil/spikes/capture/hook-payloads.jsonl', JSON.stringify({ts: Date.now(), argv: process.argv, body: s}) + '\n');
  process.stdout.write('{}');
});
