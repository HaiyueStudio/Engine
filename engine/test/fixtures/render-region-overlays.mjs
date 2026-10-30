import {RenderPipeline,RenderView,RenderFrameContext,Entity,World,FrameDiagnostics,GPUResourceTracker,createGPUResourceOwner,Render3DSystem,disposeSceneFrameGpuArena,Camera3D,CartesianTransform3D,Mesh3D,BasicMaterial,createBox3D,ColorLinear} from '/engine/dist/experimental.js';
import {RttEngine} from '/engine/dist/rtt.js';
import {SceneOutputPass} from '/region-target-build/region-copy.js';
import {GuiRoot,GuiElement,GuiLabel,GuiSystem,GuiSelect,GuiModal,GuiToast} from '/engine/dist/gui.js';

const width=384,height=240,sidebar=96,result=document.querySelector('#result'),progress=document.querySelector('#progress'),cases=[],errors=[],live=new Set();
const check=(v,m)=>{if(!v)throw Error(m)},hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),n=>n.toString(16).padStart(2,'0')).join('');
const half=n=>{const s=n&32768?-1:1,e=(n>>>10)&31,m=n&1023;return s*(e===0?m*2**-24:e===31?(m?NaN:Infinity):(1+m/1024)*2**(e-15));};
let device,summary,scope=false;
try{
 await document.fonts.ready;const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});check(adapter&&!adapter.info.isFallbackAdapter,'Native WebGPU required');device=await adapter.requestDevice();device.pushErrorScope('validation');scope=true;device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 const diagnostics=new FrameDiagnostics({enabled:true}),tracker=new GPUResourceTracker({debug:true,frameDiagnostics:diagnostics});tracker.instrumentDevice(device,createGPUResourceOwner('system','g04-global-overlay'));
 const calls={encoders:0,submits:0,uploads:0,uploadBytes:0};const encode=device.createCommandEncoder.bind(device),submit=device.queue.submit.bind(device.queue),write=device.queue.writeBuffer.bind(device.queue);
 Object.defineProperty(device,'createCommandEncoder',{configurable:true,value:(...a)=>{calls.encoders++;return encode(...a)}});Object.defineProperty(device.queue,'submit',{configurable:true,value:(...a)=>{calls.submits++;return submit(...a)}});Object.defineProperty(device.queue,'writeBuffer',{configurable:true,value:(...a)=>{calls.uploads++;calls.uploadBytes+=a[4]??a[2].byteLength;return write(...a)}});
 const snapshot=()=>({...calls}),delta=(a,b)=>Object.fromEntries(Object.keys(a).map(k=>[k,b[k]-a[k]]));
 function fixture(samples,dpr,regional){
  const w=width*dpr,h=height*dpr,world=new World(),clearColor={r:.08,g:.12,b:.18,a:.6},engine={device,format:'rgba16float',width:w,height:h,displayWidth:width,displayHeight:height,msaaSamples:samples,reverseZ:false,clearColor,getDepthFormat:()=> 'depth24plus'};
  const output=new RttEngine(engine,w,h,clearColor,'G04 overlay HDR output',null,'rgba16float');output.msaaSamples=samples;let acquisitions=0,frame=0,time=0;
  const wrap=(rtt,key)=>({key,format:'rgba16float',width:w,height:h,displayWidth:width,displayHeight:height,getOutputView(){acquisitions++;return rtt.getOutputView()},getRenderPassDescriptor:o=>rtt.getRenderPassDescriptor(o)}),target=wrap(output,output.key);
  engine.getRenderPassDescriptor=()=>target.getRenderPassDescriptor({clearColor,sampleCount:samples,depthConvention:'standard'});engine.getOutputView=()=>target.getOutputView();engine.renderTarget=target;
  const camera=new Entity('camera').addComponent(new Camera3D({fov:Math.PI/3,near:.1,far:100})).addComponent(new CartesianTransform3D({position:[0,0,5]}));world.addEntity(camera);
  world.addEntity(new Entity('actual HDR geometry behind overlays').addComponent(new CartesianTransform3D({rotation:[.2,.3,0]})).addComponent(new Mesh3D(createBox3D({width:1.8,height:1.8,depth:1.8}),new BasicMaterial({color:new ColorLinear(2,.6,.2)}))));
  const scene=new Render3DSystem(engine,camera),root=new GuiRoot({width:sidebar,height,theme:{radius:0,fontSize:12}}),globalRoot=new GuiRoot({width,height,theme:{radius:6,fontSize:12}});
  root.add(new GuiElement({width:'100%',height:'100%',style:{backgroundColor:'#20304a',radius:0}}));root.add(new GuiLabel({x:8,y:12,width:80,height:22,text:'GUI',fontSize:12}));root.add(new GuiElement({x:8,y:48,width:80,height:70,style:{backgroundColor:'#d0507080',radius:9}}));
  const popup=globalRoot.add(new GuiSelect({x:72,y:18,width:150,height:26,visible:false,placeholder:'ABC',options:Array.from({length:8},(_,i)=>({label:'ABC '+i,value:i})),optionHeight:20,maxVisibleOptions:4}));
  const modal=globalRoot.add(new GuiModal({width:250,height:180,title:'ABC',message:'GUI ABC',confirmText:'A',cancelText:'B',showCloseButton:false,showConfirmButton:false,showCancelButton:false,backdropColor:'#10203080'}));
  const toast=globalRoot.add(new GuiToast({x:64,y:160,width:240,height:44,text:'ABC',durationMs:100,animationMs:80,fontSize:14,style:{backgroundColor:'#305070c0',color:'#ffffff',radius:9}}));
  const font={chars:'GUIABCX? 01234567',fontSize:14,atlasSize:256},gui=new GuiSystem(engine,{roots:new Set([root]),font}),overlay=new GuiSystem(engine,{roots:new Set([globalRoot]),font});
  world.addEntity(new Entity('sidebar root').addComponent(root));world.addEntity(new Entity('global overlay root').addComponent(globalRoot));for(const system of [scene,gui,overlay])world.addSystem(system);
  const view=new RenderView({camera,target,sampleCount:samples,clearColor}),sceneView=new RenderView({camera,target,sampleCount:samples,clearColor,viewport:{x:sidebar*dpr,y:0,width:(width-sidebar)*dpr,height:h},scissor:{x:sidebar*dpr,y:0,width:(width-sidebar)*dpr,height:h}}),pipeline=new RenderPipeline(engine);
  const side=regional?view.createRegion({id:'sidebar',bounds:{x:0,y:0,width:sidebar,height},updateMode:'demand',clearMode:'on-update',visible:true}):null,dynamic=regional?view.createRegion({id:'scene',bounds:{x:sidebar,y:0,width:width-sidebar,height},updateMode:'continuous',clearMode:'on-update',visible:true}):null,global=regional?view.createRegion({id:'global-overlay',bounds:{x:0,y:0,width,height},updateMode:'demand',clearMode:'on-update',visible:true}):null;
  const linear=regional?null:new RttEngine(engine,w,h,{r:0,g:0,b:0,a:0},'ordinary full-output GUI layer',null,'rgba16float');if(linear)linear.msaaSamples=samples;
  const guiView=linear?new RenderView({camera,target:wrap(linear,linear.key),sampleCount:samples}):null,copy=linear?new SceneOutputPass():null;if(copy)copy.prepare(device);
  const records={scene:0,gui:0,overlay:0},layouts={gui:0,overlay:0},uploadFacts={gui:0,overlay:0};
  for(const [r,key]of [[root,'gui'],[globalRoot,'overlay']]){const layout=r.root.layout.bind(r.root);r.root.layout=(...a)=>{layouts[key]++;return layout(...a)}}
  for(const [system,key]of [[scene,'scene'],[gui,'gui'],[overlay,'overlay']]){const record=system.record.bind(system);system.record=(...a)=>{records[key]++;const start=calls.uploads;try{return record(...a)}finally{if(key!=='scene')uploadFacts[key]+=calls.uploads-start}}}
  if(regional){pipeline.add(scene,{region:dynamic,pass:'isolated'});pipeline.add(gui,{region:side,pass:'isolated'});pipeline.add(overlay,{region:global,pass:'isolated'});}
  const f={popup,modal,toast,globalRoot,gui,overlay,side,dynamic,global,pipeline,latest:null,
   render(dt=16){diagnostics.beginFrame();const before={calls:snapshot(),records:{...records},layouts:{...layouts},uploadFacts:{...uploadFacts},acquisitions};time+=dt;frame++;let context;
    if(regional)context=pipeline.execute(world,time,dt,{view});
    else{
     // Independent ordinary renderer: render every GUI root into a complete
     // output-sized linear layer, resolve it, then blend over the actual scene.
     // It never creates/reads a region or uses retained pixels.
     context=new RenderFrameContext(engine,{view,frameData:world.frameData});world.frameData.begin(world,engine,time,dt);context.beginPass(target.getRenderPassDescriptor({clearColor,sampleCount:samples,depthConvention:'standard'}));context.endPass();context.view=sceneView.snapshot();scene.record(world,context);context.endPass();
     for(const [system,key]of [[gui,'sidebar'],[overlay,'overlay']]){
      context.view=guiView.snapshot();context.descriptor=linear.getRenderPassDescriptor({clearColor:{r:0,g:0,b:0,a:0},sampleCount:samples,depthConvention:'standard'});context.beginPass(context.descriptor);context.endPass();system.record(world,context);context.endPass();
      copy.setFrameIdentity(frame,'ordinary-full-output-'+key);copy.configure('rgba16float',1,'none',Object.freeze({...view.snapshot(),loadOp:'load',viewport:null,scissor:null}));copy.apply(context.encoder,linear.colorTexture,target.getOutputView(),device);
     }context.submit();
    }
    f.latest={...delta(before.calls,snapshot()),records:delta(before.records,records),layouts:delta(before.layouts,layouts),guiUploads:delta(before.uploadFacts,uploadFacts),acquisitions:acquisitions-before.acquisitions,submitted:context.submitted,stats:pipeline.getDebugSnapshot().regions,gpuResourceSnapshot:tracker.getDebugSnapshot().byType,visibleMeshes:scene.lastVisibleCount,toast:{visible:toast.visible,animating:toast.animating,progress:toast.progress},popup:{visible:popup.visible,open:popup.open,scrollY:popup.scrollY},modal:{visible:modal.visible}};return f.latest;
   },
   async pixels(){const read=device.createBuffer({label:'G04 overlay raw HDR pixels',size:w*8*h,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),e=device.createCommandEncoder();e.copyTextureToBuffer({texture:output.colorTexture},{buffer:read,bytesPerRow:w*8},[w,h]);device.queue.submit([e.finish()]);const start=performance.now();await read.mapAsync(GPUMapMode.READ);const raw=new Uint16Array(read.getMappedRange()).slice(),pixels=Float32Array.from(raw,half),waitMs=performance.now()-start;read.unmap();read.destroy();return{raw,pixels,waitMs};},
   poison(){const e=device.createCommandEncoder(),p=e.beginRenderPass({colorAttachments:[{view:output.getOutputView(),loadOp:'clear',storeOp:'store',clearValue:{r:3,g:0,b:2,a:.4}}]});p.end();device.queue.submit([e.finish()]);},
   async destroy(){pipeline.clear();world.destroy();view.destroy();sceneView.destroy();guiView?.destroy();copy?.destroy();linear?.destroy();output.destroy();await device.queue.onSubmittedWorkDone();await Promise.resolve();live.delete(f);}
  };live.add(f);return f;
 }
 for(const samples of [1,4])for(const dpr of [1,2]){
  const a=fixture(samples,dpr,true),b=fixture(samples,dpr,false),cohort=`${samples}-${dpr}`;let baseline;
  const compare=async(id,dt=16,expectedOverlay=1,crosses=false)=>{
   progress.textContent=id+'-'+cohort;a.poison();b.poison();a.render(dt);b.render(dt);const actual=await a.pixels(),reference=await b.pixels();let max=0,bad=0,left=0,right=0;
   for(let i=0;i<actual.pixels.length;i++){const difference=Math.abs(actual.pixels[i]-reference.pixels[i]);max=Math.max(max,difference);if(!Number.isFinite(actual.pixels[i])||difference>2/255)bad++;if(baseline&&Math.abs(actual.pixels[i]-baseline[i])>2/255){if((Math.floor(i/4)%(width*dpr))<sidebar*dpr)left++;else right++;}}
   check(!bad,`${id}-${cohort}: ${bad} channels differ, max ${max}`);check(a.latest.visibleMeshes===1&&b.latest.visibleMeshes===1,'Actual3D must remain active');check(a.latest.records.scene===1,'Continuous3D stopped');check(a.latest.records.overlay===expectedOverlay,`${id}: overlay records ${a.latest.records.overlay}, expected ${expectedOverlay}`);
   if(id!=='initial')check(a.latest.records.gui===0&&a.latest.layouts.gui===0&&a.latest.guiUploads.gui===0,`${id}: static sidebar redrawn`);
   if(crosses)check(left>100&&right>100,`${id}: overlay did not cross sidebar/scene boundary: ${left}/${right}`);
   const restore=['popup-close-restore','toast-fresh','toast-replace','toast-expire','popup-close-restores-scene','remove-live-toast','wake-scene-under-static-GUI'].includes(id);
   if(restore)check(left===0&&right===0,`${id}: closing/removing the overlay did not restore the fixed baseline: ${left}/${right}`);
   check(a.latest.toast.progress===b.latest.toast.progress&&a.latest.toast.visible===b.latest.toast.visible,'Toast advanced differently between roots/paths');
   cases.push({id:id+'-'+cohort,samples,dpr,channelsCompared:actual.pixels.length,maxRawChannelDifference:max,maxChannelDifference:max*255,sha256:await hash(actual.raw),referenceSha256:await hash(reference.raw),restoresUncoveredBaseline:restore,changedChannelsAcrossBoundary:{left,right},regional:a.latest,ordinary:b.latest,queueAndReadbackWaitMs:actual.waitMs+reference.waitMs});return actual.pixels;
  };
  baseline=await compare('initial');check(baseline.some((n,i)=>i%4!==3&&n>1),'Actual scene HDR radiance above1 missing');
  for(const f of [a,b]){f.popup.setVisible(true);f.popup.setOpen(true);}await compare('popup-first-frame',16,1,true);await compare('popup-static',16,0,true);
  for(const f of [a,b])f.popup.scrollBy(30);await compare('popup-scroll-first-frame',16,1,true);
  for(const f of [a,b]){f.popup.setOpen(false);f.popup.setVisible(false);}await compare('popup-close-restore');
  for(const f of [a,b])f.toast.show();await compare('toast-fresh');check(a.latest.toast.progress===0,'Fresh toast must not consume preceding idle delta');
  await compare('toast-enter',40,1,true);await compare('toast-hold',80,1,true);check(a.latest.toast.progress===1,'Toast never reached hold');
  for(const f of [a,b])f.toast.show({text:'GUI ABC'});await compare('toast-replace');await compare('toast-replaced-enter',80,1,true);
  await compare('toast-fade',120,1,true);check(a.latest.toast.progress>0&&a.latest.toast.progress<1,'Toast exit transition missing');await compare('toast-expire',80);check(!a.latest.toast.visible&&!a.latest.toast.animating,'Expired toast did not stop animation');
  for(const f of [a,b])f.modal.show();await compare('modal-first-frame',16,1,true);await compare('modal-static',16,0,true);
  for(const f of [a,b])f.modal.setMessage('ABC GUI');await compare('modal-text-first-frame',16,1,true);
  for(const f of [a,b]){f.popup.setVisible(true);f.popup.setOpen(true);}await compare('popup-below-modal',16,1,true);
  for(const f of [a,b])f.modal.hide();await compare('modal-close-restores-popup',16,1,true);
  for(const f of [a,b]){f.popup.setOpen(false);f.popup.setVisible(false);}await compare('popup-close-restores-scene');
  for(const f of [a,b]){f.toast.show();f.globalRoot.remove(f.toast);}await compare('remove-live-toast');
  a.dynamic.setMode('demand');a.render(0);const idle=a.render(0);check(!idle.submitted&&idle.encoders===0&&idle.submits===0&&idle.acquisitions===0&&idle.uploads===0,'Empty global overlay prevented idle');a.toast.show();const detached=a.render(0);check(!detached.submitted&&detached.encoders===0&&detached.submits===0&&detached.uploads===0,'Detached toast still invalidates/animates its old region');cases.push({id:'all-idle-detached-toast-'+cohort,samples,dpr,regional:detached,beforeDetachedShow:idle});
  a.dynamic.setMode('continuous');await compare('wake-scene-under-static-GUI',16,0);
  await a.destroy();await b.destroy();
 }
 const beforeEngineCleanup=tracker.getDebugSnapshot().resources.filter(r=>r.type==='buffer'||r.type==='texture');check(beforeEngineCleanup.every(r=>r.type==='buffer'&&r.owner.kind==='engine'&&r.owner.label==='SceneFrameGpuArena'),'Non-engine allocations remain after teardown');disposeSceneFrameGpuArena(device);await device.queue.onSubmittedWorkDone();await Promise.resolve();const validation=await device.popErrorScope();scope=false;if(validation)errors.push(validation.message);check(!errors.length,errors.join('; '));const residue=tracker.getDebugSnapshot().byType;check((residue.buffer?.current??0)===0&&(residue.texture?.current??0)===0,'Overlay resource residue');
 summary={status:'passed',caseCount:cases.length,cases,errors,residue,beforeEngineCleanup,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter},gpuDuration:{status:'not-measured'},qualification:'Explicit whole-output global overlay root with actual GuiSelect/GuiModal/GuiToast over cached sidebar and continuous HDR3D. Independent ordinary renderer redraws each GUI into complete output-sized linear layers every frame; no regional helpers or retained pixels. All raw HDR channels at2/255, native MSAA1/4 and DPR1/2, first frame/show/scroll/replace/hide/animation/removal, static GUI skip, idle/wake and cleanup. Programmatic lifecycle only; G05 owns cross-system input/focus; no portal promotion or complete device/fallback/G04/G13 qualification.'};
}catch(error){if(scope){const e=await device.popErrorScope();scope=false;if(e)errors.push(e.message)}summary={status:'failed',caseCount:cases.length,cases,error:String(error.stack??error),errors}}
finally{for(const f of live)await f.destroy();if(device){disposeSceneFrameGpuArena(device);device.destroy()}}
result.textContent=JSON.stringify(summary);result.dataset.status=summary.status;
