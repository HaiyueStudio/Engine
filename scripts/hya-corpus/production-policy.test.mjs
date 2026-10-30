import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessHyaPacing,compareGpuRows,productionWorkloads} from './production-policy.mjs';
const budget=JSON.parse(readFileSync(new URL('../../config/framegraph-production-021.json',import.meta.url)));
const capture=()=>({readyFrames:[{started:0,submitted:1,completed:2,visible:true,focused:true},{started:3,submitted:4,completed:5,visible:true,focused:true}],errors:[],events:[],frames:Array.from({length:2401},(_,index)=>({time:100+index*1000/60,visible:true,focused:true}))});
test('G12 preserves production pacing limits and retains the 10k diagnostic population',()=>{
 assert.deepEqual(productionWorkloads.map(w=>w.id),['interactive-small','layout-1k','layout-10k-diagnostic','multi-instance']);
 assert.equal(assessHyaPacing(capture(),budget).status,'passed');
 const slow=capture();slow.frames=slow.frames.filter((_,index)=>index%4===0);assert.equal(assessHyaPacing(slow,budget).status,'failed');
 const hidden=capture();hidden.frames[50].focused=false;assert.equal(assessHyaPacing(hidden,budget).status,'inconclusive');
 const truncated=capture();truncated.frames.pop();assert.throws(()=>assessHyaPacing(truncated,budget));
});
test('GPU comparisons retain every raw sample, reject missing timing and enforce the original limit',()=>{
 const before=Array(30).fill({gpuMs:1}),after=Array(30).fill({gpuMs:1.051});assert.equal(compareGpuRows(before,after,.05).status,'failed');assert.equal(compareGpuRows(before,before,.05).status,'passed');assert.throws(()=>compareGpuRows(before,[{gpuMs:0}],.05));assert.throws(()=>compareGpuRows([],before,.05));
});
