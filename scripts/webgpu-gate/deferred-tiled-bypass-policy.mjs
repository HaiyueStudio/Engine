export function summarizeBypassPairs(result){
  if(result.status!=='passed'||result.schemaVersion!==1||result.adapter?.vendor!=='amd'||result.adapter?.architecture!=='rdna-1'||result.adapter.isFallbackAdapter!==false)throw Error('Native AMD paired capture required');
  if(result.fixtureId!=='deferred-room-021-v1'||JSON.stringify(result.resolution)!=='[1280,720]'||result.count!==128||result.overlap!==true||result.warmup!==120||result.pairs!==300||result.raw?.length!==300)throw Error('Wrong paired workload');
  for(const [frame,pair] of result.raw.entries()){
    if(pair.frame!==frame||JSON.stringify(pair.order)!==JSON.stringify(frame%2?['automatic','direct-full-list']:['direct-full-list','automatic']))throw Error('Pair order mismatch');
    for(const mode of pair.order){const s=pair[mode];if(!Number.isFinite(s?.cpuRuntimeMs)||s.cpuRuntimeMs<0||!Number.isFinite(s.gpuSpanMs)||s.gpuSpanMs<=0||s.passes?.length!==3||s.passes.some(p=>p.kind!=='render')||s.passes.filter(p=>p.label==='DeferredTiles.resolve').length!==1)throw Error('Incomplete paired timing');}
  }
  if(result.validationErrors?.length!==0||result.cleanup?.ownerResidual!==0||result.cleanup?.liveGpuResources!==0)throw Error('Pair validation or cleanup failure');
  const p95=values=>values.toSorted((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
  return Object.fromEntries(['cpuRuntimeMs','gpuSpanMs'].map(key=>[key,{direct:p95(result.raw.map(p=>p['direct-full-list'][key])),automatic:p95(result.raw.map(p=>p.automatic[key])),pairedDeltaP95:p95(result.raw.map(p=>p.automatic[key]-p['direct-full-list'][key]))}]));
}
