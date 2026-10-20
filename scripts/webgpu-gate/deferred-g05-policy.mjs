export const G05_ROOM_CASES=Object.freeze({
  'single-1':{count:1,width:1280,height:720,views:1,overlap:false},
  'small-8':{count:8,width:1280,height:720,views:1,overlap:false},
  'sparse-128':{count:128,width:1280,height:720,views:1,overlap:false},
  'overlap-128':{count:128,width:1280,height:720,views:1,overlap:true},
  'sparse-256':{count:256,width:1280,height:720,views:1,overlap:false},
  'dynamic-128-four-view':{count:128,width:1280,height:720,views:4,overlap:false},
  '1080p-128':{count:128,width:1920,height:1080,views:1,overlap:false},
  'stress-512':{count:512,width:1920,height:1080,views:1,overlap:true},
  'stress-1024':{count:1024,width:1920,height:1080,views:1,overlap:true},
});
for(const entry of Object.values(G05_ROOM_CASES))Object.freeze(entry);
export function parseG05RoomOptions(args){
  const result={caseId:'overlap-128',algorithm:'tiled',preference:'high-performance',full:false,idleMs:120000,moving:true};
  const seen=new Set();
  for(const arg of args){
    const key=arg.split('=')[0];if(seen.has(key))throw Error(`Duplicate ${key}`);seen.add(key);
    if(arg.startsWith('--case=')){result.caseId=arg.slice(7);if(!Object.hasOwn(G05_ROOM_CASES,result.caseId))throw Error('Unknown G05 room case');}
    else if(arg==='--reference')result.algorithm='reference';
    else if(arg==='--integrated')result.preference='low-power';
    else if(arg==='--full')result.full=true;
    else if(arg==='--static')result.moving=false;
    else if(arg.startsWith('--idle-ms=')){const value=arg.slice(10);if(!/^\d+$/.test(value)||+value<30000||+value>300000)throw Error('Invalid idle duration');result.idleMs=+value;}
    else throw Error(`Unknown G05 flag ${arg}`);
  }
  if(result.caseId==='dynamic-128-four-view'&&!result.moving)throw Error('The dynamic four-view case cannot be static');
  return result;
}
export function validateG05RoomResult(result,options){
  const c=G05_ROOM_CASES[options.caseId],samples=options.full?300:3,warmup=options.full?120:2;
  if(result.status!=='passed'||result.schemaVersion!==1||result.suite!=='g05-room')throw Error('G05 room failed');
  if(result.adapter?.isFallbackAdapter!==false||!result.adapter.vendor||!result.adapter.architecture)throw Error('Native GPU required');
  for(const key of ['caseId','algorithm','moving'])if(result[key]!==options[key])throw Error(`Workload ${key} mismatch`);
  if(result.width!==c.width||result.height!==c.height||result.views!==c.views||result.count!==c.count||result.fixtureId!=='deferred-room-021-v1')throw Error('Frozen room content changed');
  if(result.samples!==samples||result.warmup!==warmup||result.cpu?.length!==samples||result.gpu?.length!==samples)throw Error('Separate complete CPU/GPU populations required');
  for(const [i,s]of result.cpu.entries()){
    if(s.frame!==i||s.timestampQuery!==false)throw Error('CPU sample was instrumented or reordered');
    for(const k of ['cpuRuntimeMs','cpuUpdateMs','cpuRecordMs','cpuSubmitMs','queueWaitMs','frameWallMs','authoredMutationMs'])if(!Number.isFinite(s[k])||s[k]<0)throw Error(`Invalid CPU ${k}`);
  }
  for(const [i,s]of result.gpu.entries()){
    if(s.frame!==i||s.resolveCount!==c.views||!Array.isArray(s.passes))throw Error('Invalid GPU view population');
    for(const key of ['gpuSpanMs','gpuPassSumMs','resolveMs','cullMs'])if(!Number.isFinite(s[key])||s[key]<0)throw Error(`Invalid GPU ${key}`);
    if(s.gpuSpanMs<=0||s.resolveMs<=0||s.gpuSpanMs+1e-6<s.gpuPassSumMs)throw Error('Incomplete GPU span');
    if(s.effective!==`deferred-${options.algorithm}`||s.bypassReason!==null&&(options.algorithm!=='tiled'||!['empty-source','all-lights-cover-near-plane'].includes(s.bypassReason)))throw Error('Unexpected effective path');
    for(const p of s.passes)if(!['render','compute'].includes(p.kind)||!Number.isFinite(p.durationMs)||p.durationMs<0)throw Error('Invalid GPU pass');
    const resolves=s.passes.filter(p=>p.kind==='render'&&['DeferredReference.resolve','DeferredTiles.resolve'].includes(p.label));
    const culls=s.passes.filter(p=>p.kind==='compute'&&p.label==='DeferredTiles.cull');
    if(resolves.length!==c.views||culls.length!==(options.algorithm==='tiled'&&!s.bypassReason?c.views:0))throw Error('Missing GPU stage population');
    for(const [value,passes]of [[s.resolveMs,resolves],[s.cullMs,culls],[s.gpuPassSumMs,s.passes]])if(Math.abs(value-passes.reduce((n,p)=>n+p.durationMs,0))>1e-6)throw Error('GPU stage totals mismatch');
  }
  if(result.pixels?.length!==c.views)throw Error('Missing per-view HDR/LDR parity');
  for(const [i,p]of result.pixels.entries()){
    if(p.key!==`real-frame-view:${i}`||p.checkedComponents!==c.width*c.height*4)throw Error('Pixel view identity or population mismatch');
    for(const k of ['maxHdrDelta','maxHdrToleranceRatio','maxLdrDelta','litPixels'])if(!Number.isFinite(p[k])||p[k]<0)throw Error('Invalid pixel evidence');
    if(p.maxHdrToleranceRatio>1||p.maxLdrDelta>2.001||p.litPixels<c.width*c.height*.1||p.litPixels>c.width*c.height)throw Error('HDR/LDR parity failed');
  }
  if(result.source?.pointCount!==c.count||result.source.directionalCount!==1||result.source.ambientCount!==1||result.completeCoverage!==true)throw Error('Incomplete light coverage');
  if(!Array.isArray(result.validationErrors)||result.validationErrors.length||result.cleanup?.ownerResidual!==0||result.cleanup?.liveGpuResources!==0)throw Error('Errors or resource residue');
  for(const metric of [result.cpuMetrics,result.gpuMetrics]){
    for(const k of ['bufferUploadsPerFrame','uploadBytesPerFrame','renderPipelinesCreated','bindGroupsCreated','buffersCreated','bufferExpansions','bufferRetirements','drawsPerFrame','renderPassesPerFrame','poolMisses','hotObjectsCreated'])if(!Number.isFinite(metric?.[k])||metric[k]<0)throw Error(`Missing structural ${k}`);
    if(metric.metricClassification?.measuredFrames!==samples||metric.metricClassification?.strictEquality?.passed!==true)throw Error('Structural population mismatch');
  }
  for(const k of ['scenarioSetupMs','profileInitializeMs'])if(!Number.isFinite(result.cold?.[k])||result.cold[k]<0)throw Error('Missing cold-start evidence');
  if(!Number.isFinite(result.cold?.firstFrame?.sampleWallMs)||result.cold.firstFrame.sampleWallMs<0||result.cold.firstFrame.gpuTimestamp!==null)throw Error('Invalid cold first frame');
  for(const phase of ['warm','cpu','gpu'])for(const type of ['buffer','texture']){
    for(const key of ['created','current','peak','estimatedBytes','peakEstimatedBytes'])if(!Number.isFinite(result.resources?.[phase]?.[type]?.[key])||result.resources[phase][type][key]<0)throw Error('Missing resource population');
  }
}
export function summarizeG05Room(result){
  const p95=values=>values.toSorted((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
  return {cpuP95Ms:p95(result.cpu.map(s=>s.cpuRuntimeMs)),frameWallP95Ms:p95(result.cpu.map(s=>s.frameWallMs)),
    gpuP95Ms:p95(result.gpu.map(s=>s.gpuSpanMs)),resolveP95Ms:p95(result.gpu.map(s=>s.resolveMs)),cullP95Ms:p95(result.gpu.map(s=>s.cullMs))};
}
