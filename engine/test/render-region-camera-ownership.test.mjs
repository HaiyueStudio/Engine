import test from 'node:test';
import assert from 'node:assert/strict';
import {Render3DSystem,RenderView,RenderFrameContext,Camera3D,CartesianTransform3D,Entity,World,disposeSceneFrameGpuArena} from '../dist/experimental.js';
import {RenderViewFamily} from '../dist/core.js';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';

const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};
function fixture(){
 const device=createAuditGpuDevice(),audit=getAuditGpuDeviceState(device),world=new World(),camera=new Entity('shared camera').addComponent(new Camera3D({near:.1,far:100})).addComponent(new CartesianTransform3D({position:[0,0,4]}));world.addEntity(camera);
 const textures=[],target=(key,width,height)=>{const texture=device.createTexture({label:key,size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT});textures.push(texture);return{key,width,height,displayWidth:width,displayHeight:height,format:'rgba8unorm',getOutputView:()=>texture.createView(),getRenderPassDescriptor(){return{colorAttachments:[{view:this.getOutputView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}]}}}};
 const engine={device,width:128,height:80,displayWidth:128,displayHeight:80,format:'rgba8unorm',msaaSamples:1,reverseZ:false,getDepthFormat:()=> 'depth24plus',clearColor:{r:0,g:0,b:0,a:1}},wide=new RenderView({key:'wide',camera,target:target('wide',160,80)}),tall=new RenderView({key:'tall',camera,target:target('tall',80,160),depthConvention:'reverse'}),family=new RenderViewFamily({views:[wide,tall]}),system=new Render3DSystem(engine,camera,{renderProfile:'batched'}),captured=[];
 world.addSystem(system);system._recordView=(_world,_context,view,_state,_environment,_slot,planned)=>captured.push({view,cameraFrame:planned.cameraFrame,uniform:planned.sceneFrameUniforms.data.slice()});
 const contexts=[];
 return{world,camera,system,engine,device,audit,wide,tall,family,captured,
  record(view){world.frameData.begin(world,engine,0,16);const context=new RenderFrameContext(engine,{...(view?{view}:{viewFamily:family}),frameData:world.frameData});contexts.push(context);system.record(world,context);return context;},
  async destroy(){for(const c of contexts)if(!c.submitted)c.cancel();system.destroy();world.destroy();wide.destroy();tall.destroy();disposeSceneFrameGpuArena(device);for(const t of textures)t.destroy();await flush();assert.equal(audit.snapshot().resources.buffer.live,0);assert.equal(audit.snapshot().resources.texture.live,0);}
 };
}
test('shared-camera views keep CPU projection, frustum and post inputs consistent with their own planned GPU uniforms',async()=>{
 const f=fixture();try{
  f.record();assert.equal(f.captured.length,2);const [a,b]=f.captured;
  assert.equal(a.cameraFrame.width,160,'The later tall view must not overwrite the wide camera');assert.equal(a.cameraFrame.height,80);assert.equal(b.cameraFrame.width,80);assert.equal(b.cameraFrame.height,160);
  assert.notEqual(a.cameraFrame,b.cameraFrame);
  for(const c of f.captured){assert.deepEqual(c.cameraFrame.viewProjectionMatrix,c.uniform.subarray(0,16));assert.deepEqual(c.cameraFrame.viewMatrix,c.uniform.subarray(16,32));assert.deepEqual(c.cameraFrame.inverseViewProjectionMatrix,c.uniform.subarray(32,48));const planes=new Float32Array(24);c.cameraFrame.frustum.copyPlanesTo(planes);assert.deepEqual(planes,c.cameraFrame.frustumPlanes);}
 }finally{await f.destroy();}
});
test('unsubmitted camera recordings retain their matrices and jitter across later frames and view resizes',async()=>{
 const f=fixture();try{
  const pending=f.record(),old=f.captured[0].cameraFrame,before={projection:old.projectionMatrix.slice(),view:old.viewMatrix.slice(),vp:old.viewProjectionMatrix.slice(),inverse:old.inverseViewProjectionMatrix.slice(),world:old.worldMatrix.slice(),position:old.position.slice(),jitter:old.projectionJitter.slice(),width:old.width,height:old.height};
  f.camera.getComponent(CartesianTransform3D).setPosition(1,.25,5);f.wide.viewport={x:0,y:0,width:120,height:80};const later=f.record();
  for(const [field,name]of [['projectionMatrix','projection'],['viewMatrix','view'],['viewProjectionMatrix','vp'],['inverseViewProjectionMatrix','inverse'],['worldMatrix','world'],['position','position'],['projectionJitter','jitter']])assert.deepEqual(old[field],before[name],field+' changed while its recording was pending');
  assert.equal(old.width,before.width);assert.equal(old.height,before.height);assert.notEqual(f.captured[2].cameraFrame,old);later.submit();pending.cancel();
 }finally{await f.destroy();}
});
test('completed/cancelled recordings reuse per-view CPU capacity and absent views release it',async()=>{
 const f=fixture();try{
  f.record().submit();const [a,b]=f.captured.map(c=>c.cameraFrame);
  for(let i=0;i<12;i++){const c=f.record();if(i%2)c.cancel();else c.submit();assert.equal(f.captured.at(-2).cameraFrame,a);assert.equal(f.captured.at(-1).cameraFrame,b);}
  assert.deepEqual(f.system._cameraFrames.stats,{views:2,slots:2,pendingRecordings:0});
  f.family.remove(f.tall);f.record().submit();assert.deepEqual(f.system._cameraFrames.stats,{views:1,slots:1,pendingRecordings:0});
  f.system.disabled=true;f.record().cancel();assert.deepEqual(f.system._cameraFrames.stats,{views:0,slots:0,pendingRecordings:0});
 }finally{await f.destroy();assert.deepEqual(f.system._cameraFrames.stats,{views:0,slots:0,pendingRecordings:0});}
});
test('a burst of pending frames preserves each snapshot then releases spare CPU capacity',async()=>{
 const f=fixture();try{
  const contexts=Array.from({length:6},()=>f.record());assert.deepEqual(f.system._cameraFrames.stats,{views:2,slots:12,pendingRecordings:6});
  const frames=f.captured.map(c=>c.cameraFrame.frameId);assert.deepEqual(frames,[1,1,2,2,3,3,4,4,5,5,6,6]);
  for(const c of contexts)c.cancel();assert.deepEqual(f.system._cameraFrames.stats,{views:2,slots:2,pendingRecordings:0});
 }finally{await f.destroy();}
});
test('a rejected cancelled context cannot strand the camera planner or retain snapshots',async()=>{
 const f=fixture();try{
  const cancelled=new RenderFrameContext(f.engine,{viewFamily:f.family,frameData:f.world.frameData});cancelled.cancel();assert.throws(()=>f.system.record(f.world,cancelled));
  assert.deepEqual(f.system._cameraFrames.stats,{views:0,slots:0,pendingRecordings:0});assert.doesNotThrow(()=>f.record().submit());
 }finally{await f.destroy();}
});
test('independent A/B/A view calls retain each live view reusable camera identity',async()=>{
 const f=fixture();try{
  f.record(f.wide).submit();const a=f.captured.at(-1).cameraFrame;f.record(f.tall).submit();const b=f.captured.at(-1).cameraFrame;
  for(let i=0;i<20;i++){f.record(f.wide).submit();assert.equal(f.captured.at(-1).cameraFrame,a);f.record(f.tall).submit();assert.equal(f.captured.at(-1).cameraFrame,b);}
  assert.deepEqual(f.system._cameraFrames.stats,{views:2,slots:2,pendingRecordings:0});
 }finally{await f.destroy();}
});
