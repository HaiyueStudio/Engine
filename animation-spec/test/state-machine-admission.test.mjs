import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHyaStateMachineV2} from '../dist/hya-production.js';
const minimal=()=>({format:'haiyue-animation-state-machine@2',extension:'org.haiyue.animation-state-machine@2',channels:[],clips:[],stateMachines:[]});
const channel=id=>({id,target:'node',path:'x',family:'transform',valueKind:'number',policy:'override'});
function observe(t) {
 const clone=globalThis.structuredClone,seen=[];
 globalThis.structuredClone=(...args)=>{seen.push(args[0]);return clone(...args);};
 t.after(()=>{globalThis.structuredClone=clone;});return seen;
}
test('excess channels reject before any native clone or entry getter reads',t=>{
 const seen=observe(t),input=minimal();let reads=0;input.channels=Array.from({length:4096},()=>Object.defineProperty({},'touch',{enumerable:true,get(){reads++;return 1;}}));
 assert.throws(()=>parseHyaStateMachineV2(input,{limits:{maxChannels:1}}),e=>e.code==='E_STATE_MACHINE_V2_LIMIT'&&e.path==='$.channels');
 assert.equal(seen.length,0);assert.equal(reads,0);assert.equal(Object.isFrozen(input),false);
});
test('ordinary oversized JSON and unknown binary payload reject without copying',t=>{
 const seen=observe(t),large=JSON.parse(JSON.stringify({...minimal(),channels:Array.from({length:4096},(_,i)=>channel('c'+i))}));
 assert.throws(()=>parseHyaStateMachineV2(large,{limits:{maxChannels:1}}),e=>e.code==='E_STATE_MACHINE_V2_LIMIT'&&e.path==='$.channels');
 assert.throws(()=>parseHyaStateMachineV2({...minimal(),unknown:new Uint8Array(16*1024*1024)}),e=>e.code==='E_STATE_MACHINE_V2_FORMAT'&&e.path==='$.unknown');
 assert.equal(seen.length,0);
});
test('aggregate track limits are checked across clips before snapshot allocation',t=>{
 const seen=observe(t),input={...minimal(),channels:[channel('x')],clips:[0,1].map(i=>({id:'clip'+i,duration:1,tracks:[{id:'track',channel:'x',keys:[{time:0,value:0}]}]}))};
 assert.throws(()=>parseHyaStateMachineV2(input,{limits:{maxTracks:1}}),e=>e.code==='E_STATE_MACHINE_V2_LIMIT'&&e.path==='$.clips[1].tracks');assert.equal(seen.length,0);
});
test('accepted data is cloned once, deeply frozen, and remains isolated from the caller',t=>{
 const seen=observe(t),input={...minimal(),channels:[{...channel('x'),defaultValue:1}]};
 const result=parseHyaStateMachineV2(input,{limits:{maxChannels:1}});assert.equal(seen.length,1);assert.notEqual(result,input);assert.notEqual(result.channels,input.channels);assert.equal(Object.isFrozen(input),false);assert.equal(Object.isFrozen(input.channels[0]),false);assert.ok(Object.isFrozen(result.channels[0]));
 input.channels[0].defaultValue=2;assert.equal(result.channels[0].defaultValue,1);
});
test('snapshot values receive the same validation if an executable input changes between reads',t=>{
 const clone=globalThis.structuredClone;
 globalThis.structuredClone=value=>{const snapshot=clone(value);snapshot.channels=[channel('a'),channel('b')];return snapshot;};t.after(()=>{globalThis.structuredClone=clone;});
 assert.throws(()=>parseHyaStateMachineV2(minimal(),{limits:{maxChannels:1}}),e=>e.code==='E_STATE_MACHINE_V2_LIMIT'&&e.path==='$.channels');
});
