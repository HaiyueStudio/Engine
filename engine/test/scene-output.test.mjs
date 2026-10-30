import assert from 'node:assert/strict';
import test from 'node:test';
import { Entity, Render3DSystem, PostProcessRenderer, RenderView, RttTexture, TransientRenderTargetPool } from '../dist/experimental.js';
import { RttEngine } from '../dist/rtt.js';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {importEngineSource} from './helpers/internal-source.mjs';

test('unsubmitted output records snapshot changed parameters and retire after every recording boundary',async()=>{
 const {SceneOutputPass}=await importEngineSource('postprocess/SceneOutputPass.ts');
 const {setPostProcessSubmission}=await importEngineSource('postprocess/PostProcessSubmission.ts');
 let complete;const done=new Promise(resolve=>{complete=resolve}),writes=[];
 const device=createAuditGpuDevice({behaviors:{'queue.onSubmittedWorkDone':()=>done,'queue.writeBuffer':({args})=>writes.push({buffer:args[0],values:[...new Float32Array(args[2])]})}}),pass=new SceneOutputPass();pass.prepare(device);
 const source=device.createTexture({size:[16,16],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING});
 const scope=()=>{const submit=[],cancel=[];return{submit,cancel,bind:()=>setPostProcessSubmission(pass,cb=>submit.push(cb),cb=>cancel.push(cb))}};
 const encode=(boundary,exposure)=>{boundary.bind();pass.configure('rgba8unorm',exposure,'reinhard');pass.setFrameIdentity(1,'same');pass.apply(device.createCommandEncoder(),source,{},device);setPostProcessSubmission(pass);return pass._bindings.get('same')};
 const a=scope(),b=scope(),c=scope(),first=encode(a,.25),shared=encode(b,.25),next=encode(c,2);
 assert.equal(shared,first,'identical parameters may share an immutable pending binding');assert.notEqual(next.uniform,first.uniform);
 assert.equal(writes.length,2);assert.deepEqual(writes[0].values,[.25,1,1,0]);assert.deepEqual(writes[1].values,[2,1,1,0]);
 pass.destroy();assert.equal(first.uniform.destroyed,false);assert.equal(next.uniform.destroyed,false);
 a.cancel.forEach(cb=>cb());assert.equal(first.uniform.destroyed,false,'another unsubmitted encoder still references the same buffer');
 c.submit.forEach(cb=>cb(device.queue));complete();await done;await Promise.resolve();assert.equal(next.uniform.destroyed,true);assert.equal(first.uniform.destroyed,false);
 b.submit.forEach(cb=>cb(device.queue));await Promise.resolve();assert.equal(first.uniform.destroyed,true);source.destroy();
});

test('successfully submitted output parameters reuse capacity and cancellation releases replaced snapshots',async()=>{
 const {SceneOutputPass}=await importEngineSource('postprocess/SceneOutputPass.ts');const {setPostProcessSubmission}=await importEngineSource('postprocess/PostProcessSubmission.ts');
 const device=createAuditGpuDevice(),pass=new SceneOutputPass();pass.prepare(device);const source=device.createTexture({size:[16,16],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING});
 const submitted=[],cancelled=[];const apply=exposure=>{setPostProcessSubmission(pass,cb=>submitted.push(cb),cb=>cancelled.push(cb));pass.configure('rgba8unorm',exposure,'none');pass.setFrameIdentity(1,'same');pass.apply(device.createCommandEncoder(),source,{},device);setPostProcessSubmission(pass);return pass._bindings.get('same').uniform};
 const first=apply(.5);submitted.splice(0).forEach(cb=>cb(device.queue));const reused=apply(1);assert.equal(reused,first);
 const replacement=apply(2);assert.notEqual(replacement,first);cancelled.splice(0).forEach(cb=>cb());await Promise.resolve();assert.equal(first.destroyed,true);
 pass.destroy();assert.equal(replacement.destroyed,true);source.destroy();
});

test('managed post chains propagate frame cancellation to their output parameter snapshots',async()=>{
 const {SceneOutputPass}=await importEngineSource('postprocess/SceneOutputPass.ts'),{PostProcessRenderer}=await importEngineSource('postprocess/PostProcessRenderer.ts');
 const {setPostProcessFrameCancellation}=await importEngineSource('postprocess/PostProcessSubmission.ts');
 const device=createAuditGpuDevice(),engine={device,width:16,height:16,format:'rgba8unorm'},renderer=new PostProcessRenderer(),pass=new SceneOutputPass(),submitted=[],cancelled=[];
 renderer.prepare(engine);renderer.beginFrame(1,cb=>submitted.push(cb));setPostProcessFrameCancellation(renderer,cb=>cancelled.push(cb));
 pass.configure('rgba8unorm',1,'reinhard');renderer.run(device.createCommandEncoder(),[pass],{}, {frame:{frameId:1,viewKey:'managed'}});
 const uniform=pass._bindings.get('managed').uniform;pass.destroy();assert.equal(uniform.destroyed,false);assert.ok(cancelled.length>0);
 cancelled.forEach(cb=>cb());assert.equal(uniform.destroyed,true,'a cancelled frame must not leave an unsubmitted binding lease forever');renderer.destroy();
});

test('post-chain ping-pong colors remain copyable for clipped output after effects',t=>{
 const {engine}=fixture(t),renderer=new PostProcessRenderer();renderer.prepare(engine);t.after(()=>renderer.destroy());renderer.captureSceneColor(engine.device.createCommandEncoder());
 assert.ok(renderer._buf1.usage&GPUTextureUsage.COPY_SRC,'effect output must be a legal source for the final visible crop');
 assert.ok(renderer._buf1.usage&GPUTextureUsage.COPY_DST,'refraction capture remains a legal destination');
});

function fixture(t, behaviors = {}) {
  const device = createAuditGpuDevice({ behaviors });
  const engine = { device, width: 16, height: 16, format: 'bgra8unorm', defaults: {}, getDepthFormat: () => 'depth24plus' };
  const system = new Render3DSystem(engine, new Entity('camera'), { registerDefaultMaterialRenderers: false });
  t.after(() => system.destroy());
  const output = system._postScenePasses.output;
  output.prepare(device);
  t.after(() => output.destroy());
  const texture = device.createTexture({ size: [16, 16], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  t.after(() => texture.destroy());
  return { device, engine, system, output, texture };
}

test('scene output validates exposure and keeps transfer settings independent for each destination', t => {
  const { output, device, texture } = fixture(t);
  for (const value of [-1, NaN, Infinity]) assert.throws(() => output.configure('bgra8unorm', value, 'reinhard'), RangeError);
  assert.throws(() => output.configure('bgra8unorm', 1, 'aces'), RangeError);
  for (const [key, format, exposure, tone, transfer] of [
    ['display', 'bgra8unorm', .5, 'reinhard', 1], ['capture', 'rgba16float', 2, 'none', 0], ['srgb', 'rgba8unorm-srgb', 1, 'reinhard', 2],
  ]) {
    output.configure(format, exposure, tone);
    output.setSceneTextures({ frame: { frameId: 0, viewKey: key } });
    output.apply(device.createCommandEncoder(), texture, {}, device);
    assert.deepEqual([...output._bindings.get(key).values], [exposure, tone === 'reinhard' ? 1 : 0, transfer, 0]);
  }
  assert.equal(new Set([...output._bindings.values()].map(value => value.uniform)).size, 3);
});

test('unchanged scene output reuses uniforms, bind groups and pipelines across frames', t => {
  let writes = 0;
  const { output, device, texture } = fixture(t, { 'queue.writeBuffer': () => { writes++; } });
  output.configure('bgra8unorm', 1, 'reinhard');
  for (let id = 0; id < 3; id++) {
    output.setSceneTextures({ frame: { frameId: id, viewKey: 'stable' } });
    output.apply(device.createCommandEncoder(), texture, {}, device);
  }
  assert.equal(writes, 1);
  assert.equal(output._bindings.size, 1);
  assert.equal(output._pipelines.size, 1);
});

test('regional linear display intermediates apply exposure/tone without transfer while ordinary HDR captures stay raw',t=>{
 const {output,device,texture}=fixture(t);
 output.configure('rgba16float',2,'reinhard',undefined,true);output.setFrameIdentity(1,'regional');output.apply(device.createCommandEncoder(),texture,{},device);
 assert.deepEqual([...output._bindings.get('regional').values],[2,1,3,0]);
 output.configure('rgba16float',2,'reinhard');output.setFrameIdentity(2,'capture');output.apply(device.createCommandEncoder(),texture,{},device);
 assert.deepEqual([...output._bindings.get('capture').values],[2,1,0,0]);
});

test('expired output uniforms remain alive until the encoding submission completes', async t => {
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const { output, engine, device, texture } = fixture(t, { 'queue.onSubmittedWorkDone': () => completion });
  const renderer = new PostProcessRenderer(); renderer.prepare(engine);
  t.after(() => renderer.destroy());
  const callbacks = [];
  let retired;
  for (const [frameId, viewKey] of [[0, 'old'], [121, 'current']]) {
    renderer.beginFrame(frameId, callback => callbacks.push(callback));
    renderer.run(device.createCommandEncoder(), [output], texture.createView(), { frame: { frameId, viewKey } });
    if (frameId === 0) retired = output._bindings.get('old').uniform;
  }
  assert.equal(output._bindings.has('old'), false);
  assert.equal(retired.destroyed, false);
  for (const callback of callbacks) callback(device.queue);
  assert.equal(retired.destroyed, false);
  complete(); await completion; await Promise.resolve();
  assert.equal(retired.destroyed, true);
});

test('scene output resolves into the display MSAA attachment and keeps its samples for later UI loads', t => {
  const { output, engine, device, texture } = fixture(t);
  const target = new RttEngine(engine, 16, 16); t.after(() => target.destroy());
  const view = new RenderView({ target, sampleCount: 4, loadOp: 'load' }).snapshot();
  output.configure(target.format, 1, 'reinhard', view);
  output.setSceneTextures({ frame: { frameId: 0, viewKey: view.key } });
  const destination = target.getOutputView();
  let descriptor;
  const encoder = device.createCommandEncoder();
  const begin = encoder.beginRenderPass.bind(encoder);
  encoder.beginRenderPass = value => { descriptor = value; return begin(value); };
  output.apply(encoder, texture, destination, device);
  const attachment = descriptor.colorAttachments[0];
  assert.notEqual(attachment.view, destination);
  assert.equal(attachment.resolveTarget, destination);
  assert.equal(attachment.storeOp, 'store');
  assert.equal(attachment.loadOp, 'load');
  assert.equal([...output._pipelines.values()][0].descriptor.multisample.count, 4);
});

for (const sampleCount of [1, 4]) for (const reverseZ of [false, true]) {
  test(`HDR scene preserves target depth for particles (${sampleCount} samples, reverseZ=${reverseZ})`, t => {
    const { engine, device, system } = fixture(t);
    const target = new RttEngine(engine, 16, 16);
    t.after(() => target.destroy());
    const view = new RenderView({
      key: 'particles', target, camera: new Entity('camera'), sampleCount,
      depthConvention: reverseZ ? 'reverse' : 'standard',
    }).snapshot();
    const post = system._postScenePasses;
    post.prepare([], { device, encoder: device.createCommandEncoder(), view }, reverseZ);
    const sceneDescriptor = post.buildScenePassDescriptor('clear', reverseZ, view);
    const destination = target.getRenderPassDescriptor(view);
    assert.equal(sceneDescriptor.depthStencilAttachment.view, destination.depthStencilAttachment.view);
    assert.equal(sceneDescriptor.depthStencilAttachment.depthClearValue, reverseZ ? 0 : 1);
    assert.equal(sceneDescriptor.depthStencilAttachment.depthStoreOp, 'store');
    assert.equal(post._postRenderer.sceneDepthView, destination.depthStencilAttachment.view,
      'outline visibility and later overlays must read the same scene depth');

    const continuation = post.buildScenePassDescriptor('load', reverseZ, view);
    assert.equal(continuation.depthStencilAttachment.view, sceneDescriptor.depthStencilAttachment.view);
    assert.equal(continuation.depthStencilAttachment.depthLoadOp, 'load');
    post.destroy();
    assert.equal(destination.depthStencilAttachment.view.texture.destroyed, false,
      'the post renderer must not destroy borrowed target depth');
  });
}

test('viewport-local HDR depth remains local after a full-target view', t => {
  const { engine, device, system } = fixture(t);
  const target = new RttEngine(engine, 16, 16);
  t.after(() => target.destroy());
  const post = system._postScenePasses;
  const full = new RenderView({ key: 'full', target, camera: new Entity('camera') }).snapshot();
  post.prepare([], { device, encoder: device.createCommandEncoder(), view: full }, false);
  const borrowed = post.buildScenePassDescriptor('clear', false, full).depthStencilAttachment.view;
  const inset = new RenderView({
    key: 'inset', target, camera: full.camera,
    viewport: { x: 4, y: 4, width: 8, height: 8 },
  }).snapshot();
  post.prepare([], { device, encoder: device.createCommandEncoder(), view: inset }, false);
  const local = post.buildScenePassDescriptor('clear', false, inset).depthStencilAttachment.view;
  assert.notEqual(local, borrowed);
  assert.equal(local.texture.width, 8);
  assert.equal(local.texture.height, 8);
  assert.equal(post._postRenderer.sceneDepthView, local);
});

test('an explicit full-target regional viewport retains the depth used by later overlay producers',t=>{
 const {engine,device,system}=fixture(t),target=new RttEngine(engine,16,16);t.after(()=>target.destroy());
 const view=new RenderView({key:'regional-local',target,camera:new Entity(),sampleCount:4,viewport:{x:0,y:0,width:16,height:16}}).snapshot(),post=system._postScenePasses;
 post.prepare([],{device,encoder:device.createCommandEncoder(),view},false);
 assert.equal(post.buildScenePassDescriptor('clear',false,view).depthStencilAttachment.view,target.getRenderPassDescriptor(view).depthStencilAttachment.view);
});

test('HDR RTT format survives resize and cannot alias an UNORM target with equal dimensions', t => {
  const { engine } = fixture(t);
  const rtt = new RttTexture(engine, { width: 16, height: 16, format: 'rgba16float' });
  t.after(() => rtt.destroy());
  rtt.resize(8, 8);
  assert.equal(rtt.textureSource.texture.format, 'rgba16float');
  assert.equal(rtt.engine.format, 'rgba16float');
  const pool = new TransientRenderTargetPool(engine); t.after(() => pool.destroy());
  const assigned = pool.assign(['bgra8unorm', 'rgba16float'].map((format, id) => ({
    id, scope: `output-${id}`, firstUse: id, lastUse: id, payload: null,
    descriptor: { width: 16, height: 16, sampleCount: 1, reverseZ: false, format },
  })));
  assert.notEqual(assigned[0].physicalId, assigned[1].physicalId);
  assert.equal(assigned[1].estimatedBytes - assigned[0].estimatedBytes, 16 * 16 * 4);
});

for (const sampleCount of [1, 4]) {
  test(`output coverage uses destination extent after a clipped view (${sampleCount} samples)`, t => {
    const calls = [];
    const { output, engine, device, texture } = fixture(t, {
      'renderPass.setViewport': ({ args }) => calls.push(['viewport', ...args]),
      'renderPass.setScissorRect': ({ args }) => calls.push(['scissor', ...args]),
      'renderPass.draw': ({ args }) => calls.push(['draw', ...args]),
    });
    // Deliberately different from the 16×16 HDR source: output may be scaled.
    const target = new RttEngine(engine, 32, 24); t.after(() => target.destroy());
    const camera = new Entity('camera');
    const views = [
      new RenderView({ target, camera, sampleCount,
        viewport: { x: 3, y: 4, width: 12, height: 10 },
        scissor: { x: 5, y: 6, width: 8, height: 7 } }),
      new RenderView({ target, camera, sampleCount }),
    ];
    for (const [frameId, view] of views.entries()) {
      output.configure('bgra8unorm', 1, 'none', view.snapshot());
      output.setSceneTextures({ frame: { frameId, viewKey: view.key } });
      output.apply(device.createCommandEncoder(), texture, target.getOutputView(), device);
    }
    assert.deepEqual(calls, [
      ['viewport', 3, 4, 12, 10, 0, 1], ['scissor', 5, 6, 8, 7], ['draw', 3],
      ['viewport', 0, 0, 32, 24, 0, 1], ['scissor', 0, 0, 32, 24], ['draw', 3],
    ]);
  });
}
