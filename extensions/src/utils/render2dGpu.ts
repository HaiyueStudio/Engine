import { estimateTextureBytes, type ExtensionGPUResourceTracker } from '@haiyue/engine/extension-authoring';

export interface Camera2DGpu {
  layout: GPUBindGroupLayout;
  buffer: GPUBuffer;
  tracker?: ExtensionGPUResourceTracker;
  bindGroup: GPUBindGroup;
}

export interface Object2DGpu {
  buffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  snapshot: Float32Array;
  tracker?: ExtensionGPUResourceTracker;
}

export interface Texture2DGpu {
  layout: GPUBindGroupLayout;
  sampler: GPUSampler;
  fallbackTexture: GPUTexture;
  fallbackBindGroup: GPUBindGroup;
  tracker?: ExtensionGPUResourceTracker;
}

export function createCamera2DLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
  });
}

export function createCamera2DGpu(
  device: GPUDevice,
  tracker?: ExtensionGPUResourceTracker,
  layout = createCamera2DLayout(device),
): Camera2DGpu {
  const buffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  tracker?.trackBuffer(buffer, 'render2d.cameraBuffer', 64);
  const bindGroup = device.createBindGroup({
    layout,
    entries: [{ binding: 0, resource: { buffer } }],
  });
  return { layout, buffer, bindGroup, ...(tracker === undefined ? {} : { tracker }) };
}

export function createObject2DLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
  });
}

export function createObject2DGpu(device: GPUDevice, layout: GPUBindGroupLayout, tracker?: ExtensionGPUResourceTracker): Object2DGpu {
  const buffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  tracker?.trackBuffer(buffer, 'render2d.objectBuffer', 64);
  return {
    buffer,
    bindGroup: device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer } }],
    }),
    snapshot: createMatrixSnapshot(),
    ...(tracker === undefined ? {} : { tracker }),
  };
}

export function createTexture2DGpu(device: GPUDevice, fallbackAlpha = 255, tracker?: ExtensionGPUResourceTracker): Texture2DGpu {
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const fallbackTexture = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  tracker?.trackTexture(fallbackTexture, 'render2d.fallbackTexture', estimateTextureBytes([1, 1, 1], 'rgba8unorm'));
  device.queue.writeTexture(
    { texture: fallbackTexture },
    new Uint8Array([255, 255, 255, fallbackAlpha]),
    { bytesPerRow: 4 },
    [1, 1],
  );
  const fallbackBindGroup = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: fallbackTexture.createView() },
      { binding: 1, resource: sampler },
    ],
  });
  return { layout, sampler, fallbackTexture, fallbackBindGroup, ...(tracker === undefined ? {} : { tracker }) };
}

export function writeFloatBuffer(queue: GPUQueue, buffer: GPUBuffer, data: Float32Array): void {
  queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
}

export function matrixEquals(a: Float32Array, b: Float32Array): boolean {
  for (let i = 0; i < 16; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function createMatrixSnapshot(): Float32Array {
  const snapshot = new Float32Array(16);
  snapshot.fill(Number.NaN);
  return snapshot;
}

export function writeObjectMatrixIfChanged(queue: GPUQueue, gpu: Object2DGpu, matrix: Float32Array): boolean {
  if (matrixEquals(gpu.snapshot, matrix)) return false;
  writeFloatBuffer(queue, gpu.buffer, matrix);
  gpu.snapshot.set(matrix);
  return true;
}

export function destroyCamera2DGpu(gpu: Camera2DGpu): void {
  gpu.tracker?.untrackBuffer(gpu.buffer);
  gpu.buffer.destroy();
}

export function destroyObject2DGpu(gpu: Object2DGpu): void {
  gpu.tracker?.untrackBuffer(gpu.buffer);
  gpu.buffer.destroy();
}

export function destroyTexture2DGpu(gpu: Texture2DGpu): void {
  gpu.tracker?.untrackTexture(gpu.fallbackTexture);
  gpu.fallbackTexture.destroy();
}
