import test from 'node:test';
import assert from 'node:assert/strict';
import {parseG05AllocationOptions,validateG05Allocation} from './deferred-g05-allocation-policy.mjs';
const options=parseG05AllocationOptions([]);
function valid(){return {schemaVersion:1,status:'passed',suite:'g05-cpu-allocations',performanceQualified:false,adapter:{vendor:'amd',architecture:'rdna-1',isFallbackAdapter:false},validationErrors:[],...options,width:1280,height:720,views:1,count:128,warmup:120,frames:300,fixtureId:'deferred-room-021-v1',completeCoverage:true,source:{pointCount:128},cleanup:{ownerResidual:0,liveGpuResources:0},resources:{before:{texture:{created:4},buffer:{created:3}},after:{texture:{created:4},buffer:{created:3}}},metrics:{metricClassification:{measuredFrames:300,strictEquality:{passed:true}}},pixels:[{key:'real-frame-view:0',components:1280*720*4,litPixels:500000}],allocationSampling:{kind:'chrome-v8-allocation-sampling',scope:'fixture-steady-state-v1',samplingInterval:4096,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true,sampledBytes:8192,sampleCount:2,rawProfile:{head:{id:0,children:[{id:1}]},samples:[{size:4096,nodeId:1},{size:4096,nodeId:1}]}}};}
test('allocation workload is bounded and never accepts timing-qualification flags',()=>{
 assert.equal(options.caseId,'sparse-128');assert.equal(parseG05AllocationOptions(['--reference','--static']).moving,false);
 for(const args of [['--full'],['--idle-ms=120000'],['--case=stress-1024'],['--case=dynamic-128-four-view','--static']])assert.throws(()=>parseG05AllocationOptions(args));
});
test('allocation evidence binds measured phase, complete raw population and live render output',()=>{
 assert.equal(validateG05Allocation(valid(),options).sampledBytes,8192);
 const changes=[r=>r.performanceQualified=true,r=>r.frames=3,r=>r.resources.after.texture.created++,r=>r.metrics.metricClassification.measuredFrames=299,r=>r.pixels[0].litPixels=0,r=>r.cleanup.ownerResidual=1,r=>r.allocationSampling.scope='whole-page',r=>r.allocationSampling.includeObjectsCollectedByMinorGC=false,r=>r.allocationSampling.rawProfile.samples.pop(),r=>r.allocationSampling.rawProfile.samples[0].nodeId='missing',r=>r.allocationSampling.rawProfile.samples[0].size=-1,r=>r.allocationSampling.sampledBytes++,r=>r.allocationSampling.rawProfile.head.children.push({id:1})];
 for(const change of changes){const r=valid();change(r);assert.throws(()=>validateG05Allocation(r,options));}
});

test('Chrome samples without a returned tree node remain included and explicitly unattributed',()=>{const r=valid();r.allocationSampling.rawProfile.samples[0].nodeId=9;const v=validateG05Allocation(r,options);assert.equal(v.sampledBytes,8192);assert.equal(v.unattributedBytes,4096);assert.equal(v.unattributedSamples,1);});
