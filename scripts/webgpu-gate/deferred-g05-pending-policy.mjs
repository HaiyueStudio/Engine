import {summarizeG05ResourceRecords} from './deferred-g05-memory-policy.mjs';
export function validateG05PendingNative(r,config){
 if(r.schemaVersion!==1||r.status!=='passed'||r.suite!=='g05-native-pending-memory'||r.performanceQualified!==false)throw Error('Invalid native pending capture');
 if(r.adapter?.isFallbackAdapter!==false||!r.adapter.vendor||!r.adapter.architecture||r.validationErrors?.length!==0)throw Error('Native adapter/validation failure');
 if(JSON.stringify(r.dimensions)!==JSON.stringify([[1904,1072],[1920,1080]])||r.views!==4)throw Error('Pending workload changed');
 const withAo=r.withAo===true;
 let expectedBytes=withAo?260:0;
 for(const [w,h]of r.dimensions){const ao=withAo?256+Math.ceil(w*2/256)*256*h+2*w*h:0,tiles=Math.ceil(w/16)*Math.ceil(h/16),stored=withAo?Math.min(tiles,Math.floor((config.memory.maxDeferredBytesPerViewGeneration-28*w*h-ao-524288)/528)):tiles;expectedBytes+=4*(28*w*h+Math.max(4,stored*528)+ao);}
 for(const phase of ['pending','heldBeforeSubmission']){
  const snapshot=r[phase],sum=summarizeG05ResourceRecords(snapshot?.records);
  if(snapshot.driverResidentMemory!==false||JSON.stringify(snapshot.views)!==JSON.stringify(sum.views)||snapshot.deferredEstimateBytes!==sum.deferredEstimateBytes)throw Error('Invalid pending attribution');
  if(sum.views.length!==4||sum.views.some(v=>v.gbufferTextures!==8||v.tileBuffers!==2)||sum.deferredEstimateBytes!==(expectedBytes-(withAo&&phase==='heldBeforeSubmission'?260:0))||sum.deferredEstimateBytes>config.memory.maxDeferredTargetBytesTotal)throw Error('Pending allocation budget/population mismatch');
 }
 const referenced=s=>s.records.filter(record=>record.label!=='DeferredAO.neutral');
 if(JSON.stringify(referenced(r.pending))!==JSON.stringify(referenced(r.heldBeforeSubmission)))throw Error('Referenced resources released before submission');
 if(JSON.stringify(r.capacityFailures)!==JSON.stringify(['live-target-generations','tile-live-generations','view-count','tile-view-count','deferred-target-bytes'])||r.newResourcesOnRejectedRequests!==0)throw Error('Capacity rejection allocated resources');
 if(r.readbacks?.length!==8||r.readbacks.some((v,i)=>v.generation!==Math.floor(i/4)||v.view!==i%4||v.tileValue!==123||JSON.stringify(v.rgba16)!==JSON.stringify([13312,14336,14848,15360])))throw Error('Submitted resources did not produce expected GPU values');
 if(r.budgetAtPeak!==expectedBytes||r.budgetAfterCompletion!==0)throw Error('Shared budget does not match actual allocations/retirement');
 if(withAo&&r.readbacks.some(v=>v.aoValues?.length!==2||v.aoValues.some(value=>value!==.25+v.generation*.25+v.view/16)))throw Error('AO visibility or in-flight configuration corruption');
 if(withAo){
  const cases=r.packingProbe?.cases;
  if(JSON.stringify(cases?.map(c=>[c.width,c.height]))!==JSON.stringify([[17,9],[129,3],[1920,2]]))throw Error('Missing AO packing probes');
  for(const c of cases){
   const count=c.width*c.height;
   if(c.values?.length!==count+2||c.neutralValues?.length!==count+2||c.neutralValues.some(v=>v!==1))throw Error('Invalid AO packing/neutral population');
   for(let i=0;i<count+2;i++){
    const pixel=i===count?0:i===count+1?count-1:i;
    const expected=((pixel%c.width)+7*Math.floor(pixel/c.width))%17/16;
    if(c.values[i]!==expected)throw Error(`AO packing mismatch ${c.width}x${c.height} at ${i}`);
   }
  }
 }
 const settled=summarizeG05ResourceRecords(r.afterCompletion?.records);
 if(settled.allocationEstimateBytes!==0||r.afterCompletion.records.length!==0||r.deviceDestroyed!==true)throw Error('Pending resources leaked');
 return {status:'passed',estimatedBytes:r.pending.deferredEstimateBytes,driverResidentMemory:false,performanceQualified:false};
}
