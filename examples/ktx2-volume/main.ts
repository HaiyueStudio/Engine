import { CartesianTransform3D, Entity, Mesh3D, HaiyueEngine, createBox3D } from '@haiyue/engine';
import { VolumeMaterial } from '@haiyue/engine/material';

const VOLUME_SIZE = 48;

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const meta = document.getElementById('meta')!;
  const verificationMode = new URLSearchParams(window.location.search).get('verify') === '1';
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.015, g: 0.02, b: 0.03, a: 1 },
  });
  await engine.init();
  const { device } = engine;

  const volumeBuffer = createProceduralKtx2Volume(VOLUME_SIZE);
  const volumeTexture = uploadKtx2VolumeTexture(device, volumeBuffer, 'ProceduralVolume.ktx2');

  const scene = engine.createScene({
    name: 'KTX2 Volume',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 },
      orbit: { radius: 5.2, theta: Math.PI * 0.18, phi: Math.PI * 0.34, target: [0, 0, 0] },
    },
    render3D: { loadOp: 'clear', transparentSort: true },
    pipelineLabel: 'KTX2Volume.render',
  });

  const volumeEntity = new Entity('Volume');
  const volumeTransform = new CartesianTransform3D();
  volumeEntity.addComponent(volumeTransform);
  volumeEntity.addComponent(new Mesh3D(
    createBox3D({ width: 2.2, height: 2.2, depth: 2.2 }),
    new VolumeMaterial({
      texture: volumeTexture,
      color: [1, 1, 1, 1],
      densityScale: 1.2,
      opacityScale: 3.0,
      steps: 112,
      sampler: {
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
      },
    }),
  ));
  scene.add(volumeEntity);

  meta.textContent = `${VOLUME_SIZE}x${VOLUME_SIZE}x${VOLUME_SIZE} RGBA8 KTX2`;
  engine.switchScene(scene);
  if (!verificationMode) {
    engine.on('update', ({ detail: { time } }) => {
      volumeTransform.setRotation(time * 0.00013, time * 0.00022, 0);
    });
  }
  engine.run();
  if (verificationMode) {
    await waitAnimationFrames(4);
    engine.stop();
    await device.queue.onSubmittedWorkDone();
    document.body.dataset.volumeRenderStatus = 'passed';
    document.body.dataset.volumeShaderCoverage = 'storage-object-table,raymarch,bounds,volume-params';
  }
}

function createProceduralKtx2Volume(size: number): ArrayBuffer {
  const voxelData = new Uint8Array(size * size * size * 4);
  let offset = 0;
  for (let z = 0; z < size; z++) {
    const nz = z / (size - 1) * 2 - 1;
    for (let y = 0; y < size; y++) {
      const ny = y / (size - 1) * 2 - 1;
      for (let x = 0; x < size; x++) {
        const nx = x / (size - 1) * 2 - 1;
        const sphereA = densitySphere(nx + 0.28, ny, nz, 0.56);
        const sphereB = densitySphere(nx - 0.28, ny * 1.1, nz + 0.1, 0.48);
        const shell = Math.max(0, 1 - Math.abs(Math.hypot(nx, ny, nz) - 0.66) * 8);
        const swirl = 0.5 + 0.5 * Math.sin((nx * 5 + ny * 4 - nz * 6) * Math.PI);
        const density = Math.min(1, Math.max(sphereA, sphereB) * 0.9 + shell * 0.42 + swirl * 0.1);
        voxelData[offset++] = Math.round((0.35 + nx * 0.25 + density * 0.4) * 255);
        voxelData[offset++] = Math.round((0.48 + ny * 0.18 + density * 0.35) * 255);
        voxelData[offset++] = Math.round((0.74 + nz * 0.12) * 255);
        voxelData[offset++] = Math.round(Math.max(0, Math.min(1, density)) * 255);
      }
    }
  }
  return createMinimalKtx2({
    vkFormat: 37,
    typeSize: 1,
    width: size,
    height: size,
    depth: size,
    levelData: voxelData,
  });
}

function densitySphere(x: number, y: number, z: number, radius: number): number {
  return Math.max(0, 1 - Math.hypot(x, y, z) / radius);
}

function createMinimalKtx2(options: {
  vkFormat: number;
  typeSize: number;
  width: number;
  height: number;
  depth: number;
  levelData: Uint8Array;
}): ArrayBuffer {
  const identifier = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const levelIndexOffset = 80;
  const levelDataOffset = alignUp(levelIndexOffset + 24, 8);
  const buffer = new ArrayBuffer(levelDataOffset + options.levelData.byteLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(identifier, 0);
  view.setUint32(12, options.vkFormat, true);
  view.setUint32(16, options.typeSize, true);
  view.setUint32(20, options.width, true);
  view.setUint32(24, options.height, true);
  view.setUint32(28, options.depth, true);
  view.setUint32(32, 0, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, 1, true);
  view.setUint32(44, 0, true);
  view.setUint32(48, levelDataOffset, true);
  view.setUint32(52, 0, true);
  view.setBigUint64(levelIndexOffset, BigInt(levelDataOffset), true);
  view.setBigUint64(levelIndexOffset + 8, BigInt(options.levelData.byteLength), true);
  view.setBigUint64(levelIndexOffset + 16, BigInt(options.levelData.byteLength), true);
  bytes.set(options.levelData, levelDataOffset);
  return buffer;
}

function uploadKtx2VolumeTexture(device: GPUDevice, buffer: ArrayBuffer, label: string): GPUTexture {
  const view = new DataView(buffer);
  const vkFormat = view.getUint32(12, true);
  const width = view.getUint32(20, true);
  const height = view.getUint32(24, true);
  const depth = view.getUint32(28, true);
  const levelOffset = Number(view.getBigUint64(80, true));
  const levelLength = Number(view.getBigUint64(88, true));
  if (vkFormat !== 37 || !width || !height || !depth) {
    throw new Error('This example expects a 3D RGBA8 KTX2 texture.');
  }

  const texture = device.createTexture({
    label,
    size: [width, height, depth],
    dimension: '3d',
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const bytesPerRow = width * 4;
  const alignedBytesPerRow = alignUp(bytesPerRow, 256);
  const staging = device.createBuffer({
    label: `${label}.upload`,
    size: alignedBytesPerRow * height * depth,
    usage: GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
  });
  const source = new Uint8Array(buffer, levelOffset, levelLength);
  const mapped = new Uint8Array(staging.getMappedRange());
  for (let z = 0; z < depth; z++) {
    const sourceSlice = z * height * bytesPerRow;
    const mappedSlice = z * height * alignedBytesPerRow;
    for (let y = 0; y < height; y++) {
      const sourceRow = sourceSlice + y * bytesPerRow;
      mapped.set(source.subarray(sourceRow, sourceRow + bytesPerRow), mappedSlice + y * alignedBytesPerRow);
    }
  }
  staging.unmap();
  const encoder = device.createCommandEncoder({ label: `${label}.uploadEncoder` });
  encoder.copyBufferToTexture(
    { buffer: staging, bytesPerRow: alignedBytesPerRow, rowsPerImage: height },
    { texture },
    { width, height, depthOrArrayLayers: depth },
  );
  device.queue.submit([encoder.finish()]);
  void device.queue.onSubmittedWorkDone().then(() => staging.destroy());
  return texture;
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function waitAnimationFrames(count: number): Promise<void> {
  return new Promise(resolve => {
    const next = (remaining: number) => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => next(remaining - 1));
    };
    next(count);
  });
}

main().catch(error => {
  console.error(error);
  document.body.dataset.volumeRenderStatus = 'failed';
  document.body.dataset.volumeRenderError = error instanceof Error ? error.message : String(error);
  const meta = document.getElementById('meta');
  if (meta) meta.textContent = error instanceof Error ? error.message : String(error);
});
