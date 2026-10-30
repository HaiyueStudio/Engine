import {HaiyueEngine, Entity, Camera3D, CartesianTransform3D, Mesh3D, createBox3D, ColorSRGB} from '/engine/dist/index.js';
import {BasicMaterial} from '/engine/dist/material.js';
import {GuiRoot, GuiElement, GuiLabel, GuiImage, GuiModal, GuiSystem} from '/engine/dist/gui.js';
import {Render3DSystem, getSceneRenderPipeline, getEngineFrameDiagnostics, getEngineGPUResourceTracker} from '/engine/dist/experimental.js';

// Real Engine/canvas/RAF recovery. The control has the identical regional scene on
// a separate device that is never lost; direct-vs-regional pixels have their own gate.
const result = document.querySelector('#result'), progress = document.querySelector('#progress');
const cases = [], errors = [], live = new Set();
const check = (value, message) => { if (!value) throw Error(message); };
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
const timeout = (promise, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), 10000);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
let summary,familySerial=0;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function trackEvents(target,types){const entries=new Map(types.map(type=>[type,new Set()])),add=target.addEventListener.bind(target),remove=target.removeEventListener.bind(target);target.addEventListener=(type,listener,...args)=>{entries.get(type)?.add(listener);return add(type,listener,...args)};target.removeEventListener=(type,listener,...args)=>{entries.get(type)?.delete(listener);return remove(type,listener,...args)};return()=>[...entries.values()].reduce((sum,set)=>sum+set.size,0);}
const fontListeners=trackEvents(document.fonts,['loadingdone','loadingerror']);


async function fixture(samples, name, {scenario='after',guiMode='demand',clearMode='on-update'}={}) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:192px;height:128px'; document.body.append(canvas);const canvasListeners=trackEvents(canvas,['pointerdown','pointermove','pointerup','pointercancel','wheel','keydown','compositionstart','compositionend','copy','cut','paste']);
  let dpr = 1, devices = [], adapters = [], pendingLostMutation,recoveryGate;
  const counters = {encoders:0, submits:0, uploads:0, bufferUploadBytes:0, textureUploads:0, textureUploadTexels:0, acquired:0, passes:0, guiRecords:0, sceneRecords:0, layouts:0, guiUploads:0,overlayRecords:0,overlayLayouts:0,overlayUploads:0};
  const events = [];
  const gpu = {
    getPreferredCanvasFormat: () => navigator.gpu.getPreferredCanvasFormat(),
    async requestAdapter() {
      const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
      check(adapter && !adapter.info.isFallbackAdapter, 'Native adapter required');
      adapters.push({vendor:adapter.info.vendor, architecture:adapter.info.architecture, description:adapter.info.description, isFallbackAdapter:adapter.info.isFallbackAdapter});
      return {features:adapter.features, limits:adapter.limits, info:adapter.info, async requestDevice(options) {
        if(recoveryGate){const gate=recoveryGate;gate.entered();await gate.wait;}const device = await adapter.requestDevice(options), generation = devices.length + 1;
        devices.push(device); device.pushErrorScope('validation');
        device.addEventListener('uncapturederror', e => errors.push({name, generation, message:e.error.message}));
        const create = device.createCommandEncoder.bind(device), submit = device.queue.submit.bind(device.queue), write = device.queue.writeBuffer.bind(device.queue);
        Object.defineProperty(device, 'createCommandEncoder', {configurable:true, value(...args) {
          counters.encoders++; const encoder = create(...args), begin = encoder.beginRenderPass.bind(encoder);
          Object.defineProperty(encoder, 'beginRenderPass', {configurable:true, value(...args) { counters.passes++; return begin(...args); }});
          return encoder;
        }});
        Object.defineProperty(device.queue, 'submit', {configurable:true, value(...args) { counters.submits++; return submit(...args); }});
        Object.defineProperty(device.queue, 'writeBuffer', {configurable:true, value(...args) {
          counters.uploads++; const unit=ArrayBuffer.isView(args[2])?(args[2].BYTES_PER_ELEMENT??1):1;
          counters.bufferUploadBytes+=(args[4]??(args[2].byteLength/unit-(args[3]??0)))*unit; return write(...args);
        }});
        for(const key of ['writeTexture','copyExternalImageToTexture']) {
          const original=device.queue[key].bind(device.queue);
          Object.defineProperty(device.queue,key,{configurable:true,value(...args) {
            counters.uploads++; counters.textureUploads++; const size=args.at(-1);
            counters.textureUploadTexels+=(size.width??size[0])*(size.height??size[1]??1)*(size.depthOrArrayLayers??size[2]??1);
            return original(...args);
          }});
        }
        return device;
      }};
    },
  };
  const engine = new HaiyueEngine({canvas, gpu, msaaSamples:samples, devicePixelRatio:() => dpr, diagnostics:{enabled:true}, clearColor:{r:.04,g:.07,b:.12,a:1}});
  // Retain cleanup ownership even if setup fails.
  const f = {engine, canvas, async destroy() { engine.destroy(); canvas.remove(); live.delete(f); }}; live.add(f);
  await engine.init();
  const context = engine.context, acquire = context.getCurrentTexture.bind(context);
  Object.defineProperty(context, 'getCurrentTexture', {configurable:true, value() { counters.acquired++; return acquire(); }});
  const camera = new Entity('camera').addComponent(new Camera3D({near:.1,far:100,fov:Math.PI/3})).addComponent(new CartesianTransform3D({position:[0,0,5]}));
  const scene = engine.createScene({camera,render3D:false,render2D:false,gui:false});
  const transform = new CartesianTransform3D({rotation:[.2,.3,0]});
  scene.add(new Entity('box').addComponent(transform).addComponent(new Mesh3D(createBox3D({width:1.8,height:1.8,depth:1.8}), new BasicMaterial({color:ColorSRGB.fromHex('#e06030')}))));
  const side = scene.renderView.createRegion({id:'sidebar',bounds:{x:0,y:0,width:64,height:128},updateMode:guiMode,clearMode,visible:true});
  const dynamic = scene.renderView.createRegion({id:'scene',bounds:{x:64,y:0,width:128,height:128},updateMode:'continuous',clearMode,visible:true});
  const root = new GuiRoot({theme:{fontSize:12,radius:0}});
  root.add(new GuiElement({width:'100%',height:'100%',style:{backgroundColor:'#20304a',radius:0}}));
  const label = root.add(new GuiLabel({x:6,y:10,width:56,height:24,text:'GUI',fontSize:12,style:{color:'#e0f0ff'}}));
  root.add(new GuiElement({x:8,y:50,width:48,height:40,style:{backgroundColor:'#d0507080',radius:8}}));
  const imageSource = color => {
    const image=document.createElement('canvas'); image.width=8; image.height=8;
    image.getContext('2d').fillStyle=color; image.getContext('2d').fillRect(0,0,8,8); return image;
  };
  const green=imageSource('#20c050'),purple=imageSource('#8030d0');
  const image=root.add(new GuiImage({x:8,y:98,width:48,height:22,source:green}));
  const layout = root.root.layout.bind(root.root);
  root.root.layout = (...args) => { counters.layouts++; return layout(...args); };
  class MeasuredGui extends GuiSystem {
    record(...args) {
      counters.guiRecords++; const before = counters.uploads;
      try { return super.record(...args); } finally { counters.guiUploads += counters.uploads - before; }
    }
  }
  class MeasuredScene extends Render3DSystem { record(...args) { counters.sceneRecords++; return super.record(...args); } }
  scene.add(new Entity('gui').addComponent(root));
  scene.addSystem(new MeasuredScene(engine,camera), {region:dynamic,pass:'isolated'});
  scene.addSystem(new MeasuredGui(engine,{roots:new Set([root]),font:{chars:'GUIABC? ',fontSize:12,atlasSize:128}}), {region:side,pass:'isolated'});
  const family='G04AsyncRecovery'+samples+(++familySerial),fontFamily='"'+family+'", sans-serif',face=new FontFace(family,'local("Courier New")');
  const watchedImages=[];
  const watchedImage=()=>{const source=new Image(),count=trackEvents(source,['load','error']);watchedImages.push({source,count});return source;};
  let overlaySource=watchedImage(),fontEvents=0,expectedOverlay=null;
  const globalRoot=new GuiRoot({theme:{fontSize:14,fontFamily,radius:0}}),globalRegion=scene.renderView.createRegion({id:'global-overlay',bounds:{x:0,y:0,width:192,height:128},updateMode:scenario==='during'?'once':'demand',clearMode:'on-update',visible:true});
  const modal=globalRoot.add(new GuiModal({width:144,height:112,title:'GUI',message:'ABC',showCloseButton:false,showConfirmButton:false,showCancelButton:false,backdropColor:'#10203080'}));modal.show();
  globalRoot.add(new GuiLabel({x:48,y:8,width:96,height:28,text:'iiiiWWW',fontSize:14,style:{color:'#ffffff'}}));
  const overlayImage=globalRoot.add(new GuiImage({x:48,y:2,width:96,height:10,source:overlaySource}));
  const overlayLayout=globalRoot.root.layout.bind(globalRoot.root);globalRoot.root.layout=(...args)=>{counters.overlayLayouts++;return overlayLayout(...args);};
  class MeasuredOverlay extends GuiSystem {record(...args){counters.overlayRecords++;const before=counters.uploads;try{return super.record(...args)}finally{counters.overlayUploads+=counters.uploads-before;}}}
  scene.add(new Entity('global GUI').addComponent(globalRoot));scene.addSystem(new MeasuredOverlay(engine,{roots:new Set([globalRoot]),font:{chars:'iWGUIABC? ',fontFamily,fontSize:14,atlasSize:256}}),{region:globalRegion,pass:'isolated',sort:10001});
  f.overlay=globalRegion;f.modal=modal;
  f.overlayState=()=>{const states=getSceneRenderPipeline(scene)._regions?.known;const state=states&&[...states].find(state=>state.handle===globalRegion);return state?.snapshot();};
  f.resetGlobalStorage=()=>{globalRegion.setBounds({x:0,y:0,width:193,height:128});globalRegion.setBounds({x:0,y:0,width:192,height:128});};
  f.pulseIfOnce=()=>{if(f.overlayState()?.updateMode==='once')globalRegion.requestOnce();};
  f.decodeOverlay=async color=>{overlaySource.src=imageSource(color).toDataURL('image/png');await overlaySource.decode();await tick();check(overlaySource.naturalWidth===8&&overlaySource.naturalHeight===8,'Real image did not decode');expectedOverlay=color==='#20c050'?[32,192,80,255]:[128,48,208,255];return {width:overlaySource.naturalWidth,height:overlaySource.naturalHeight,complete:overlaySource.complete,dataUrlSha256:await hash(new TextEncoder().encode(overlaySource.currentSrc))};};
  f.replacePendingImage=()=>{overlaySource=watchedImage();overlayImage.setSource(overlaySource);expectedOverlay=null;};
  f.loadFont=async()=>{const loaded=()=>fontEvents++;document.fonts.addEventListener('loadingdone',loaded);try{document.fonts.add(face);await document.fonts.load('14px "'+family+'"');await document.fonts.ready;await tick();check(face.status==='loaded'&&fontEvents>0,'Real FontFaceSet event missing');}finally{document.fonts.removeEventListener('loadingdone',loaded);}return{status:face.status,events:fontEvents,source:'local Courier New'};};
  f.readiness=()=>({imageWidth:overlaySource.naturalWidth,imageComplete:overlaySource.complete,fontStatus:face.status,fontEvents,imageListeners:watchedImages.reduce((sum,item)=>sum+item.count(),0),canvasListeners:canvasListeners(),globalFontListeners:fontListeners()});
  engine.switchScene(scene);
  for (const event of ['device-lost','device-restored','recovery-progress','recovery-failed','state-change']) engine.on(event, e => {
    events.push({event,detail:event === 'device-restored' ? {generation:devices.length} : event === 'device-lost' ? {reason:e.detail.reason,message:e.detail.message} : e.detail});
    if (event === 'device-lost') pendingLostMutation?.();
  });
  const snapshot = () => ({...counters});
  const delta = before => Object.fromEntries(Object.entries(counters).map(([key,value]) => [key,value-before[key]]));
  f.step = async (capture = true) => {
    const before = snapshot(), allocationsBefore=getEngineGPUResourceTracker(engine).getDebugSnapshot().byType;
    let metrics, read, rowBytes, width, height, start, recordStart;
    engine.on('update', () => { recordStart=performance.now(); }, {once:true});
    const frame = new Promise((resolve,reject) => engine.on('after-update', () => {
      engine.stop();
      try {
        const resources=getEngineGPUResourceTracker(engine).getDebugSnapshot().byType;
        metrics = {...delta(before), cpuRecordMs:performance.now()-recordStart, diagnostics:getEngineFrameDiagnostics(engine).snapshot(), regions:getSceneRenderPipeline(scene).getDebugSnapshot().regions, resources,
          fontProbeRect:{...modal.titleLabel.rect},overlayState:f.overlayState(),readiness:f.readiness(),allocations:Object.fromEntries(Object.entries(resources).map(([key,value])=>[key,value.created-(allocationsBefore[key]?.created??0)]))};
        if (capture) {
          width=canvas.width; height=canvas.height; rowBytes=Math.ceil(width*4/256)*256;
          read=engine.device.createBuffer({label:'g04-recovery-readback',size:rowBytes*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
          const encoder=engine.device.createCommandEncoder();
          encoder.copyTextureToBuffer({texture:context.getCurrentTexture()},{buffer:read,bytesPerRow:rowBytes},[width,height]);
          engine.device.queue.submit([encoder.finish()]); start=performance.now();
        }
        resolve();
      } catch(error) { reject(error); }
    }, {once:true}));
    engine.run(); await timeout(frame, `${name} frame`);
    let pixels;
    if (read) {
      try {
        await read.mapAsync(GPUMapMode.READ); const raw=new Uint8Array(read.getMappedRange()); pixels=new Uint8Array(width*height*4);
        for(let y=0;y<height;y++) pixels.set(raw.subarray(y*rowBytes,y*rowBytes+width*4),y*width*4);
        // Canvas formats are identical for both fixtures; byte comparison is exact regardless of BGRA/RGBA order.
        metrics.queueAndReadbackWaitMs=performance.now()-start;
      } finally { read.unmap(); read.destroy(); }
    } else { const start=performance.now(); await engine.device.queue.onSubmittedWorkDone(); metrics.queueWaitMs=performance.now()-start; }
    await Promise.resolve();
    const linear=c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4,encode=c=>c<=.0031308?12.92*c:1.055*c**(1/2.4)-.055;const expectedVisible=expectedOverlay&&modal.visible?[...expectedOverlay.slice(0,3).map((v,i)=>Math.round(255*encode(linear(v/255)*(127/255)+linear([16,32,48][i]/255)*(128/255)))),255]:expectedOverlay;
    const overlayPixels=[];
    if(pixels&&expectedOverlay&&f.overlayState()?.visible&&f.overlayState().updateMode!=='disabled')for(const x of [52,120]){const offset=(6*canvas.width+x)*4,pixel=Array.from(pixels.slice(offset,offset+4));if(engine.format.startsWith('bgra'))[pixel[0],pixel[2]]=[pixel[2],pixel[0]];check(pixel.every((value,index)=>Math.abs(value-expectedVisible[index])<=2),'Global image not correct across sidebar/scene boundary: '+pixel);overlayPixels.push(pixel);}
    return {pixels,metrics,width:canvas.width,height:canvas.height,overlayImage:{expected:expectedVisible,sourceExpected:expectedOverlay,modalVisible:modal.visible,pixels:overlayPixels}};
  };
  f.recover = async (mutate,during) => {
    const old=engine.device, generation=devices.length, firstEvent=events.length;
    check(!(await old.popErrorScope()), 'Validation before loss'); pendingLostMutation=mutate;
    const restored = new Promise((resolve,reject) => {
      const done=() => { engine.off('recovery-failed',failed); resolve(); };
      const failed=e => { engine.off('device-restored',done); reject(Error(JSON.stringify(e.detail))); };
      engine.on('device-restored',done,{once:true}); engine.on('recovery-failed',failed,{once:true});
    });
    let duringEvidence=null;
    if(during){let entered,resume;const reached=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>resume=resolve);recoveryGate={entered,wait};old.destroy();await timeout(reached,'native replacement barrier');try{check(engine.state==='recovering','Barrier did not hold actual recovery');duringEvidence=await during();check(engine.state==='recovering','Async sources did not complete inside recovery');}finally{resume();recoveryGate=null;}}
    else old.destroy(); await timeout(restored, `${name} real device recovery`); await engine.waitForRecovery(); pendingLostMutation=undefined;
    check(engine.state==='ready' && engine.device!==old && devices.length===generation+1, 'Engine did not replace device exactly once');
    return {generation:devices.length,events:events.slice(firstEvent),adapter:adapters.at(-1),duringEvidence,readiness:f.readiness(),cause:'Native GPUDevice.destroy drives actual Engine recovery; provider gate only controls real replacement request timing'};
  };
  f.dynamic=dynamic;f.side=side;
  f.destroy = async () => {
    const error=engine.state==='ready' ? await engine.device.popErrorScope() : null;
    check(!error, `Validation before teardown: ${error?.message}`);
    const tracker=getEngineGPUResourceTracker(engine);engine.destroy();document.fonts.delete(face);canvas.remove();live.delete(f);
    await Promise.resolve(); const residue=tracker.getDebugSnapshot();
    check((residue.byType.buffer?.current??0)===0 && (residue.byType.texture?.current??0)===0, 'Engine teardown retains resources');
    const imageListeners=watchedImages.reduce((sum,item)=>sum+item.count(),0);check(imageListeners===0&&canvasListeners()===0,'Image/canvas listeners survived Engine destroy');return {byType:residue.byType,remaining:residue.resources,devices:devices.length,adapters,imageListeners,canvasListeners:canvasListeners()};
  };
  return f;
}

function fontBand(pixels,width){const band=new Uint8Array(96*34*4);for(let y=0;y<34;y++)band.set(pixels.subarray(((36+y)*width+48)*4,((36+y)*width+144)*4),y*96*4);return band;}
async function compare(id,a,b,samples,scenario,overlay,{warm=false,pending,controlOverlay=overlay}={}){
 progress.textContent=id+'-'+scenario+'-'+samples;const aa=await a.step(),bb=await b.step();let max=0,bad=0;const first=[];
 check(aa.width===192&&aa.height===128&&bb.width===192&&bb.height===128,'Canvas dimensions differ');
 for(let i=0;i<aa.pixels.length;i++){const d=Math.abs(aa.pixels[i]-bb.pixels[i]);max=Math.max(max,d);if(d>2){bad++;if(first.length<6)first.push({byte:i,a:aa.pixels[i],b:bb.pixels[i]});}}
 const row={id:id+'-'+scenario+'-msaa'+samples,samples,scenario,channelsCompared:aa.pixels.length,maxChannelDifference:max,sha256:await hash(aa.pixels),controlSha256:await hash(bb.pixels),fontBandSha256:await hash(fontBand(aa.pixels,aa.width)),controlFontBandSha256:await hash(fontBand(bb.pixels,bb.width)),candidate:aa.metrics,control:bb.metrics,overlayImage:aa.overlayImage,controlOverlayImage:bb.overlayImage};
 if(bad){cases.push({...row,status:'failed',bad,first});throw Error(id+': '+JSON.stringify({max,bad,first}));}
 check(aa.metrics.overlayRecords===overlay&&bb.metrics.overlayRecords===controlOverlay,id+': global GUI record count '+aa.metrics.overlayRecords+'/'+bb.metrics.overlayRecords);
 check(aa.metrics.sceneRecords===1&&bb.metrics.sceneRecords===1,'Continuous actual3D stopped');
 if(warm)for(const m of [aa.metrics,bb.metrics])check(m.guiRecords===0&&m.overlayRecords===0&&m.layouts===0&&m.overlayLayouts===0&&m.guiUploads===0&&m.overlayUploads===0,'Warm GUI repeats layout/records/uploads');
 if(pending!==undefined)for(const m of [aa.metrics,bb.metrics])check(m.overlayState?.pendingOnce===pending,'Pending once request incorrectly consumed or stranded');
 cases.push(row);return row;
}
try{
 await document.fonts.ready;
 for(const scenario of ['during','after'])for(const samples of [1,4]){
  const suffix='-'+scenario+'-msaa'+samples,a=await fixture(samples,'candidate',{scenario}),b=await fixture(samples,'control',{scenario});
  const initial=await compare('initial',a,b,samples,scenario,1);await compare('warm',a,b,samples,scenario,0,{warm:true});
  let loss;
  if(scenario==='during'){
   for(const f of [a,b]){f.overlay.setVisible(false);f.overlay.requestOnce();}
   loss=await a.recover(null,async()=>{const before=a.engine.state,images=await Promise.all([a.decodeOverlay('#20c050'),b.decodeOverlay('#20c050')]),fonts=await Promise.all([a.loadFont(),b.loadFont()]);return{stateBefore:before,stateAfter:a.engine.state,images,fonts};});
  }else loss=await a.recover();
  cases.push({id:'loss-ready-timing'+suffix,samples,scenario,...loss});
  await compare('restore-first',a,b,samples,scenario,scenario==='during'?0:1,{pending:scenario==='during',controlOverlay:0});
  if(scenario==='during')for(const f of [a,b])f.overlay.setVisible(true);
  else await Promise.all([a.decodeOverlay('#20c050'),b.decodeOverlay('#20c050')]);
  const visible=await compare('visible-ready-first',a,b,samples,scenario,1,{pending:false});await compare('warm-ready',a,b,samples,scenario,0,{warm:true});
  if(scenario==='after')await Promise.all([a.loadFont(),b.loadFont()]);
  const font=await compare('font-confirmed',a,b,samples,scenario,scenario==='during'?0:1,{warm:scenario==='during'});
  check(font.fontBandSha256!==(scenario==='during'?initial.fontBandSha256:visible.fontBandSha256),'Real font readiness did not change glyph pixels');
  check(font.candidate.readiness.fontStatus==='loaded'&&font.control.readiness.fontStatus==='loaded'&&font.candidate.readiness.fontEvents>0&&font.control.readiness.fontEvents>0,'Font readiness/event witness missing');
  await compare('font-warm',a,b,samples,scenario,0,{warm:true});
  for(const f of [a,b]){f.modal.hide();f.pulseIfOnce();}await compare('modal-close',a,b,samples,scenario,1);
  for(const f of [a,b]){f.modal.show();f.pulseIfOnce();}await compare('modal-reopen',a,b,samples,scenario,1);
  for(const f of [a,b]){f.overlay.setMode('disabled');f.overlay.requestOnce();f.replacePendingImage();}
  const disabled=await a.recover(()=>b.resetGlobalStorage());cases.push({id:'loss-disabled'+suffix,samples,scenario,...disabled,controlHistoryReinitialized:true});
  await compare('disabled-restore-first',a,b,samples,scenario,0,{pending:true});
  await Promise.all([a.decodeOverlay('#8030d0'),b.decodeOverlay('#8030d0')]);
  await compare('disabled-image-ready',a,b,samples,scenario,0,{pending:true});
  for(const f of [a,b])f.overlay.setMode('demand');
  await compare('reenable-first',a,b,samples,scenario,1,{pending:false});await compare('reenable-warm',a,b,samples,scenario,0,{warm:true});
  for(const f of [a,b])f.dynamic.setMode('demand');await a.step(false);await b.step(false);const idleA=await a.step(false),idleB=await b.step(false);
  for(const m of [idleA.metrics,idleB.metrics])check(['encoders','submits','uploads','acquired','passes','guiRecords','sceneRecords','layouts','guiUploads','overlayRecords','overlayLayouts','overlayUploads'].every(k=>m[k]===0),'All-static recovered overlay performs work');
  cases.push({id:'all-idle'+suffix,samples,scenario,candidate:idleA.metrics,control:idleB.metrics});
  for(const f of [a,b])f.dynamic.setMode('continuous');await compare('wake',a,b,samples,scenario,0,{warm:true});
  const cleanupA=await a.destroy(),cleanupB=await b.destroy();check(fontListeners()===0,'FontFaceSet listeners survived both Engine owners');cases.push({id:'cleanup'+suffix,samples,scenario,candidate:cleanupA,control:cleanupB,fontListeners:fontListeners()});
 }
 check(!errors.length,'GPU/cleanup errors: '+JSON.stringify(errors));
 summary={status:'passed',caseCount:cases.length,cases,errors,gpuDuration:{status:'not-measured'},qualification:'Real Engine/canvas/RAF and native GPUDevice.destroy recovery; delayed HTMLImageElement and FontFaceSet readiness during held real replacement request or after restoration. Hidden once and disabled pending requests, cross-boundary global image and GuiModal, first visible/enabled frame, font glyph pixels, static skip, idle/wake, owned image/canvas/font listeners and GPU cleanup. Independent never-lost Engine control; disabled control storage publicly reinitialized to match lost GPU contents. MSAA1/4 native Windows local Courier New only; not physical TDR/input/focus, Toast recovery or formal performance qualification.'};
}catch(error){summary={status:'failed',error:String(error.stack??error),caseCount:cases.length,cases,errors};}
finally{for(const f of [...live])try{await f.destroy();}catch(error){errors.push({cleanup:String(error)});f.engine.destroy();f.canvas.remove();}}
result.textContent=JSON.stringify(summary);result.dataset.status=summary.status;
