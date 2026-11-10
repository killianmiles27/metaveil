import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTRIBUTOR_GUIDANCE, addContributorGuidance } from '../src/guidance.js';
import {makeRuntimeConfig,startFakeUpstream,startProxy,postResponses,contributorPreamble,SYNTH,sse,parseSse} from './helpers.js';

test('guidance preserves instructions, is idempotent and contains no sandbox grant',()=>{
  const original={instructions:'Original system rules',input:[]};
  const next=addContributorGuidance(original);
  assert.ok(next.instructions.startsWith(original.instructions));
  assert.equal(addContributorGuidance(next),next);
  assert.doesNotMatch(CONTRIBUTOR_GUIDANCE,/Session permission mode|Shell sandbox: on\./);
  assert.match(CONTRIBUTOR_GUIDANCE,/not a real file/);
  assert.match(CONTRIBUTOR_GUIDANCE,/timeout is not an approval/);
});

test('verified Contributor and reviewer requests receive guidance and still redact identity',async t=>{
  const upstream=await startFakeUpstream(async(_req,res)=>{
    const args=JSON.stringify({decision:'approve',reason:'Synthetic sandboxed test'});
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(sse([{event:'response.completed',data:{type:'response.completed',response:{output:[{type:'function_call',id:'a',call_id:'c',name:'submit_approval_assessment',arguments:args}]}}}]));
  });t.after(()=>upstream.close());
  const {config}=makeRuntimeConfig({upstream:upstream.url});const proxy=await startProxy(config);t.after(()=>proxy.stop());
  const headers={'x-tbh-contributor-mode':'1','x-tbh-session-id':'parent'};
  const first=await postResponses(proxy.url,{model:'muse-wonder-1.0',instructions:contributorPreamble(),input:[],stream:true},headers);
  assert.equal(first.status,200);
  const review={model:'muse-spark-1.3',input:[{role:'user',content:`Review synthetic action for ${SYNTH.name} ${SYNTH.email}`}],tools:[{type:'function',name:'submit_approval_assessment',parameters:{type:'object'}}],stream:true};
  const response=await postResponses(proxy.url,review,{...headers,'x-tbh-session-id':'review-child','x-tbh-root-session-id':'parent'});
  assert.equal(response.status,200);
  assert.equal(parseSse(response.body).find(e=>e.object?.type==='response.completed').object.response.output[0].name,'submit_approval_assessment');
  const sent=JSON.parse(upstream.requests.at(-1).body);
  assert.ok(sent.instructions.includes(CONTRIBUTOR_GUIDANCE));
  assert.equal(sent.model,'muse-spark-1.3');
  assert.equal(upstream.requests.at(-1).headers['x-tbh-contributor-mode'],'1');
  assert.ok(sent.tools.some(tool=>tool.name==='submit_approval_assessment'));
  assert.doesNotMatch(JSON.stringify(sent),new RegExp(SYNTH.name+'|'+SYNTH.email));
  assert.equal((await postResponses(proxy.url,review,{'x-tbh-contributor-mode':'1','x-tbh-session-id':'unknown'})).status,403);
});

test('guidance is Contributor-only and cannot satisfy a missing permission block',async t=>{
  const upstream=await startFakeUpstream(async(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"output":[]}');});t.after(()=>upstream.close());
  const {config}=makeRuntimeConfig({upstream:upstream.url});const proxy=await startProxy(config);t.after(()=>proxy.stop());
  const body={model:'fixture',input:[{role:'user',content:'hello'}]};
  assert.equal((await postResponses(proxy.url,body,{'x-tbh-contributor-mode':'1'})).status,403);
  assert.equal(upstream.requests.length,0);
  assert.equal((await postResponses(proxy.url,body,{'x-tbh-contributor-mode':'0'})).status,200);
  assert.ok(!JSON.stringify(JSON.parse(upstream.requests[0].body)).includes('metaveil-contributor-guidance'));
});
