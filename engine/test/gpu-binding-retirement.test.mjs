import assert from 'node:assert/strict';
import test from 'node:test';
import { Entity, Geometry3D, Render3DSystem, GPUResourceTracker, FrameDiagnostics,
  registerEngineDiagnostics, PlanarMirrorRenderer, PlanarMirrorMaterial } from '../dist/experimental.js';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';

const identity = () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
function fixture(t, behaviors = {}) {
  const device = createAuditGpuDevice({ behaviors });
  const tracker = new GPUResourceTracker({ debug: true });
  tracker.instrumentDevice(device, tracker.createScope('engine', 'test').owner);
  const engine = { device, width:16, height:16, format:'bgra8unorm', defaults:{}, getDepthFormat:()=> 'depth24plus' };
  registerEngineDiagnostics(engine, { resourceTracker: tracker, frameDiagnostics: new FrameDiagnostics() });
  const system = new Render3DSystem(engine, new Entity('camera'), { registerDefaultMaterialRenderers:false });
  t.after(() => { system.destroy(); tracker.releaseAll(); });
  const groups = () => tracker.getDebugSnapshot().byType['bind-group']?.current ?? 0;
  return { device, engine, tracker, system, groups };
}

test('motion entity binding records retire with their buffers after pending submission', async t => {
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const f = fixture(t, { 'queue.onSubmittedWorkDone': () => completion });
  const motion = f.system._postScenePasses._requireMotionVectorRenderer();
  const geometry = new Geometry3D({ positions:new Float32Array([0,0,0,1,0,0,0,1,0]) });
  const data = new Float32Array(68); data.set(identity()); data.set([16,16,1/16,1/16],52);
  const callbacks=[];
  const render = (frameId, visible) => {
    const options={viewKey:'main',frameId,cameraId:1,historyRevision:0,near:.1,far:100,isOrthographic:false,projectionJitter:[0,0]};
    motion.beginView({ data,frameId,phaseRevision:frameId,cameraEntityId:1 },options,{afterSubmit:cb=>callbacks.push(cb)});
    if(visible) { const pass=f.device.createCommandEncoder().beginRenderPass({colorAttachments:[]}); motion.render(pass,1,geometry,identity()); pass.end(); }
    motion.endView(options);
  };
  render(1,true);
  const entity=motion._views.get('main').entities.get(1), withEntity=f.groups();
  render(2,false);
  for(const cb of callbacks.splice(0)) cb(f.device.queue);
  assert.equal(entity.buffer.destroyed,false);
  assert.equal(f.groups(),withEntity,'pending ownership remains visible');
  complete(); await completion; await Promise.resolve();
  assert.equal(entity.buffer.destroyed,true);
  assert.equal(f.groups(),withEntity-1,'retired object binding must not stay strongly held by the tracker');
  for(let i=3;i<103;i+=2) {
    render(i,true); render(i+1,false);
    for(const cb of callbacks.splice(0)) cb(f.device.queue);
    await Promise.resolve();
    assert.equal(f.groups(),withEntity-1,'visibility churn stays bounded');
  }
});

test('mirror texture replacements and cache sweeps release obsolete binding records', t => {
  const f=fixture(t), renderer=new PlanarMirrorRenderer(); renderer.prepare(f.engine);
  t.after(()=>renderer.destroy());
  const material=new PlanarMirrorMaterial(), matrix=identity();
  renderer.activeViewKey='main';
  const texture=f.device.createTexture({size:[16,16],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING});
  material.setReflection('main',texture,0,matrix);
  renderer.ensureMaterial(material); renderer.ensureEntity(1,matrix);
  const baseline=f.groups();
  for(let version=1;version<=100;version++) {
    material.setReflection('main',texture,version,matrix); renderer.ensureMaterial(material);
    assert.equal(f.groups(),baseline,'replaced groups are not owned by diagnostics');
  }
  renderer.viewGeneration=1000; renderer.sweepCaches();
  assert.equal(f.groups(),baseline-2,'evicted entity and material groups are released');
});

test('scene output source changes release old groups without destroying borrowed textures', t => {
  const f=fixture(t), output=f.system._postScenePasses.output;
  output.prepare(f.device); output.configure('bgra8unorm',1,'reinhard');
  const textures=[0,1].map(()=>f.device.createTexture({size:[16,16],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING}));
  const before=f.groups();
  for(let frameId=0;frameId<100;frameId++) {
    output.setSceneTextures({frame:{frameId,viewKey:'main'}});
    output.apply(f.device.createCommandEncoder(),textures[frameId%2],{},f.device);
    assert.equal(f.groups(),before+1);
  }
  output.destroy();
  assert.equal(f.groups(),before);
  assert.ok(textures.every(texture=>!texture.destroyed),'borrowed sources remain alive');
});
