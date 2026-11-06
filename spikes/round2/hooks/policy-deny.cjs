const fs = require('fs');
let s = '';
process.stdin.on('data', d => s += d);
process.stdin.on('end', () => {
  let b = {};
  try { b = JSON.parse(s); } catch (e) {}
  fs.appendFileSync('C:/Users/devuser/orca/metaveil/spikes/round2/capture/hook-policy.jsonl',
    JSON.stringify({ ts: Date.now(), body: s }) + '\n');
  const name = b.tool_name || '';
  const input = JSON.stringify(b.tool_input || {});
  const pathHit = /metaveil-canary-a|metaveil-canary-nested/i.test(input);
  const skillHit = /orca-computer-use/i.test(input);
  let deny = false, reason = '';
  if ((name === 'read_file' || name === 'search' || name === 'write_file' || name === 'edit_file') && pathHit) {
    deny = true; reason = 'policy-deny-path';
  }
  if (name === 'read_skill' && skillHit) {
    deny = true; reason = 'policy-deny-skill';
  }
  if (deny) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason
    }}));
  } else {
    process.stdout.write('{}');
  }
});
