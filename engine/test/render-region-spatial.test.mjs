import test from 'node:test';
import assert from 'node:assert/strict';
import {RenderView,World,Entity,Camera3D,CartesianTransform3D,Geometry3D,Mesh3D,BasicMaterial,DirectionalLight,Render3DSystem,getSpatialIndexService} from '../dist/experimental.js';
import {MaterialRendererRegistry} from '../dist/material.js';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';

function fixture(){
 const world=new World('G04 planned spatial frusta'),geometry=new Geometry3D({positions:new Float32Array([-.1,-.1,0,.1,-.1,0,0,.1,0])}),material=new BasicMaterial(),entities=new Set(),meshes=[];
 for(let i=0;i<600;i++){const x=i===0?7.5:i===1?-7.5:i===2?0:100+i;const entity=new Entity('mesh-'+i).addComponent(new CartesianTransform3D({position:[x,0,0]})).addComponent(new Mesh3D(geometry,material));world.addEntity(entity);entities.add(entity);meshes.push(entity);}
 const camera=new Entity('camera').addComponent(new CartesianTransform3D({position:[0,0,4.4]})).addComponent(new Camera3D({fov:Math.PI/3,near:.1,far:100}));world.addEntity(camera);world.frameData.begin(world,null,0,16);
 const device=createAuditGpuDevice(),engine={device,width:128,height:80,displayWidth:128,displayHeight:80,format:'rgba8unorm',msaaSamples:1,reverseZ:false,getDepthFormat:()=> 'depth24plus'},system=new Render3DSystem(engine,camera,{renderProfile:'batched',spatialCullingThreshold:512,materialRenderers:new MaterialRendererRegistry(),registerDefaultMaterialRenderers:false});
 const target={key:'spatial-output',width:128,height:80,displayWidth:128,displayHeight:80,format:'rgba8unorm',getRenderPassDescriptor:()=>({colorAttachments:[]}),getOutputView:()=>({})},right=new RenderView({key:'right-window',camera,target}).snapshot(),left=new RenderView({key:'left-window',camera,target}).snapshot();
 const source=world.frameData.getCamera3D(camera,camera.getComponent(Camera3D),{width:512,height:128,projectionJitter:new Float32Array([.25,-.25])}),before={matrix:source.viewProjectionMatrix.slice(),jitter:source.projectionJitter.slice(),width:source.width,height:source.height};
 const frame=translate=>{const data=new Float32Array(68),m=before.matrix;for(let c=0;c<4;c++){const i=c*4;data[i]=4*m[i]+translate*m[i+3];data[i+1]=1.6*m[i+1];data[i+2]=m[i+2];data[i+3]=m[i+3];}return{sceneFrameUniforms:{frameId:source.frameId,phaseRevision:source.phaseRevision,cameraEntityId:camera.id,data}};};
 const planned=new Map([[right.key,frame(-3)],[left.key,frame(3)]]);let cameraQueries=0;const original=world.frameData.getCamera3D.bind(world.frameData);world.frameData.getCamera3D=(...args)=>{cameraQueries++;return original(...args);};
 return{world,system,device,entities,meshes,right,left,planned,source,before,get cameraQueries(){return cameraQueries},destroy(){system.destroy();world.destroy();assert.equal(getAuditGpuDeviceState(device).snapshot().resources.buffer.live,0);assert.equal(getAuditGpuDeviceState(device).snapshot().resources.texture.live,0);}};
}
test('large regional extraction uses the planned window frustum and preserves original camera aspect/jitter',()=>{
 const f=fixture();try{
  const candidates=f.system._resolveExtractionEntities(f.world,f.world.frameData,[f.right],f.entities,[],f.planned);
  assert.equal(f.system.lastSpatialIndexUsed,true);assert.equal(f.system.lastSpatialQueryCount,1);assert.equal(candidates.size,1);assert.ok(candidates.has(f.meshes[0]),'Off-center visible mesh was lost');assert.ok(!candidates.has(f.meshes[2]),'Window culling became a full-camera scan');
  assert.equal(f.cameraQueries,0,'Do not recompute or mutate a camera after frame planning');assert.deepEqual(f.source.viewProjectionMatrix,f.before.matrix);assert.deepEqual(f.source.projectionJitter,f.before.jitter);assert.equal(f.source.width,f.before.width);assert.equal(getSpatialIndexService(f.world).meshSyncCount,1);
 }finally{f.destroy();}
});
test('multiple planned windows and directional shadows share one spatial index without replacing their camera frames',()=>{
 const f=fixture();try{
  const candidates=f.system._resolveExtractionEntities(f.world,f.world.frameData,[f.right,f.left],f.entities,[new DirectionalLight({direction:[0,-1,0],shadow:{extent:20,far:100}})],f.planned);
  assert.equal(f.system.lastSpatialIndexUsed,true);assert.equal(f.system.lastSpatialQueryCount,3);assert.equal(f.system.lastSpatialShadowQueryCount,1);assert.ok(candidates.has(f.meshes[0])&&candidates.has(f.meshes[1])&&candidates.has(f.meshes[2]));assert.ok(candidates.size<10);assert.equal(f.cameraQueries,0);assert.equal(getSpatialIndexService(f.world).meshSyncCount,1);assert.deepEqual(f.source.viewProjectionMatrix,f.before.matrix);
 }finally{f.destroy();}
});
