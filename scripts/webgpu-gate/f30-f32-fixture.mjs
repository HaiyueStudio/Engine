const node = document.querySelector('#result');
const WIDTH = 128, HEIGHT = 128;
const cases = [], failures = [], validationErrors = [], previews = [], resourceResidue = [];
const metrics = { scope:'Uploads cover all fixture GPU devices; directFixtureDraws/Passes cover Toon and warmup, excluding internal HYA passes.',bufferUploads: 0, bufferUploadBytes: 0, textureUploads: 0, directFixtureDraws: 0, directFixturePasses: 0, readbacks: 0 };
let api, adapter, tracker;
const devices = [];
const check = (condition, message) => { if (!condition) throw Error(message); };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const identity = () => Float32Array.from([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
async function device() {
  const selected = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  check(selected && selected.info?.isFallbackAdapter!==true,'A native adapter is required for every device');
  const value = await selected.requestDevice(); devices.push(value);
  tracker.instrumentDevice(value, api.createGPUResourceOwner('renderer', 'F30-F32 native pixels'));
  value.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  value.pushErrorScope('validation');
  const write = value.queue.writeBuffer.bind(value.queue), texture = value.queue.writeTexture.bind(value.queue);
  value.queue.writeBuffer = (buffer, offset, data, first = 0, count) => {
    const stride = data.BYTES_PER_ELEMENT ?? 1;
    metrics.bufferUploads++; metrics.bufferUploadBytes += count === undefined ? data.byteLength - first * stride : count * stride;
    return write(buffer, offset, data, first, count);
  };
  value.queue.writeTexture = (...args) => { metrics.textureUploads++; return texture(...args); };
  return value;
}
function target(gpu, samples = 1) {
  const color = gpu.createTexture({label:'F30-F32 color', size:[WIDTH,HEIGHT],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC|GPUTextureUsage.STORAGE_BINDING});
  const msaa = samples === 4 ? gpu.createTexture({label:'F30-F32 MSAA',size:[WIDTH,HEIGHT],format:'rgba8unorm',sampleCount:4,usage:GPUTextureUsage.RENDER_ATTACHMENT}) : null;
  const depth = gpu.createTexture({label:'F30-F32 depth',size:[WIDTH,HEIGHT],format:'depth24plus',sampleCount:samples,usage:GPUTextureUsage.RENDER_ATTACHMENT});
  return {device:gpu,format:'rgba8unorm',width:WIDTH,height:HEIGHT,displayWidth:WIDTH,displayHeight:HEIGHT,msaaSamples:samples,reverseZ:false,colorTexture:color,
    getDepthFormat:()=>'depth24plus',getRenderPassDescriptor:()=>({colorAttachments:[{view:(msaa??color).createView(),...(msaa?{resolveTarget:color.createView()}:{}),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'discard'}}),
    destroy(){color.destroy();msaa?.destroy();depth.destroy();}};
}
async function pixels(gpu, texture) {
  const read = gpu.createBuffer({label:'F30-F32 readback',size:WIDTH*HEIGHT*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try {
    const encoder = gpu.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer:read,bytesPerRow:WIDTH*4},[WIDTH,HEIGHT]);gpu.queue.submit([encoder.finish()]);metrics.readbacks++;
    await read.mapAsync(GPUMapMode.READ);const result = new Uint8Array(read.getMappedRange()).slice();read.unmap();return result;
  } finally {read.destroy();}
}
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
function png(bytes) {const canvas=document.createElement('canvas');canvas.width=WIDTH;canvas.height=HEIGHT;canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes),WIDTH,HEIGHT),0,0);return canvas.toDataURL('image/png');}
async function compare(id, candidate, reference) {
  check(candidate.length===reference.length&&candidate.length===WIDTH*HEIGHT*4,id+': invalid full-frame readback');
  let maximumChannelDifference=0,changedChannels=0,visibleChannels=0;
  for(let i=0;i<candidate.length;i++){const delta=Math.abs(candidate[i]-reference[i]);maximumChannelDifference=Math.max(maximumChannelDifference,delta);if(delta)changedChannels++;if(i%4!==3&&reference[i])visibleChannels++;}
  const result={id,width:WIDTH,height:HEIGHT,maximumChannelDifference,changedChannels,visibleChannels,candidateSha256:await hash(candidate),referenceSha256:await hash(reference)};cases.push(result);
  if((previews.length<6&&id.includes('t0.5'))||id==='toon-old-recording-msaa1')previews.push({id,candidate:png(candidate),reference:png(reference)});
  check(visibleChannels>16,id+': reference is blank');check(maximumChannelDifference===0,id+': complete RGBA frames differ, max '+maximumChannelDifference);
}
const rect=(size=24)=>({type:'shape2d',shape:'rect',size:[size,size],fill:[.9,.4,.2,1]});
const track=(a,b)=>({times:[0,1],values:[a,b],valueSize:1,interpolation:'linear'});
const documentFor=nodes=>({format:'haiyue-animation',version:'1.0',canvas:{width:WIDTH,height:HEIGHT,coordinateSystem:'screen-y-down'},duration:1,nodes,tracks:[]});
function hyaCases() {
  const mask=stack=>documentFor([{id:'mask',transform:{position:[36,36]},components:[rect(24)]},{id:'node',transform:{position:[36,36]},components:[rect(52)],composite:stack?{layers:[{kind:'mask',source:'mask',mode:'alpha',expansion:0,expansionTrack:track(0,12)}]}:{kind:'mask',source:'mask',mode:'alpha',expansion:0,expansionTrack:track(0,12)}}]);
  return [
    {id:'legacy-morph',value:{...documentFor([{id:'node',transform:{position:[30,30]},components:[{type:'org.haiyue.vector-path-morph@1',commands:'MLLLZ',times:[0,1],valueSize:8,values:[0,0,28,0,28,28,0,28,20,0,48,0,28,28,0,28],interpolation:'linear',fill:[1,.2,.1,1]}]}]),extensionsUsed:['org.haiyue.vector-path-morph@1']}},
    {id:'opacity-effect',value:documentFor([{id:'node',transform:{position:[36,36]},components:[rect(48)],effects:[{kind:'opacity',opacity:1,opacityTrack:track(1,.15)}]}])},
    {id:'compact-expansion',value:mask(false)},{id:'stack-expansion',value:mask(true)},
  ];
}
function hyaScene(gpu, samples, document, production) {
  const engine=target(gpu,samples),world=new api.World(),camera=new api.Entity('camera').add(new api.Camera2D({width:WIDTH,height:HEIGHT,designWidth:WIDTH,designHeight:HEIGHT,viewportMode:'fixed'})),owner=new api.Entity('animation').add(new api.Transform2D());world.add(camera);world.add(owner);
  const runtime=production?new api.ProductionCoreStateVisualRuntime(owner,api.parseAnimation(document),[]):new api.Animation2DRuntime(owner,api.parseAnimation(document));
  const draw=new api.ProductionDrawOwner(engine);let sequence=0;
  return {engine,runtime,async render(time){if(production)runtime.applyAuthoredMixedChannels([],time);else runtime.apply(time,false,1);world.frameData.begin(world,engine,++sequence,0);const step=draw.preparePlan(owner,String(sequence),()=>api.compileProductionCoreDrawPlan(world,camera,engine,{viewport:[WIDTH,HEIGHT],dpr:1,maxGeometryBytes:1024*1024}));step.commit();step.finalize?.();const context=new api.RenderFrameContext(engine,{descriptor:engine.getRenderPassDescriptor(),frameData:world.frameData});context.beginPass();context.endPass();draw.record(world,context);context.submit();return pixels(gpu,engine.colorTexture);},async close(){draw.dispose();runtime.destroy();world.destroy();await gpu.queue.onSubmittedWorkDone();await settle();engine.destroy();}};
}
async function hya() {
  const gpu=await device();
  for(const samples of [1,4]){
    for(const entry of hyaCases()){
      const candidate=hyaScene(gpu,samples,entry.value,true),reference=hyaScene(gpu,samples,entry.value,false);let first,changed=false;
      try{for(const [step,time] of [0,.5,.25,0].entries()){const a=await candidate.render(time),b=await reference.render(time);await compare('hya-'+entry.id+'-t'+time+'-step'+step+'-msaa'+samples,a,b);if(!first)first=await hash(b);else if(time===.5)changed=(await hash(b))!==first;}check(changed,entry.id+': test animation did not visibly change');}
      finally{await candidate.close();await reference.close();}
    }
    const staticDoc=documentFor([{id:'node',transform:{position:[32,32]},components:[rect()]}]),scene=hyaScene(gpu,samples,staticDoc,true);
    try{const initial=await scene.render(0),later=await scene.render(.5);check(scene.runtime.stats.authoredEvaluations===1,'static authored early return was lost');await compare('hya-static-msaa'+samples,later,initial);}finally{await scene.close();}
  }
  api.disposeSceneFrameGpuArena(gpu);
}
function toonScene(gpu,samples) {
  const engine=target(gpu,samples),renderer=new api.ToonRenderer();renderer.prepare(engine);
  const material=new api.ToonMaterial({baseColor:[1,.1,.05,1],layers:[{minLight:0,color:[1,1,1,1]}]}),geometry=new api.Geometry3D({positions:Float32Array.from([-.8,-.8,.2,.8,-.8,.2,0,.8,.2]),normals:Float32Array.from([0,0,1,0,0,1,0,0,1])});
  let sequence=0;const contexts=[];
  function record(){const context=new api.RenderFrameContext(engine,{descriptor:engine.getRenderPassDescriptor()}),data=new Float32Array(68);data.set(identity());data.set(identity(),16);data.set(identity(),32);contexts.push(context);renderer.beginView({reverseZ:false,msaaSamples:samples,sceneFrameUniforms:{data,frameId:++sequence,phaseRevision:sequence,cameraEntityId:1},sceneEnvironment:{pbrLights:[]},directionalShadow:null,commandContext:context});renderer.prepareObjects([{entityId:1,geometry,material,worldMatrix:identity(),clippingPlanes:null}]);renderer.flushUploads();const pass=context.beginPass();renderer.render(pass,1,geometry,material,identity());context.endPass();renderer.endView();metrics.directFixtureDraws++;metrics.directFixturePasses++;return context;}
  return {engine,renderer,material,record,async render(){record().submit();return pixels(gpu,engine.colorTexture);},async read(){return pixels(gpu,engine.colorTexture);},async close(){contexts.forEach(context=>context.cancel());renderer.destroy();await gpu.queue.onSubmittedWorkDone();await settle();engine.destroy();}};
}
async function toon() {
  const gpu=await device();
  for(const samples of [1,4]){
    const a=toonScene(gpu,samples),b=toonScene(gpu,samples);
    try{
      const red=await b.render();await compare('toon-initial-msaa'+samples,await a.render(),red);
      const old=a.record();a.material.baseColor=b.material.baseColor=[.1,1,.1,1];const next=a.record();old.submit();await compare('toon-old-recording-msaa'+samples,await a.read(),red);next.submit();const green=await b.render();await compare('toon-next-recording-msaa'+samples,await a.read(),green);
      const held=a.record();a.material.baseColor=b.material.baseColor=[.1,.2,1,1];const newest=a.record();newest.submit();const blue=await b.render();await compare('toon-reverse-new-first-msaa'+samples,await a.read(),blue);held.submit();await compare('toon-reverse-old-last-msaa'+samples,await a.read(),green);
      const cancelled=a.record();a.renderer.releaseMaterialsNotIn(new Set());cancelled.cancel();await compare('toon-after-cancel-eviction-msaa'+samples,await a.render(),blue);
      const destroyed=a.record();a.renderer.destroy();const clear=new api.RenderFrameContext(a.engine,{descriptor:a.engine.getRenderPassDescriptor()});clear.beginPass();clear.endPass();clear.submit();check((await a.read()).every(value=>value===0),'destroy test must start from a cleared destination');destroyed.submit();await compare('toon-destroy-before-submit-msaa'+samples,await a.read(),blue);
    }finally{await a.close();await b.close();}
  }
  api.disposeSceneFrameGpuArena(gpu);
}
function warmupRenderer(kind) {
  return new class extends api.BaseRenderer {
    prepare(engine){this.clearPipelineCache();this.device=engine.device;this.compute=null;this.module=this.device.createShaderModule({code:kind==='render'?'@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}@fragment fn fs()->@location(0) vec4f{return vec4f(.15,.75,.3,1);}':'@group(0) @binding(0) var output:texture_storage_2d<rgba8unorm,write>; @compute @workgroup_size(8,8) fn cs(@builtin(global_invocation_id) p:vec3u){if(p.x<128u && p.y<128u){textureStore(output,vec2i(p.xy),vec4f(.15,.75,.3,1));}}'});}
    descriptor(){return kind==='render'?{layout:'auto',vertex:{module:this.module,entryPoint:'vs'},fragment:{module:this.module,entryPoint:'fs',targets:[{format:'rgba8unorm'}]}}:{layout:'auto',compute:{module:this.module,entryPoint:'cs'}};}
    contributePipelineWarmup(plan){if(kind==='render')this.addPipelineWarmup(plan,'main','native render',()=>this.descriptor(),this.device);else this.addComputePipelineWarmup(plan,'main','native compute',()=>this.descriptor(),this.device,()=>this.compute,pipeline=>{this.compute=pipeline;});}
    record(engine){const gpu=this.device,encoder=gpu.createCommandEncoder();if(kind==='render'){const pipeline=this.getCachedPipeline('main',()=>gpu.createRenderPipeline(this.descriptor())),pass=encoder.beginRenderPass({colorAttachments:engine.getRenderPassDescriptor().colorAttachments});pass.setPipeline(pipeline);pass.draw(3);pass.end();metrics.directFixtureDraws++;}else{const pipeline=this.getCachedComputePipeline('main',()=>this.compute,()=>gpu.createComputePipeline(this.descriptor()),pipeline=>{this.compute=pipeline;}),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,gpu.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:engine.colorTexture.createView()}]}));pass.dispatchWorkgroups(16,16);pass.end();}metrics.directFixturePasses++;gpu.queue.submit([encoder.finish()]);}
    destroy(){this.clearPipelineCache();this.compute=null;}
  }();
}
async function warmup() {
  for(const kind of ['render','compute']){
    const a=await device(),b=await device(),renderer=warmupRenderer(kind),reference=warmupRenderer(kind),pending=[],method=kind==='render'?'createRenderPipelineAsync':'createComputePipelineAsync',original=a[method].bind(a);
    Object.defineProperty(a,method,{configurable:true,value:descriptor=>new Promise((resolve,reject)=>pending.push(()=>original(descriptor).then(resolve,reject)))});
    const plan=new api.PipelineWarmupPlan(),abort=new AbortController(),left=target(b),right=target(b);
    renderer.prepare({device:a});renderer.contributePipelineWarmup(plan);const running=plan.run({signal:abort.signal});
    try{for(let i=0;i<100&&!pending.length;i++)await settle();check(pending.length===1,'native warmup did not reach its delayed compile');abort.abort();renderer.destroy();renderer.prepare({device:b});pending[0]();check((await running).status==='cancelled','cancelled warmup status changed');renderer.record(left);reference.prepare({device:b});reference.record(right);await compare('warmup-'+kind+'-new-device',await pixels(b,left.colorTexture),await pixels(b,right.colorTexture));check(renderer.getPipelineCacheDiagnostics().pending===0,'native warmup counter did not settle');}
    finally{pending.forEach(complete=>complete());await running.catch(()=>{});renderer.destroy();reference.destroy();await b.queue.onSubmittedWorkDone();left.destroy();right.destroy();}
  }
}
try {
  const bundle=new URLSearchParams(location.search).get('bundle');check(bundle?.startsWith('/artifacts/'),'Expected a locally built fixture bundle');api=await import(bundle);adapter=await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});check(adapter,'A real WebGPU adapter is required');check(adapter.info?.isFallbackAdapter!==true,'This check requires native GPU pixels');tracker=new api.GPUResourceTracker();
  for(const [group,run] of [['hya',hya],['toon',toon],['warmup',warmup]])try{await run();}catch(error){failures.push({group,error:error.stack??String(error)});}
  for(const gpu of devices){api.disposeSceneFrameGpuArena(gpu);await gpu.queue.onSubmittedWorkDone().catch(()=>{});await settle();api.RendererResourceCache.clear(gpu);const error=await gpu.popErrorScope();if(error)validationErrors.push(error.message);}
  for(let i=0;i<20&&tracker.getUsage().estimatedBytes;i++)await settle();resourceResidue.push(tracker.getUsage());if(resourceResidue.some(value=>value.buffers||value.textures||value.querySets))failures.push({group:'cleanup',error:JSON.stringify(tracker.getUsage()),resources:tracker.getResources()});
  if(validationErrors.length)failures.push({group:'validation',error:validationErrors.join('\n')});
} catch(error) {failures.push({group:'fixture',error:error.stack??String(error)});}
finally {for(const gpu of devices)gpu.destroy();}
node.textContent=JSON.stringify({schemaVersion:1,status:failures.length?'failed':'passed',role:'native-correctness-regression',generatedAt:new Date().toISOString(),browser:navigator.userAgent,adapter:adapter?{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter}:null,width:WIDTH,height:HEIGHT,maximumAllowedChannelDifference:0,cases,failures,validationErrors,resourceResidue,metrics,previews});node.dataset.status=failures.length?'failed':'passed';
