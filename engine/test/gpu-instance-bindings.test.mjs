import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {importEngineSource} from './helpers/internal-source.mjs';
const {GpuInstanceBindings}=await importEngineSource('renderer/GpuInstanceBindings.ts');
function fixture(){
 const device=createAuditGpuDevice(),buffers=[];const make=size=>{const b=device.createBuffer({size,usage:GPUBufferUsage.STORAGE});buffers.push(b);return b;};
 const transforms=make(64*8),colors=make(16*8),visible=make(256*32);let revision=0,retiredOffset=-1;const created=[];
 const owner=new GpuInstanceBindings(device,(source,uniform)=>{if(source.visibleOffset===retiredOffset)throw Error('retired borrowed source');const binding={source:{...source},uniform,revision,serial:created.length};created.push(binding);return binding;});
 const source=offset=>({device,transforms,colors,visibleIndices:visible,visibleOffset:offset*256,capacity:8,count:8});
 return {owner,device,created,source,retire(offset){retiredOffset=offset*256;},rebind(){revision++;owner.rebind();},destroy(){owner.destroy();for(const b of buffers)b.destroy();}};
}
test('external instance bindings reuse four per-view lists without changing recorded bindings',()=>{
 const f=fixture();try{
  const groups=Array.from({length:4},(_,i)=>f.owner.get(7,f.source(i)).bindGroup1);
  for(let frame=0;frame<300;frame++)for(let view=0;view<4;view++){
   const entry=f.owner.get(7,{...f.source(view),count:3});assert.equal(entry.bindGroup1,groups[view]);assert.equal(entry.bindGroup1.source.visibleOffset,view*256);
  }
  assert.equal(f.created.length,4);assert.equal(new Set(groups.map(g=>g.uniform)).size,1);
  assert.deepEqual(groups.map(g=>g.source.visibleOffset),[0,256,512,768]);
 }finally{f.destroy();}
});
test('external instance binding cache is bounded and rebinds all retained views',()=>{
 const f=fixture();try{
  for(let offset=0;offset<24;offset++)f.owner.get(7,f.source(offset));
  assert.equal(f.owner.variants.get(7).length,16);
  f.rebind();const created=f.created.length;
  for(let offset=8;offset<24;offset++)assert.equal(f.owner.get(7,f.source(offset)).bindGroup1.revision,1);
  assert.equal(f.created.length,created+16);
  assert.equal(f.owner.get(7,f.source(0)).bindGroup1.revision,1);assert.equal(f.created.length,created+17);
  assert.equal(f.owner.variants.get(7).length,16);
 }finally{f.destroy();}
});
test('releasing an entity clears every borrowed-source variant and destroys its single material buffer',()=>{
 const f=fixture();try{
  for(let view=0;view<4;view++)f.owner.get(7,f.source(view));const old=f.owner.get(7,f.source(0)).bindGroup1;
  f.owner.release(new Set());assert.equal(f.owner.variants.size,0);
  const calls=getAuditGpuDeviceState(f.device).calls.filter(c=>c.method==='buffer.destroy');assert.ok(calls.length>=1);
  assert.notEqual(f.owner.get(7,f.source(0)).bindGroup1.uniform,old.uniform);
  f.owner.destroy();assert.equal(f.owner.variants.size,0);
 }finally{f.destroy();}
});

test('rebind does not touch retired borrowed buffers from unused cached views',()=>{
 const f=fixture();try{
  f.owner.get(7,f.source(0));f.owner.get(7,f.source(1));f.retire(0);f.rebind();
  assert.equal(f.created.length,2);assert.equal(f.owner.get(7,f.source(1)).bindGroup1.revision,1);
  const created=f.created.length;f.owner.get(7,f.source(1));assert.equal(f.created.length,created);
 }finally{f.destroy();}
});
