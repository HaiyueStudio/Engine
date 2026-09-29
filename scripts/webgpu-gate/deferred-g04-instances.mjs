import {createRealRendererBenchmarkScenario,runRealRendererBenchmarkFrame,destroyRealRendererBenchmarkScenario,createAuditTarget,resetRealRendererBenchmarkMetrics,Entity,Transform3D,Camera3D,RenderView,Mesh3D,Geometry3D,PbrMaterial,PointLight,createDeferredReferenceProfile,InstancedMesh3D,InstancedMesh3DRenderSystem,InstancedPbrMaterial} from '../../artifacts/engine-0.2.1/g04/fixture.js';
import {readFloatTexture} from './float-texture-readback.mjs';
const check=(v,m)=>{if(!v)throw Error(m);};
export async function runG04Instances(device){
 const target=createAuditTarget(device,64,64,true),buffers=[];let state,result,failure;
 try{
 state=await createRealRendererBenchmarkScenario({device,target,entityCount:0,renderProfile:'batched'});for(const e of [...state.world.entities.values()])state.world.removeEntity(e);state.render3d.passes.length=0;
 const camera=new Entity('instance-camera').addComponent(new Transform3D().setTranslation(0,0,3)).addComponent(new Camera3D({type:'orthographic',left:-1.5,right:1.5,bottom:-1.5,top:1.5,near:.1,far:10}));state.world.add(camera);state.views=[new RenderView({key:'instances',camera,target}).snapshot()];
 const geometry=new Geometry3D({positions:new Float32Array([-.35,-.4,0,.35,-.4,0,0,.4,0]),normals:new Float32Array([.6,.3,.74162,.6,.3,.74162,.6,.3,.74162]),cullMode:'none'});
 const material=new InstancedPbrMaterial(4,{metallic:0,roughness:.6}),colors=[[1,.05,.05,1],[.05,1,.05,1],[.05,.05,1,1],[1,1,.05,1]],matrices=[];
 for(let i=0;i<4;i++){const matrix=new Float32Array([i%2?-1.4:1.4,0,0,0,0,.7,0,0,0,0,1,0,i%2?.65:-.65,i<2?.65:-.65,.2,1]);matrices.push(matrix);material.setTransform(i,matrix);material.setColor(i,...colors[i]);}
 const object=new Entity('instances').addComponent(new InstancedMesh3D(geometry,material));state.world.add(object);
 // A regular surface ensures the complete-view guard is exercised alongside its separate instance system.
 state.world.add(new Entity('ordinary-pbr').addComponent(new Transform3D().setTranslation(0,0,-1)).addComponent(new Mesh3D(geometry,new PbrMaterial({emissiveFactor:[.04,.04,.04]}))));
 for(let i=0;i<9;i++)state.world.add(new Entity(`instance-light:${i}`).addComponent(new Transform3D().setTranslation(0,0,2)).addComponent(new PointLight({range:8,intensity:.05})));
 const instances=new InstancedMesh3DRenderSystem(state.engine,camera,{loadOp:'load'});state.world.addSystem(instances);instances.checkEntityManager(state.world);state.render3d.checkEntityManager(state.world);
 const record=state.render3d.record.bind(state.render3d);state.render3d.record=(world,context)=>{record(world,context);context.endPass();context.view=state.views[0];context.descriptor=undefined;context.loadOp='load';instances.record(world,context);context.endPass();};
 resetRealRendererBenchmarkMetrics(state);await runRealRendererBenchmarkFrame(state);const baseline=await readFloatTexture(device,target.colorTexture);
 const source={device,capacity:4,count:4};for(const [key,data] of [['transforms',new Float32Array(matrices.flatMap(m=>Array.from(m)))],['colors',new Float32Array(colors.flat())],['visibleIndices',new Uint32Array([3,1,0,2])]]){const buffer=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(buffer,0,data);buffers.push(buffer);source[key]=buffer;}
 const draw=instances.renderer.render.bind(instances.renderer);let external=false;instances.renderer.render=(pass,id,g,m,options)=>draw(pass,id,g,m,external?{...options,externalInstances:source}:options);
 const cases=[];
 for(const algorithm of ['reference','tiled'])for(const stream of ['cpu','external-gpu']){
  external=stream==='external-gpu';const profile=await createDeferredReferenceProfile(state.render3d,state.engine,{failurePolicy:'forward',...(algorithm==='tiled'?{tiled:{forceCulling:true}}:{})});resetRealRendererBenchmarkMetrics(state);await runRealRendererBenchmarkFrame(state);
  const image=await readFloatTexture(device,target.colorTexture);let maxDelta=0;for(let i=0;i<image.length;i++){const delta=Math.abs(image[i]-baseline[i]);maxDelta=Math.max(maxDelta,delta);check(Number.isFinite(delta)&&delta<=1/255+1e-5,`instance identity/normal mismatch ${algorithm}/${stream}/${i}: ${delta}`);}
  const d=profile.backend.diagnostics;check(d.effective==='forward'&&!d.completeCoverage&&d.reason==='unsupported-instance-surface','instance full coverage was falsely reported');
  const probes=[];for(let id=0;id<4;id++){const x=id%2?46:18,y=id<2?18:46,offset=(y*64+x)*4,pixel=Array.from(image.slice(offset,offset+4));check(pixel.some((v,i)=>i<3&&v>.02),`invisible instance ${id}`);probes.push({id,pixel,mirrored:id%2===1});}
  cases.push({algorithm,stream,maxDelta,diagnostics:{...d},probes});
 }
 result={cases,authoredLights:9,coverage:'explicit-whole-view-forward',externalVisibleIds:[3,1,0,2]};return result;
 }catch(error){failure=error;throw error;}finally{if(state){try{await destroyRealRendererBenchmarkScenario(state);}catch(error){if(!failure)throw error;failure.stack+=`\nCleanup: ${error.stack}`;}if(result)result.cleanup={ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources};}for(const buffer of buffers)buffer.destroy();target.destroy();}
}
