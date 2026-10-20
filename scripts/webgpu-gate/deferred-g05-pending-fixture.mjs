import {GPUResourceTracker,createGPUResourceOwner,TransientRenderTargetPool,acquireTransientAttachments,releaseTransientAttachments,DeferredTileResources,planDeferredTiles,DeferredAmbientOcclusion,getDeferredAllocationBudget,planDeferredViewMemory,registerLightingAmbientOcclusion} from '../../artifacts/engine-0.2.1/g05/pending-runtime/fixture.js';
import {captureG05ResourceSnapshot} from './deferred-g05-memory-policy.mjs';
import {probeAoPacking} from './deferred-g05-ao-packing-probe.mjs';
import {validateG05PendingNative} from './deferred-g05-pending-policy.mjs';
const node=document.querySelector('#result'),check=(v,m)=>{if(!v)throw Error(m);};
let device,pool,tiles,tracker,owner,readback,aoOwner,aoReadback;
try{
 const config=await (await fetch('../../config/lighting-performance-021.json')).json();
 const query=new URLSearchParams(location.search),preference=query.get('powerPreference')??'high-performance',withAo=query.get('ao')==='1';
 const adapter=await navigator.gpu.requestAdapter({powerPreference:preference});check(adapter&&!adapter.info.isFallbackAdapter,'Native adapter required');
 device=await adapter.requestDevice();const validationErrors=[];device.addEventListener('uncapturederror',e=>validationErrors.push(e.error.message));device.pushErrorScope('validation');
 tracker=new GPUResourceTracker({debug:true});owner=createGPUResourceOwner('system','g05-native-pending');tracker.instrumentDevice(device,owner);
 const budget=getDeferredAllocationBudget(device);
 pool=new TransientRenderTargetPool({device,format:'rgba16float',width:1920,height:1080,defaults:{},getDepthFormat:()=> 'depth24plus'});tiles=new DeferredTileResources(device);
 const encoder=device.createCommandEncoder({label:'G05 pending generations'}),callbacks=[],context={device,encoder,afterSubmit:cb=>callbacks.push(cb)};
 const module=device.createShaderModule({label:'G05 pending tile sentinel',code:'@group(0) @binding(0) var<storage,read_write> values:array<u32>; @compute @workgroup_size(1) fn main(){values[0]=123u;}'});
 const pipeline=await device.createComputePipelineAsync({label:'G05 pending tile sentinel',layout:'auto',compute:{module,entryPoint:'main'}});
 readback=device.createBuffer({label:'G05 pending readback',size:4096,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
 const source={value:.25};let aoPipeline;
 if(withAo){
  aoOwner=new DeferredAmbientOcclusion(device);
  registerLightingAmbientOcclusion(source,{composite:()=>true,create:()=>({prepare(d,format){this.device=d;this.format=format;},setSceneTextures(){},destroy(){},apply(encoder,_src,view){
   const module=this.device.createShaderModule({code:`@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{let p=array<vec2<f32>,3>(vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));return vec4(p[i],0.,1.);} @fragment fn fs()->@location(0) vec4<f32>{return vec4(${this.value},0.,0.,1.);}`});
   const pipeline=this.device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:this.format}]}});
   const pass=encoder.beginRenderPass({colorAttachments:[{view,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});pass.setPipeline(pipeline);pass.draw(3);pass.end();
  }}),configure(pass){pass.value=source.value;}});
  const include=await (await fetch('../../shader-language/src/deferred-lighting/lighting-ao.wgslinc')).text();
  const module=device.createShaderModule({code:include.replace('@group(3)','@group(0)').replace('__BINDING__','0')+'\n@group(0) @binding(1) var<storage,read_write> result:array<f32>; @compute @workgroup_size(1) fn main(){result[0]=lightingAmbientVisibility(vec2(.5,.5));result[1]=lightingAmbientVisibility(vec2(f32(lightingAo[0])-.5,f32(lightingAo[1])-.5));}'});
  aoPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  aoReadback=device.createBuffer({label:'G05 AO probe output',size:8,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
 }
 const dimensions=[[1904,1072],[1920,1080]],formats=['rgba16float','rgba16float','rgba16float','depth32float'];
 for(const [generation,[width,height]]of dimensions.entries())for(let view=0;view<4;view++){
  document.querySelector('#progress').textContent=`Generation ${generation}, view ${view}`;
  const memory=withAo?planDeferredViewMemory(width,height,1):undefined,plan=planDeferredTiles(device,width,height,{},memory);check(plan.viewBytes<=config.memory.maxDeferredBytesPerViewGeneration,'View generation over budget');
  const attachments=acquireTransientAttachments(pool,`view:${view}`,width,height,formats,context,{maxViews:4,maxLiveGenerations:2,reserveBytes:n=>budget.reserve(n)});
  const binding=tiles.acquire(`view:${view}`,plan,context);
  const pass=encoder.beginRenderPass({colorAttachments:attachments.views.slice(0,3).map(v=>({view:v,loadOp:'clear',storeOp:'store',clearValue:[.25,.5,.75,1]})),depthStencilAttachment:{view:attachments.views[3],depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1}});pass.end();
  const compute=encoder.beginComputePass();compute.setPipeline(pipeline);compute.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:binding}]}));compute.dispatchWorkgroups(1);compute.end();
  const offset=(generation*4+view)*512;
  encoder.copyTextureToBuffer({texture:attachments.textures[0]},{buffer:readback,offset,bytesPerRow:256},[1,1]);encoder.copyBufferToBuffer(binding.buffer,0,readback,offset+256,4);
  if(withAo){
   source.value=.25+generation*.25+view/16;
   const visibility=aoOwner.record(context,`view:${view}`,width,height,{passes:[source],prepare:()=>({normal:attachments.textures[1],depth:attachments.textures[3],frame:{}})});
   const group=device.createBindGroup({layout:aoPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:visibility},{binding:1,resource:{buffer:aoReadback}}]});
   const pass=encoder.beginComputePass();pass.setPipeline(aoPipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(aoReadback,0,readback,offset+260,8);
  }
 }
 const budgetAtPeak=budget.bytes;
 const pending=captureG05ResourceSnapshot(tracker),before=tracker.getDebugSnapshot().byType,capacityFailures=[];
 function reject(reason,fn){try{fn();throw Error('Expected capacity rejection');}catch(error){check(error.reason===reason,`Wrong rejection: ${error}`);capacityFailures.push(reason);}}
 reject('live-target-generations',()=>acquireTransientAttachments(pool,'view:0',1920,1079,formats,context,{maxViews:4,maxLiveGenerations:2}));
 reject('tile-live-generations',()=>tiles.acquire('view:0',planDeferredTiles(device,1936,1080),context));
 reject('view-count',()=>acquireTransientAttachments(pool,'view:4',1920,1080,formats,context,{maxViews:4,maxLiveGenerations:2}));
 reject('tile-view-count',()=>tiles.acquire('view:4',planDeferredTiles(device,1920,1080),context));
 const competingPool=new TransientRenderTargetPool({device});
 reject('deferred-target-bytes',()=>acquireTransientAttachments(competingPool,'competing-profile',1920,1080,formats,context,{maxViews:4,maxLiveGenerations:2,reserveBytes:n=>budget.reserve(n)}));competingPool.destroy();
 const after=tracker.getDebugSnapshot().byType,newResourcesOnRejectedRequests=['buffer','texture'].reduce((n,k)=>n+after[k].created-before[k].created,0);
 pool.destroy();tiles.destroy();aoOwner?.destroy();const heldBeforeSubmission=captureG05ResourceSnapshot(tracker);
 device.queue.submit([encoder.finish()]);for(const callback of callbacks)callback(device.queue);await device.queue.onSubmittedWorkDone();await Promise.resolve();
 await readback.mapAsync(GPUMapMode.READ);const data=readback.getMappedRange(),readbacks=[];
 for(let i=0;i<8;i++)readbacks.push({generation:Math.floor(i/4),view:i%4,rgba16:[...new Uint16Array(data,i*512,4)],tileValue:new Uint32Array(data,i*512+256,1)[0],...(withAo?{aoValues:[...new Float32Array(data,i*512+260,2)]}:{})});
 readback.unmap();readback.destroy();readback=null;aoReadback?.destroy();aoReadback=null;const packingProbe=withAo?await probeAoPacking(device):undefined;const afterCompletion=captureG05ResourceSnapshot(tracker);
 const error=await device.popErrorScope();if(error)validationErrors.push(error.message);device.destroy();await device.lost;
 const result={schemaVersion:1,suite:'g05-native-pending-memory',status:'passed',performanceQualified:false,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},withAo,packingProbe,budgetAtPeak,budgetAfterCompletion:budget.bytes,dimensions,views:4,pending,heldBeforeSubmission,capacityFailures,newResourcesOnRejectedRequests,readbacks,afterCompletion,deviceDestroyed:true,validationErrors};
 validateG05PendingNative(result,config);node.textContent=JSON.stringify(result);node.dataset.status='passed';
}catch(error){node.textContent=JSON.stringify({schemaVersion:1,status:'failed',error:error.stack??String(error)});node.dataset.status='failed';}
finally{if(pool){pool.destroy();releaseTransientAttachments(pool,true);}tiles?.destroy(true);aoOwner?.destroy(true);aoReadback?.destroy();readback?.destroy();if(tracker&&owner)tracker.releaseOwner(owner);device?.destroy();}
