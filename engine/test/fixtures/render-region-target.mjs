import {RenderFrameContext,FrameDiagnostics,GPUResourceTracker,createGPUResourceOwner} from '/engine/dist/experimental.js';
import {RegionColorTarget} from '/region-target-build/region-target.js';
import {getRegionCacheBudget} from '/region-target-build/region-budget.js';
import {SceneOutputPass} from '/region-target-build/region-copy.js';
const result=document.querySelector('#result'),progress=document.querySelector('#progress');
const check=(v,m)=>{if(!v)throw Error(m)},hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),n=>n.toString(16).padStart(2,'0')).join('');
let device,output,copy;const live=new Set(),errors=[],cases=[];let summary;
try{
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});check(adapter&&!adapter.info.isFallbackAdapter,'Native WebGPU adapter is required');device=await adapter.requestDevice();device.pushErrorScope('validation');device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 const diagnostics=new FrameDiagnostics({enabled:true}),tracker=new GPUResourceTracker({debug:true,frameDiagnostics:diagnostics});tracker.instrumentDevice(device,createGPUResourceOwner('system','g04-native-target'));
 output=device.createTexture({label:'G04 verification destination',size:[32,16],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
 const engine={device,format:'rgba8unorm',width:32,height:16,displayWidth:32,displayHeight:16,msaaSamples:1,reverseZ:false,clearColor:{r:0,g:0,b:0,a:0},getDepthFormat:()=> 'depth24plus',getRenderPassDescriptor:()=>({colorAttachments:[{view:output.createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:0}}]})};
 copy=new SceneOutputPass();copy.prepare(device);copy.configure('rgba8unorm',1,'none');let frames=0;
 const capture=async(target,id,clearColor,expected)=>{
  diagnostics.beginFrame(++frames);const context=new RenderFrameContext(engine),start=performance.now();
  if(clearColor){const descriptor=target.updateDescriptor(true);descriptor.colorAttachments[0].clearValue=clearColor;context.beginPass(descriptor);context.endPass();target.encoded(context)}
  copy.setSceneTextures({frame:{frameId:frames,viewKey:'region-target'}});copy.apply(context.encoder,target.sample(context),output.createView(),device);
  const read=device.createBuffer({label:'G04 readback',size:256*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});context.encoder.copyTextureToBuffer({texture:output},{buffer:read,bytesPerRow:256},[32,16]);const cpuMs=performance.now()-start;context.submit();
  const wait=performance.now();await read.mapAsync(GPUMapMode.READ);const queueAndReadbackWaitMs=performance.now()-wait,raw=new Uint8Array(read.getMappedRange()).slice();read.unmap();read.destroy();const pixels=new Uint8Array(32*16*4);
  for(let y=0;y<16;y++)pixels.set(raw.subarray(y*256,y*256+32*4),y*32*4);
  for(let p=0;p<pixels.length;p++)check(pixels[p]===expected[p%4],id+' native pixels differ at '+p+': '+pixels[p]);
  cases.push({id,sha256:await hash(pixels),contentGeneration:target.contentGeneration,producerPasses:clearColor?1:0,compositionDraws:diagnostics.snapshot().counters.draws,cpuMs,queueAndReadbackWaitMs});
 };
 for(const samples of [1,4]){
  progress.textContent='Retained target MSAA '+samples;
  const spec={width:32,height:16,displayWidth:32,displayHeight:16,format:'rgba16float',sampleCount:samples,depthConvention:'standard'};
  const attempt=RegionColorTarget.create(engine,'native-'+samples,spec);check(attempt.accepted,'Target allocation was rejected');const target=attempt.target;live.add(target);
  check(target.colorBytes===32*16*8*(samples===4?5:1),'MSAA colors missing from retained-byte accounting');
  await capture(target,'initialize-'+samples,{r:0,g:0,b:0,a:0},[0,0,0,0]);
  await capture(target,'update-'+samples,{r:1,g:0,b:0,a:1},[255,0,0,255]);const generation=target.contentGeneration;
  await capture(target,'sample-only-'+samples,null,[255,0,0,255]);check(target.contentGeneration===generation,'Sampling incorrectly advanced content generation');
  target.retire();live.delete(target);await device.queue.onSubmittedWorkDone();await Promise.resolve();
  const cancelled=RegionColorTarget.create(engine,'cancelled-'+samples,spec).target;live.add(cancelled);const context=new RenderFrameContext(engine);context.beginPass(cancelled.updateDescriptor(true));context.endPass();cancelled.encoded(context);
  const before=tracker.getDebugSnapshot().byType.texture.current;cancelled.retire();check(tracker.getDebugSnapshot().byType.texture.current===before,'Unsubmitted target was destroyed too early');context.cancel();live.delete(cancelled);
  check(getRegionCacheBudget(device).snapshot().retainedBytes===0,'Cancelled target retained its color budget');cases.push({id:'cancel-'+samples,sourceTextures:before-tracker.getDebugSnapshot().byType.texture.current,presentations:0});
 }
 copy.destroy();copy=null;output.destroy();output=null;await device.queue.onSubmittedWorkDone();await Promise.resolve();const residue=tracker.getDebugSnapshot().byType;
 check((residue.buffer?.current??0)===0&&(residue.texture?.current??0)===0,'Region verification retained owned GPU allocations');const validation=await device.popErrorScope();check(!validation,'Validation: '+validation?.message);check(!errors.length,'Uncaptured validation errors');
 summary={status:'passed',caseCount:cases.length,cases,residue,errors,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter},gpuDuration:{status:'not-measured'},qualification:'Native retained RTT allocation/initialization/resolve/sampling/retirement only; GUI composition, demand scheduling and production performance remain pending'};
}catch(error){summary={status:'failed',error:String(error.stack??error),cases,errors}}
finally{for(const target of live)target.abandon();copy?.destroy();output?.destroy();device?.destroy()}
result.textContent=JSON.stringify(summary);result.dataset.status=summary.status;
