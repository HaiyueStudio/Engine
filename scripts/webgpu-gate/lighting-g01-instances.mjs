import { InstancedMesh3DRenderer, InstancedToonMaterial, GpuInstanceLod } from '/engine/dist/experimental/gpu-driven.js';
import { createBox3D } from '/engine/dist/geometry.js';
import { PipelineWarmupPlan, disposeSceneFrameGpuArena } from '/engine/dist/experimental/renderer.js';
import { createRealRendererGpuTimestampProbe } from '../benchmark/real-renderer-scenario.mjs';
import { summarizeTimingSamples } from '../benchmark/timing-cohorts.mjs';

const node = document.querySelector('#result');
try { node.textContent = JSON.stringify(await run()); node.dataset.status = 'passed'; }
catch (error) { node.textContent = error.stack; node.dataset.status = 'failed'; }

async function run() {
  const q = new URLSearchParams(location.search);
  const count = Number(q.get('count') ?? 10000), warmup = Number(q.get('warmup') ?? 120), samples = Number(q.get('samples') ?? 300);
  const powerPreference = q.get('powerPreference') ?? 'high-performance';
  if (![1000,10000].includes(count) || ![warmup,samples].every(n => Number.isInteger(n) && n > 0)) throw new Error('Invalid sampling input');
  if (!['high-performance','low-power'].includes(powerPreference)) throw new Error('Invalid adapter preference');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference });
  if (!adapter) throw new Error('No adapter');
  const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] });
  const buffers = [], textures = [], errors = [];
  const engine = { device, format: 'rgba8unorm', getDepthFormat: () => 'depth24plus' };
  let renderer, lod, probe;
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const buffer = (size, usage) => { const b = device.createBuffer({size,usage}); buffers.push(b); return b; };
  try {
    const color = device.createTexture({size:[1280,720],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT}); textures.push(color);
    const depth = device.createTexture({size:[1280,720],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT}); textures.push(depth);
    const colorView = color.createView(), depthView = depth.createView();
    const transforms = buffer(count*64, GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
    const colors = buffer(count*16, GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
    const identity = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
    const matrices = new Float32Array(count*16), rgba = new Float32Array(count*4);
    const columns = Math.ceil(Math.sqrt(count));
    for (let i=0;i<count;i++) {
      matrices.set(identity,i*16);
      const scale = [.009,.004,.001][i%3];
      matrices[i*16]=matrices[i*16+5]=matrices[i*16+10]=scale;
      matrices[i*16+12]=-.95+(i%columns)*1.9/columns;
      matrices[i*16+13]=-.95+Math.floor(i/columns)*1.9/columns; matrices[i*16+14]=.5;
      rgba.set([.35,.6,1,1],i*4);
    }
    device.queue.writeBuffer(transforms,0,matrices); device.queue.writeBuffer(colors,0,rgba);
    renderer = new InstancedMesh3DRenderer(); renderer.prepare(engine);
    lod = new GpuInstanceLod(engine,count);
    const geometry = createBox3D(), material = new InstancedToonMaterial(1);
    const commands = Array.from({length:3},()=>buffer(20,GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST));
    commands.forEach(b=>device.queue.writeBuffer(b,0,new Uint32Array([geometry.indices.length,0,0,0,0])));
    const sources = commands.map((_,i)=>lod.source(i,transforms,colors));
    const warm = new PipelineWarmupPlan('G01 existing instance pipeline'); renderer.contributePipelineWarmup(warm); await warm.run();
    const view = {planes:new Float32Array([1,0,0,1,-1,0,0,1,0,1,0,1,0,-1,0,1,0,0,1,0,0,0,-1,1]),viewMatrix:identity,localSphere:[0,0,0,Math.sqrt(3)/2],projectionPixelScale:320,perspective:false,nearPixels:6,middlePixels:2,hysteresis:.15};
    const data = new Float32Array(68); data.set(identity);data.set(identity,16);data.set(identity,32);data.set([0,0,2,1,1280,720,1/1280,1/720],48);
    const snapshot = {frameId:0,phaseRevision:0,cameraEntityId:1,data};
    renderer.updateLighting([{type:1,color:[1,1,1],intensity:1,direction:[-1,-1,-1],position:[0,0,0],range:1}],null,1);
    probe = createRealRendererGpuTimestampProbe({device});
    async function frame(timed) {
      const start = performance.now(), callbacks=[];
      const encoder = device.createCommandEncoder({label:'G01.instances'});
      // Reuse the benchmark timestamp recorder for both compute and render descriptors.
      if (timed && probe.supported) {
        probe.beginFrame();
        const begin = encoder.beginComputePass.bind(encoder);
        encoder.beginComputePass = descriptor => begin(probe.decorateRenderPass(descriptor ?? {label:'instance LOD'}));
      }
      const context = {device,encoder,afterSubmit:fn=>callbacks.push(fn)};
      lod.encode(context,transforms,count,view);
      commands.forEach((b,i)=>lod.encodeDrawCount(context,i,b));
      snapshot.frameId++; renderer.updateCamera(snapshot,context);
      const descriptor = {label:'instance draw',colorAttachments:[{view:colorView,loadOp:'clear',clearValue:[0,0,0,1],storeOp:'store'}],depthStencilAttachment:{view:depthView,depthLoadOp:'clear',depthClearValue:1,depthStoreOp:'store'}};
      const pass = encoder.beginRenderPass(timed ? probe.decorateRenderPass(descriptor) : descriptor);
      commands.forEach((b,i)=>renderer.render(pass,i+1,geometry,material,{externalInstances:sources[i],indirect:true,externalIndirect:{indexedIndirectBuffer:b,indexedIndirectOffset:0,drawIndirectBuffer:b,drawIndirectOffset:0}}));
      pass.end(); if (timed) probe.resolve(encoder);
      const command = encoder.finish(), cpuRecord = performance.now()-start;
      const submit = performance.now(); device.queue.submit([command]); callbacks.forEach(fn=>fn(device.queue));
      const cpuSubmit = performance.now()-submit, wait = performance.now();
      await device.queue.onSubmittedWorkDone();
      const frameWall = performance.now()-start, queueWait=performance.now()-wait;
      return {cpuRecord,cpuSubmit,frameWall,queueWait,gpu:timed && probe.supported ? await probe.readFrame():null};
    }
    for(let i=0;i<warmup;i++) await frame(false);
    const cpuRecord=[],cpuSubmit=[],frameWall=[],queueWait=[],gpu=[]; let labels=[];
    // CPU and GPU populations are separate to avoid counting timestamp readback in normal frames.
    for(let i=0;i<samples;i++) {const r=await frame(false);cpuRecord.push(r.cpuRecord);cpuSubmit.push(r.cpuSubmit);frameWall.push(r.frameWall);queueWait.push(r.queueWait);}
    if(probe.supported) for(let i=0;i<samples;i++) {const r=await frame(true);gpu.push(r.gpu.totalMs);labels=r.gpu.passLabels;}
    const read = buffer(12,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
    const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(lod.counts,0,read,0,12);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    const counts=[...new Uint32Array(read.getMappedRange())];read.unmap();
    if(counts.reduce((a,b)=>a+b,0)!==count) throw new Error('Lost instances');
    const error=await device.popErrorScope();if(error||errors.length)throw new Error(error?.message??errors.join(';'));
    return {schemaVersion:1,suite:'lighting.g01.existing-instances',status:'passed',count,counts,resolution:[1280,720],warmup,samples,powerPreference,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},browser:navigator.userAgent,validationErrors:0,scope:'static external matrices; existing LOD+indirect Toon; identical box geometry in all tiers; not simulation or LOD quality/speedup qualification',timing:{cpuRecord:summarizeTimingSamples(cpuRecord),cpuSubmit:summarizeTimingSamples(cpuSubmit),frameWall:summarizeTimingSamples(frameWall),queueWait:summarizeTimingSamples(queueWait),gpuTimestamp:gpu.length?{status:'available',timing:summarizeTimingSamples(gpu),passLabels:labels}:{status:'unavailable',reason:'timestamp-query unavailable'}},normalFrameInstanceReadbackBytes:0};
  } finally {
    probe?.destroy(); renderer?.destroy(); lod?.destroy(); disposeSceneFrameGpuArena(device);
    buffers.forEach(b=>b.destroy());textures.forEach(t=>t.destroy());device.destroy();
  }
}
