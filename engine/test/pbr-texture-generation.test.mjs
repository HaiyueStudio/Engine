import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
import {createAuditGpuDevice} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const {AssetManager}=await importEngineSource('assets/AssetManager.ts');
const {PbrMaterialResources}=await importEngineSource('renderer/PbrMaterialResources.ts');
const {PbrMaterial}=await importEngineSource('material/PbrMaterial.ts');
const {RecordedGpuResources}=await importEngineSource('renderer/RecordedGpuResources.ts');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(assetsFactory){
 const device=createAuditGpuDevice(),recorded=new RecordedGpuResources(device);
 const white=device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING});
 const assets=assetsFactory(device),owner=new PbrMaterialResources({device,recorded,assets,white,normal:white,black:white,signal:new AbortController().signal,layout:device.createBindGroupLayout({entries:[]}),defaultSampler:device.createSampler()});
 const material=new PbrMaterial(),data=owner.entries.ensure(material.id,()=>owner.create(material));
 return{device,assets,owner,material,data,async dispose(){owner.destroy();recorded.retireAll();await settle();assets.dispose?.();white.destroy();}};
}
for(const [slot,property] of [['baseColor','baseColorTexture'],['normal','normalTexture']])test(`PBR ${slot} retires both independent A leases after A-B-A shares a pending record`,async()=>{
 const pending=new Map(),f=fixture(device=>{
  const assets=new AssetManager(device);
  assets.loadTexture=(source,options)=>assets.load(source,()=>new Promise(resolve=>pending.set(source,resolve)),texture=>texture.destroy(),{signal:options.signal});
  return assets;
 });
 try{
  for(const source of ['A','B','A']){f.material[property]=source;f.owner.sync(f.material,f.data);}
  for(const source of ['A','B'])pending.get(source)(f.device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING}));
  await settle();assert.deepEqual(f.assets.getDebugSnapshot().records.map(r=>[r.key,r.refs]),[['A',1]]);
  f.owner.entries.clear();await settle();assert.equal(f.assets.getDebugSnapshot().records.length,0);
 }finally{await f.dispose();}
});
test('PBR stale same-source completion cannot replace the newest binding and every discarded handle releases once',async()=>{
 const pending=[],handles=[];
 const f=fixture(()=>({loadTexture:source=>new Promise(resolve=>pending.push({source,resolve}))}));
 const handle=()=>{const texture=f.device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING});const h={value:texture,releases:0,release(){h.releases++;texture.destroy();}};handles.push(h);return h;};
 try{
  for(const source of ['A','B','A']){f.material.baseColorTexture=source;f.owner.sync(f.material,f.data);}
  const first=handle(),middle=handle(),last=handle();pending[2].resolve(last);await settle();const group=f.data.bindGroup;
  pending[0].resolve(first);pending[1].resolve(middle);await settle();
  assert.equal(f.data.bindGroup,group);assert.equal(f.data.handles.baseColor,last);assert.deepEqual(handles.map(h=>h.releases),[1,1,0]);
  f.owner.entries.clear();await settle();assert.deepEqual(handles.map(h=>h.releases),[1,1,1]);
 }finally{await f.dispose();}
});
test('PBR replacing a pending source with an external texture and disposing before a late result preserve lifetime guards',async()=>{
 const pending=[],f=fixture(()=>({loadTexture:source=>new Promise(resolve=>pending.push({source,resolve}))}));
 let releases=0;
 const texture=f.device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING});
 try{
  f.material.baseColorTexture='A';f.owner.sync(f.material,f.data);
  f.material.baseColorTexture=texture;f.owner.sync(f.material,f.data);
  const group=f.data.bindGroup;pending[0].resolve({value:texture,release(){releases++;}});await settle();assert.equal(releases,1);assert.equal(f.data.bindGroup,group);
  f.material.baseColorTexture='B';f.owner.sync(f.material,f.data);f.owner.entries.clear();
  pending[1].resolve({value:texture,release(){releases++;}});await settle();assert.equal(releases,2);
 }finally{await f.dispose();texture.destroy();}
});
