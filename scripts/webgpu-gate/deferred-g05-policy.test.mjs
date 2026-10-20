import test from 'node:test';
import assert from 'node:assert/strict';
import {parseG05RoomOptions,validateG05RoomResult,summarizeG05Room,G05_ROOM_CASES} from './deferred-g05-policy.mjs';
import {valid} from './deferred-g05-test-data.mjs';
test('G05 case/option parsing rejects typos, prototype keys and conflicting populations',()=>{
 assert.equal(parseG05RoomOptions([]).idleMs,120000);
 for(const args of [['--case=__proto__'],['--case=constructor'],['--case=bad'],['--full','--full'],['--idle-ms=1'],['--idle-ms=1e5'],['--static','--case=dynamic-128-four-view'],['--smoke']])assert.throws(()=>parseG05RoomOptions(args));
 for(const id of Object.keys(G05_ROOM_CASES))assert.equal(parseG05RoomOptions([`--case=${id}`]).caseId,id);
});
test('G05 requires separate complete CPU/GPU populations and actual timestamp stage totals',()=>{
 const options=parseG05RoomOptions([]);validateG05RoomResult(valid(),options);
 for(const mutate of [r=>r.cpu.pop(),r=>r.gpu.pop(),r=>r.cpu[0].timestampQuery=true,r=>r.cpu[0].frame=1,r=>r.cpu[0].frameWallMs=NaN,r=>r.gpu[0].gpuSpanMs=Infinity,r=>r.gpu[0].resolveMs=1,r=>r.gpu[0].passes=[],r=>r.gpu[0].bypassReason=null,r=>r.gpu[0].effective='forward',r=>r.cpuMetrics.metricClassification.measuredFrames=1]){
  const r=valid();mutate(r);assert.throws(()=>validateG05RoomResult(r,options));
 }
 assert.throws(()=>validateG05RoomResult(valid(),{...options,full:true}));
 assert.deepEqual(summarizeG05Room(valid()),{cpuP95Ms:1,frameWallP95Ms:3,gpuP95Ms:3,resolveP95Ms:2,cullP95Ms:0});
});
test('G05 rejects missing or contaminated views, HDR violations, missing resources and cleanup leaks',()=>{
 const options=parseG05RoomOptions(['--case=dynamic-128-four-view']);validateG05RoomResult(valid(options),options);
 for(const mutate of [r=>r.pixels.pop(),r=>r.pixels[0].key=r.pixels[1].key,r=>r.pixels[0].maxHdrToleranceRatio=1.001,r=>r.pixels[0].maxLdrDelta=3,r=>r.pixels[0].checkedComponents=4,r=>r.pixels[0].litPixels=0,r=>delete r.resources.cpu.buffer.created,r=>r.cold.firstFrame.gpuTimestamp={},r=>r.source.pointCount=8,r=>r.validationErrors.push('error'),r=>r.cleanup.liveGpuResources=1,r=>r.adapter.isFallbackAdapter=true]){
  const r=valid(options);mutate(r);assert.throws(()=>validateG05RoomResult(r,options));
 }
});
