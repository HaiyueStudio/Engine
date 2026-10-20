const categories=['gbuffer','tiles','light-source','light-view','parameters','ao','other-deferred','other'];
function classify(label){
 if(label.startsWith('TransientMRT:'))return 'gbuffer';
 if(label.startsWith('DeferredTiles:'))return 'tiles';
 if(label==='DeferredLights.source')return 'light-source';
 if(label==='DeferredLights.view')return 'light-view';
 if(label==='DeferredReference.parameters'||label==='DeferredTiles.parameters')return 'parameters';
 if(label.startsWith('DeferredAO.'))return 'ao';
 return /deferred/i.test(label)?'other-deferred':'other';
}
export function summarizeG05ResourceRecords(records){
 if(!Array.isArray(records))throw Error('Resource records missing');
 const totals=Object.fromEntries(categories.map(k=>[k,{count:0,bytes:0}])),views=new Map(),seen=new Set();
 let bytes=0;
 for(const r of records){
  if(!Number.isSafeInteger(r.id)||seen.has(r.id)||!['buffer','texture'].includes(r.type)||typeof r.label!=='string'||!Number.isSafeInteger(r.estimatedBytes)||r.estimatedBytes<0)throw Error('Invalid or duplicate resource record');
  seen.add(r.id);const category=classify(r.label);totals[category].count++;totals[category].bytes+=r.estimatedBytes;bytes+=r.estimatedBytes;
  if(category==='gbuffer'||category==='tiles'){
   const key=category==='tiles'?r.label.slice('DeferredTiles:'.length):r.label.slice('TransientMRT:'.length,r.label.lastIndexOf(':'));
   if(!key)throw Error('Missing resource view key');
   const view=views.get(key)??{key,gbufferBytes:0,gbufferTextures:0,tileBytes:0,tileBuffers:0};
   if(category==='gbuffer'){if(r.type!=='texture')throw Error('G-buffer record is not a texture');view.gbufferBytes+=r.estimatedBytes;view.gbufferTextures++;}
   else{if(r.type!=='buffer')throw Error('Tile record is not a buffer');view.tileBytes+=r.estimatedBytes;view.tileBuffers++;}
   views.set(key,view);
  }
 }
 return {allocationEstimateBytes:bytes,deferredEstimateBytes:bytes-totals.other.bytes,totals,views:[...views.values()].sort((a,b)=>a.key.localeCompare(b.key))};
}
export function captureG05ResourceSnapshot(tracker){
 const snapshot=tracker.getDebugSnapshot();if(!snapshot.enabled)throw Error('Detailed shared resource tracker required');
 const records=snapshot.resources.filter(r=>r.type==='buffer'||r.type==='texture').map(r=>({id:r.id,type:r.type,label:r.label,estimatedBytes:r.estimatedBytes,owner:r.owner,createdAtFrame:r.createdAtFrame}));
 return {schemaVersion:1,driverResidentMemory:false,records,...summarizeG05ResourceRecords(records)};
}
export function validateG05RoomMemory(result,config){
 const memory=config.memory;
 if(!memory||memory.maxViews!==4||memory.maxLiveTargetGenerations!==2||memory.driverResidentMemoryClaim!==false)throw Error('Missing frozen memory contract');
 const phases=['warm','cpu','gpu'],checks=[];
 for(const phase of phases){
  const snapshot=result.resourceAttribution?.[phase];
  if(snapshot?.schemaVersion!==1||snapshot.driverResidentMemory!==false)throw Error('Missing attributed resource snapshot');
  const recomputed=summarizeG05ResourceRecords(snapshot.records);
  for(const field of ['allocationEstimateBytes','deferredEstimateBytes','totals','views'])if(JSON.stringify(snapshot[field])!==JSON.stringify(recomputed[field]))throw Error('Resource attribution summary mismatch');
  for(const type of ['buffer','texture']){
   const records=snapshot.records.filter(r=>r.type===type),stats=result.resources[phase][type];
   if(records.length!==stats.current||records.reduce((n,r)=>n+r.estimatedBytes,0)!==stats.estimatedBytes)throw Error('Resource attribution does not match tracker totals');
  }
  if(recomputed.views.length!==result.views||result.views>memory.maxViews)throw Error('Memory view population mismatch');
  if(recomputed.totals['other-deferred'].count!==0)throw Error(`Unattributed Deferred resource: ${snapshot.records.filter(r=>classify(r.label)==='other-deferred').map(r=>r.label).join(', ')}`);
  // The E/G room has no AO pass. Charge all shared source/view/parameter/neutral
  // storage to each view as a conservative ceiling, and also retain its actual total.
  const shared=recomputed.deferredEstimateBytes-recomputed.totals.gbuffer.bytes-recomputed.totals.tiles.bytes;
  for(const view of recomputed.views){
   if(view.gbufferTextures!==4||view.gbufferBytes!==28*result.width*result.height||view.tileBuffers>1)throw Error('Steady room target generation mismatch');
   const observed=view.gbufferBytes+view.tileBytes+shared,limit=memory.maxDeferredBytesPerViewGeneration;
   checks.push({phase,view:view.key,metric:'conservativeViewAllocationBytes',observed,limit,passed:observed<=limit});
  }
  checks.push({phase,metric:'totalDeferredAllocationBytes',observed:recomputed.deferredEstimateBytes,limit:memory.maxDeferredTargetBytesTotal,passed:recomputed.deferredEstimateBytes<=memory.maxDeferredTargetBytesTotal});
 }
 for(const phase of ['cpu','gpu'])if(result.resourceAttribution[phase].deferredEstimateBytes!==result.resourceAttribution.warm.deferredEstimateBytes)throw Error('Deferred allocation grew after warmup');
 return {status:checks.every(c=>c.passed)?'passed':'failed',checks,scope:'E/G steady single-generation allocation estimates; two pending generations and AO need separate lifecycle/cost evidence; no driver residency claim'};
}
