import test from 'node:test';
import assert from 'node:assert/strict';
import {captureAllocationPhase} from './allocation-sampling-phase.mjs';
test('allocation profiler samples only between explicit fixture boundaries and retains raw samples',async()=>{
 const calls=[],profile={head:{id:1},samples:[{size:64,nodeId:1}]};
 const cdp={async call(method,args){calls.push({method,args});return method==='HeapProfiler.stopSampling'?{result:{profile}}:{result:{result:{value:true}}};}};
 const wait=async(read,_timeout,label)=>{calls.push({label});assert.equal(await read(),true);};
 assert.equal(await captureAllocationPhase(cdp,wait,{phase:'fixture-steady-state-v1',samplingInterval:4096},500),profile);
 assert.deepEqual(calls.filter(x=>x.method).map(x=>x.method),['Runtime.evaluate','HeapProfiler.startSampling','Runtime.evaluate','Runtime.evaluate','HeapProfiler.stopSampling','Runtime.evaluate']);
 assert.deepEqual(calls[2].args,{samplingInterval:4096,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
});
test('failed fixture stops sampling and cannot resume cleanup or return partial success',async()=>{
 const calls=[];let waits=0;
 const cdp={async call(method){calls.push(method);return {result:{profile:{head:{},samples:[]},result:{value:true}}};}};
 await assert.rejects(captureAllocationPhase(cdp,async()=>{if(++waits===2)throw Error('fixture failure');},{phase:'fixture-steady-state-v1'},500),/fixture failure/);
 assert.deepEqual(calls,['HeapProfiler.startSampling','Runtime.evaluate','HeapProfiler.stopSampling']);
 await assert.rejects(captureAllocationPhase(cdp,()=>{},{phase:'unknown'},500),/Unknown/);
});
