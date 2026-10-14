import { createProductionScene } from './framegraph-production-scene.mjs';
import { RenderGraph } from '../../engine/src/core/RenderGraph.ts';
import { getDeferredLightingBackend } from '../../engine/src/renderer/DeferredLightingBackendPort.ts';
import { getSequentialAttachmentAllocator } from '../../engine/src/rtt/TransientAttachmentSequence.ts';
import { getEngineGPUResourceTracker, getEngineFrameDiagnostics } from '../../engine/src/core/EngineDiagnosticsAccess.ts';
import { RealRendererGpuTimestampProbe } from '../benchmark/real-renderer-gpu-timestamp.mjs';

window.startAblation = async (spec, variant, sampling) => {
  const raw = { schemaVersion: 1, status: 'running', caseId: spec.id, variant, sampling, startedAt: new Date().toISOString(), errors: [], cpu: [], gpu: [], loading: [] };
  window.studySnapshot=()=>({...raw,visible:document.visibilityState,focused:document.hasFocus(),observedAt:new Date().toISOString()});
  let scene, probe;
  try {
    const level = ['A','B1','B2','B3','B4'].indexOf(variant);
    if (level < 0) throw Error('Unknown ablation variant');
    const add = RenderGraph.prototype.addPass;
    if (level === 0) RenderGraph.prototype.addPass = function(options) { return add.call(this, { ...options, sideEffect: true }); };
    scene = await createTimestampScene(document.querySelector('#canvas'), spec);
    const engine = scene.engine, device = engine.device, system = engine.activeScene.render3DSystem;
    // The injected device feature also enables the engine's profiler. This
    // private study owns all timestamps; disable the competing profiler before
    // the first draw, equally for every variant. CPU/resource diagnostics stay on.
    engine._timestampQuerySupported = false;
    const tracker = getEngineGPUResourceTracker(engine), diagnostics = getEngineFrameDiagnostics(engine);
    const backend = getDeferredLightingBackend(system);
    raw.adapter = { vendor: engine.adapter.info.vendor, architecture: engine.adapter.info.architecture, isFallbackAdapter: engine.adapter.info.isFallbackAdapter };
    device.addEventListener('uncapturederror', e => raw.errors.push(e.error.message));
    function owners() {
      const post = system._postScenePasses, coordinator = system._frameCoordinator;
      const caches = { view: coordinator.viewPlan.cache, scene: coordinator.sceneGlobalPlan.cache, requirements: post._requirementsGraph.cache };
      const pools = {};
      if (post._postRenderer) {
        caches.post = post._postRenderer._graph.cache; pools.post = post._postRenderer._transientTextures;
        caches.postAllocation = pools.post.planCache;
      }
      if (backend) {
        caches.deferred = backend._plan.cache;
        pools.ao = backend._ambientOcclusion._transientTextures; caches.aoAllocation = pools.ao.planCache;
        const mrt = getSequentialAttachmentAllocator(backend._pool);
        if (mrt) { pools.mrt = mrt; caches.mrtAllocation = mrt.planCache; }
      }
      const graphs = { view:coordinator.viewPlan, scene:coordinator.sceneGlobalPlan, requirements:post._requirementsGraph };
      if (post._postRenderer) graphs.post = post._postRenderer._graph;
      if (backend) graphs.deferred = backend._plan;
      return { caches, pools, graphs };
    }
    function configure() {
      system._postScenePasses._attachmentOptimizations = level >= 4;
      const { caches, pools } = owners();
      for (const cache of Object.values(caches)) cache.enabled = level >= 3;
      for (const pool of Object.values(pools)) pool.reuse = level >= 2;
    }
    function snapshot() {
      const { caches, pools, graphs } = owners();
      return { ...scene.snapshot(), tracked: tracker.getDebugSnapshot().byType,
        controls: { forceEnabledPassRoots:level===0, attachment:system._postScenePasses._attachmentOptimizations,
          caches:Object.fromEntries(Object.entries(caches).map(([k,c])=>[k,c.enabled])), pools:Object.fromEntries(Object.entries(pools).map(([k,p])=>[k,p.reuse])) },
        graphs: Object.fromEntries(Object.entries(graphs).map(([k,g])=>[k,{...g.stats}])),
        caches: Object.fromEntries(Object.entries(caches).map(([k,c]) => [k,{...c.stats}])),
        pools: Object.fromEntries(Object.entries(pools).map(([k,p]) => [k,{...p.stats}])) };
    }
    let frameIndex = 0, start = 0, mode = 'loading', fixed = false;
    engine.on('update', () => { start = performance.now(); configure(); scene.update(fixed ? 0 : frameIndex++ * 1000 / 60); });
    const oneFrame = () => new Promise((resolve,reject) => {
      const fail=e=>{engine.stop();engine.off('after-update',done);reject(e.error??Error(e.message));};
      const done=({detail:{time}})=>{window.removeEventListener('error',fail);engine.stop();resolve({time,cpuMs:performance.now()-start,visible:document.visibilityState,focused:document.hasFocus(),counters:{...diagnostics.snapshot().counters}});};
      window.addEventListener('error',fail,{once:true});engine.once('after-update',done);
      engine.run();
    });
    // Allocate lazy owners, then repeat with the selected controls in force.
    for (let i=0;i<3;i++) { raw.loading.push(await oneFrame()); await device.queue.onSubmittedWorkDone(); }
    raw.before = snapshot(); mode = 'cpu';
    await new Promise((resolve,reject) => {
      let frames = 0;
      const fail=e=>{engine.stop();engine.off('after-update',onFrame);reject(e.error??Error(e.message));};
      const onFrame = ({detail:{time}}) => {
        const row = {time,cpuMs:performance.now()-start,visible:document.visibilityState,focused:document.hasFocus(),counters:{...diagnostics.snapshot().counters}};
        if (frames++ >= sampling.warmupFrames) raw.cpu.push(row);
        if (raw.cpu.length === sampling.cpuFrames) { engine.stop(); engine.off('after-update',onFrame); window.removeEventListener('error',fail);resolve(); }
      };
      window.addEventListener('error',fail,{once:true});engine.on('after-update',onFrame); engine.run();
    });
    await device.queue.onSubmittedWorkDone(); raw.afterCpu = snapshot();
    probe = new RealRendererGpuTimestampProbe(device,{includeCompute:true});
    if (!probe.supported) throw Error('Native timestamp-query required');
    const originalEncoder = device.createCommandEncoder.bind(device);
    Object.defineProperty(device,'createCommandEncoder',{configurable:true,value:descriptor=>{
      const encoder=originalEncoder(descriptor), render=encoder.beginRenderPass.bind(encoder),compute=encoder.beginComputePass.bind(encoder);
      const decorate=(d,kind)=>{
        if(mode!=='gpu')return d;
        if(d.timestampWrites)throw Error('Competing timestamp recorder in ablation study');
        return kind==='render'?probe.decorateRenderPass(d):probe.decorateComputePass(d);
      };
      Object.defineProperty(encoder,'beginRenderPass',{configurable:true,value:d=>render(decorate(d,'render'))});
      Object.defineProperty(encoder,'beginComputePass',{configurable:true,value:(d={})=>compute(decorate(d,'compute'))});
      return encoder;
    }});
    mode='gpu';
    for(let i=-sampling.gpuWarmupFrames;i<sampling.gpuFrames;i++) {
      probe.beginFrame(); const row=await oneFrame(), encoder=originalEncoder(); probe.resolve(encoder); device.queue.submit([encoder.finish()]);
      const wait=performance.now(); await device.queue.onSubmittedWorkDone(); row.queueWaitMs=performance.now()-wait;
      const read=performance.now(); row.timing=await probe.readFrame(); row.readbackMs=performance.now()-read;
      if(i>=0)raw.gpu.push(row);
    }
    mode='parity'; fixed=true;
    for(const pass of system.passes) pass.resetHistory?.();
    for(let i=0;i<3;i++){await oneFrame();await device.queue.onSubmittedWorkDone();}
    raw.final=snapshot(); raw.status='captured';
  } catch(error) { raw.status='failed';raw.error=error.stack; }
  finally { scene?.engine.stop(); }
  window.finishAblation=()=>{
    probe?.destroy(); if(scene){scene.dispose();raw.cleanup=scene.cleanup();}
    raw.finishedAt=new Date().toISOString();const node=document.querySelector('#result');node.textContent=JSON.stringify(raw);node.dataset.status=raw.status;
  };
  window.ablationReady=true;
};

async function createTimestampScene(canvas,spec) {
  const gpu=navigator.gpu, original=Object.getOwnPropertyDescriptor(gpu,'requestAdapter'), request=gpu.requestAdapter.bind(gpu);
  Object.defineProperty(gpu,'requestAdapter',{configurable:true,value:async options=>{
    const adapter=await request(options);
    if(!adapter?.features.has('timestamp-query'))throw Error('Native timestamp-query required');
    const requestDevice=adapter.requestDevice.bind(adapter);
    Object.defineProperty(adapter,'requestDevice',{configurable:true,value:(descriptor={})=>requestDevice({...descriptor,
      requiredFeatures:[...new Set([...(descriptor.requiredFeatures??[]),'timestamp-query'])]})});
    return adapter;
  }});
  try { return await createProductionScene(canvas,spec); }
  finally { if(original)Object.defineProperty(gpu,'requestAdapter',original);else delete gpu.requestAdapter; }
}
