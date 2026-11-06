const fs = require('fs');
let s = '';
process.stdin.on('data', d => s += d);
process.stdin.on('end', () => {
  const mode = process.argv[2] || 'allow';
  fs.appendFileSync('C:/Users/devuser/orca/metaveil/spikes/round2/capture/hook-fail.jsonl',
    JSON.stringify({ ts: Date.now(), mode, body: s }) + '\n');
  if (mode === 'exit1') process.exit(1);
  if (mode === 'exit2') process.exit(2);
  if (mode === 'badjson') { process.stdout.write('this is not json'); return; }
  if (mode === 'empty') { process.stdout.write(''); return; }
  if (mode === 'hang') { setTimeout(() => {}, 600000); return; }
  if (mode === 'throw') { throw new Error('hook boom'); }
  if (mode === 'deny') { process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'fail-mode-deny'}})); return; }
  process.stdout.write('{}');
});
