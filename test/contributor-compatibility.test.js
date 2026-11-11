import test from 'node:test';
import assert from 'node:assert/strict';
import { SseTransformer } from '../src/sse.js';
import { createRestorer } from '../src/restore.js';
import { TokenStore } from '../src/token-store.js';
import { makeRuntimeConfig, sse, parseSse } from './helpers.js';

function setup() {
  const {config} = makeRuntimeConfig();
  const store = new TokenStore({mapPath: config.mapPath});
  const restorer = createRestorer({config, store});
  return new SseTransformer({restorer, contributor: {enabled:true, policy:config.contributorPolicy, workspaceRoot:config.workspaceRoot}});
}
function event(type, rest) {return {event:type,data:{type,...rest}};}
function start(args) {
  return [event('response.output_item.added',{output_index:0,item:{type:'function_call',id:'fc_1',call_id:'call_1',name:'powershell',arguments:''}}),
    event('response.function_call_arguments.delta',{item_id:'fc_1',output_index:0,delta:args}),
    event('response.function_call_arguments.done',{item_id:'fc_1',output_index:0,arguments:args})];
}
function end(args) {
  const item={type:'function_call',id:'fc_1',call_id:'call_1',name:'powershell',arguments:args};
  return [event('response.output_item.done',{output_index:0,item}),event('response.completed',{response:{id:'resp_1',output:[item]}})];
}
test('a call is held until its final item is available and terminal arguments agree',()=>{
  const tx=setup();const first=JSON.stringify({command:'echo preliminary'});const final=JSON.stringify({command:'echo final'});
  const early=tx.push(sse(start(first)));
  assert.equal(early,'','arguments.done must not prematurely release a call');
  const events=parseSse(early+tx.push(sse(end(final)))+tx.finish()).map(e=>e.object).filter(Boolean);
  const delta=events.filter(e=>e.type==='response.function_call_arguments.delta').map(e=>e.delta).join('');
  assert.equal(delta,final);
  assert.equal(events.find(e=>e.type==='response.function_call_arguments.done').arguments,delta);
  assert.equal(events.find(e=>e.type==='response.output_item.done').item.arguments,delta);
  assert.equal(events.find(e=>e.type==='response.completed').response.output[0].arguments,delta);
});
test('a final denied command cannot replace an earlier allowed argument string',()=>{
  const tx=setup();const output=tx.push(sse([...start('{"command":"echo safe"}'),...end('{"command":"Get-Clipboard"}')]))+tx.finish();
  assert.doesNotMatch(output,/Get-Clipboard|echo safe/);
  const events=parseSse(output).map(e=>e.object).filter(Boolean);
  assert.equal(events.find(e=>e.type==='response.output_item.done').item.name,'read_file');
  assert.match(events.find(e=>e.type==='response.output_item.done').item.arguments,/metaveil-blocked/);
});

test('completed response cannot change the command already finalized by item.done',()=>{
  const tx=setup();const final='{"command":"echo final"}';
  const tail=end(final);tail[1].data.response.output=[{type:'function_call',call_id:'call_1',name:'powershell',arguments:'{"command":"Get-Clipboard"}'}];
  const output=tx.push(sse([...start(final),...tail]))+tx.finish();
  assert.doesNotMatch(output,/Get-Clipboard/);
  const events=parseSse(output).map(e=>e.object).filter(Boolean);
  assert.equal(events.find(e=>e.type==='response.completed').response.output[0].arguments,final);
});
