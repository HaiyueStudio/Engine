import {createRealRendererBenchmarkScenario,runRealRendererBenchmarkFrame,destroyRealRendererBenchmarkScenario,createAuditTarget,resetRealRendererBenchmarkMetrics,Entity,Transform3D,Camera3D,RenderView,Mesh3D,Geometry3D,PbrMaterial,PointLight,createDeferredReferenceProfile,TaaPass,GtaoPass,AmbientLight} from '../../artifacts/engine-0.2.1/g04/fixture.js';
import {readFloatTexture} from './float-texture-readback.mjs';
const check=(v,m)=>{if(!v)throw Error(m);};
export async function runG04Lifecycle(device){
 const targets=Array.from({length:8},(_,i)=>createAuditTarget(device,i%2?48:32,i%2?32:48,true));let state,result,failure;
 try{
  state=await createRealRendererBenchmarkScenario({device,target:targets[0],entityCount:0,renderProfile:'batched'});
  for(const e of [...state.world.entities.values()])state.world.removeEntity(e);
  state.render3d.passes.length=0;const taa=new TaaPass({jitterScale:0,sharpness:0});state.render3d.passes.push(new GtaoPass({radius:2,intensity:3}),taa);
  state.world.add(new Entity('ao-ambient').addComponent(new AmbientLight({intensity:.4}))); 
  const geometry=new Geometry3D({positions:new Float32Array([-2,-2,0,2,-2,0,2,2,0,-2,2,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),indices:new Uint32Array([0,1,2,0,2,3])});
  const base=new Entity('base').addComponent(new Transform3D()).addComponent(new Mesh3D(geometry,new PbrMaterial({baseColor:[.3,.5,.2,1],emissiveFactor:[.03,.05,.02],roughness:.5,metallic:0})));state.world.add(base);
  const front=new Entity('proxy').addComponent(new Transform3D().setTranslation(1,0,.1)).addComponent(new Mesh3D(geometry,new PbrMaterial({baseColor:[.2,.3,.6,1],clearcoatFactor:.5,roughness:.4,metallic:0})));state.world.add(front);
  const glass=new Entity('glass').addComponent(new Transform3D().setTranslation(-1,0,.2)).addComponent(new Mesh3D(geometry,new PbrMaterial({baseColor:[.7,.1,.1,.4],alphaMode:'blend'})));state.world.add(glass);
  for(let i=0;i<9;i++)state.world.add(new Entity(`light:${i}`).addComponent(new Transform3D().setTranslation((i%3)-1,Math.floor(i/3)-1,2)).addComponent(new PointLight({intensity:.15,range:6})));
  const cameras=Array.from({length:4},(_,i)=>new Entity(`lifecycle-camera:${i}`).addComponent(new Transform3D().setTranslation(0,0,4)).addComponent(new Camera3D(i%2?{near:.2+i*.1,far:20+i*10}:{type:'orthographic',left:-2,right:2,bottom:-2,top:2,near:.1,far:20})));
  for(const camera of cameras)state.world.add(camera);state.render3d.checkEntityManager(state.world);
  const configure=(step)=>{const phase=step%6;state.views=Array.from({length:phase===4?3:4},(_,i)=>{const target=targets[i*2+(phase%2)];target.displayWidth=target.width/(phase%2?2:1);target.displayHeight=target.height/(phase%2?2:1);return new RenderView({key:`lifecycle:${i}`,target,camera:cameras[i],depthConvention:i===3?'reverse':'standard',excludedEntityIds:i%2?new Set([glass.id]):null,viewport:phase===2?{x:4,y:4,width:target.width-8,height:target.height-8,minDepth:.1,maxDepth:.9}:null}).snapshot();});};
  const references=new Map(),samples=[],allocations=[],resourceSamples=[];let backend,profileChanges=0;
  async function activate(tiled){backend=(await createDeferredReferenceProfile(state.render3d,state.engine,tiled?{tiled:{forceCulling:true}}:{})).backend;profileChanges++;resetRealRendererBenchmarkMetrics(state);}
  resetRealRendererBenchmarkMetrics(state);
  // Freeze current-source reference images for every lifecycle state after temporal reset.
  await activate(false);
  for(let step=0;step<6;step++){configure(step);taa.resetHistory();await runRealRendererBenchmarkFrame(state);for(const view of state.views)references.set(`${step}/${view.key}`,await readFloatTexture(device,view.target.colorTexture));}
  // Prime two complete Reference/Tiled cycles, including both resize generations and all post surfaces.
  for(let step=0;step<24;step++){if(step%6===0)await activate(Math.floor(step/6)%2===0);configure(step);taa.resetHistory();await runRealRendererBenchmarkFrame(state);}
  for(let step=0;step<312;step++){
   if(step%6===0)await activate(Math.floor(step/6)%2===0);
   configure(step);taa.resetHistory();await runRealRendererBenchmarkFrame(state);
   check(backend.diagnostics.completeCoverage,`fallback at switch ${step}`);
   check(taa.stats.historyCount===4,`unexpected history count at ${step}: ${taa.stats.historyCount}`);
   // GPU completion callbacks retire earlier generations asynchronously. Sample a settled owner,
   // retaining the immediate count separately so transient retirement is not hidden.
   const pending=state.tracker.getDebugSnapshot().byType;
   await device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,0));
   const resources=state.tracker.getDebugSnapshot().byType;
   allocations.push({step,pendingTextures:pending.texture?.current??0,views:state.views.length,profile:backend.diagnostics.requested,buffers:resources.buffer?.current??0,textures:resources.texture?.current??0,bufferBytes:resources.buffer?.estimatedBytes??0,textureBytes:resources.texture?.estimatedBytes??0});
   if([11,23,47,95,155,311].includes(step))resourceSamples.push({step,resources:state.tracker.getDebugSnapshot().resources.filter(r=>r.type==='buffer').map(r=>({label:r.label,bytes:r.estimatedBytes}))});
   if(step<6||step>=306){for(const view of state.views){const actual=await readFloatTexture(device,view.target.colorTexture),expected=references.get(`${step%6}/${view.key}`);let maxDelta=0,lit=0;for(let i=0;i<actual.length;i++){const d=Math.abs(actual[i]-expected[i]);maxDelta=Math.max(maxDelta,d);check(Number.isFinite(d)&&d<=3/255,`view contamination ${step}/${view.key}/${i}: ${d}`);if(i%4===0&&actual[i]+actual[i+1]+actual[i+2]>.03)lit++;}check(lit>50,'invisible lifecycle scene');samples.push({step,key:view.key,maxDelta,lit,width:view.width,height:view.height,dpr:view.target.width/view.target.displayWidth});}}
   document.querySelector('#progress').textContent=`G04 native lifecycle ${step+1}/312`;
  }
  const highWater={};for(const key of ['buffers','textures','bufferBytes','textureBytes']){const warm=Math.max(...allocations.slice(0,12).map(s=>s[key])),later=Math.max(...allocations.slice(12).map(s=>s[key]));check(later<=warm,`unbounded ${key}: ${warm} -> ${later}; resources=${JSON.stringify(resourceSamples)}; allocations=${JSON.stringify(allocations)}`);highWater[key]={warm,later};}
  // TAA deliberately retains temporarily inactive views for 120 frames. Verify actual expiry.
  state.views=state.views.slice(0,1);
  for(let i=0;i<121;i++)await runRealRendererBenchmarkFrame(state);
  check(taa.stats.historyCount===1,`expired view histories leaked: ${taa.stats.historyCount}`);
  result={lightingAo:true,switches:312,profileChanges,warmupSwitches:24,allocations,highWater,samples,viewRetirement:{graceFrames:120,frames:121,remainingHistories:taa.stats.historyCount}};return result;
 }catch(error){failure=error;throw error;}finally{if(state){try{await destroyRealRendererBenchmarkScenario(state);}catch(error){if(!failure)throw error;failure.stack+=`\nCleanup: ${error.stack}`;}if(result)result.cleanup={ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources};}for(const target of targets)target.destroy();}
}
