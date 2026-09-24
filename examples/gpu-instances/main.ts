import { HaiyueEngine } from '@haiyue/engine';
import { createBox3D, createRoundedBox3D } from '@haiyue/engine/geometry';
import { GpuComputeProgram, GpuInstanceLod, GpuReadbackRing, InstancedMesh3DRenderer, InstancedToonMaterial, inspectGpuSimulationCapabilities } from '@haiyue/engine/experimental/gpu-driven';
import { PipelineWarmupPlan } from '@haiyue/engine/experimental/renderer';

// This example intentionally teaches experimental low-level compute/render ownership.
const count = 10000, grid = 100;
const identity = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
const resultNode = document.querySelector<HTMLElement>('#result')!;
const progress = document.querySelector<HTMLElement>('#progress')!;
const testing = new URLSearchParams(location.search).has('test');
const engine = new HaiyueEngine({ canvas: document.querySelector<HTMLCanvasElement>('#canvas')!, msaaSamples: 1, reverseZ: false, clearColor: { r: .04, g: .08, b: .09, a: 1 } });
let stop = () => engine.destroy();
window.addEventListener('pagehide', () => stop(), { once: true });
void main().catch(error => { stop(); progress.textContent = '初始化或验证失败'; resultNode.dataset.status = 'failed'; resultNode.textContent = String(error instanceof Error ? error.stack : error); });
async function main() {
  await engine.init();
  const device = engine.device;
  const admission = inspectGpuSimulationCapabilities(device, { stateBytes: count * 64, instanceCount: count });
  if (!admission.supported) throw new Error(`设备容量不足: ${JSON.stringify(admission.checks)}`);
  const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const owned: GPUBuffer[] = [];
  const buffer = (label: string, size: number, usage: GPUBufferUsageFlags) => { const b = device.createBuffer({ label, size, usage }); owned.push(b); return b; };
  const transforms = buffer('GpuExample.transforms', count * 64, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const colors = buffer('GpuExample.colors', count * 16, GPUBufferUsage.STORAGE);
  const clock = buffer('GpuExample.clock', 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const program = new GpuComputeProgram(engine, { label: 'GpuExample.simulation', bindGroupLayoutEntries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
  ], code: `
@group(0) @binding(0) var<storage,read_write> transforms: array<mat4x4<f32>>;
@group(0) @binding(1) var<storage,read_write> colors: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> clock: vec4<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
 let id = invocation.x; if (id >= ${count}u) { return; }
 let bucket = id % 3u;
 let size = select(select(.001, .004, bucket == 1u), .009, bucket == 0u);
 let angle = clock.x + f32(id % 7u) * .1;
 let c = cos(angle) * size; let s = sin(angle) * size;
 transforms[id] = mat4x4<f32>(vec4<f32>(c, 0., s, 0.), vec4<f32>(0., size, 0., 0.), vec4<f32>(-s, 0., c, 0.),
  vec4<f32>(-.98 + f32(id % ${grid}u) * .0198, -.98 + f32(id / ${grid}u) * .0198, .5, 1.));
 colors[id] = select(select(vec4<f32>(.35,.6,1.,1.),vec4<f32>(1.,.65,.3,1.), bucket==1u), vec4<f32>(.4,1.,.6,1.), bucket==0u);
}` });
  const lod = new GpuInstanceLod(engine, count);
  const ring = new GpuReadbackRing(device, lod.strideBytes * 3, 3);
  const renderer = new InstancedMesh3DRenderer(); renderer.prepare(engine);
  const material = new InstancedToonMaterial(1); material.bands = 3; material.ambient = .4;
  const geometries = [createRoundedBox3D({ radius: .15, segments: 2 }), createRoundedBox3D({ radius: .15, segments: 1 }), createBox3D()];
  const commands = geometries.map((geometry, level) => {
    const command = buffer(`GpuExample.draw.${level}`, 20, GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    device.queue.writeBuffer(command, 0, new Uint32Array([geometry.indices!.length, 0, 0, 0, 0])); return command;
  });
  let alive = true, frame = 0, animation = 0;
  stop = () => { if (!alive) return; alive = false; cancelAnimationFrame(animation); ring.destroy(); program.destroy(); renderer.destroy(); lod.destroy(); for (const b of owned) b.destroy(); engine.destroy(); };
  void device.lost.then(() => { if (alive) { stop(); progress.textContent = 'GPU 设备已丢失，请重新初始化。'; } });
  await program.initialize();
  if (!alive) return;
  const group = program.createBindGroup([transforms, colors, clock].map((buffer, binding) => ({ binding, resource: { buffer } })));
  const warmup = new PipelineWarmupPlan('GPU instance example'); renderer.contributePipelineWarmup(warmup); await warmup.run();
  if (!alive) return;
  const sources = geometries.map((_, level) => lod.source(level, transforms, colors));
  const view = { planes: new Float32Array([1,0,0,1, -1,0,0,1, 0,1,0,1, 0,-1,0,1, 0,0,1,0, 0,0,-1,1]), viewMatrix: identity, localSphere: [0,0,0,Math.sqrt(3)/2] as const, projectionPixelScale: 320, perspective: false, nearPixels: 6, middlePixels: 2, hysteresis: .15 };
  const data = new Float32Array(68); data.set(identity); data.set(identity,16); data.set(identity,32); data.set([0,0,2,1,640,640,1/640,1/640],48);
  const snapshot = { frameId: 0, phaseRevision: 0, cameraEntityId: 1, data };
  renderer.updateLighting([{ type: 1, color: [1,1,1], intensity: 1, direction: [-1,-1,-1], position: [0,0,0], range: 1 }], null, 1);
  function encode(time: number, check: boolean, outside = false) {
    const callbacks: ((queue: GPUQueue) => void)[] = [];
    const encoder = device.createCommandEncoder({ label: 'GpuExample.frame' });
    const context = { device, encoder, afterSubmit: (callback: (queue: GPUQueue) => void) => callbacks.push(callback) };
    device.queue.writeBuffer(clock, 0, new Float32Array([time,0,0,0]));
    program.dispatch(context, group, Math.ceil(count / 64));
    lod.encode(context, transforms, count, outside ? { ...view, planes: new Float32Array([1,0,0,-2, ...Array<number>(20).fill(0)]) } : view);
    for (let level = 0; level < 3; level++) lod.encodeDrawCount(context, level, commands[level]!);
    snapshot.frameId = ++frame; renderer.updateCamera(snapshot, context);
    // Manual frame submission must acquire a fresh swapchain view each time.
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: engine.context!.getCurrentTexture().createView(), loadOp: 'clear', clearValue: engine.clearColor, storeOp: 'store' }], depthStencilAttachment: { view: engine.depthTextureView, depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'store' } });
    for (let level = 0; level < 3; level++) renderer.render(pass, level + 1, geometries[level]!, material, { externalInstances: sources[level]!, indirect: true, externalIndirect: { indexedIndirectBuffer: commands[level]!, indexedIndirectOffset: 0, drawIndirectBuffer: commands[level]!, drawIndirectOffset: 0 } });
    pass.end();
    const counts = check ? ring.request(context, lod.counts, 0, 12, frame) : null;
    const indices = check && !outside ? ring.request(context, lod.visibleIndices, 0, lod.strideBytes * 3, frame) : null;
    device.queue.submit([encoder.finish()]); for (const callback of callbacks) callback(device.queue);
    return { counts, indices };
  }
  const first = encode(0, true);
  const firstCounts = await first.counts!; const visible = await first.indices!;
  if (!firstCounts.bytes || !visible.bytes) throw new Error('Initial readback failed');
  const firstValidation = await device.popErrorScope();
  if (firstValidation || errors.length) throw new Error(firstValidation?.message ?? errors.join('\n'));
  device.pushErrorScope('validation');
  const counts = [...new Uint32Array(firstCounts.bytes.buffer)];
  if (JSON.stringify(counts) !== '[3334,3333,3333]') throw new Error(`Wrong LOD counts: ${counts}`);
  const ids = new Set<number>(), words = new Uint32Array(visible.bytes.buffer);
  for (let level = 0; level < 3; level++) for (let i = 0; i < counts[level]!; i++) { const id = words[level * lod.strideBytes / 4 + i]!; if (id % 3 !== level || ids.has(id)) throw new Error('Invalid stable LOD identity'); ids.add(id); }
  if (ids.size !== count) throw new Error('Missing GPU instances');
  const culled = await encode(0, true, true).counts!;
  if (!culled.bytes || new Uint32Array(culled.bytes.buffer).some(n => n !== 0)) throw new Error('Frustum rejection failed');
  encode(0, false);
  await device.queue.onSubmittedWorkDone();
  const validation = await device.popErrorScope();
  if (validation || errors.length) throw new Error(validation?.message ?? errors.join('\n'));
  progress.textContent = '10,000 实例 · 3 次间接绘制 · 每帧 CPU 不读取士兵状态';
  resultNode.textContent = JSON.stringify({ schemaVersion: 1, suite: 'gpu-instances-021', status: 'passed', instanceCount: count, counts, uniqueIds: ids.size, frustumCulled: count, validationErrors: 0, readbackBytes: ring.stats.copiedBytes, device: { vendor: device.adapterInfo.vendor, architecture: device.adapterInfo.architecture, device: device.adapterInfo.device, description: device.adapterInfo.description, isFallbackAdapter: device.adapterInfo.isFallbackAdapter }, performanceQualification: 'correctness-only; not mobile performance evidence' }, null, 2);
  resultNode.dataset.status = 'passed';
  if (testing) { stop(); return; }
  const animate = (time: number) => { if (!alive) return; encode(time * .0003, false); animation = requestAnimationFrame(animate); };
  animation = requestAnimationFrame(animate);
}
