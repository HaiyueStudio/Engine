import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {summarizeG05ResourceRecords} from './deferred-g05-memory-policy.mjs';
import {validateG05PendingNative} from './deferred-g05-pending-policy.mjs';
const config=JSON.parse(readFileSync(new URL('../../config/lighting-performance-021.json',import.meta.url)));
function valid(){
 const records=[];
 for(const [w,h]of [[1904,1072],[1920,1080]])for(let v=0;v<4;v++){
  for(let i=0;i<4;i++)records.push({id:records.length,type:'texture',label:`TransientMRT:view:${v}:${i}`,estimatedBytes:w*h*(i===3?4:8)});
  records.push({id:records.length,type:'buffer',label:`DeferredTiles:view:${v}`,estimatedBytes:Math.ceil(w/16)*Math.ceil(h/16)*132*4});
 }
 const pending={driverResidentMemory:false,records,...summarizeG05ResourceRecords(records)};
 return {schemaVersion:1,status:'passed',suite:'g05-native-pending-memory',withAo:false,budgetAtPeak:494917952,budgetAfterCompletion:0,performanceQualified:false,adapter:{vendor:'amd',architecture:'rdna-1',isFallbackAdapter:false},validationErrors:[],dimensions:[[1904,1072],[1920,1080]],views:4,pending,heldBeforeSubmission:structuredClone(pending),capacityFailures:['live-target-generations','tile-live-generations','view-count','tile-view-count','deferred-target-bytes'],newResourcesOnRejectedRequests:0,readbacks:Array.from({length:8},(_,i)=>({generation:Math.floor(i/4),view:i%4,tileValue:123,rgba16:[13312,14336,14848,15360]})),afterCompletion:{records:[]},deviceDestroyed:true};
}
test('native pending memory requires both generations, GPU output and no premature destruction',()=>{
 const r=valid();assert.equal(validateG05PendingNative(r,config).estimatedBytes,494917952);
 for(const mutate of [r=>r.pending.records.pop(),r=>r.pending.deferredEstimateBytes++,r=>r.heldBeforeSubmission.records[0].id=99,r=>r.readbacks[0].tileValue=0,r=>r.readbacks[0].rgba16[0]=0,r=>r.readbacks.pop(),r=>r.performanceQualified=true,r=>r.validationErrors=['destroyed texture'],r=>r.deviceDestroyed=false]){const bad=valid();mutate(bad);assert.throws(()=>validateG05PendingNative(bad,config));}
});
test('native capacity failures must allocate nothing and all referenced resources must retire',()=>{
 for(const mutate of [r=>r.capacityFailures.pop(),r=>r.newResourcesOnRejectedRequests=1,r=>r.afterCompletion.records=[r.pending.records[0]],r=>r.pending.driverResidentMemory=true]){const r=valid();mutate(r);assert.throws(()=>validateG05PendingNative(r,config));}
 const smaller=structuredClone(config);smaller.memory.maxDeferredTargetBytesTotal=494917951;assert.throws(()=>validateG05PendingNative(valid(),smaller));
});

test('native AO generations preserve every pixel probe and exact ledger retirement',()=>{
 const r=valid();r.withAo=true;const records=[];
 for(const [w,h]of r.dimensions)for(let v=0;v<4;v++){
  const ao=256+Math.ceil(w*2/256)*256*h+2*w*h,stored=Math.min(Math.ceil(w/16)*Math.ceil(h/16),Math.floor((67108864-28*w*h-ao-524288)/528));
  for(let i=0;i<4;i++)records.push({id:records.length,type:'texture',label:`TransientMRT:view:${v}:${i}`,estimatedBytes:w*h*(i===3?4:8)});
  records.push({id:records.length,type:'buffer',label:`DeferredTiles:view:${v}`,estimatedBytes:stored*528});
  records.push({id:records.length,type:'buffer',label:'DeferredAO.visibility',estimatedBytes:256+Math.ceil(w*2/256)*256*h});
  records.push({id:records.length,type:'texture',label:'DeferredAO.visibility:0',estimatedBytes:2*w*h});
 }
 records.push({id:records.length,type:'buffer',label:'DeferredAO.neutral',estimatedBytes:260});
 r.pending={driverResidentMemory:false,records,...summarizeG05ResourceRecords(records)};
 const held=records.filter(x=>x.label!=='DeferredAO.neutral');r.heldBeforeSubmission={driverResidentMemory:false,records:held,...summarizeG05ResourceRecords(held)};
 r.budgetAtPeak=r.pending.deferredEstimateBytes;r.readbacks.forEach(v=>v.aoValues=Array(2).fill(.25+v.generation*.25+v.view/16));
 r.packingProbe={cases:[[17,9],[129,3],[1920,2]].map(([width,height])=>({width,height,values:Array.from({length:width*height+2},(_,i)=>{const p=i===width*height?0:i===width*height+1?width*height-1:i;return ((p%width)+7*Math.floor(p/width))%17/16;}),neutralValues:Array(width*height+2).fill(1)}))};
 validateG05PendingNative(r,config);
 for(const change of [r=>r.readbacks[1].aoValues[0]=0,r=>r.budgetAfterCompletion=1,r=>r.budgetAtPeak++,r=>r.heldBeforeSubmission.records.pop(),r=>r.packingProbe.cases.pop(),r=>r.packingProbe.cases[0].values[1]=0,r=>r.packingProbe.cases[1].values[129]=0,r=>r.packingProbe.cases[2].values[3841]=0,r=>r.packingProbe.cases[0].neutralValues[0]=0]){const copy=structuredClone(r);change(copy);assert.throws(()=>validateG05PendingNative(copy,config));}
});
