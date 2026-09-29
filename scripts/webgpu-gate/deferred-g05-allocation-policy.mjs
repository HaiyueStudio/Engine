import {G05_ROOM_CASES,parseG05RoomOptions} from './deferred-g05-policy.mjs';
export function parseG05AllocationOptions(args){
 if(args.some(a=>a==='--full'||a.startsWith('--idle-ms=')))throw Error('Allocation diagnostics are not timing qualification');
 const options=parseG05RoomOptions(args.some(a=>a.startsWith('--case='))?args:['--case=sparse-128',...args]);
 if(!['sparse-128','dynamic-128-four-view'].includes(options.caseId))throw Error('Unsupported allocation case');
 return options;
}
export function validateG05Allocation(r,options){
 if(r.status!=='passed'||r.schemaVersion!==1||r.suite!=='g05-cpu-allocations'||r.performanceQualified!==false)throw Error('Invalid allocation diagnostic');
 if(r.adapter?.isFallbackAdapter!==false||!r.adapter.vendor||!r.adapter.architecture||r.validationErrors?.length!==0)throw Error('Native device validation failed');
 const c=G05_ROOM_CASES[options.caseId];
 for(const key of ['caseId','algorithm','moving'])if(r[key]!==options[key])throw Error('Allocation workload mismatch');
 for(const key of ['width','height','views','count'])if(r[key]!==c[key])throw Error('Allocation scene mismatch');
 if(r.warmup!==120||r.frames!==300||r.fixtureId!=='deferred-room-021-v1'||r.completeCoverage!==true||r.source?.pointCount!==c.count)throw Error('Missing allocation population/coverage');
 if(r.cleanup?.ownerResidual!==0||r.cleanup.liveGpuResources!==0)throw Error('Allocation diagnostic leaked GPU resources');
 for(const kind of ['texture','buffer'])if(r.resources?.before?.[kind]?.created!==r.resources?.after?.[kind]?.created||!Number.isFinite(r.resources?.before?.[kind]?.created))throw Error('Steady GPU creation');
 if(r.metrics?.metricClassification?.measuredFrames!==300||r.metrics.metricClassification.strictEquality?.passed!==true)throw Error('Counter population mismatch');
 if(r.pixels?.length!==c.views||r.pixels.some((p,i)=>p.key!==`real-frame-view:${i}`||p.components!==c.width*c.height*4||p.litPixels<c.width*c.height*.1))throw Error('Missing visible output');
 const a=r.allocationSampling;
 if(a?.kind!=='chrome-v8-allocation-sampling'||a.scope!=='fixture-steady-state-v1'||a.samplingInterval!==4096||a.includeObjectsCollectedByMajorGC!==true||a.includeObjectsCollectedByMinorGC!==true)throw Error('Wrong sampling scope');
 const nodes=new Set();
 function visit(n){if(!Number.isInteger(n?.id)||nodes.has(n.id))throw Error('Invalid profile node');nodes.add(n.id);for(const child of n.children??[])visit(child);}
 visit(a.rawProfile?.head);
 if(!Array.isArray(a.rawProfile.samples)||!a.rawProfile.samples.length||a.sampleCount!==a.rawProfile.samples.length)throw Error('Missing raw allocation samples');
 let bytes=0,unattributedBytes=0,unattributedSamples=0;for(const sample of a.rawProfile.samples){if(!Number.isInteger(sample.nodeId)||!Number.isFinite(sample.size)||sample.size<=0)throw Error('Invalid raw allocation sample');bytes+=sample.size;if(!nodes.has(sample.nodeId)){unattributedBytes+=sample.size;unattributedSamples++;}}
 if(bytes!==a.sampledBytes)throw Error('Allocation byte total mismatch');
 return {status:'passed',sampledBytes:bytes,sampledBytesPerFrame:bytes/300,unattributedBytes,unattributedSamples,exactAllocationCount:false,performanceQualified:false};
}
