import {RenderPipeline,RenderView,RenderFrameContext,Entity,World,FrameDiagnostics,GPUResourceTracker,createGPUResourceOwner,Render3DSystem,disposeSceneFrameGpuArena,Camera3D,CartesianTransform3D,Mesh3D,BasicMaterial,createBox3D,ColorLinear} from '/engine/dist/experimental.js';
import {RttEngine} from '/engine/dist/rtt.js';
import {SceneOutputPass} from '/region-target-build/region-copy.js';
import {GuiRoot,GuiElement,GuiLabel,GuiSystem,GuiSelect,GuiModal,GuiToast} from '/engine/dist/gui.js';

const width=384,height=240,sidebar=96,result=document.querySelector('#result'),progress=document.querySelector('#progress'),cases=[],errors=[],live=new Set();
const check=(v,m)=>{if(!v)throw Error(m)},hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),n=>n.toString(16).padStart(2,'0')).join('');
const half=n=>{const s=n&32768?-1:1,e=(n>>>10)&31,m=n&1023;return s*(e===0?m*2**-24:e===31?(m?NaN:Infinity):(1+m/1024)*2**(e-15));};
let device,summary,scope=false;const pressures=new Set();
try{
 await document.fonts.ready;const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});check(adapter&&!adapter.info.isFallbackAdapter,'Native WebGPU required');device=await adapter.requestDevice();device.pushErrorScope('validation');scope=true;device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 const diagnostics=new FrameDiagnostics({enabled:true}),tracker=new GPUResourceTracker({debug:true,frameDiagnostics:diagnostics});tracker.instrumentDevice(device,createGPUResourceOwner('system','g04-global-overlay'));
 const calls={encoders:0,submits:0,uploads:0,uploadBytes:0,textureUploads:0,textureUploadTexels:0,passes:0};const encode=device.createCommandEncoder.bind(device),submit=device.queue.submit.bind(device.queue),write=device.queue.writeBuffer.bind(device.queue);
 Object.defineProperty(device,'createCommandEncoder',{configurable:true,value:(...a)=>{calls.encoders++;const encoder=encode(...a),begin=encoder.beginRenderPass.bind(encoder);Object.defineProperty(encoder,'beginRenderPass',{configurable:true,value:(...a)=>{calls.passes++;return begin(...a)}});return encoder}});Object.defineProperty(device.queue,'submit',{configurable:true,value:(...a)=>{calls.submits++;return submit(...a)}});Object.defineProperty(device.queue,'writeBuffer',{configurable:true,value:(...a)=>{calls.uploads++;const unit=ArrayBuffer.isView(a[2])?(a[2].BYTES_PER_ELEMENT??1):1;calls.uploadBytes+=(a[4]??(a[2].byteLength/unit-(a[3]??0)))*unit;return write(...a)}});
 for(const key of ['writeTexture','copyExternalImageToTexture']){const original=device.queue[key].bind(device.queue);Object.defineProperty(device.queue,key,{configurable:true,value:(...args)=>{calls.uploads++;calls.textureUploads++;const n=args.at(-1);calls.textureUploadTexels+=(n.width??n[0])*(n.height??n[1]??1)*(n.depthOrArrayLayers??n[2]??1);return original(...args)}});}
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
  const f={engine,popup,modal,toast,globalRoot,gui,overlay,side,dynamic,global,pipeline,latest:null,
   register(){pipeline.add(scene,{region:dynamic,pass:'isolated'});pipeline.add(gui,{region:side,pass:'isolated'});pipeline.add(overlay,{region:global,pass:'isolated'});},
   budget(){const observer=pipeline._regions??this.budgetObserver;check(observer,'Region observer missing');this.budgetObserver=observer;observer.publish(0,0,0,0,[]);return{retainedBytes:observer.stats.retainedColorBytes,retainedRegions:observer.stats.cachedRegions};},
   render(dt=16){diagnostics.beginFrame();const before={calls:snapshot(),records:{...records},layouts:{...layouts},uploadFacts:{...uploadFacts},acquisitions,allocations:tracker.getDebugSnapshot().byType};const cpuStart=performance.now();time+=dt;frame++;let context;
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
    f.latest={...delta(before.calls,snapshot()),cpuMs:performance.now()-cpuStart,frameDiagnostics:diagnostics.snapshot(),allocations:Object.fromEntries(Object.entries(tracker.getDebugSnapshot().byType).map(([k,v])=>[k,v.created-(before.allocations[k]?.created??0)])),records:delta(before.records,records),layouts:delta(before.layouts,layouts),guiUploads:delta(before.uploadFacts,uploadFacts),acquisitions:acquisitions-before.acquisitions,submitted:context.submitted,stats:pipeline.getDebugSnapshot().regions,gpuResourceSnapshot:tracker.getDebugSnapshot().byType,visibleMeshes:scene.lastVisibleCount,toast:{visible:toast.visible,animating:toast.animating,progress:toast.progress},popup:{visible:popup.visible,open:popup.open,scrollY:popup.scrollY},modal:{visible:modal.visible}};return f.latest;
   },
   async pixels(){const read=device.createBuffer({label:'G04 overlay raw HDR pixels',size:w*8*h,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),e=device.createCommandEncoder();e.copyTextureToBuffer({texture:output.colorTexture},{buffer:read,bytesPerRow:w*8},[w,h]);device.queue.submit([e.finish()]);const start=performance.now();await read.mapAsync(GPUMapMode.READ);const raw=new Uint16Array(read.getMappedRange()).slice(),pixels=Float32Array.from(raw,half),waitMs=performance.now()-start;read.unmap();read.destroy();return{raw,pixels,waitMs};},
   poison(){const e=device.createCommandEncoder(),p=e.beginRenderPass({colorAttachments:[{view:output.getOutputView(),loadOp:'clear',storeOp:'store',clearValue:{r:3,g:0,b:2,a:.4}}]});p.end();device.queue.submit([e.finish()]);},
   async destroy(){pipeline.clear();world.destroy();view.destroy();sceneView.destroy();guiView?.destroy();copy?.destroy();linear?.destroy();output.destroy();await device.queue.onSubmittedWorkDone();await Promise.resolve();live.delete(f);}
  };live.add(f);return f;
 }
 for(const samples of [1,4])for(const dpr of [1,2]){
  const a=fixture(samples,dpr,true),b=fixture(samples,dpr,false),cohort=`${samples}-${dpr}`;let baseline;
  const bounded=()=>{const r=a.budget();check(r.retainedRegions<=8&&r.retainedBytes<=67108864,'Shared cache cap exceeded');return r;};
  const compare=async(id,expectedGui,expectedOverlay,dt=16,kind='cached',crosses=false,restores=false)=>{
   progress.textContent=id+'-'+cohort;a.poison();b.poison();a.render(dt);b.render(dt);const actual=await a.pixels(),reference=await b.pixels();let max=0,bad=0,left=0,right=0;
   for(let i=0;i<actual.pixels.length;i++){const difference=Math.abs(actual.pixels[i]-reference.pixels[i]);max=Math.max(max,difference);if(!Number.isFinite(actual.pixels[i])||difference>2/255)bad++;if(baseline&&Math.abs(actual.pixels[i]-baseline[i])>2/255){if((Math.floor(i/4)%(width*dpr))<sidebar*dpr)left++;else right++;}}
   check(!bad,`${id}-${cohort}: ${bad} channels differ, max ${max}`);check(a.latest.visibleMeshes===1&&b.latest.visibleMeshes===1&&a.latest.records.scene===1,'Actual continuous3D missing');
   check(a.latest.records.gui===expectedGui&&a.latest.records.overlay===expectedOverlay,`${id}: unexpected GUI/overlay records ${JSON.stringify(a.latest.records)}`);
   if(expectedGui===0)check(a.latest.layouts.gui===0&&a.latest.guiUploads.gui===0,'Static sidebar repeated layout/upload');
   if(expectedOverlay===0)check(a.latest.layouts.overlay===0&&a.latest.guiUploads.overlay===0,'Static overlay repeated layout/upload');
   if(kind==='fallback')check(a.latest.stats.fallbacks.length===3&&a.latest.stats.fallbacks.every(v=>v.endsWith(':region-count'))&&a.latest.stats.cachedRegions===6,'Count-pressure ordered fallback not exercised');
   else check(!a.latest.stats.fallbacks.length&&a.latest.stats.cachedRegions===(kind==='readmitted'?8:3),'Expected complete caching');
   if(crosses)check(left>100&&right>100,'Overlay does not cross sidebar/scene boundary');if(restores)check(left===0&&right===0,'Closing overlay did not restore baseline');
   check(a.latest.toast.progress===b.latest.toast.progress&&a.latest.toast.visible===b.latest.toast.visible,'Toast clocks differ');bounded();
   cases.push({id:id+'-'+cohort,samples,dpr,kind,channelsCompared:actual.pixels.length,maxRawChannelDifference:max,maxChannelDifference:max*255,sha256:await hash(actual.raw),referenceSha256:await hash(reference.raw),changedChannelsAcrossBoundary:{left,right},restoresUncoveredBaseline:restores,regional:a.latest,ordinary:b.latest,queueAndReadbackWaitMs:actual.waitMs+reference.waitMs});return actual.pixels;
  };
  baseline=await compare('baseline-initial',1,1);check(baseline.some((v,i)=>i%4!==3&&v>1),'Actual HDR scene radiance missing');await compare('baseline-warm',0,0);
  a.budget();a.pipeline.clear();await device.queue.onSubmittedWorkDone();await Promise.resolve();check(a.budget().retainedRegions===0,'Prior main cache not retired before pressure setup');
  const owned=[];
  for(let n=0;n<6;n++){
   const world=new World(),target=new RttEngine(a.engine,4,4,{r:0,g:0,b:0,a:0},'other owner count-pressure'),camera=new Entity('other camera').addComponent(new Camera3D()).addComponent(new CartesianTransform3D()),view=new RenderView({camera,target,sampleCount:samples}),pipeline=new RenderPipeline(a.engine),region=view.createRegion({id:'count-pressure-'+n,bounds:{x:0,y:0,width:4,height:4},updateMode:'demand',clearMode:'on-update',visible:true});
   pipeline.add({record(){}},{region,pass:'isolated'});pipeline.execute(world,0,0,{view});
   const pressure={retire(){pipeline.clear();world.destroy();view.destroy();target.destroy();}};owned.push(pressure);pressures.add(pressure);
   check(pipeline.getDebugSnapshot().regions.cachedRegions===a.budget().retainedRegions,'Private/public device-budget identity mismatch');
  }
  check(bounded().retainedRegions===6,'Six other regions must occupy six logical slots');cases.push({id:'pressure-installed-'+cohort,samples,dpr,budget:bounded(),otherRegions:6,sharedBudgetVerified:true});a.register();
  await compare('fallback-initial',1,1,16,'fallback',false,true);
  for(const f of [a,b]){f.popup.setVisible(true);f.popup.setOpen(true);}await compare('fallback-popup-first',1,1,16,'fallback',true);
  await compare('fallback-popup-static',1,1,16,'fallback',true);
  for(const f of [a,b])f.modal.show();await compare('fallback-modal-first',1,1,16,'fallback',true);await compare('fallback-modal-static',1,1,16,'fallback',true);
  for(const f of [a,b])f.toast.show();await compare('fallback-toast-fresh',1,1,16,'fallback');check(a.latest.toast.progress===0,'Fresh toast consumed idle delta');
  await compare('fallback-toast-enter',1,1,40,'fallback',true);await compare('fallback-toast-expire',1,1,400,'fallback');check(!a.latest.toast.animating&&!a.latest.toast.visible,'Expired toast still animates');
  for(const f of [a,b]){f.modal.hide();f.popup.setOpen(false);f.popup.setVisible(false);}await compare('fallback-close-restore',1,1,16,'fallback',false,true);
  const released=owned.pop();released.retire();await device.queue.onSubmittedWorkDone();await Promise.resolve();pressures.delete(released);cases.push({id:'one-slot-released-'+cohort,samples,dpr,budget:bounded()});check(a.budget().retainedRegions===5,'Released slot not retired');
  await compare('readmit-first',1,1,16,'readmitted',false,true);await compare('readmit-warm',0,0,16,'readmitted',false,true);
  for(const f of [a,b]){f.popup.setVisible(true);f.popup.setOpen(true);}await compare('readmit-popup-first',0,1,16,'readmitted',true);await compare('readmit-popup-static',0,0,16,'readmitted',true);
  for(const f of [a,b]){f.popup.setOpen(false);f.popup.setVisible(false);}await compare('readmit-close-restore',0,1,16,'readmitted',false,true);
  a.dynamic.setMode('demand');a.render(0);const idle=a.render(0);check(!idle.submitted&&idle.encoders===0&&idle.submits===0&&idle.acquisitions===0&&idle.uploads===0,'Post-admission all-idle does work');cases.push({id:'all-idle-'+cohort,samples,dpr,regional:idle});
  a.dynamic.setMode('continuous');await compare('wake',0,0,16,'readmitted',false,true);
  for(const pressure of owned){pressure.retire();pressures.delete(pressure);}await a.destroy();await b.destroy();check(a.budget().retainedRegions===0&&a.budget().retainedBytes===0,'Other owners/cache reservations remain');cases.push({id:'cache-cleanup-'+cohort,samples,dpr,budget:a.budget()});
 }
 const beforeEngineCleanup=tracker.getDebugSnapshot().resources.filter(r=>r.type==='buffer'||r.type==='texture');check(beforeEngineCleanup.every(r=>r.type==='buffer'&&r.owner.kind==='engine'&&r.owner.label==='SceneFrameGpuArena'),'Non-engine allocations remain after teardown');disposeSceneFrameGpuArena(device);await device.queue.onSubmittedWorkDone();await Promise.resolve();const validation=await device.popErrorScope();scope=false;if(validation)errors.push(validation.message);check(!errors.length,errors.join('; '));const residue=tracker.getDebugSnapshot().byType;check((residue.buffer?.current??0)===0&&(residue.texture?.current??0)===0,'Overlay resource residue');
 summary={status:'passed',caseCount:cases.length,cases,errors,residue,beforeEngineCleanup,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter},gpuDuration:{status:'not-measured'},qualification:'Native count-pressure with actual public RenderPipeline owners and GuiSelect/GuiModal/GuiToast over continuous HDR3D. Six foreign logical regions plus three overlapping product regions exceed original8 cap, forcing ordered redraw; one slot retirement re-admits all three at exactly8. Raw full-output independent reference at MSAA1/4,DPR1/2; explicit fallback costs, cross-boundary first frames/static/restore, idle/wake and cleanup. On-update clear only; no physical input, device-wide or formal performance qualification.'};
}catch(error){if(scope){const e=await device.popErrorScope();scope=false;if(e)errors.push(e.message)}summary={status:'failed',caseCount:cases.length,cases,error:String(error.stack??error),errors}}
finally{for(const pressure of pressures)pressure.retire();for(const f of live)await f.destroy();if(device){disposeSceneFrameGpuArena(device);device.destroy()}}
result.textContent=JSON.stringify(summary);result.dataset.status=summary.status;
