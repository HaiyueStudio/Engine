import{summarizePacing}from'../../scripts/webgpu-gate/framegraph-production-policy.mjs';
import{productionProfile as profile}from'./tilemap-browser-policy.mjs';
export function validateTilemapProduction(r){
 const errors=[],captures=[];
 if(r?.schemaVersion!==1||r.status!=='passed'||r.adapter?.isFallbackAdapter!==false||JSON.stringify(r.profile)!==JSON.stringify(profile)||r.cohorts?.length!==12)errors.push('Complete native production matrix required.');
 const workloads=[false,true].flatMap(atlas=>profile.mutationPercent.map(mutation=>({atlas,mutation})));
 const order=[1,2].flatMap(round=>(round===2?[...workloads].reverse():workloads).map(spec=>({...spec,round})));
 for(let i=0;i<order.length;i++){
  const expected=order[i],c=r?.cohorts?.[i];if(!c||Object.keys(expected).some(k=>c[k]!==expected[k])){errors.push('Missing/reordered production capture '+i);continue;}
  if(!Number.isFinite(c.firstRenderedAt)||c.captureStartedAt-c.firstRenderedAt!==10000||c.completedAt-c.captureStartedAt<30000||c.readiness?.length!==2||!c.readiness.every((v,j)=>v.frame===j+1&&Number.isFinite(v.completedAt)&&v.completedAt<c.captureStartedAt)||!c.warmup?.length||!c.samples?.length||c.warmup[0].time!==c.firstRenderedAt||c.samples.at(-1)?.time!==c.completedAt||c.warmup.some(f=>f.time>=c.captureStartedAt)||c.samples.some(f=>f.time<c.captureStartedAt))errors.push('Missing startup, readiness or continuous capture '+i);
  if(c.cleanup?.stats?.totalBytes!==0||c.finalGpu?.resources!==0||c.finalGpu?.estimatedBytes!==0)errors.push('Residual GPU resources '+i);
  if(!(c.gpuWorkingSet?.totals?.estimatedBytes>0)||!(c.beforeSceneDestroy?.totals?.estimatedBytes>0))errors.push('Missing total GPU working-set accounting '+i);
  const frames=[...(c.warmup??[]),...(c.samples??[])];
  // FrameLoop starts with performance.now(); the first rAF timestamp can precede it.
  // Preserve that signed startup value. A presented interval exists only from frame 2.
  if(!frames.every((f,j)=>Number.isFinite(f.time)&&Number.isFinite(f.intervalMs)&&(!j||f.intervalMs>0&&f.time>frames[j-1].time&&Math.abs(f.time-frames[j-1].time-f.intervalMs)<.001)&&['cpuMutationMs','cpuUpdateRenderSubmitMs','vertexUploadCalls','vertexUploadBytes','draws','activeBytes','retiredBytes','workingBytes','cpuVertexBytes','cpuMapBytes'].every(k=>Number.isFinite(f[k])&&f[k]>=0)&&Number.isInteger(f.residentChunks)&&f.residentChunks<=64))errors.push('Missing/invalid timing or resource channels '+i);
  if(!frames.every(f=>f.visible===true&&f.focused===true))errors.push('Hidden/unfocused capture '+i);
  if((c.samples??[]).some(f=>expected.mutation===0&&f.vertexUploadCalls!==0))errors.push('Static extra vertex uploads '+i);
  try{const steady=summarizePacing((c.samples??[]).map(f=>f.intervalMs),50);captures.push({...expected,...steady});if(steady.p95Ms>20||steady.p99Ms>34||steady.longFrameRatio>.01||steady.maxConsecutiveLongFrames>2)errors.push('Production pacing budget '+i);}catch{errors.push('Invalid pacing population '+i);}
 }
 if(!Array.isArray(r?.errors)||r.errors.length)errors.push('GPU validation errors.');
 return {status:errors.length?'failed':'passed',errors,captures,startupInterpretation:'The first warmup callback has no previous presented frame. Its original signed Engine delta is retained as startup metadata; every subsequent interval must be positive and equal consecutive rAF timestamps. All steady samples and pacing limits are unchanged.'};
}
export function validateTilemapApplication(r){
 const errors=[];
 if(r?.schemaVersion!==1||r.status!=='passed'||r.adapter?.isFallbackAdapter!==false||r.checks?.length!==23||r.cycles?.length!==12||r.retired?.stats?.totalBytes!==0||r.finalGpu?.resources!==0||r.finalGpu?.estimatedBytes!==0||!Array.isArray(r.errors)||r.errors.length)errors.push('Complete native application lifecycle proof required.');
 return {status:errors.length?'failed':'passed',errors};
}
