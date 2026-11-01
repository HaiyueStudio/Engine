import {summarizePacing} from './webgpu-gate/framegraph-production-policy.mjs';
import {decodePng} from './visual-regression/png.mjs';

export const GAMEPLAY_PRODUCTION_PROTOCOL='g11-gameplay-production-v1';
export const GAMEPLAY_PRODUCTION_INPUTS=Object.freeze(['scripts/run-gameplay-023-production.mjs','scripts/gameplay-023-production-policy.mjs','scripts/webgpu-gate/gameplay-023-production-fixture.mjs','scripts/webgpu-gate/chrome-runner.mjs','scripts/webgpu-gate/framegraph-presentation.mjs','scripts/webgpu-gate/completed-fixture-transfer.mjs','scripts/webgpu-gate/allocation-sampling-phase.mjs','scripts/hya-corpus/packed-browser.mjs','scripts/npm-process.mjs','config/gameplay-023-contract.json','artifacts/engine-0.2.3/g11/candidate-inputs.mjs']);
export const GAMEPLAY_PRODUCTION_PROFILE=Object.freeze({width:1280,height:720,samples:4,characters:32,obstacles:128,requests:32,voices:32,mutations:Object.freeze([0,1,10]),gui:Object.freeze(['passive','interactive']),browsers:Object.freeze(['chrome-windows','edge-windows']),rounds:2,reverseSecondRound:true,warmupMs:10000,durationMs:30000,readinessFrames:2,frameP95Ms:20,frameP99Ms:34,longFrameMs:50,longFrameRatioMax:.01,consecutiveLongFramesMax:2,regionsMax:8,retainedColorBytesMax:67108864,decodedAudioBytesMax:67108864,maxResidentChunks:64});
const finite=n=>Number.isFinite(n)&&n>=0,same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function gameplayProductionPlan(){
 const p=GAMEPLAY_PRODUCTION_PROFILE,workloads=p.gui.flatMap(gui=>p.mutations.map(mutation=>({gui,mutation})));
 return [1,2].flatMap(round=>(round===2?[...workloads].reverse():workloads).flatMap(workload=>(round===2?[...p.browsers].reverse():p.browsers).map(browserId=>({round,browserId,...workload}))));
}
export function assertGameplayProductionContract(contract){
 const p=GAMEPLAY_PRODUCTION_PROFILE,a=contract?.acceptance;
 if(contract?.contractId!=='haiyue-gameplay-023/1'||contract.status!=='frozen'||a?.productionWarmupSeconds*1000!==p.warmupMs||a.productionDurationSeconds*1000!==p.durationMs||a.productionRounds!==p.rounds||a.frameP95Ms!==p.frameP95Ms||a.frameP99Ms!==p.frameP99Ms||a.longFrameMs!==p.longFrameMs||a.longFrameRatioMax!==p.longFrameRatioMax||a.consecutiveLongFramesMax!==p.consecutiveLongFramesMax||a.retainedRegionsMax!==p.regionsMax||a.retainedColorBytesMax!==p.retainedColorBytesMax||a.gpuRegressionPercent!==5)throw Error('G01 frozen production contract differs; sampler cannot change acceptance.');
}
export function validateGameplayPresentationImage(bytes){
 const decoded=decodePng(bytes);let world=0,gui=0;
 for(let y=0;y<decoded.height;y++)for(let x=0;x<decoded.width;x++){const i=(y*decoded.width+x)*4,r=decoded.data[i],g=decoded.data[i+1],b=decoded.data[i+2];if(x>=480&&g>r+25&&b>r+25)world++;if(x<480&&r>60&&g>60&&b>60)gui++;}
 return{status:decoded.width===1280&&decoded.height===720&&world>1000&&gui>1000?'passed':'failed',width:decoded.width,height:decoded.height,worldPixels:world,guiPixels:gui,role:'Nonblank combined presentation only; independent full-frame reference gates remain required'};
}
export function validateGameplayProductionMatrix(report,captures){
 const errors=[],smoke=report?.tier==='smoke',plan=gameplayProductionPlan(),fail=m=>errors.push(m);
 if(report?.schemaVersion!==1||report.protocolId!==GAMEPLAY_PRODUCTION_PROTOCOL||!same(report.profile,GAMEPLAY_PRODUCTION_PROFILE)||report.status!==(smoke?'smoke-complete':'passed-production-prerequisite')||report.releaseQualified!==false||report.published!==false||report.formalBaselineUpdated!==false)fail('Incomplete original matrix report.');
 if(!/^[a-f0-9]{40}$/.test(report?.source?.revision??'')||typeof report.source.dirty!=='boolean'||!smoke&&report.source.dirty)fail('Formal matrix requires a recorded clean source.');
 if(!Array.isArray(report?.plan)||!Array.isArray(report?.entries)||!Array.isArray(captures)||captures.length!==report.entries?.length||report.entries?.length!==report.plan?.length||!(smoke?report.plan.length===1&&plan.some(p=>same(p,report.plan[0])):same(report.plan,plan)))fail('Missing, duplicated or reordered frozen captures.');
 if(!report?.hostBefore||!same(report.hostBefore,report.hostAfter))fail('Host/power identity changed or absent.');
 if(!/^[a-f0-9]{64}$/.test(report?.candidate?.sha256??'')||!/^[a-f0-9]{64}$/.test(report?.candidate?.contentManifest?.sha256??''))fail('Missing candidate/content binding.');
 if(!same(Object.keys(report?.inputs??{}).sort(),[...GAMEPLAY_PRODUCTION_INPUTS].sort())||!Object.values(report?.inputs??{}).every(h=>/^[a-f0-9]{64}$/.test(h)))fail('Exact collector/input coverage required.');
 const assessments=(captures??[]).map((r,i)=>{const expected=report?.plan?.[i],entry=report?.entries?.[i];if(!same(entry?.spec,expected)||entry?.status!==(smoke?'smoke-complete':'passed'))fail('Original entry is incomplete: '+i);const a=validateGameplayProductionCapture(r,expected??{}, {smoke});if(a.status==='failed')fail('Raw capture failed: '+i);if(!same(a,entry?.assessment))fail('Stored assessment differs from independent raw assessment: '+i);return a;});
 return{status:errors.length?'failed':smoke?'smoke-audited':'passed-production-prerequisite',errors:[...new Set(errors)],captures:assessments.length,assessments,qualification:false};
}
export function validateGameplayProductionCapture(r,expected,{smoke=false}={}){
 const p=GAMEPLAY_PRODUCTION_PROFILE,errors=[],fail=message=>errors.push(message),warmupMs=p.warmupMs,durationMs=smoke?1000:p.durationMs;
 if(r?.schemaVersion!==1||r.protocolId!==GAMEPLAY_PRODUCTION_PROTOCOL||r.status!=='captured'||r.smoke!==smoke||!same(r.profile,p)||!same(r.spec,expected))fail('Exact protocol, job and complete capture required.');
 if(r?.adapter?.isFallbackAdapter!==false||!Array.isArray(r.errors)||r.errors.length)fail('Actual native adapter and clean GPU validation required.');
 if(r?.browserEvidence?.nativeBackend!==true||(!smoke&&r.browserEvidence.presentationMode!=='visible-window')||typeof r?.browserEvidence?.userAgent!=='string'||!r.browserEvidence.userAgent.includes('Chrome/')||(expected.browserId==='edge-windows')!==r.browserEvidence.userAgent.includes('Edg/'))fail('Actual expected native browser/presentation identity required.');
 if(r?.renderSize?.width!==1280||r.renderSize.height!==720||r.renderSize.samples!==4||r.renderSize.dpr!==1)fail('Exact frozen framebuffer size, MSAA and DPR required.');
 const startup=r?.startup??[],warmup=r?.warmup??[],samples=r?.samples??[],frames=[...startup,...warmup,...samples];
 if(!finite(r?.firstRenderedAt)||r.captureStartedAt!==r.firstRenderedAt+warmupMs||!warmup.length||!samples.length||warmup[0]?.time!==r.firstRenderedAt||r.completedAt!==samples.at(-1)?.time||r.completedAt-r.captureStartedAt<durationMs||warmup.some(f=>f.time>=r.captureStartedAt)||samples.some(f=>f.time<r.captureStartedAt))fail('Retain complete first-render, warmup and continuous steady populations.');
 if(!frames.every((f,i)=>Number.isSafeInteger(f.id)&&f.id>0&&finite(f.time)&&Number.isFinite(f.intervalMs)&&(!i||f.id===frames[i-1].id+1&&f.intervalMs>0&&Math.abs(f.time-frames[i-1].time-f.intervalMs)<.001)&&['cpuMs','guiCpuMs','samplerCpuMs','actionCpuMs'].every(k=>finite(f[k]))&&f.guiCpuMs<=f.cpuMs&&f.visible===true&&f.focused===true&&f.polls===f.tick&&['draws','passes','bufferUploads','bufferUploadBytes'].every(k=>Number.isSafeInteger(f.counters?.[k])&&f.counters[k]>=0)&&finite(f.totalGpuBytes)))fail('Missing/invalid consecutive timing, visibility, input or resource channels.');
 if(!warmup[0]?.counters?.draws||!frames.some(f=>f.counters?.bufferUploadBytes>0))fail('First rendered frame and real startup uploads must be retained.');
 const ready=r?.readiness??[];
 if(ready.length!==2||new Set(ready.map(x=>x.frame)).size!==2||!ready.every(x=>Number.isSafeInteger(x.frame)&&frames.some(f=>f.id===x.frame&&f.counters?.draws>0)&&finite(x.completedAt)&&x.completedAt<r.captureStartedAt))fail('Two real submitted/completed readiness frames required before steady collection.');
 for(const f of samples){
  if(f.characters!==32||f.obstacles!==128||f.assignedAssets!==32||f.worlds!==1||f.audio?.voices!==32||f.audio?.state!=='running'||f.audio?.stereoPan!==true||!finite(f.audio?.decodedBytes)||f.audio.decodedBytes>p.decodedAudioBytesMax)fail('Incomplete combined production populations or audio host.');
  if(!Number.isSafeInteger(f.listRows)||f.listRows>25||!Number.isSafeInteger(f.treeRows)||f.treeRows>25)fail('Collection instance window exceeded.');
  if(!Number.isSafeInteger(f.regions?.cachedRegions)||f.regions.cachedRegions>8||!finite(f.regions?.retainedColorBytes)||f.regions.retainedColorBytes>67108864||!['workingColorBytes','workingRetiringColorBytes','totalRegionAttachmentBytes'].every(k=>finite(f.regions?.[k])))fail('Region cache budget or separate working/retired accounting missing.');
  if(!Number.isSafeInteger(f.map?.residentChunks)||f.map.residentChunks>64||!['activeBytes','retiredBytes','workingBytes','cpuVertexBytes','cpuMapBytes','vertexUploadBytes','vertexUploadCalls'].every(k=>finite(f.map?.[k]))||f.map.cpuMapBytes<=0)fail('Map residency, CPU map/chunk or GPU channel missing.');
  if(expected.mutation===0&&f.map?.vertexUploadBytes!==0)fail('Static map added vertex uploads.');
  if(expected.gui==='passive'&&f.guiRecords!==0)fail('Unchanged GUI added regional producer records.');
  if(f.gpu!==null&&(!Number.isSafeInteger(f.gpu?.frame)||f.gpu.frame>f.id||!finite(f.gpu.totalMs)))fail('Invalid asynchronous GPU snapshot; missing data cannot be recorded as zero.');
 }
 if(expected.mutation>0&&!samples.some(f=>f.map?.vertexUploadBytes>0))fail('Dynamic map workload did not produce actual vertex uploads.');
 if(expected.gui==='interactive'&&(!Array.isArray(r?.actions)||r.actions.filter(a=>a.time>=r.captureStartedAt).length<(smoke?1:10)))fail('Complete scheduled GUI interactions required.');
 if(!finite(r?.navigation?.startTime)||r.navigation.startTime!==0||!finite(r.factoryStartedAt)||!finite(r.factoryCompletedAt)||r.factoryCompletedAt<r.factoryStartedAt||r.firstRenderedAt<r.factoryStartedAt)fail('Missing navigation-inclusive cold start or factory boundary.');
 if(!finite(r?.finalDrainMs)||r.samplerAddedSteadyQueueWaits!==0||r?.cleanup?.gpu?.resources!==0||r.cleanup.gpu.estimatedBytes!==0||r.cleanup.worlds!==0||r.cleanup.levels!==0||r.cleanup.audioNodes!==0||r.cleanup.voices!==0||r.cleanup.buffers!==0||r.cleanup.rowsCreated!==r.cleanup.rowsDisposed||r.cleanup.rowsBound!==r.cleanup.rowsUnbound)fail('Missing queue boundary or owned-resource zero residue.');
 let pacing;try{pacing=summarizePacing(samples.map(f=>f.intervalMs),50);if(!smoke&&(pacing.p95Ms>20||pacing.p99Ms>34||pacing.longFrameRatio>.01||pacing.maxConsecutiveLongFrames>2))fail('Original presented pacing budget failed.');}catch{fail('Missing presented intervals.');}
 return{status:errors.length?'failed':smoke?'smoke-complete':'passed',errors:[...new Set(errors)],pacing,qualification:false,scope:'Production/cold/resource prerequisite only. Independent correctness/GPU comparisons, real devices, global gate and rehearsal remain mandatory.'};
}
