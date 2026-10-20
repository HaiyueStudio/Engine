import { validateProductionConfig, summarizePacing } from './framegraph-production-policy.mjs';
import { decodePng } from '../visual-regression/png.mjs';
export const STUDY_VARIANTS = Object.freeze(['A','B1','B2','B3','B4']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const finite=n=>Number.isFinite(n)&&n>=0;
export function frameGraphStudyPlan(config,mode,smoke=false) {
  validateProductionConfig(config);
  if(mode==='resources')return {mode,seconds:smoke?20:310,sampleSeconds:smoke?2:5,warmupSeconds:10,envelopeEndSeconds:smoke?14:30,
    rule:'Every resource type, owner/cache population and estimated bytes after the fixed 10-30 second envelope must stay bounded; complete pending drain and zero cleanup residual.',
    jobs:[['chrome-windows','f3-temporal-transparent'],['edge-windows','f3-temporal-transparent'],['edge-windows','f5-mirror'],['chrome-windows','f5-mirror']]
      .filter(([browser])=>!smoke||browser==='chrome-windows').map(([browserId,caseId])=>({browserId,caseId}))};
  if(mode!=='ablation')throw Error('Unknown production study');
  const specs=config.workloads.filter(w=>['F0','F2','F3','F4'].includes(w.group));
  const jobs=smoke?[
    ['chrome-windows','f4-four-viewports','A'],['chrome-windows','f4-four-viewports','B2'],
    ['chrome-windows','f3-temporal-transparent','A'],['chrome-windows','f3-temporal-transparent','B4'],
    ['edge-windows','f2-gtao-128','A'],['edge-windows','f2-gtao-128','B4'],
    ['chrome-windows','f0-forward-1','A'],['chrome-windows','f0-forward-1','B4'],
  ].map(([browserId,caseId,variant])=>({browserId,caseId,variant})):
    specs.flatMap((w,i)=>config.browser.flatMap((browserId,b)=>((i+b)%2?[...STUDY_VARIANTS].reverse():STUDY_VARIANTS).map(variant=>({browserId,caseId:w.id,variant}))));
  return {mode,sampling:smoke?{warmupFrames:10,cpuFrames:20,gpuWarmupFrames:2,gpuFrames:4}:{warmupFrames:120,cpuFrames:300,gpuWarmupFrames:120,gpuFrames:300},jobs,
    scope:'One preregistered attribution matrix, no timing significance claim. CPU normal visible scheduling; GPU separate equal serial completion/readback. A is current source with controls disabled, not historical A0.'};
}
function common(raw,job,config) {
  const spec=config.workloads.find(w=>w.id===job.caseId);
  if(!spec||raw.schemaVersion!==1||raw.status!=='captured'||raw.caseId!==job.caseId||raw.adapter?.vendor!==config.device.vendor||raw.adapter.architecture!==config.device.architecture||raw.adapter.isFallbackAdapter!==false||
    !raw.browserEvidence?.nativeBackend||raw.browserEvidence.presentationMode!=='visible-window'||raw.browserDiagnostics?.unclassifiedFailureCount!==0||raw.errors?.length!==0||raw.cleanup?.resources!==0||raw.cleanup?.estimatedBytes!==0)throw Error('Invalid production study capture');
  const ua=raw.browserEvidence.userAgent??'';
  if(/Headless/i.test(ua)||(job.browserId==='edge-windows'?!/Edg\//.test(ua):/Edg\//.test(ua)||!/Chrome\//.test(ua)))throw Error('Study browser differs');
  if(raw.final?.width!==spec.resolution[0]||raw.final.height!==spec.resolution[1]||raw.final.views!==spec.views||raw.final.lights!==spec.lights||raw.final.boxes!==256)throw Error('Study workload differs');
  if(spec.algorithm!=='forward'&&(!raw.final.lighting?.completeCoverage||raw.final.lighting.effective!==`deferred-${spec.algorithm}`||raw.final.lighting.submittedPoints!==spec.lights))throw Error('Study lighting coverage differs');
  const effects=spec.effect==='gtao'?['GtaoPass']:spec.effect==='taa-blur'?['TaaPass','GaussianBlurPass']:[];
  if(!same(raw.final.effects,effects))throw Error('Study effect quality differs');
}
export function assessResourceStudy(raw,job,config,plan) {
  common(raw,job,config);
  if(!same(raw.plan,plan)||raw.samples?.at(-1)?.elapsed<plan.seconds||raw.drained?.pendingCompletions!==0||
    raw.cleanupDetails?.owners!==0||raw.cleanupDetails.caches!==0||raw.cleanupDetails.releasedOwnerResiduals!==0)throw Error('Incomplete resource population or pending/owner/cache residue');
  if(raw.frames?.length<3)throw Error('Missing resource frames');
  for(let i=0;i<raw.frames.length;i++)if(raw.frames[i].length!==5||raw.frames[i].some(x=>!Number.isFinite(x))||i&&raw.frames[i][0]<=raw.frames[i-1][0])throw Error('Corrupt resource frame sequence');
  if((raw.frames.at(-1)[0]-raw.frames[0][0])/1000<plan.seconds)throw Error('Truncated resource duration');
  const samples=raw.samples;
  for(let i=0;i<samples.length;i++){
    const s=samples[i];
    if(!finite(s.elapsed)||Math.abs(s.elapsed-i*plan.sampleSeconds)>.5||s.releasedOwnerResiduals!==0||
      !['ownerCount','cacheCount','cacheEntries','resources','bytes','pendingCompletions','peakPendingCompletions'].every(k=>finite(s[k]))||
      Object.values(s.byType??{}).some(t=>!finite(t.current)||!finite(t.estimatedBytes)))throw Error('Missing/reordered resource checkpoints');
    if(Object.values(s.byType).reduce((n,t)=>n+t.current,0)!==s.resources||Object.values(s.byType).reduce((n,t)=>n+t.estimatedBytes,0)!==s.bytes)throw Error('Resource totals differ');
  }
  const envelope=samples.filter(s=>s.elapsed>=10&&s.elapsed<=plan.envelopeEndSeconds+.1),tail=samples.filter(s=>s.elapsed>plan.envelopeEndSeconds+.1);
  if(envelope.length<(plan.seconds===20?2:4)||tail.length<(plan.seconds===20?2:55))throw Error('Incomplete resource checkpoints');
  const types=[...new Set(samples.flatMap(s=>Object.keys(s.byType)))],bounds=[];
  const add=(name,get)=>{const initialMax=Math.max(...envelope.map(get)),tailMax=Math.max(...tail.map(get));bounds.push({name,initialMax,tailMax,passed:tailMax<=initialMax});};
  for(const type of types)for(const metric of ['current','estimatedBytes'])add(`${type}.${metric}`,s=>s.byType[type]?.[metric]??0);
  for(const metric of ['ownerCount','cacheCount','cacheEntries'])add(metric,s=>s[metric]);
  const steady=raw.frames.filter(f=>f[0]-raw.frames[0][0]>=10000),pacing=summarizePacing(steady.slice(1).map((f,i)=>f[0]-steady[i][0]),50);
  const contaminated=raw.frames.some(f=>f[3]!==1||f[4]!==1),pacingPassed=pacing.p95Ms<=config.frameP95Ms&&pacing.p99Ms<=config.frameP99Ms&&pacing.longFrameRatio<=config.maxLongFrameRatio&&pacing.maxConsecutiveLongFrames<=config.maxConsecutiveLongFrames;
  return {status:contaminated?'inconclusive':bounds.every(b=>b.passed)&&pacingPassed?'passed':'failed',bounds,pacing,pacingPassed,contaminated,pending:{peak:raw.drained.peakPendingCompletions,drained:raw.drained.pendingCompletions}};
}
export function assessAblationStudy(raw,job,config,plan) {
  common(raw,job,config);
  if(raw.variant!==job.variant||!same(raw.sampling,plan.sampling)||raw.cpu?.length!==plan.sampling.cpuFrames||raw.gpu?.length!==plan.sampling.gpuFrames||raw.loading?.length!==3)throw Error('Incomplete ablation population');
  const level=STUDY_VARIANTS.indexOf(job.variant);
  const deferred=config.workloads.find(w=>w.id===job.caseId).algorithm!=='forward';
  const cacheKeys=['view','scene','requirements','post','postAllocation',...(deferred?['deferred','aoAllocation','mrtAllocation']:[])].sort();
  const poolKeys=['post',...(deferred?['ao','mrt']:[])].sort();
  for(const snapshot of [raw.before,raw.afterCpu,raw.final]){
    const c=snapshot?.controls;
    if(!c||c.forceEnabledPassRoots!==(level===0)||c.attachment!==(level>=4)||!same(Object.keys(c.caches??{}).sort(),cacheKeys)||!same(Object.keys(c.pools??{}).sort(),poolKeys)||
      Object.values(c.caches).some(x=>x!==(level>=3))||Object.values(c.pools).some(x=>x!==(level>=2)))throw Error('Ablation controls differ');
  }
  for(const rows of [raw.loading,raw.cpu,raw.gpu])for(let i=0;i<rows.length;i++)if(!finite(rows[i].time)||i&&rows[i].time<=rows[i-1].time)throw Error('Reordered ablation frames');
  for(const f of [...raw.cpu,...raw.gpu])if(!finite(f.cpuMs)||!finite(f.time))throw Error('Invalid ablation CPU timing');
  for(const f of raw.gpu){
    const t=f.timing;
    if(!finite(f.queueWaitMs)||!finite(f.readbackMs)||!(t?.spanMs>0)||!finite(t.totalMs)||t.spanMs+1e-6<t.totalMs||!t.passes?.length||
      t.passes.some(p=>!['render','compute'].includes(p.kind)||!finite(p.durationMs))||Math.abs(t.totalMs-t.passes.reduce((n,p)=>n+p.durationMs,0))>1e-6)throw Error('Incomplete GPU timing scope');
  }
  const contaminated=[...raw.loading,...raw.cpu,...raw.gpu].some(f=>f.visible!=='visible'||f.focused!==true);
  const p95=a=>a.toSorted((a,b)=>a-b)[Math.ceil(a.length*.95)-1];
  return {status:contaminated?'inconclusive':'passed',contaminated,metrics:{cpuP95Ms:p95(raw.cpu.map(f=>f.cpuMs)),gpuSpanP95Ms:p95(raw.gpu.map(f=>f.timing.spanMs)),gpuPassSumP95Ms:p95(raw.gpu.map(f=>f.timing.totalMs)),
    queueWaitP95Ms:p95(raw.gpu.map(f=>f.queueWaitMs)),readbackP95Ms:p95(raw.gpu.map(f=>f.readbackMs)),pacing:summarizePacing(raw.cpu.slice(1).map((f,i)=>f.time-raw.cpu[i].time),50),
    counters:raw.cpu.at(-1).counters,pools:raw.afterCpu.pools,caches:raw.afterCpu.caches,graphs:raw.afterCpu.graphs,resources:raw.afterCpu.resources}};
}
export function compareStudyPixels(actual,reference) {
  const a=decodePng(actual),b=decodePng(reference);
  if(a.width<1280||b.width<1280||a.height<720||b.height<720)throw Error('Study canvas clipped');
  let maxDelta=0,componentsOver2=0;
  for(let y=0;y<720;y++)for(let x=0;x<1280;x++)for(let c=0;c<3;c++){
    const delta=Math.abs(a.data[(y*a.width+x)*4+c]-b.data[(y*b.width+x)*4+c]);maxDelta=Math.max(maxDelta,delta);if(delta>2)componentsOver2++;
  }
  return {maxDelta,componentsOver2,passed:componentsOver2===0,scope:'All RGB components of the 1280x720 visible canvas; separate native correctness gates own HDR/per-view oracles'};
}
