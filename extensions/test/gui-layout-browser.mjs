import {GuiRoot,GuiLabel,GuiButton,GuiImage,GuiScrollView,GuiElement,GuiSystem,hitTestGui} from '/engine/dist/gui.js';
import {World} from '/engine/dist/ecs.js';
import {FrameDiagnostics,GPUResourceTracker,createGPUResourceOwner} from '/engine/dist/experimental.js';
import {attachGuiLayout,createGuiContainer} from '/g03-layout-build/gui-layout.js';
import {readGuiLayoutCounters} from '/g03-layout-build/gui-layout/diagnostics.js';

const resultNode=document.querySelector('#result'),canvas=document.querySelector('#canvas');
const check=(value,message)=>{if(!value)throw Error(message)},dpr=Number(new URLSearchParams(location.search).get('dpr')??1);
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
let device,system,root,world,binding,output,depth,tracker,fontFace;
const validationErrors=[],cases=[],styleInputs=new Map();let width=640,height=480,frames=0,clicks=0;
let nativeTextMeasurements=0;const observedRenderers=new WeakSet();
try{
 for(let i=0;devicePixelRatio!==dpr&&i<120;i++)await new Promise(requestAnimationFrame);
 check(devicePixelRatio===dpr,'DPR emulation did not take effect');
 await document.fonts.ready;
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});check(adapter&&!adapter.info.isFallbackAdapter,'A native WebGPU adapter is required');
 const diagnostics=new FrameDiagnostics({enabled:true});tracker=new GPUResourceTracker({debug:true,frameDiagnostics:diagnostics});const owner=createGPUResourceOwner('system','g03-layout-native');
 let generations=0;
 const initializeDevice=async()=>{
  const current=generations++===0?adapter:await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  check(current&&!current.info.isFallbackAdapter&&['vendor','architecture','device'].every(key=>current.info[key]===adapter.info[key]),'Device recovery changed the adapter profile');
  device=await current.requestDevice();device.addEventListener('uncapturederror',e=>validationErrors.push(e.error.message));device.pushErrorScope('validation');tracker.instrumentDevice(device,owner);
 };
 await initializeDevice();
 const host={device,canvas,format:'rgba8unorm',displayWidth:width,displayHeight:height,reverseZ:false,msaaSamples:1,getDepthFormat:()=> 'depth24plus'};
 world=new World('g03-native');root=new GuiRoot({theme:{fontSize:16}});world.createEntity('gui').add(root);system=new GuiSystem(host);world.add(system);
 const panel=root.add(createGuiContainer('column',{id:'panel',style:{width:{percent:45},height:400,padding:{left:12,right:12,top:12,bottom:12},rowGap:8,alignItems:'start'}}));
 const label=panel.add(new GuiLabel({id:'text',text:'Layout wraps the same native glyph metrics that it draws.',style:{color:'#ffffff'}}));
 const action=panel.add(new GuiButton({id:'action',text:'Action',height:36,onClick:()=>clicks++}));
 const image=panel.add(new GuiImage({id:'image',source:null}));
 const scroll=root.add(new GuiScrollView({id:'scroll',x:350,y:70,width:220,height:180,showScrollbar:false}));
 const rows=Array.from({length:8},(_,i)=>scroll.add(new GuiButton({id:'row-'+i,text:'Row '+i,width:200,height:40,style:{backgroundColor:'#ff0000',borderColor:'#ff0000',radius:0},onClick:()=>clicks++})));
 root.add(new GuiElement({id:'manual',x:420,y:20,width:60,height:30,style:{backgroundColor:'#0000ff',radius:0}}));
 root.add(new GuiLabel({id:'legacy-auto',x:10,y:440,text:'Static auto width',autoWidth:true}));
 binding=attachGuiLayout(root);
 const set=(element,style)=>{styleInputs.set(element,{...styleInputs.get(element),...style});binding.setStyle(element,style)};
 set(label,{width:'auto',height:'auto',alignSelf:'stretch'});set(action,{width:150,height:36,shrink:0});set(image,{width:'auto',height:'auto',alignSelf:'start'});set(scroll,{direction:'column',width:220,height:180,alignItems:'start'});
 const recreateBinding=()=>{binding.dispose();binding=attachGuiLayout(root);for(const [element,style]of styleInputs)binding.setStyle(element,style)};
 const geometry=()=>{const data=[];const visit=e=>{data.push([e.id,{...e.rect}]);for(const c of e.children)visit(c)};visit(root.root);return JSON.stringify(data)};
 const resize=()=>{
  output?.destroy();depth?.destroy();canvas.width=width*dpr;canvas.height=height*dpr;canvas.style.width=width+'px';canvas.style.height=height+'px';host.displayWidth=width;host.displayHeight=height;
  output=device.createTexture({label:'G03 output',size:[canvas.width,canvas.height],format:host.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  depth=device.createTexture({label:'G03 depth',size:[canvas.width,canvas.height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});
 };
 const frame=async()=>{
  if(!observedRenderers.has(system.renderer)){
   const renderer=system.renderer,measure=renderer.measureTextWidth.bind(renderer);renderer.measureTextWidth=(...args)=>{nativeTextMeasurements++;return measure(...args)};observedRenderers.add(renderer);
  }
  const nativeBefore=nativeTextMeasurements;
  diagnostics.beginFrame(++frames);const start=performance.now();system.prepareRoots(world,width,height);system.dispatchPendingEvents(world);
  const encoder=device.createCommandEncoder({label:'G03 native GUI'}),pass=encoder.beginRenderPass({colorAttachments:[{view:output.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'discard',depthClearValue:1}});
  diagnostics.increment('passes');
  system.renderer.render(pass,[root],host);pass.end();const cpuMs=performance.now()-start;
  const stride=Math.ceil(canvas.width*4/256)*256,read=device.createBuffer({label:'G03 pixels',size:stride*canvas.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  encoder.copyTextureToBuffer({texture:output},{buffer:read,bytesPerRow:stride},[canvas.width,canvas.height]);device.queue.submit([encoder.finish()]);root.clearDirty();
  const wait=performance.now();await read.mapAsync(GPUMapMode.READ);const queueAndReadbackWaitMs=performance.now()-wait,bytes=new Uint8Array(read.getMappedRange()).slice();read.unmap();read.destroy();
  return {bytes,stride,cpuMs,queueAndReadbackWaitMs,nativeAutomaticMeasurements:nativeTextMeasurements-nativeBefore,metrics:diagnostics.snapshot().counters,counters:readGuiLayoutCounters(binding)};
 };
 const pixel=(frame,x,y)=>[...frame.bytes.slice(Math.floor(y*dpr)*frame.stride+Math.floor(x*dpr)*4,Math.floor(y*dpr)*frame.stride+Math.floor(x*dpr)*4+4)];
 const capture=async(id,mutate=()=>{},noSolve=false,verify=()=>{})=>{
  document.querySelector('#progress').textContent='Native GUI case: '+id;
  const previous=readGuiLayoutCounters(binding);await mutate();const actual=await frame(),rects=geometry();verify(actual);
  const delta={solves:actual.counters.solves-previous.solves,measurements:actual.counters.measurements-previous.measurements};
  if(noSolve)check(delta.solves===0&&delta.measurements===0&&actual.nativeAutomaticMeasurements===0,id+' should not solve or measure');
  recreateBinding();const reference=await frame();check(geometry()===rects,id+' fresh and retained geometry differ');
  let differentBytes=0;for(let i=0;i<actual.bytes.length;i++)if(actual.bytes[i]!==reference.bytes[i])differentBytes++;
  check(differentBytes===0,id+' fresh and retained native pixels differ: '+differentBytes);
  check(actual.metrics.draws>0&&actual.metrics.passes>0,'Native diagnostic counters were not instrumented: '+JSON.stringify(actual.metrics));
  cases.push({id,differentBytes,actualSha256:await hash(actual.bytes),referenceSha256:await hash(reference.bytes),delta,nativeAutomaticMeasurements:actual.nativeAutomaticMeasurements,draws:actual.metrics.draws,passes:actual.metrics.passes,bufferUploads:actual.metrics.bufferUploads,bufferUploadBytes:actual.metrics.bufferUploadBytes,cpuMs:actual.cpuMs,queueAndReadbackWaitMs:actual.queueAndReadbackWaitMs});
 };
 resize();const startup=await frame();check(startup.metrics.bufferUploads>0,'Native buffer upload instrumentation is unavailable');await new Promise(requestAnimationFrame);await frame();
 await capture('static',()=>{},true,f=>check(f.metrics.bufferUploads===0,'Static native GUI uploaded buffers'));
 await capture('paint-only',()=>label.setStyle({color:'#00ff00'}),true);
 const firstHeight=label.rect.height;
 await capture('text-wrap',()=>label.setText('Long content changes measured height. '.repeat(8)),false,()=>check(label.rect.height>firstHeight,'Long text did not reflow'));
 await capture('viewport-resize',()=>{width=800;resize()});
 const retainedHeight=label.rect.height;
 await capture('visible-retains-layout',()=>label.setVisible(false),true,()=>check(label.rect.height===retainedHeight,'visible=false collapsed layout'));
 await capture('display-none',()=>set(label,{display:'none'}),false,()=>check(label.rect.width===0&&label.rect.height===0,'display none retained geometry'));
 await capture('show-remount',()=>{label.setVisible(true);set(label,{display:'flex'});root.remove(panel);root.add(panel)});
 await capture('scroll-and-clip',()=>scroll.scrollTo(80),true,f=>{check(hitTestGui(world,new Set([root]),390,80)===rows[2],'Scrolled hit geometry is stale');check(pixel(f,390,256).slice(0,3).every(n=>n===0),'Scroll content escaped its clip')});
 const expectedClicks=clicks;
 await capture('queued-touch-drag',()=>{
  const box=canvas.getBoundingClientRect();for(const [type,y]of [['pointerdown',150],['pointermove',110],['pointerup',110]])canvas.dispatchEvent(new PointerEvent(type,{clientX:box.left+390,clientY:box.top+y,pointerId:71,pointerType:'touch',buttons:type==='pointerup'?0:1,bubbles:true,cancelable:true}));
 },true,()=>{check(clicks===expectedClicks,'A scroll drag activated a row');check(scroll.scrollY===120,'Queued touch did not scroll by forty pixels')});
 await capture('queued-touch-click',()=>{
  const box=canvas.getBoundingClientRect();for(const type of ['pointerdown','pointerup'])canvas.dispatchEvent(new PointerEvent(type,{clientX:box.left+390,clientY:box.top+80,pointerId:72,pointerType:'touch',buttons:type==='pointerup'?0:1,bubbles:true,cancelable:true}));
 },true,()=>check(clicks===expectedClicks+1,'A queued touch tap did not activate exactly once'));
 await capture('image-ready',async()=>{const img=new Image();image.setSource(img);const source=document.createElement('canvas');source.width=32;source.height=16;source.getContext('2d').fillStyle='#00ff00';source.getContext('2d').fillRect(0,0,32,16);await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=source.toDataURL()})},false,()=>check(image.rect.width===32&&image.rect.height===16,'Image readiness did not update intrinsic size'));
 await capture('image-replacement',()=>{const source=document.createElement('canvas');source.width=60;source.height=10;source.getContext('2d').fillStyle='#0000ff';source.getContext('2d').fillRect(0,0,60,10);image.setSource(source)},false,()=>check(image.rect.width===60&&image.rect.height===10,'Image replacement kept old metrics'));
 label.setText('iiiiiiii');root.theme.fontFamily='G03LoadedMono';await frame();const fallbackWidth=root.measureElement(label,{mode:'unbounded'},{mode:'unbounded'}).width;
 await capture('font-ready',async()=>{fontFace=new FontFace('G03LoadedMono','local("Courier New")');document.fonts.add(fontFace);await document.fonts.load('16px G03LoadedMono');await document.fonts.ready;await new Promise(requestAnimationFrame)},false,()=>{check(fontFace.status==='loaded','Local font was not loaded');check(root.measureElement(label,{mode:'unbounded'},{mode:'unbounded'}).width!==fallbackWidth,'Font readiness retained fallback metrics')});
 await capture('font-size-and-language',()=>{root.theme.fontSize=20;label.setText('Settings and inventory: locale changed')});
 await capture('grid',()=>set(panel,{display:'grid',columns:[{fr:1},{fr:1}],rows:[80,80],columnGap:10,rowGap:10}));
 system.suspendForDeviceLoss();output.destroy();depth.destroy();output=depth=null;await device.queue.onSubmittedWorkDone();await Promise.resolve();
 const oldResources=tracker.getDebugSnapshot().byType;check((oldResources.buffer?.current??0)===0&&(oldResources.texture?.current??0)===0,'Old device retained GUI resources');
 const oldError=await device.popErrorScope();check(!oldError,'Old device validation: '+oldError?.message);device.destroy();await initializeDevice();host.device=device;system.recoverGpuResource(device,new AbortController().signal);resize();await frame();await new Promise(requestAnimationFrame);await frame();
 await capture('device-recovery');
 binding.dispose();binding=null;root.destroy();system.destroy();system=null;world.destroy();world=null;output.destroy();depth.destroy();output=depth=null;await device.queue.onSubmittedWorkDone();await Promise.resolve();
 const residual=tracker.getDebugSnapshot().byType;check((residual.buffer?.current??0)===0&&(residual.texture?.current??0)===0,'GUI teardown retained native buffers/textures');
 const error=await device.popErrorScope();check(!error&&!validationErrors.length,'Native validation failed: '+JSON.stringify({error:error?.message,validationErrors}));
 resultNode.textContent=JSON.stringify({schemaVersion:1,status:'passed',suite:'g03-native-layout-render',dpr,cases,caseCount:cases.length,deviceGenerations:2,oldDeviceResidual:{buffers:oldResources.buffer?.current??0,textures:oldResources.texture?.current??0},residual:{buffers:residual.buffer?.current??0,textures:residual.texture?.current??0},validationErrors,qualification:'Correctness and structural counters; no formal performance, physical input device or product/tarball qualification',gpuDuration:{status:'not-measured'},adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,isFallbackAdapter:adapter.info.isFallbackAdapter}});resultNode.dataset.status='passed';
}catch(error){resultNode.textContent=JSON.stringify({schemaVersion:1,status:'failed',error:String(error.stack??error),completedCases:cases,validationErrors});resultNode.dataset.status='failed';}
finally{binding?.dispose();root?.destroy();system?.destroy();world?.destroy();output?.destroy();depth?.destroy();if(fontFace)document.fonts.delete(fontFace);device?.destroy();}
