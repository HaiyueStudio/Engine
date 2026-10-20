import {parseG05RoomOptions,validateG05RoomResult} from './deferred-g05-policy.mjs';
import {summarizeG05ResourceRecords} from './deferred-g05-memory-policy.mjs';
export function parseG05CostOptions(args){
 const aoArgs=args.filter(a=>a.startsWith('--ao='));if(aoArgs.length!==1||!['off','gtao','sao','ssao'].includes(aoArgs[0].slice(5)))throw Error('Select --ao=off|gtao|sao|ssao');
 const options=parseG05RoomOptions(args.filter(a=>!a.startsWith('--ao=')));
 if(!['small-8','1080p-128'].includes(options.caseId)||!options.moving||options.idleMs!==120000)throw Error('AO attribution uses frozen moving small-8/1080p-128 and 120s idle');
 return {...options,ao:aoArgs[0].slice(5)};
}
export function validateG05CostResult(r,options,config){
 validateG05RoomResult(r,options);const c=r.creationCosts;
 if(c?.schemaVersion!==1||c.ao!==options.ao||!c.scope?.includes('not isolated driver compiler time'))throw Error('Missing creation-cost attribution');
 if(JSON.stringify(c.settings)!==JSON.stringify(options.ao==='off'?null:{radius:2,intensity:3,resolutionScale:1,quality:'high'}))throw Error('AO quality changed');
 if(!Array.isArray(c.records)||c.records.length===0||c.counts.gpu!==c.records.length||c.counts.cpu!==c.counts.warm||c.counts.gpu!==c.counts.cpu||!Number.isInteger(c.counts.cold)||c.counts.cold<1||c.counts.cold>c.counts.warm)throw Error('Missing cold costs or steady creation regression');
 for(const [i,row]of c.records.entries()){
  if(row.status!=='passed'||!['scenario','profile','first-frame','warmup'].includes(row.stage)||!Number.isFinite(row.callMs)||row.callMs<0)throw Error('Invalid creation timing/stage');
  if(row.method==='createShaderModule'){
   if(!Number.isSafeInteger(row.bytes)||row.bytes<=0||!/^[a-f0-9]{64}$/.test(row.sha256))throw Error('Missing shader bytes/hash');
  }else{
   if(!['createRenderPipeline','createRenderPipelineAsync','createComputePipeline','createComputePipelineAsync'].includes(row.method)||row.shaderIds?.length<1||row.shaderIds.some(id=>!Number.isInteger(id)||id>=i||id<0||c.records[id].method!=='createShaderModule'))throw Error('Unattributed pipeline');
   if(row.method.endsWith('Async')&&(!Number.isFinite(row.settleMs)||row.settleMs<row.callMs))throw Error('Missing async completion time');
  }
 }
 const memory=[];
 for(const phase of ['warm','cpu','gpu']){
  const snapshot=r.resourceAttribution?.[phase],sum=summarizeG05ResourceRecords(snapshot?.records);
  if(snapshot.driverResidentMemory!==false||sum.deferredEstimateBytes!==snapshot.deferredEstimateBytes)throw Error('Invalid AO resource attribution');
  if(sum.views.length!==1||sum.views[0].gbufferTextures!==4||sum.totals['other-deferred'].count!==0)throw Error('Unexpected Deferred storage');
  if(options.ao==='off'?sum.totals.ao.bytes!==520:sum.totals.ao.bytes!==520+256+Math.ceil(r.width*2/256)*256*r.height+2*r.width*r.height)throw Error('AO visibility buffer/texture population changed');
  if(sum.deferredEstimateBytes>config.memory.maxDeferredBytesPerViewGeneration||sum.deferredEstimateBytes>config.memory.maxDeferredTargetBytesTotal)throw Error(`AO allocation budget exceeded at ${phase}: ${sum.deferredEstimateBytes} bytes, per-view limit ${config.memory.maxDeferredBytesPerViewGeneration}, total limit ${config.memory.maxDeferredTargetBytesTotal}`);
  for(const type of ['buffer','texture']){const rows=snapshot.records.filter(r=>r.type===type),stats=r.resources[phase][type];if(rows.length!==stats.current||rows.reduce((n,r)=>n+r.estimatedBytes,0)!==stats.estimatedBytes)throw Error('AO tracker totals mismatch');}
  memory.push({phase,aoBytes:sum.totals.ao.bytes,deferredBytes:sum.deferredEstimateBytes,totalBytes:sum.allocationEstimateBytes});
 }
 if(memory.some(m=>m.deferredBytes!==memory[0].deferredBytes))throw Error('AO storage grew during steady populations');
 if(r.allocationBudget?.limitBytes!==config.memory.maxDeferredTargetBytesTotal||r.allocationBudget.reservedBytes>r.allocationBudget.limitBytes||r.allocationBudget.peakReservedBytes>r.allocationBudget.limitBytes||r.cleanup.allocationBudgetReservedBytes!==0)throw Error('Shared allocation budget mismatch/leak');
 if(options.algorithm==='tiled'){
  const p=r.tilePlan;if(!p||p.tileCount!==Math.ceil(r.width/16)*Math.ceil(r.height/16)||p.fullListTiles!==p.tileCount-p.storedTiles||p.memoryLimitedTiles<0||p.viewBytes>config.memory.maxDeferredBytesPerViewGeneration)throw Error('Missing joint tile memory plan');
  if(options.ao!=='off'&&r.width===1920&&p.memoryLimitedTiles<=0)throw Error('Missing memory fallback diagnostics');
 }
 const modules=c.records.filter(r=>r.method==='createShaderModule'),pipelines=c.records.filter(r=>r.method!=='createShaderModule');
 const unique=[...new Map(modules.map(m=>[m.sha256,m])).values()];
 return {status:'passed',scope:options.full?'Full single-capture diagnostic; cohort/host qualification is separate':'Short cost diagnostic; no performance qualification',moduleCalls:modules.length,uniqueShaderVariants:unique.length,uniqueShaderBytes:unique.reduce((n,m)=>n+m.bytes,0),pipelineCalls:pipelines.length,byStage:Object.fromEntries(['scenario','profile','first-frame','warmup'].map(stage=>[stage,{modules:modules.filter(m=>m.stage===stage).length,pipelines:pipelines.filter(p=>p.stage===stage).length}])),memory};
}
