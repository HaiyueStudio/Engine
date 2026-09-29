// Synthetic policy-test data only; never native evidence.
import {summarizeG05ResourceRecords} from './deferred-g05-memory-policy.mjs';
import {parseG05RoomOptions,G05_ROOM_CASES} from './deferred-g05-policy.mjs';
export function valid(options=parseG05RoomOptions([])){
 const c=G05_ROOM_CASES[options.caseId],n=options.full?300:3;
 const passes=Array.from({length:c.views},()=>({kind:'render',label:options.algorithm==='reference'?'DeferredReference.resolve':'DeferredTiles.resolve',durationMs:2}));
 const metrics={metricClassification:{measuredFrames:n,strictEquality:{passed:true}}};
 for(const k of ['bufferUploadsPerFrame','uploadBytesPerFrame','renderPipelinesCreated','bindGroupsCreated','buffersCreated','bufferExpansions','bufferRetirements','drawsPerFrame','renderPassesPerFrame','poolMisses','hotObjectsCreated'])metrics[k]=0;
 const records=Array.from({length:c.views},(_,view)=>[8,8,8,4].map((bpp,index)=>({id:view*4+index,label:`TransientMRT:real-frame-view:${view}:${index}`,type:'texture',estimatedBytes:bpp*c.width*c.height}))).flat();
 records.push({id:c.views*4,label:'DeferredLights.source',type:'buffer',estimatedBytes:1024});
 const attribution={schemaVersion:1,driverResidentMemory:false,records,...summarizeG05ResourceRecords(records)};
 const resource=Object.fromEntries(['buffer','texture'].map(type=>{const rows=records.filter(r=>r.type===type),bytes=rows.reduce((n,r)=>n+r.estimatedBytes,0);return [type,{created:rows.length,current:rows.length,peak:rows.length,estimatedBytes:bytes,peakEstimatedBytes:bytes}];}));
 return {schemaVersion:1,status:'passed',suite:'g05-room',...options,...c,adapter:{vendor:'amd',architecture:'rdna-1',isFallbackAdapter:false},fixtureId:'deferred-room-021-v1',samples:n,warmup:options.full?120:2,
 cpu:Array.from({length:n},(_,frame)=>({frame,timestampQuery:false,cpuRuntimeMs:1,cpuUpdateMs:0,cpuRecordMs:1,cpuSubmitMs:0,queueWaitMs:2,frameWallMs:3,authoredMutationMs:0})),
 gpu:Array.from({length:n},(_,frame)=>({frame,gpuSpanMs:3*c.views,gpuPassSumMs:2*c.views,resolveMs:2*c.views,resolveCount:c.views,cullMs:0,effective:`deferred-${options.algorithm}`,bypassReason:options.algorithm==='reference'?null:'all-lights-cover-near-plane',passes})),
 pixels:Array.from({length:c.views},(_,i)=>({key:`real-frame-view:${i}`,checkedComponents:c.width*c.height*4,maxHdrDelta:0,maxHdrToleranceRatio:0,maxLdrDelta:0,litPixels:c.width*c.height})),
 sourceUploads:Object.fromEntries(['cpu','gpu'].map(phase=>[phase,{before:{sourceUploads:1},after:{sourceUploads:1+(options.moving?n:0)}}])),source:{pointCount:c.count,directionalCount:1,ambientCount:1},completeCoverage:true,validationErrors:[],cleanup:{ownerResidual:0,liveGpuResources:0},cpuMetrics:metrics,gpuMetrics:metrics,
 cold:{scenarioSetupMs:1,profileInitializeMs:1,firstFrame:{sampleWallMs:5,gpuTimestamp:null}},resourceAttribution:Object.fromEntries(['warm','cpu','gpu'].map(p=>[p,structuredClone(attribution)])),resources:Object.fromEntries(['warm','cpu','gpu'].map(p=>[p,structuredClone(resource)]))};
}
