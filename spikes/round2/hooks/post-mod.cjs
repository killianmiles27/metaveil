const fs = require('fs');
let s = '';
process.stdin.on('data', d => s += d);
process.stdin.on('end', () => {
  let b = {}; try { b = JSON.parse(s); } catch (e) {}
  const mode = process.argv[2] || 'toolResponse';
  fs.appendFileSync('C:/Users/devuser/orca/metaveil/spikes/round2/capture/hook-post.jsonl', JSON.stringify({ts:Date.now(),mode,body:s}) + '\n');
  let out = {};
  if (mode === 'toolResponse') out = {hookSpecificOutput:{hookEventName:'PostToolUse',toolResponse:'POST-REPLACED'}};
  if (mode === 'updatedToolOutput') out = {hookSpecificOutput:{hookEventName:'PostToolUse',updatedToolOutput:'POST-REPLACED'}};
  if (mode === 'decisionBlock') out = {decision:'block', reason:'post-block-1234'};
  if (mode === 'additionalContext') out = {hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'POST-CTX-5678'}};
  if (mode === 'systemMessage') out = {systemMessage:'POST-SYS-9012'};
  process.stdout.write(JSON.stringify(out));
});
