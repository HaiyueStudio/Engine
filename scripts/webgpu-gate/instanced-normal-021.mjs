import { InstancedMesh3DRenderer, InstancedToonMaterial, GpuInstanceLod } from '/engine/dist/experimental/gpu-driven.js';
import { Geometry3D } from '/engine/dist/geometry.js';
const node = document.querySelector('#result');
try { node.textContent = JSON.stringify(await run()); node.dataset.status = 'passed'; }
catch (error) { node.textContent = String(error.stack ?? error); node.dataset.status = 'failed'; }
async function run() {
  const adapter = await navigator.gpu.requestAdapter(); if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice(), errors = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const color = device.createTexture({ size: [64,64], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const depth = device.createTexture({ size: [64,64], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const read = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const engine = { device, format: 'rgba8unorm', getDepthFormat: () => 'depth24plus' };
  const renderer = new InstancedMesh3DRenderer(); renderer.prepare(engine);
  const normal = Math.SQRT1_2;
  const geometry = new Geometry3D({ positions: new Float32Array([-.4,-.8,.5, .4,-.8,.5, 0,.8,.5]), normals: new Float32Array([normal,normal,0, normal,normal,0, normal,normal,0]), cullMode: 'none' });
  const material = new InstancedToonMaterial(1); material.bands = 4; material.ambient = .2;
  const identity = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  const data = new Float32Array(68); data.set(identity); data.set(identity,16); data.set(identity,32); data.set([0,0,2,1,64,64,1/64,1/64],48);
  const snapshot = { frameId: 1, phaseRevision: 0, cameraEntityId: 1, data };
  async function pixel(scaleX, direction, light = true) {
    const model = identity.slice(); model[0] = scaleX; material.setTransform(0,model);
    renderer.updateCamera(snapshot); snapshot.frameId++;
    renderer.updateLighting(light ? [{ type: 1, color: [1,1,1], intensity: 1, direction, position: [0,0,0], range: 1 }] : [], null, snapshot.frameId);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: color.createView(), loadOp: 'clear', clearValue: [0,0,0,1], storeOp: 'store' }], depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'store' } });
    renderer.render(pass, 1, geometry, material); pass.end();
    encoder.copyTextureToBuffer({ texture: color, origin: [32,32] }, { buffer: read, bytesPerRow: 256 }, [1,1]);
    device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ); const value = new Uint8Array(read.getMappedRange())[0]; read.unmap(); return value;
  }
  const nonUniform = await pixel(2,[0,-1,0]);
  const mirrored = await pixel(-2,[1,0,0]);
  const ambient = await pixel(2,[0,-1,0],false);
  // Inverse-transpose: (1,1,0) -> (.447,.894,0), mirrored -> (-.447,.894,0).
  // Four toon bands yield 1.0, 1/3, 0 respectively before ambient mixing.
  for (const [name,actual,expected] of [['nonUniform',nonUniform,255],['mirrored',mirrored,119],['ambient',ambient,51]]) if (Math.abs(actual-expected)>2) throw new Error(`${name}: ${actual}, expected ${expected}`);
  // Orthographic hysteresis: keep the bucket around the threshold, then cross it;
  // a large change must jump two tiers without losing the stable ID.
  const transforms = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const historyRead = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const lod = new GpuInstanceLod(engine,1), levels = [];
  const view = { planes: new Float32Array(24), viewMatrix: identity, localSphere: [0,0,0,1], projectionPixelScale: 1, perspective: false, nearPixels: 48, middlePixels: 16, hysteresis: .15 };
  for (const height of [60,46,40,14,12,60]) {
    const model = identity.slice(); model[0] = model[5] = model[10] = height/(2*Math.sqrt(3)); device.queue.writeBuffer(transforms,0,model);
    const encoder = device.createCommandEncoder(); lod.encode({ device,encoder },transforms,1,view); encoder.copyBufferToBuffer(lod.levels,0,historyRead,0,4); device.queue.submit([encoder.finish()]);
    await historyRead.mapAsync(GPUMapMode.READ); levels.push(new Uint32Array(historyRead.getMappedRange())[0]); historyRead.unmap();
  }
  if (JSON.stringify(levels)!=='[0,0,1,1,2,0]') throw new Error(`LOD hysteresis: ${levels}`);
  const validation = await device.popErrorScope(); if (validation || errors.length) throw new Error(validation?.message ?? errors.join(';'));
  renderer.destroy(); lod.destroy(); for (const b of [transforms,historyRead,read]) b.destroy(); color.destroy(); depth.destroy(); device.destroy();
  return { device: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter }, suite: 'instanced-normal-021', status: 'passed', nonUniform, mirrored, ambient, hysteresis: levels, validationErrors: 0 };
}
