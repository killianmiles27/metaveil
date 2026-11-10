import test from 'node:test';
import assert from 'node:assert/strict';
import {makeRuntimeConfig,startFakeUpstream,startProxy,postResponses,contributorPreamble,SYNTH} from './helpers.js';

test('embedded escaped tool-output lines cannot hide token prefixes or JWTs',async t=>{
  const upstream=await startFakeUpstream(async(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"output":[]}');});t.after(()=>upstream.close());
  const {config}=makeRuntimeConfig({upstream:upstream.url});const proxy=await startProxy(config);t.after(()=>proxy.stop());
  for(const token of [SYNTH.secretValue,SYNTH.jwt,'ghp_0123456789ABCDEFGHIJKLMNOPQRSTUV012345']) {
    for(const depth of [1,2,4]) {
      const separator='\\'.repeat(depth)+'r'+'\\'.repeat(depth)+'n';
      const content=`Tool result follows: {"output":"SAFE_LINE${separator}${token}${separator}"} End.`;
      const response=await postResponses(proxy.url,{model:'fixture',input:[{role:'developer',content:contributorPreamble()+'\n'+content}]},{'x-tbh-contributor-mode':'1'});
      assert.equal(response.status,200);
      const sent=upstream.requests.at(-1).body.toString('utf8');
      assert.ok(!sent.includes(token));assert.match(sent,/SECRET_\d+/);assert.ok(sent.includes('SAFE_LINE'));
    }
  }
});
