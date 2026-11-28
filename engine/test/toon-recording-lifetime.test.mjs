import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuditGpuDevice} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {importEngineSource} from './helpers/internal-source.mjs';
const {ToonRenderer}=await importEngineSource('renderer/ToonRenderer.ts');
const {ToonMaterial}=await importEngineSource('material/ToonMaterial.ts');
const {Geometry3D}=await importEngineSource('geometry/Geometry3D.ts');
const {RenderFrameContext}=await importEngineSource('core/RenderCommandContext.ts');
const {disposeSceneFrameGpuArena}=await importEngineSource('renderer/SceneFrameGpuArena.ts');
const identity=Float32Array.from([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}){
 const writes=[],device=createAuditGpuDevice({behaviors:{'queue.writeBuffer':({args})=>{if(args[0].label==='ToonRenderer.material')writes.push(args[0]);}}}),engine={device,format:'rgba8unorm',getDepthFormat:()=> 'depth24plus',width:64,height:64,...(options.assets?{assetManager:options.assets(device)}:{})},renderer=new ToonRenderer(),contexts=[];renderer.prepare(engine);
 const geometry=new Geometry3D({positions:Float32Array.from([0,0,0,1,0,0,0,1,0])}),material=new ToonMaterial({baseColor:[1,0,0,1]});
 function record(frame=1){const context=new RenderFrameContext(engine,{descriptor:{colorAttachments:[]}}),data=new Float32Array(68);data.set(identity);data.set(identity,16);data.set(identity,32);contexts.push(context);renderer.beginView({reverseZ:false,msaaSamples:1,sceneFrameUniforms:{data,frameId:frame,phaseRevision:frame,cameraEntityId:1},sceneEnvironment:{pbrLights:[]},directionalShadow:null,commandContext:context});const pass=context.encoder.beginRenderPass({colorAttachments:[]});renderer.render(pass,1,geometry,material,identity);pass.end();renderer.endView();return{context,data:renderer._materials.get(material.id),buffer:renderer._materials.get(material.id).buffer};}
 return{device,engine,renderer,material,record,writes,async close(){for(const context of contexts)context.cancel();renderer.destroy();disposeSceneFrameGpuArena(device);await settle();}};
}
test('Toon material changes preserve both unsubmitted buffer generations and retire after their own boundaries',async()=>{
 const f=fixture();try{const a=f.record();f.material.baseColor=[0,1,0,1];const b=f.record(2);assert.notEqual(a.buffer,b.buffer);assert.equal(a.buffer.destroyed,false);f.renderer.releaseMaterialsNotIn(new Set());assert.equal(a.buffer.destroyed,false);assert.equal(b.buffer.destroyed,false);a.context.cancel();assert.equal(a.buffer.destroyed,true);assert.equal(b.buffer.destroyed,false);b.context.submit();assert.equal(b.buffer.destroyed,false,'submitted storage waits for queue completion');await settle();assert.equal(b.buffer.destroyed,true);}
 finally{await f.close();}
});
test('unchanged Toon material shares its immutable buffer without another uniform upload',async()=>{
 const f=fixture();try{const a=f.record(),writes=f.writes.length,b=f.record(2);assert.equal(a.buffer,b.buffer);assert.equal(f.writes.length,writes);f.renderer.releaseMaterialsNotIn(new Set());a.context.cancel();assert.equal(b.buffer.destroyed,false);b.context.cancel();assert.equal(b.buffer.destroyed,true);}
 finally{await f.close();}
});
test('same encoder material edits use different buffers because queue writes are not encoded writes',async()=>{
 const f=fixture();try{const a=f.record();const context=a.context;f.renderer._commandContext=context;const data=a.data;f.material.baseColor=[0,0,1,1];f.renderer._syncMaterial(f.material,data);assert.notEqual(data.buffer,a.buffer);assert.equal(a.buffer.destroyed,false);context.cancel();assert.equal(a.buffer.destroyed,true);}
 finally{await f.close();}
});
test('Toon renderer destruction keeps the held material and default textures until cancellation',async()=>{
 const f=fixture();try{const a=f.record(),white=f.renderer._defaultTexture,shadow=f.renderer._defaultShadowTexture,lights=f.renderer._lightUniforms.buffer;f.renderer.destroy();assert.equal(a.buffer.destroyed,false);assert.equal(white.destroyed,false);assert.equal(shadow.destroyed,false);assert.equal(lights.destroyed,false);a.context.cancel();assert.equal(a.buffer.destroyed,true);assert.equal(white.destroyed,true);assert.equal(shadow.destroyed,true);assert.equal(lights.destroyed,true);}
 finally{await f.close();}
});
function textureHost(){const requests=[],handles=[];return{requests,handles,assets:gpu=>({loadTexture:source=>new Promise(resolve=>requests.push({source,resolve})),gpu}),handle(gpu){const texture=gpu.createTexture({size:[1,1],format:'rgba8unorm-srgb',usage:4}),value={value:texture,releases:0,release(){this.releases++;texture.destroy();}};handles.push(value);return value;}};}
test('Toon replacement releases an acquired texture only after every recording using it closes',async()=>{
 const host=textureHost(),f=fixture(host);try{
  f.material.layers=[{minLight:0,texture:'a.png'}];f.record();const a=host.handle(f.device);host.requests[0].resolve(a);await settle();
  const first=f.record(2),second=f.record(3);f.material.layers=[{minLight:0,texture:'b.png'}];f.record(4);assert.equal(a.releases,0);first.context.cancel();assert.equal(a.releases,0);second.context.cancel();assert.equal(a.releases,1);
  const b=host.handle(f.device);host.requests[1].resolve(b);await settle();f.renderer.releaseMaterialsNotIn(new Set());assert.equal(b.releases,1,'never-recorded replacement is released immediately');
 }finally{await f.close();}
});
test('Toon A-to-B-to-A completion accepts only the current texture request',async()=>{
 const host=textureHost(),f=fixture(host);try{
  for(const source of ['a.png','b.png','a.png']){f.material.layers=[{minLight:0,texture:source}];f.record();}
  const handles=host.requests.map(()=>host.handle(f.device));host.requests[2].resolve(handles[2]);await settle();const group=f.renderer._materials.get(f.material.id).bindGroup;host.requests[0].resolve(handles[0]);host.requests[1].resolve(handles[1]);await settle();assert.equal(f.renderer._materials.get(f.material.id).bindGroup,group);assert.deepEqual(handles.map(value=>value.releases),[1,1,0]);f.renderer.releaseMaterialsNotIn(new Set());assert.deepEqual(handles.map(value=>value.releases),[1,1,1]);
 }finally{await f.close();}
});
test('Toon rejects a texture that finishes after its material was evicted',async()=>{
 const host=textureHost(),f=fixture(host);try{f.material.layers=[{minLight:0,texture:'late.png'}];f.record();f.renderer.releaseMaterialsNotIn(new Set());const handle=host.handle(f.device);host.requests[0].resolve(handle);await settle();assert.equal(handle.releases,1);assert.equal(f.renderer._materials.size,0);}finally{await f.close();}
});
