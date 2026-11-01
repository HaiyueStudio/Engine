export const pixelProfile=Object.freeze({cases:64,tolerance:1,samples:[1,4],dpr:[1,2],transforms:['identity','translation','mirror','rotation'],gaps:[0,1]});
export const timingProfile=Object.freeze({mapCells:[16384,262144,1048576],mutationPercent:[0,1,10],viewport:[1280,720],tileSize:32,warmup:12,samples:30,rounds:3,reverseRound:2,gpuRegressionPercent:5});
export const productionProfile=Object.freeze({columns:512,rows:512,mutationPercent:[0,1,10],viewport:[1280,720],samples:4,warmupMs:10000,durationMs:30000,rounds:2,reverseRound:2,frameP95Ms:20,frameP99Ms:34,longFrameMs:50,longFrameRatioMax:.01,consecutiveLongFramesMax:2});
export function validateTilemapPixels(r){
 const errors=[];if(r?.schemaVersion!==1||r.status!=='passed'||r.adapter?.isFallbackAdapter!==false||!Array.isArray(r.cases)||r.cases.length!==64)errors.push('Complete native pixel evidence required.');
 for(const atlas of [false,true])for(const samples of pixelProfile.samples)for(const dpr of pixelProfile.dpr)for(const transform of pixelProfile.transforms)for(const gap of pixelProfile.gaps){const matches=Array.isArray(r?.cases)?r.cases.filter(c=>c?.texturedMode===atlas&&c.samples===samples&&c.dpr===dpr&&c.transform===transform&&c.gap===gap):[];if(matches.length!==1||!Number.isInteger(matches[0].maxDelta)||matches[0].maxDelta>1||matches[0].maxDelta<0||matches[0].changed!==0)errors.push('Missing/failed pixel '+[atlas,samples,dpr,transform,gap]);}
 if(!Array.isArray(r?.errors)||r.errors.length)errors.push('GPU validation errors.');return {status:errors.length?'failed':'passed',errors};
}
const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
export function validateTilemapTiming(r){
 const errors=[],comparisons=[];
 if(r?.schemaVersion!==1||r.status!=='passed'||r.adapter?.isFallbackAdapter!==false||JSON.stringify(r.profile)!==JSON.stringify(timingProfile)||!Array.isArray(r.cohorts)||r.cohorts.length!==108)errors.push('Complete frozen native timing matrix required.');
 for(const cells of timingProfile.mapCells)for(const mutation of timingProfile.mutationPercent)for(const atlas of [false,true]){
  const values={reference:[],optimized:[]};
  for(const variant of ['reference','optimized'])for(let round=1;round<=3;round++){
   const matches=Array.isArray(r?.cohorts)?r.cohorts.filter(c=>c?.cells===cells&&c.mutation===mutation&&c.atlas===atlas&&c.variant===variant&&c.round===round):[];
   if(matches.length!==1||matches[0].samples?.length!==30){errors.push('Missing cohort '+[cells,mutation,atlas,variant,round]);continue;}
   if(matches[0].warmup?.length!==12||matches[0].cleanup?.totalBytes!==0||!Number.isFinite(matches[0].retirementDrainMs)||matches[0].retirementDrainMs>5000)errors.push('Missing warmup or safe retirement.');
   for(const sample of matches[0].samples){if(!Number.isFinite(sample.gpuMs)||sample.gpuMs<0||!['cpuMutationMs','cpuRecordMs','cpuSubmitMs','queueWaitMs','vertexUploadBytes','vertexUploadCalls','draws'].every(key=>Number.isFinite(sample[key])&&sample[key]>=0))errors.push('Missing native timing channels.');else values[variant].push(sample.gpuMs);if(variant==='optimized'&&mutation===0&&sample.vertexUploadCalls!==0)errors.push('Static vertex upload.');if(variant==='optimized'&&(!Number.isSafeInteger(sample.residentChunks)||sample.residentChunks>64))errors.push('Unbounded chunk residency.');}
  }
  if(values.reference.length===90&&values.optimized.length===90){const before=p95(values.reference),after=p95(values.optimized);if(before<=0){errors.push('Reference GPU P95 is below timestamp resolution.');continue;}const regressionPercent=(after/before-1)*100;comparisons.push({cells,mutation,atlas,referenceGpuP95Ms:before,optimizedGpuP95Ms:after,regressionPercent,passed:regressionPercent<=5});if(regressionPercent>5)errors.push('GPU 5% regression '+[cells,mutation,atlas]);}
 }
 const workloads=timingProfile.mapCells.flatMap(cells=>timingProfile.mutationPercent.flatMap(mutation=>[false,true].map(atlas=>({cells,mutation,atlas}))));
 const order=[1,2,3].flatMap(round=>(round===2?[...workloads].reverse():workloads).flatMap(spec=>(round===2?['optimized','reference']:['reference','optimized']).map(variant=>({...spec,round,variant}))));
 if(order.some((spec,i)=>Object.keys(spec).some(k=>r?.cohorts?.[i]?.[k]!==spec[k])))errors.push('Frozen forward/reverse order changed.');
 if(!Array.isArray(r?.errors)||r.errors.length)errors.push('GPU errors.');return {status:errors.length?'failed':'passed',errors,comparisons};
}
