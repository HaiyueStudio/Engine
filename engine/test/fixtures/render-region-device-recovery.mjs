import {HaiyueEngine, Entity, Camera3D, CartesianTransform3D, Mesh3D, createBox3D, ColorSRGB} from '/engine/dist/index.js';
import {BasicMaterial} from '/engine/dist/material.js';
import {GuiRoot, GuiElement, GuiLabel, GuiImage, GuiSystem} from '/engine/dist/gui.js';
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
let summary;

async function fixture(samples, name, {guiMode='demand',clearMode='on-update'}={}) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:192px;height:128px'; document.body.append(canvas);
  let dpr = 1, devices = [], adapters = [], pendingLostMutation;
  const counters = {encoders:0, submits:0, uploads:0, bufferUploadBytes:0, textureUploads:0, textureUploadTexels:0, acquired:0, passes:0, guiRecords:0, sceneRecords:0, layouts:0, guiUploads:0};
  const events = [];
  const gpu = {
    getPreferredCanvasFormat: () => navigator.gpu.getPreferredCanvasFormat(),
    async requestAdapter() {
      const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
      check(adapter && !adapter.info.isFallbackAdapter, 'Native adapter required');
      adapters.push({vendor:adapter.info.vendor, architecture:adapter.info.architecture, description:adapter.info.description, isFallbackAdapter:adapter.info.isFallbackAdapter});
      return {features:adapter.features, limits:adapter.limits, info:adapter.info, async requestDevice(options) {
        const device = await adapter.requestDevice(options), generation = devices.length + 1;
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
          allocations:Object.fromEntries(Object.entries(resources).map(([key,value])=>[key,value.created-(allocationsBefore[key]?.created??0)]))};
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
    let imagePixel;
    if(pixels) {
      const x=Math.floor(16*canvas.width/engine.displayWidth),y=Math.floor(108*canvas.height/engine.displayHeight),offset=(y*canvas.width+x)*4;
      imagePixel=Array.from(pixels.slice(offset,offset+4));
      if(engine.format.startsWith('bgra')) [imagePixel[0],imagePixel[2]]=[imagePixel[2],imagePixel[0]];
      check(imagePixel.every((value,index)=>Math.abs(value-f.expectedImage[index])<=2), `GUI CPU-source image did not render: ${imagePixel}, expected ${f.expectedImage}`);
    }
    return {pixels,metrics,width:canvas.width,height:canvas.height,imagePixel};
  };
  f.recover = async mutate => {
    const old=engine.device, generation=devices.length, firstEvent=events.length;
    check(!(await old.popErrorScope()), 'Validation before loss'); pendingLostMutation=mutate;
    const restored = new Promise((resolve,reject) => {
      const done=() => { engine.off('recovery-failed',failed); resolve(); };
      const failed=e => { engine.off('device-restored',done); reject(Error(JSON.stringify(e.detail))); };
      engine.on('device-restored',done,{once:true}); engine.on('recovery-failed',failed,{once:true});
    });
    old.destroy(); await timeout(restored, `${name} real device recovery`); await engine.waitForRecovery(); pendingLostMutation=undefined;
    check(engine.state==='ready' && engine.device!==old && devices.length===generation+1, 'Engine did not replace device exactly once');
    return {generation:devices.length,events:events.slice(firstEvent),adapter:adapters.at(-1),cause:'Native GPUDevice.destroy() drives engine.device.lost and automatic Engine recovery'};
  };
  f.resize = value => { dpr=value; canvas.style.width='208px'; canvas.style.height='144px'; side.setBounds({x:0,y:0,width:64,height:144}); dynamic.setBounds({x:64,y:0,width:144,height:144}); if(engine.state==='ready') engine.resizeToDisplaySize(true); };
  f.expectedImage=[32,192,80,255];
  f.mutate = () => { label.setText('ABC'); image.setSource(purple); f.expectedImage=[128,48,208,255]; transform.setRotation(.45,.65,.1); dynamic.invalidate('Explicit scene mutation'); };
  f.mutateLost = () => { label.setText('GUI'); image.setSource(green); f.expectedImage=[32,192,80,255]; transform.setRotation(.1,.9,.2); side.invalidate('Lost-device content change'); dynamic.invalidate('Lost-device scene mutation'); };
  f.dynamic=dynamic; f.side=side;
  f.resetControlHistory = () => {
    // A lost GPU cannot keep old clear-once pixels. Give the never-lost reference
    // the same initialized=false storage semantics through public bounds changes,
    // while ending at the identical logical bounds and retaining CPU scene state.
    side.setBounds({x:0,y:0,width:65,height:128}); side.setBounds({x:0,y:0,width:64,height:128});
    dynamic.setBounds({x:64,y:0,width:129,height:128}); dynamic.setBounds({x:64,y:0,width:128,height:128});
  };
  f.destroy = async () => {
    const error=engine.state==='ready' ? await engine.device.popErrorScope() : null;
    check(!error, `Validation before teardown: ${error?.message}`);
    const tracker=getEngineGPUResourceTracker(engine); engine.destroy(); canvas.remove(); live.delete(f);
    await Promise.resolve(); const residue=tracker.getDebugSnapshot();
    check((residue.byType.buffer?.current??0)===0 && (residue.byType.texture?.current??0)===0, 'Engine teardown retains resources');
    return {byType:residue.byType,remaining:residue.resources,devices:devices.length,adapters};
  };
  return f;
}

async function compare(id, a, b, samples, {gui,scene,dirtyGui=false} = {}) {
  progress.textContent=id; const aa=await a.step(), bb=await b.step();
  check(aa.width===bb.width && aa.height===bb.height, `${id}: output size differs`);
  let max=0,bad=0; const first=[];
  for(let i=0;i<aa.pixels.length;i++) { const diff=Math.abs(aa.pixels[i]-bb.pixels[i]); max=Math.max(max,diff); if(diff>2) { bad++; if(first.length<6) first.push({byte:i,a:aa.pixels[i],b:bb.pixels[i]}); } }
  if(bad) cases.push({id,samples,status:'failed',channelsCompared:aa.pixels.length,maxChannelDifference:max,bad,first,candidate:aa.metrics,control:bb.metrics});
  check(!bad, `${id}: ${JSON.stringify({max,bad,first})}`);
  check(aa.pixels.some((value,i)=>i%4!==3 && value>120), `${id}: rendered output is blank`);
  if(gui!==undefined) check(aa.metrics.guiRecords===gui, `${id}: GUI records ${aa.metrics.guiRecords}, expected ${gui}`);
  if(gui===0) check((dirtyGui||aa.metrics.layouts===0) && aa.metrics.guiUploads===0, `${id}: unchanged GUI solves/uploads`);
  if(scene!==undefined) check(aa.metrics.sceneRecords===scene, `${id}: scene records ${aa.metrics.sceneRecords}, expected ${scene}`);
  cases.push({id,samples,width:aa.width,height:aa.height,channelsCompared:aa.pixels.length,maxChannelDifference:max,sha256:await hash(aa.pixels),controlSha256:await hash(bb.pixels),image:{expected:a.expectedImage,candidate:aa.imagePixel,control:bb.imagePixel},candidate:aa.metrics,control:bb.metrics});
}
async function idle(id,a,b,samples) {
  a.dynamic.setMode('demand'); b.dynamic.setMode('demand');
  await a.step(false); await b.step(false); const aa=await a.step(false),bb=await b.step(false);
  for(const m of [aa.metrics,bb.metrics]) check(['encoders','submits','uploads','acquired','passes','guiRecords','sceneRecords','layouts','guiUploads'].every(key=>m[key]===0), `${id}: all-static frame performs GPU or GUI work: ${JSON.stringify(m)}`);
  cases.push({id,samples,candidate:aa.metrics,control:bb.metrics});
}
try {
  await document.fonts.ready;
  for(const samples of [1,4]) {
    const a=await fixture(samples,'candidate'),b=await fixture(samples,'control'), suffix=`-msaa${samples}`;
    await compare('initial'+suffix,a,b,samples,{gui:1,scene:1});
    await compare('static-GUI'+suffix,a,b,samples,{gui:0,scene:1});
    a.mutate(); b.mutate(); await compare('mutation-first-frame'+suffix,a,b,samples,{gui:1,scene:1});
    await idle('before-loss-idle'+suffix,a,b,samples);
    const first=await a.recover(()=>{a.mutateLost();b.mutateLost();}); cases.push({id:'device-loss-1'+suffix,samples,...first});
    await compare('restore-first-frame'+suffix,a,b,samples,{gui:1,scene:1});
    a.dynamic.setMode('continuous'); b.dynamic.setMode('continuous');
    await compare('restore-static-GUI'+suffix,a,b,samples,{gui:0,scene:1});
    await idle('after-loss-idle'+suffix,a,b,samples);
    const second=await a.recover(()=>{a.resize(1.5);b.resize(1.5);a.mutate();b.mutate();}); cases.push({id:'device-loss-2-with-resize-DPR'+suffix,samples,...second});
    await compare('resize-restore-first-frame'+suffix,a,b,samples,{gui:1,scene:1});
    a.dynamic.setMode('continuous'); b.dynamic.setMode('continuous');
    await compare('resize-restore-static-GUI'+suffix,a,b,samples,{gui:0,scene:1});
    await idle('resize-loss-idle'+suffix,a,b,samples);
    a.dynamic.setMode('continuous'); b.dynamic.setMode('continuous');
    await compare('wake-after-two-losses'+suffix,a,b,samples,{gui:0,scene:1});
    cases.push({id:'engine-destroy'+suffix,samples,candidate:await a.destroy(),control:await b.destroy()});
  }
  for(const samples of [1,4]) {
    const options={guiMode:'once',clearMode:'once'},a=await fixture(samples,'once-candidate',options),b=await fixture(samples,'once-control',options),suffix=`-msaa${samples}`;
    await compare('once-initial'+suffix,a,b,samples,{gui:1,scene:1});
    await compare('once-static-GUI'+suffix,a,b,samples,{gui:0,scene:1});
    // An invalidation is not a fresh once pulse. The old cached pixels stay visible.
    for(const f of [a,b]) { f.mutate(); f.expectedImage=[32,192,80,255]; }
    await compare('once-muted-invalidation'+suffix,a,b,samples,{gui:0,scene:1,dirtyGui:true});
    for(const f of [a,b]) { f.side.requestOnce(); f.expectedImage=[128,48,208,255]; }
    await compare('once-explicit-pulse'+suffix,a,b,samples,{gui:1,scene:1});
    await idle('once-before-loss-idle'+suffix,a,b,samples);
    const first=await a.recover(()=>{
      for(const f of [a,b]) { f.mutateLost(); f.side.requestOnce(); f.dynamic.requestOnce(); }
      b.resetControlHistory();
    });
    cases.push({id:'once-loss-pending'+suffix,samples,...first,pulseDuringLoss:true,controlHistoryReinitialized:true});
    await compare('once-restore-pending'+suffix,a,b,samples,{gui:1,scene:1});
    for(const f of [a,b]) f.dynamic.setMode('continuous');
    await compare('once-warm-pending'+suffix,a,b,samples,{gui:0,scene:1});
    for(const f of [a,b]) f.dynamic.setMode('once');
    await a.step(false); await b.step(false);
    // idle() may select demand, so inspect once-mode zero work directly here.
    const frozenA=await a.step(false),frozenB=await b.step(false);
    check(frozenA.metrics.sceneRecords===0&&frozenB.metrics.sceneRecords===0,'Once scene pulse was not consumed');
    cases.push({id:'once-consumed-idle'+suffix,samples,candidate:frozenA.metrics,control:frozenB.metrics});
    const second=await a.recover(()=>{
      // Only the never-lost control needs an explicit redraw to produce a fresh
      // swapchain readback. The lost candidate must rebuild consumed-once storage
      // without a caller pulse; otherwise it would present empty or stale data.
      b.side.requestOnce(); b.dynamic.requestOnce(); b.resetControlHistory();
    });
    cases.push({id:'once-loss-consumed'+suffix,samples,...second,candidatePulseDuringLoss:false,controlPulseForFreshReadback:true,controlHistoryReinitialized:true});
    await compare('once-restore-consumed'+suffix,a,b,samples,{gui:1,scene:1});
    for(const f of [a,b]) f.dynamic.setMode('continuous');
    await compare('once-warm-consumed'+suffix,a,b,samples,{gui:0,scene:1});
    await idle('once-after-loss-idle'+suffix,a,b,samples);
    cases.push({id:'once-engine-destroy'+suffix,samples,candidate:await a.destroy(),control:await b.destroy()});
  }
  check(errors.length===0, `Uncaptured GPU errors: ${JSON.stringify(errors)}`);
  summary={status:'passed',caseCount:cases.length,cases,errors,gpuDuration:{status:'not-measured'},onceWorkload:{guiMode:'once',clearMode:'once',dirtyContentDoesNotPulse:true,pendingPulseSurvivesLoss:true,consumedOnceStorageRebuildsWithoutCandidatePulse:true},qualification:'Native GPU device-loss recovery diagnostic: demand and once/clear-once, two replacements per candidate and MSAA1/4; independent never-lost regional control and full canvas readback. Includes GUI/font/CPU-source image/3D, idle, resize/DPR and pending/consumed pulses. For consumed-once recovery only the control requests a redraw for fresh swapchain capture. Direct-vs-regional equivalence is verified separately; not physical TDR, performance or release qualification.'};
} catch(error) { summary={status:'failed',error:String(error.stack??error),cases,errors}; }
finally { for(const f of live) { try { await f.destroy(); } catch(error) { errors.push({cleanup:String(error)}); f.engine.destroy();f.canvas.remove(); } } }
result.textContent=JSON.stringify(summary);result.dataset.status=summary.status;
