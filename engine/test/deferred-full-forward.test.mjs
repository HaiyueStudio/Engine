import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {importEngineSource} from './helpers/internal-source.mjs';
const {DeferredFullForward}=await importEngineSource('renderer/DeferredFullForward.ts');
const {PbrRenderer}=await importEngineSource('renderer/PbrRenderer.ts');
const {getPbrDeferredSurfacePort}=await importEngineSource('renderer/PbrDeferredSurfacePort.ts');
const {disposeSceneFrameGpuArena}=await importEngineSource('renderer/SceneFrameGpuArena.ts');

test('full-light groups preserve dynamic light offsets and reuse immutable per-view bindings',()=>{
  const device=createAuditGpuDevice(),renderer=new PbrRenderer();
  renderer.prepare({device,format:'rgba16float',width:32,height:32,defaults:{},getDepthFormat:()=> 'depth24plus'});
  const port=getPbrDeferredSurfacePort(renderer),owner=new DeferredFullForward(device,port);
  const buffer=device.createBuffer({size:4096,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.UNIFORM});
  try{
    const bindings={source:{buffer,offset:0,size:80},header:{buffer,offset:256,size:32},indices:{buffer,offset:512,size:4}};
    const state=owner.bind(bindings),base=device.createBindGroup({layout:port.layouts[3],entries:[]});
    assert.equal(owner.bind(structuredBindings(bindings)),state);
    assert.equal(state.shader(false,false),state.shader(false,false));
    assert.equal(new Set([state.shader(false,false),state.shader(true,false),state.shader(false,true),state.shader(true,true)]).size,4);
    const group=state.bindGroup(base,[]);
    assert.equal(state.bindGroup(base,[]),group);
    const shifted=owner.bind({...bindings,header:{...bindings.header,offset:768}});
    assert.notEqual(shifted.bindGroup(base,[]),group,'different pending view offset must never reuse another view binding');
    for(const runtime of owner.runtimes){
      const pass=runtime.pass.bindGroups.find(group=>group.physicalGroup===3);
      assert.equal(pass.bindings[0].layout.hasDynamicOffset,true);
      assert.deepEqual(pass.bindings.slice(12).map(binding=>binding.layout.hasDynamicOffset),[false,false,false,false]);
    }
    const maskTexture=device.createTexture({size:[32,32],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING}),mask=maskTexture.createView();
    const sceneColorTexture=device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING}),originalSceneColor=sceneColorTexture.createView();
    const originalCreate=device.createBindGroup,created=[];
    device.createBindGroup=descriptor=>{created.push(descriptor);return originalCreate.call(device,descriptor);};
    const entries=[{binding:11,resource:originalSceneColor}],otherBase=originalCreate.call(device,{layout:port.layouts[3],entries:[]});
    try {
      const masked=owner.bind(bindings,mask);
      assert.notEqual(masked,state);
      assert.equal(owner.bind(bindings,mask),masked);
      masked.bindGroup(otherBase,entries);state.bindGroup(otherBase,entries);
      assert.equal(created[0].entries.find(e=>e.binding===11).resource,mask);
      assert.equal(created[1].entries.find(e=>e.binding===11).resource,originalSceneColor);
      assert.equal(entries[0].resource,originalSceneColor,'proxy binding must never mutate pending transparent binding inputs');
    } finally {device.createBindGroup=originalCreate;maskTexture.destroy();sceneColorTexture.destroy();}
    const calls=getAuditGpuDeviceState(device).calls.filter(call=>call.method==='queue.writeBuffer').length;
    for(let i=0;i<300;i++)owner.bind({...bindings,indices:{buffer,offset:512+i*4,size:4}}).bindGroup(base,[]);
    assert.ok(owner._states.size<=64);assert.ok(owner._groups.size<=128);
    assert.equal(getAuditGpuDeviceState(device).calls.filter(call=>call.method==='queue.writeBuffer').length,calls);
    owner.destroy();assert.equal(owner._groups.size,0);assert.equal(owner._states.size,0);
  }finally{owner.destroy();buffer.destroy();renderer.destroy();disposeSceneFrameGpuArena(device);}
});
function structuredBindings(bindings){return Object.fromEntries(Object.entries(bindings).map(([key,b])=>[key,{...b}]));}

test('opaque proxy relighting preserves prepared batch object slots for single-item runs',async()=>{
  const {Render3DScenePassRenderer}=await importEngineSource('systems/Render3DScenePassRenderer.ts');
  const {Render3DSubmitter}=await importEngineSource('systems/Render3DSubmitter.ts');
  const items=Array.from({length:4},(_,i)=>({entityId:i,geometry:{},material:{},worldMatrix:new Float32Array(16)}));
  const slots=[19,27,34,42],batchBuffer={getObjectSlot:i=>slots[i]},seen=[];
  const registration={renderItem(){throw Error('Single item fallback would consume the unprepared per-entity object table');},
    renderBatch(_context,original,first,count,buffer){assert.equal(original,items);assert.equal(count,1);seen.push(buffer.getObjectSlot(first));}};
  const options={batchBuffer,resolveMaterialRenderer:()=>registration,setMaterialRenderContext:()=>({})};
  const renderer=new Render3DScenePassRenderer({});
  const backend={record(input){input.drawOpaqueForward({},[1,3]);return true;}};
  renderer.renderDeferred(backend,{opaqueItems:items,transparentItems:[],view:{reverseZ:false,sampleCount:1},context:{view:{}},
    postScene:{buildScenePassDescriptor:()=>({})},submitter:new Render3DSubmitter(),submitterOptions:options,
    pbrRenderer:{},viewProj:new Float32Array(16),viewMatrix:new Float32Array(16)});
  assert.deepEqual(seen,[27,42]);
});
