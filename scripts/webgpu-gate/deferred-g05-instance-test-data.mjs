// Synthetic policy-test data only; never native evidence.
export function instanceEvidence(job){
 const n=300,metrics=Object.fromEntries(['bindGroupsCreated','buffersCreated','renderPipelinesCreated','bufferUploadsPerFrame','uploadBytesPerFrame','drawsPerFrame','renderPassesPerFrame'].map(k=>[k,0]));metrics.metricClassification={measuredFrames:n,strictEquality:{passed:true}};
 const modes=job.variant==='lod-off'?['all','gpu']:['gpu','all'];
 const r={status:'passed',schemaVersion:1,suite:'g05-instances',count:job.count,views:job.views,variant:job.variant,
 adapter:{vendor:job.preference==='low-power'?'intel':'amd',architecture:job.preference==='low-power'?'gen-9':'rdna-1',isFallbackAdapter:false},width:1280,height:720,normalFrameInstanceReadbackBytes:0,samples:n,warmup:120,
 paths:['candidate','reference'].map((path,i)=>{const passes=Array.from({length:job.views},()=>[{kind:'render',label:'instance render',durationMs:.1},...(modes[i]==='gpu'?[{kind:'compute',label:'GpuInstanceLod.classify',durationMs:.1}]:[])]).flat();return {path,mode:modes[i],
 cpu:Array.from({length:n},(_,frame)=>({frame,timestampQuery:false,cpuRuntimeMs:1,cpuRecordMs:.5,cpuSubmitMs:.5,queueWaitMs:1,frameWallMs:2})),gpu:Array.from({length:n},(_,frame)=>({frame,gpuSpanMs:3,gpuPassSumMs:passes.length*.1,passes})),metrics:structuredClone(metrics),gpuMetrics:structuredClone(metrics),resourcesBefore:{buffer:{created:1,estimatedBytes:64},texture:{created:1,estimatedBytes:4}},resources:{buffer:{created:1,estimatedBytes:64},texture:{created:1,estimatedBytes:4}}};}),
 pixelReference:job.variant.startsWith('frustum-')?'unculled-all-high':'cpu-lod-buckets',
 ids:Array.from({length:job.views},(_,view)=>{const count=job.variant==='frustum-rejected'?81:job.count;return {view,checkedIds:count,counts:[count,0,0]};}),
 pixels:Array.from({length:job.views},(_,view)=>({view,maxDelta:0,litPixels:100})),geometryTiers:[144,64,16].map(triangles=>({triangles})),
 poseNormals:{count:9,mirrored:4,nonuniform:9,maxDelta:0,litPixels:100,probes:Array.from({length:9},(_,id)=>({id,mirrored:id%2===1,pixel:[.2,.3,.4,1]}))},validationErrors:[],cleanup:{ownerResidual:0,liveGpuResources:0}};
 return {schemaVersion:1,tier:'diagnostic-g05-instance-performance-candidate',options:{...job},interCaseIdleMs:120001,hostSamples:Array.from({length:2},()=>({ready:true,cpuSpeedLimit:100,cpuSchedulerLimit:100})),inputs:{sha256:'a'.repeat(64)},build:{inputs:{sha256:'a'.repeat(64)}},harness:{sha256:'b'.repeat(64)},revision:'c'.repeat(40),result:r};
}
