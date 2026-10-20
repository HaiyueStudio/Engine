import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {minimumPossiblePooledP95,assessG05RoomRejection} from './deferred-g05-rejection-policy.mjs';
import {valid} from './deferred-g05-test-data.mjs';
const config=JSON.parse(readFileSync(new URL('../../config/lighting-performance-021.json',import.meta.url)));
function candidate(){
 const job={caseId:'overlap-128',algorithm:'tiled',preference:'low-power',moving:true,full:true,idleMs:120000};
 const result=valid(job);result.adapter={vendor:'intel',architecture:'gen-9',isFallbackAdapter:false};
 return {job,evidence:{schemaVersion:1,tier:'diagnostic-g05-performance-candidate',options:{...job},interCaseIdleMs:120001,hostSamples:Array.from({length:2},()=>({ready:true,cpuSpeedLimit:100,cpuSchedulerLimit:100})),inputs:{sha256:'a'.repeat(64)},build:{inputs:{sha256:'a'.repeat(64)}},harness:{sha256:'b'.repeat(64)},revision:'c'.repeat(40),result}};
}
test('zero completion gives the exact nearest-rank lower bound without modifying samples',()=>{
 const samples=Array.from({length:300},(_,i)=>i+1),before=[...samples];
 assert.equal(minimumPossiblePooledP95(samples,900),255);assert.deepEqual(samples,before);
 const completed=[...samples,...Array(600).fill(0)].toSorted((a,b)=>a-b);assert.equal(completed[854],255);
 assert.equal(minimumPossiblePooledP95([],900),0);assert.equal(minimumPossiblePooledP95([100],900),0);
 assert.equal(minimumPossiblePooledP95(Array(900).fill(4),900),4);
});
test('nonnegative completions never fall below the witness, including ties and zero timings',()=>{
 const observed=Array.from({length:300},(_,i)=>(i*17)%73),bound=minimumPossiblePooledP95(observed,900);
 for(const fill of [0,.01,10,100,1000]){const completed=[...observed,...Array.from({length:600},(_,i)=>i%2?fill:0)].toSorted((a,b)=>a-b);assert.ok(completed[854]>=bound);}
 for(const [a,n]of [[[-1],900],[[NaN],900],[[Infinity],900],[[1,2],1],[[],0],[[],1.5]])assert.throws(()=>minimumPossiblePooledP95(a,n));
});
test('a full qualified capture can prove failure, but can never prove passage',()=>{
 const {job,evidence}=candidate();assert.equal(assessG05RoomRejection(evidence,job,config).status,'inconclusive');
 evidence.result.gpu.forEach(s=>s.gpuSpanMs=62);
 const report=assessG05RoomRejection(evidence,job,config),gpu=report.checks.find(c=>c.metric==='gpuP95Ms');
 assert.equal(report.status,'failed');assert.equal(gpu.lowerBoundMs,62);assert.equal(gpu.limitMs,24);assert.equal(gpu.unmeasuredSamples,600);assert.equal(report.releaseQualified,false);
});
test('throttled, short or altered-contract captures cannot furnish a rejection witness',()=>{
 const {job,evidence}=candidate();
 for(const mutate of [e=>e.hostSamples[1].cpuSpeedLimit=75,e=>e.result.gpu.pop(),e=>e.tier='smoke',e=>e.build.inputs.sha256='f'.repeat(64)]){const copy=structuredClone(evidence);mutate(copy);assert.throws(()=>assessG05RoomRejection(copy,job,config));}
 for(const mutate of [c=>c.state='draft',c=>c.sampling.cohorts=2,c=>c.sampling.dropSlowSamples=true,c=>c.sampling.percentile='interpolated']){const copy=structuredClone(config);mutate(copy);assert.throws(()=>assessG05RoomRejection(evidence,job,copy),/contract/);}
});
