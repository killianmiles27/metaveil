// Real Muse CLI -> real MetaVeil -> deterministic loopback fixture. No Meta/Jev
// request is made. This verifies CLI compatibility, not model reasoning quality.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {normalizeConfig} from '../src/config.js';
import {createProxyServer} from '../src/server.js';
import {hookCommandFor} from '../src/install/launcher.js';

const repo=path.resolve(import.meta.dirname,'..');
const install=path.join(process.env.LOCALAPPDATA,'Programs','muse');
const candidates=fs.readdirSync(install).filter(n=>/^muse-bin.*\.exe$/i.test(n)).map(n=>path.join(install,n)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
const binary=process.env.METAVEIL_SMOKE_MUSE_EXE||candidates[0];
assert.ok(binary,'A local Muse CLI binary is required');
fs.mkdirSync(path.join(repo,'.metaveil-tmp'),{recursive:true});
const work=fs.mkdtempSync(path.join(repo,'.metaveil-tmp','compatibility-'));
const workspace=path.join(work,'workspace');fs.mkdirSync(workspace,{recursive:true});
const home=os.homedir();const user=os.userInfo().username;
const fixtureName='Synthetic Privacy Canary';const fixtureSecret='ghp_0123456789ABCDEFGHIJKLMNOPQRSTUV012345';
fs.writeFileSync(path.join(workspace,'fixture.txt'),`SAFE_FIXTURE\n${fixtureName}\n${fixtureSecret}\n`);
let mainRequests=0;const observed=[];const modes=[];
const responseObject=(id,status,output)=>({id,object:'response',model:'muse-wonder-1.0',status,created_at:Math.floor(Date.now()/1000),output,usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}},error:null,incomplete_details:null});
const server=http.createServer(async(req,res)=>{
  if(req.method==='GET') {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:['muse-wonder-1.0','muse-wonder-1.0-contributor','muse-spark-1.3','muse-spark-1.3-contributor'].map(id=>({id,object:'model',owned_by:'meta',created:0}))}));return;}
  const buffers=[];for await(const b of req)buffers.push(b);
  const body=JSON.parse(Buffer.concat(buffers));observed.push(body);modes.push(req.headers['x-tbh-contributor-mode']);
  const tools=(body.tools||[]).flatMap(t=>t.tools||t.functions||[t]);
  const main=tools.some(t=>/(^|\.)powershell$/.test(t.name||''));
  const step=main?mainRequests++:0;
  const calls=[
    {name:'muse.powershell',args:{command:'Get-Content -LiteralPath fixture.txt',description:'Read synthetic fixture'}},
    // Harmless if executed, but intentionally matches the existing desktop denial.
    {name:'muse.powershell',args:{command:"Write-Output 'orca computer'",description:'Verify privacy refusal'}},
    {name:'muse.powershell',args:{command:'Set-Content -LiteralPath smoke-ok.txt -Value METAVEIL_SMOKE_OK',description:'Continue permitted coding after refusal'}},
  ];
  const call=main?calls[step]:{name:'muse.submit_reminder_decision',args:{decision:'none',advisory_text:null,confidence:'high',priority:'low',reason:'Synthetic loopback fixture',skill_id:null,visible_for_steps:1}};
  const id='resp_fixture_'+observed.length;let sequence=0;
  res.writeHead(200,{'content-type':'text/event-stream'});
  const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data,sequence_number:sequence++})}\n\n`);
  send('response.created',{response:responseObject(id,'in_progress',[])});
  let item;
  if(call){const args=JSON.stringify(call.args);item={id:'fc_'+id,type:'function_call',status:'completed',call_id:'call_'+id,name:call.name,arguments:args};
    send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',arguments:''}});
    // Exercise the formerly inconsistent terminal-arguments case safely.
    const provisional=main&&step===0?JSON.stringify({...call.args,command:'Write-Output preliminary'}):args;
    send('response.function_call_arguments.delta',{item_id:item.id,output_index:0,delta:provisional});
    send('response.function_call_arguments.done',{item_id:item.id,output_index:0,arguments:provisional});
  }else{const text='METAVEIL_LOOPBACK_DONE';item={id:'msg_'+id,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[],logprobs:[]}]};
    send('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});
    send('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[],logprobs:[]}});
    send('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:text});
    send('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text});
    send('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part:item.content[0]});}
  send('response.output_item.done',{output_index:0,item});send('response.completed',{response:responseObject(id,'completed',[item])});res.end('data: [DONE]\n\n');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const config=normalizeConfig({port:0,upstream:`http://127.0.0.1:${server.address().port}`,homeDir:home,workspaceRoot:workspace,mapPath:path.join(work,'map.json'),auditPath:path.join(work,'audit.jsonl'),identity:{names:[fixtureName],usernames:[user],hostnames:[os.hostname()]}});
const proxy=await createProxyServer({config});const address=await proxy.listen(0);
let child;
try{
  const hook=hookCommandFor(path.join(repo,'src/hook/policy.cjs'));
  assert.ok(!/\s/.test(path.join(repo,'src/hook/policy.cjs')),'The installed Muse hook requires a path without spaces');
  const hooks=JSON.stringify({PreToolUse:[{hooks:[{type:'command',command:hook,timeout:15}]}]});
  const args=['exec','--contributor-mode','on','--model','muse-wonder-1.0','--reasoning-effort','low','--no-session-log','--trust-workspace','--approval-mode','never','--approval-judge','off','-c','telemetry.enabled=false','-c',`hooks=${hooks}`,'--base-url',address.url+'/v1','Run only the scripted local compatibility fixture.'];
  let output='';const result=await new Promise((resolve,reject)=>{child=spawn(binary,args,{cwd:workspace,env:{...process.env,MUSE_CONTRIBUTOR_MODE:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{child.kill();reject(Error('CLI fixture exceeded 60 seconds'));},60000);child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);resolve(code);});});
  assert.equal(result,0,`Muse CLI failed; diagnostics remain local in ${work}`);
  assert.ok(output.includes('METAVEIL_LOOPBACK_DONE'));
  assert.equal(fs.readFileSync(path.join(workspace,'smoke-ok.txt'),'utf8').trim(),'METAVEIL_SMOKE_OK');
  const sent=JSON.stringify(observed);
  fs.writeFileSync(path.join(work,'diagnostics.json'),JSON.stringify({modes,output,toolOutputs:observed.flatMap(b=>(b.input||[]).filter(i=>i.type==='function_call_output'))},null,2));
  assert.ok(modes.every(m=>m==='1'),'Real CLI must stay in Contributor mode');
  assert.doesNotMatch(output,/arguments mismatch|stream protocol error/i);
  const probes=[fixtureName,fixtureSecret,home,home.replaceAll('\\','/'),home.replaceAll('\\','\\\\')];
  const leaks=probes.map((value,index)=>sent.includes(value)?index:null).filter(v=>v!==null);
  if(leaks.length)fs.writeFileSync(path.join(work,'privacy-diagnostics.json'),JSON.stringify({leakProbeIndexes:leaks,requests:observed},null,2));
  assert.equal(leaks.length,0,'A synthetic private value or local home path survived redaction; probe indexes: '+leaks.join(','));
  assert.ok(sent.includes('SAFE_FIXTURE'));
  assert.ok(sent.includes('privacy refusal'));
  console.log(JSON.stringify({passed:true,realMuseCLI:true,contributorMode:true,externalModelRequests:0,mainRequests,consistentArguments:true,privacyDenialObserved:true,codingContinued:true,syntheticCanariesRedacted:true}));
}finally{child?.kill();await proxy.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
