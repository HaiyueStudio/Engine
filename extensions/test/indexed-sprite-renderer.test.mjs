import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IndexedSpriteRenderer,
  prepareIndexedSpriteAtlas,
} from '../dist/experimental-indexed-sprite.js';

installGpuConstants();

const palette = (id, red = 255) => ({
  id,
  colorCount: 2,
  rgba: new Uint8Array([0, 0, 0, 0, red, 32, 16, 255]),
});

test('atlas layout is deterministic, preserves indexed planes, converts RGB, and replicates gutters', () => {
  const descriptors = [
    { id: 'z-rgb', width: 1, height: 1, format: 'rgb8', pixels: new Uint8Array([4, 5, 6]) },
    { id: 'a-index', width: 2, height: 1, format: 'indexed8', pixels: new Uint8Array([7, 9]) },
  ];
  const first = prepareIndexedSpriteAtlas(descriptors, [palette('z'), palette('a', 64)], limits());
  const second = prepareIndexedSpriteAtlas([...descriptors].reverse(), [palette('a', 64), palette('z')], limits());

  assert.deepEqual([...first.placements], [...second.placements]);
  assert.deepEqual([...first.paletteRows], [['a', 0], ['z', 1]]);
  assert.equal(typeof first.placements.set, 'undefined');
  assert.equal(first.pages.length, 2);

  const indexed = first.pages.find(page => page.kind === 'indexed');
  const placement = first.placements.get('a-index');
  assert.ok(indexed && placement);
  const row = y => [...indexed.pixels.slice(y * indexed.width, (y + 1) * indexed.width)];
  assert.deepEqual(row(0), [7, 7, 9, 9]);
  assert.deepEqual(row(1), [7, 7, 9, 9]);
  assert.deepEqual(row(2), [7, 7, 9, 9]);

  const color = first.pages.find(page => page.kind === 'color');
  assert.ok(color);
  assert.deepEqual([...color.pixels.slice(0, 4)], [4, 5, 6, 255]);
  assert.equal(first.gpuBytes, first.pages.reduce((total, page) => total + page.pixels.byteLength, 0) + first.palettePixels.byteLength);
});

test('atlas layout rejects duplicate ids, malformed planes, and bounded resource overruns', () => {
  assert.throws(() => prepareIndexedSpriteAtlas([
    { id: 'same', width: 1, height: 1, format: 'indexed8', pixels: new Uint8Array(1) },
    { id: 'same', width: 1, height: 1, format: 'indexed8', pixels: new Uint8Array(1) },
  ], [], limits()), /Duplicate/);
  assert.throws(() => prepareIndexedSpriteAtlas([
    { id: 'bad', width: 2, height: 2, format: 'rgba8', pixels: new Uint8Array(3) },
  ], [], limits()), /byte length/);
  assert.throws(() => prepareIndexedSpriteAtlas([
    { id: 'wide', width: 63, height: 1, format: 'indexed8', pixels: new Uint8Array(63) },
  ], [], limits()), /dimensions/);
  assert.throws(() => prepareIndexedSpriteAtlas([], [palette('a'), palette('b')], { ...limits(), maxPaletteGpuBytes: 1024 }), /palette bank/);
});

test('renderer batches commands, performs bounded uploads, recovers, and disposes once', () => {
  const firstGpu = fakeDevice();
  const renderer = new IndexedSpriteRenderer(firstGpu.device, [
    { id: 'indexed', width: 2, height: 1, format: 'indexed8', pixels: new Uint8Array([0, 1]) },
    { id: 'color', width: 1, height: 1, format: 'rgba8', pixels: new Uint8Array([1, 2, 3, 4]) },
  ], [palette('main')], { targetFormat: 'bgra8unorm', sampleCount: 4, limits: limits() });

  assert.equal(firstGpu.pipelines.length, 3);
  assert.ok(firstGpu.pipelines.every(value => value.layout === firstGpu.pipelineLayouts[0] && value.multisample.count === 4));
  assert.equal(renderer.ready, false);
  renderer.upload(1024);
  assert.equal(renderer.ready, false);
  renderer.uploadAll();
  assert.equal(renderer.ready, true);
  assert.ok(firstGpu.textureWrites.length >= 3);
  assert.ok(firstGpu.textureWrites.every(value => value.layout.bytesPerRow % 256 === 0));

  const pass = fakePass();
  const stats = renderer.render(pass, [
    { spriteId: 'indexed', paletteId: 'main', x: 10, y: 10, priority: 1 },
    { spriteId: 'indexed', paletteId: 'main', x: 20, y: 10, priority: 1 },
    { spriteId: 'color', x: 30, y: 10, priority: 2, blend: 'additive', sampling: 'linear' },
  ], 1280, 720);
  assert.equal(stats.drawCommands, 3);
  assert.equal(stats.drawCalls, 2);
  assert.deepEqual(pass.draws.map(value => [value.instanceCount, value.firstInstance]), [[2, 0], [1, 2]]);

  const replacement = fakeDevice();
  const oldTextures = [...firstGpu.textures];
  renderer.recover(replacement.device);
  assert.equal(renderer.stats().generation, 1);
  assert.equal(renderer.ready, false);
  assert.ok(oldTextures.every(value => value.destroyCount === 1));
  renderer.uploadAll();
  renderer.dispose();
  renderer.dispose();
  assert.ok(replacement.textures.every(value => value.destroyCount === 1));
  assert.equal(renderer.stats().disposed, true);
  assert.throws(() => renderer.uploadAll(), /disposed/);
});

test('renderer validates draw references and indexed palette selection', () => {
  const gpu = fakeDevice();
  const renderer = new IndexedSpriteRenderer(gpu.device, [
    { id: 'indexed', width: 1, height: 1, format: 'indexed8', pixels: new Uint8Array([0]) },
  ], [palette('main')], { targetFormat: 'rgba8unorm', limits: limits() });
  renderer.uploadAll();
  assert.throws(() => renderer.render(fakePass(), [{ spriteId: 'missing', x: 0, y: 0 }], 1920, 1080), /unknown sprite/);
  assert.throws(() => renderer.render(fakePass(), [{ spriteId: 'indexed', x: 0, y: 0 }], 1920, 1080), /paletteId/);
  assert.throws(() => renderer.render(fakePass(), [{ spriteId: 'indexed', paletteId: 'main', x: 0, y: 0, opacity: 2 }], 1920, 1080), /opacity/);
  renderer.dispose();
});

function limits() {
  return {
    maxTextureDimension2D: 64,
    maxAtlasPages: 4,
    maxGpuBytes: 1_000_000,
    maxPaletteGpuBytes: 4096,
    maxUploadBytesPerFrame: 4096,
    maxDrawCommandsPerFrame: 32,
  };
}

function installGpuConstants() {
  globalThis.GPUBufferUsage ??= { UNIFORM: 1, STORAGE: 2, COPY_DST: 4 };
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1, COPY_DST: 2 };
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 };
  globalThis.GPUColorWrite ??= { ALL: 15 };
}

function fakeDevice() {
  const textures = [];
  const buffers = [];
  const pipelines = [];
  const pipelineLayouts = [];
  const textureWrites = [];
  const bufferWrites = [];
  const device = {
    limits: { maxTextureDimension2D: 8192 },
    queue: {
      writeTexture(destination, data, layout, size) { textureWrites.push({ destination, data: data.slice(), layout, size }); },
      writeBuffer(buffer, offset, data) { bufferWrites.push({ buffer, offset, data: new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength).slice() }); },
    },
    createShaderModule(descriptor) { return { descriptor }; },
    createBindGroupLayout(descriptor) { return { descriptor }; },
    createPipelineLayout(descriptor) { const value = { descriptor }; pipelineLayouts.push(value); return value; },
    createRenderPipeline(descriptor) { pipelines.push(descriptor); return { descriptor }; },
    createBuffer(descriptor) { const value = destroyable(descriptor); buffers.push(value); return value; },
    createSampler(descriptor) { return { descriptor }; },
    createTexture(descriptor) {
      const value = { ...destroyable(descriptor), createView() { return { texture: value }; } };
      textures.push(value);
      return value;
    },
    createBindGroup(descriptor) { return { descriptor }; },
  };
  return { device, textures, buffers, pipelines, pipelineLayouts, textureWrites, bufferWrites };
}

function destroyable(descriptor) {
  return { descriptor, destroyCount: 0, destroy() { this.destroyCount++; } };
}

function fakePass() {
  return {
    pipelines: [], bindGroups: [], draws: [],
    setPipeline(value) { this.pipelines.push(value); },
    setBindGroup(index, value) { this.bindGroups.push({ index, value }); },
    draw(vertexCount, instanceCount, firstVertex, firstInstance) { this.draws.push({ vertexCount, instanceCount, firstVertex, firstInstance }); },
  };
}
