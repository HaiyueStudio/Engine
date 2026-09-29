import {createRealRendererBenchmarkScenario,runRealRendererBenchmarkFrame,destroyRealRendererBenchmarkScenario,createAuditTarget,resetRealRendererBenchmarkMetrics,getRealRendererBenchmarkMetrics,createRealRendererGpuTimestampProbe,InstancedMesh3DRenderer,InstancedToonMaterial,GpuInstanceLod,createSphere3D} from '../../artifacts/engine-0.2.1/g05/fixture.js';
import {createG05InstanceData,createG05InstanceView,classifyG05Instances,verifyG05InstanceIds,G05_INSTANCE_VARIANTS} from './deferred-g05-instance-policy.mjs';
import {verifyInstancePoseNormals} from './deferred-g05-instance-oracle.mjs';
import {readFloatTexture} from './float-texture-readback.mjs';
const node=document.querySelector('#result'),progress=document.querySelector('#progress');
try{node.textContent=JSON.stringify(await run());node.dataset.status='passed';}catch(error){node.textContent=JSON.stringify({status:'failed',error:error.stack??String(error)});node.dataset.status='failed';}
async function readWords(device,source,offset,size){
 const buffer=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
 try{const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(source,offset,buffer,0,size);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);const values=new Uint32Array(buffer.getMappedRange().slice(0));buffer.unmap();return values;}finally{buffer.destroy();}
}
async function run(){
 const q=new URLSearchParams(location.search),count=Number(q.get('count')),views=Number(q.get('views')),variant=q.get('variant'),full=q.get('full')==='1';
 if(![1000,10000].includes(count)||![1,4].includes(views)||!G05_INSTANCE_VARIANTS.includes(variant))throw Error('Invalid instance fixture');
 const warmup=full?120:2,samples=full?300:3,adapter=await navigator.gpu.requestAdapter({powerPreference:q.get('powerPreference')??'high-performance'});
 if(!adapter||adapter.info.isFallbackAdapter||!adapter.features.has('timestamp-query'))throw Error('Native timestamp GPU required');
 const device=await adapter.requestDevice({requiredFeatures:['timestamp-query']}),errors=[],buffers=[];
 device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
 const targets=Array.from({length:views},()=>createAuditTarget(device,1280,720,true));let state,renderer,probe,result,failure;const classifiers=[];
 const buffer=(data,usage)=>{const b=device.createBuffer({size:Math.max(4,data.byteLength),usage:usage|GPUBufferUsage.COPY_DST});buffers.push(b);if(data.byteLength)device.queue.writeBuffer(b,0,data);return b;};
 try{
  const coldStart=performance.now();state=await createRealRendererBenchmarkScenario({device,target:targets[0],entityCount:0,viewCount:views,renderProfile:'batched'});
  for(const entity of [...state.world.entities.values()])state.world.removeEntity(entity);
  const data=createG05InstanceData(count),transforms=buffer(data.matrices,GPUBufferUsage.STORAGE),colors=buffer(data.colors,GPUBufferUsage.STORAGE),allIds=buffer(Uint32Array.from({length:count},(_,id)=>id),GPUBufferUsage.STORAGE);
  const geometries=[[12,6],[8,4],[4,2]].map(([widthSegments,heightSegments])=>createSphere3D({radius:.5,widthSegments,heightSegments}));
  const material=new InstancedToonMaterial(1);renderer=new InstancedMesh3DRenderer();renderer.prepare(state.engine);
  renderer.updateLighting([{type:1,color:[1,1,1],intensity:1,direction:[-.3,-.6,-1],position:[0,0,0],range:1}],null,1);
  const useLod=variant.startsWith('lod-'),cameras=Array.from({length:views},(_,i)=>createG05InstanceView(i,variant==='frustum-rejected',useLod));
  const expected=cameras.map(view=>classifyG05Instances(data.matrices,view));
  const direct={device,transforms,colors,visibleIndices:allIds,capacity:count,count};
  const oracles=expected.map(buckets=>buckets.map(ids=>({device,transforms,colors,visibleIndices:buffer(Uint32Array.from({length:count},(_,i)=>ids[i]??0),GPUBufferUsage.STORAGE),capacity:count,count:ids.length})));
  const commands=cameras.map(()=>geometries.map(g=>buffer(new Uint32Array([g.indices.length,0,0,0,0]),GPUBufferUsage.INDIRECT)));
  const sources=cameras.map(()=>{const lod=new GpuInstanceLod(state.engine,count);classifiers.push(lod);return geometries.map((_,i)=>lod.source(i,transforms,colors));});
  const snapshots=cameras.map((v,i)=>{const packed=new Float32Array(68);packed.set(v.viewProjection);packed.set(v.viewMatrix,16);packed.set(v.projection,32);packed.set([0,0,2,1,1280,720,1/1280,1/720],48);return {frameId:0,phaseRevision:0,cameraEntityId:i+1,data:packed};});
  let mode='gpu';
  state.render3d.record=(_world,context)=>{
   for(let view=0;view<views;view++){
    const classified=mode==='gpu';if(classified){classifiers[view].encode(context,transforms,count,cameras[view]);for(let level=0;level<3;level++)classifiers[view].encodeDrawCount(context,level,commands[view][level]);}
    snapshots[view].frameId=state.frameId;renderer.updateCamera(snapshots[view],context);
    const pass=context.encoder.beginRenderPass({...targets[view].getRenderPassDescriptor(),label:`G05.instances.view:${view}`});
    if(mode==='all')renderer.render(pass,1,geometries[0],material,{externalInstances:direct});
    else for(let level=0;level<3;level++){
     const source=mode==='oracle'?oracles[view][level]:sources[view][level];
     if(mode==='oracle'&&source.count===0)continue;
     const geometry=useLod?geometries[level]:geometries[0],command=commands[view][level];
     renderer.render(pass,level+1,geometry,material,{externalInstances:source,...(classified?{indirect:true,externalIndirect:{indexedIndirectBuffer:command,indexedIndirectOffset:0,drawIndirectBuffer:command,drawIndirectOffset:0}}:{})});
    }pass.end();
   }
  };
  // Frustum-only classification sends every surviving instance to tier zero.
  const candidateMode=variant==='lod-off'?'all':'gpu',referenceMode=variant==='lod-off'?'gpu':'all';
  mode=candidateMode;await runRealRendererBenchmarkFrame(state);const cold={setupAndFirstFrameMs:performance.now()-coldStart,firstFrame:{...state.lastFrameTiming}};
  probe=createRealRendererGpuTimestampProbe(state,{includeCompute:true});const paths=[];
  for(const [path,pathMode]of [['candidate',candidateMode],['reference',referenceMode]]){
   mode=pathMode;for(let i=0;i<warmup;i++)await runRealRendererBenchmarkFrame(state);
   resetRealRendererBenchmarkMetrics(state);const cpu=[],resourcesBefore=state.tracker.getDebugSnapshot().byType;
   for(let frame=0;frame<samples;frame++){progress.textContent=`${count}/${views}/${variant}/${path} CPU ${frame+1}/${samples}`;await runRealRendererBenchmarkFrame(state);const t=state.lastFrameTiming;if(t.gpuTimestamp!==null)throw Error('CPU timestamps enabled');cpu.push({frame,timestampQuery:false,cpuRuntimeMs:t.runtimeFrameMs,cpuRecordMs:t.cpuRecordMs,cpuSubmitMs:t.cpuSubmitMs,queueWaitMs:t.queueWaitMs,frameWallMs:t.sampleWallMs});}
   const metrics=getRealRendererBenchmarkMetrics(state),resources=state.tracker.getDebugSnapshot().byType;
   for(let i=0;i<warmup;i++)await runRealRendererBenchmarkFrame(state,{gpuTimestampProbe:probe});resetRealRendererBenchmarkMetrics(state);const gpu=[];
   for(let frame=0;frame<samples;frame++){progress.textContent=`${count}/${views}/${variant}/${path} GPU ${frame+1}/${samples}`;await runRealRendererBenchmarkFrame(state,{gpuTimestampProbe:probe});const t=state.lastFrameTiming.gpuTimestamp;if(t.scope!=='render-and-compute-span-v1')throw Error('Missing GPU scope');gpu.push({frame,gpuSpanMs:t.spanMs,gpuPassSumMs:t.totalMs,passes:t.passes});}
   paths.push({path,mode:pathMode,quality:pathMode==='all'?'all-high':useLod?'three-geometry-tiers':'all-high',cpu,gpu,metrics,gpuMetrics:getRealRendererBenchmarkMetrics(state),resourcesBefore,resources});
  }
  // Only diagnostics below perform ID or pixel readback.
  mode='gpu';await runRealRendererBenchmarkFrame(state);const ids=[];
  for(let view=0;view<views;view++){
   const lod=classifiers[view],counts=await readWords(device,lod.counts,0,12),actual=[];
   for(let level=0;level<3;level++)actual.push(counts[level]?[...await readWords(device,lod.visibleIndices,level*lod.strideBytes,counts[level]*4)]:[]);
   ids.push({view,...verifyG05InstanceIds(actual,expected[view],count)});
  }
  const actual=[];for(const target of targets)actual.push(await readFloatTexture(device,target.colorTexture));
  const pixelReference=variant.startsWith('frustum-')?'unculled-all-high':'cpu-lod-buckets';
  mode=variant.startsWith('frustum-')?'all':'oracle';await runRealRendererBenchmarkFrame(state);const pixels=[];
  for(let view=0;view<views;view++){
   const expectedPixels=await readFloatTexture(device,targets[view].colorTexture);let maxDelta=0,litPixels=0;
   for(let i=0;i<expectedPixels.length;i++){const delta=Math.abs(actual[view][i]-expectedPixels[i]);if(!Number.isFinite(delta)||delta>1/255+1e-6)throw Error(`Instance pixel ${view}/${i} differs ${delta}`);maxDelta=Math.max(maxDelta,delta);if(i%4===0&&actual[view][i]+actual[view][i+1]+actual[view][i+2]>.01)litPixels++;}
   if(!litPixels)throw Error('Invisible instances');pixels.push({view,maxDelta,litPixels});
  }
  const poseNormals=await verifyInstancePoseNormals({state,renderer,material,target:targets[0]});
  const validation=await device.popErrorScope();if(validation)errors.push(validation.message);if(errors.length)throw Error(errors.join('\n'));
  result={schemaVersion:1,status:'passed',suite:'g05-instances',count,views,variant,width:1280,height:720,warmup,samples,cold,paths,ids,pixels,pixelReference,poseNormals,
   geometryTiers:geometries.map(g=>({triangles:g.indices.length/3,vertices:g.positions.length/3})),normalFrameInstanceReadbackBytes:0,
   scope:'Paired instance diagnostic; LOD is a quality change. CPU ID/pixel oracle verifies visible buckets, independent CPU baked pose/normal oracle verified; full cohorts remain required.',
   adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},browser:navigator.userAgent,validationErrors:errors};return result;
 }catch(error){failure=error;throw error;}
 finally{
  try{probe?.destroy();renderer?.destroy();for(const lod of classifiers)lod.destroy();for(const b of buffers)b.destroy();if(state){await destroyRealRendererBenchmarkScenario(state);if(result)result.cleanup={ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources};}}
  catch(error){if(!failure)throw error;failure.stack+=`\nCleanup: ${error.stack}`;}
  finally{for(const target of targets)target.destroy();device.destroy();}
 }
}
