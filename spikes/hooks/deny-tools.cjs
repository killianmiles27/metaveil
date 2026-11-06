const fs=require('fs');
let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{
  let b={}; try{b=JSON.parse(s)}catch(e){}
  fs.appendFileSync('C:/Users/devuser/orca/metaveil/spikes/capture/hook-payloads.jsonl',JSON.stringify({ts:Date.now(),body:s})+'\n');
  const out={hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'spike-hook-deny-9902'}};
  process.stdout.write(JSON.stringify(out));
});
