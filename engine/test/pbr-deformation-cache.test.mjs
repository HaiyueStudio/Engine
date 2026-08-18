import assert from 'node:assert/strict';
import test from 'node:test';
import { Geometry3D } from '../dist/index.js';
import { PbrRenderer } from '../dist/renderer.js';

function createEngine(log) {
  globalThis.GPUBufferUsage ??= { COPY_DST: 1, UNIFORM: 2, STORAGE: 4, VERTEX: 8, INDEX: 16 };
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 };
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 };
  let nextId = 1;
  const device = {
    features: new Set(),
    queue: {
      writeBuffer(buffer) { log.push(['writeBuffer', buffer.descriptor.label]); },
      writeTexture() {},
    },
    createBuffer(descriptor) {
      const buffer = {
        id: `buffer-${nextId++}`,
        descriptor,
        destroyed: false,
        destroy() { this.destroyed = true; },
      };
      log.push(['createBuffer', descriptor.label, buffer]);
      return buffer;
    },
    createTexture(descriptor) {
      return {
        descriptor,
        destroyed: false,
        createView(viewDescriptor) { return { texture: this, descriptor: viewDescriptor }; },
        destroy() { this.destroyed = true; },
      };
    },
    createSampler(descriptor = {}) { return { descriptor }; },
    createBindGroupLayout(descriptor) { return { descriptor }; },
    createPipelineLayout(descriptor) { return { descriptor }; },
    createShaderModule(descriptor) { return { descriptor }; },
    createBindGroup(descriptor) { return { id: `bind-${nextId++}`, descriptor }; },
    createRenderPipeline(descriptor) { return { descriptor }; },
  };
  return {
    device,
    assetManager: { loadTexture: async () => { throw new Error('not used'); } },
    defaults: {},
    format: 'bgra8unorm',
    reverseZ: false,
    msaaSamples: 1,
    getDepthFormat() { return 'depth24plus'; },
  };
}

function identityMatrix() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

test('PBR deformation owner deduplicates multi-view skin uploads and releases all buffers', () => {
  const log = [];
  const engine = createEngine(log);
  const renderer = new PbrRenderer();
  renderer.prepare(engine);
  const cache = renderer._deformationCache;
  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    morphTargets: [{ positions: new Float32Array([0, 0, 0, 0.2, 0, 0, 0, 0.2, 0]) }],
    morphWeights: [0.25],
    skinning: {
      joints: new Float32Array(12),
      weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      jointMatrices: identityMatrix(),
    },
  });

  const first = cache.ensure(geometry);
  const initialSkinWrites = log.filter(entry => entry[0] === 'writeBuffer'
    && entry[1] === 'PbrRenderer.skinMatrices').length;
  assert.equal(cache.ensure(geometry), first, 'a second view reuses one deformation allocation');
  assert.equal(log.filter(entry => entry[0] === 'writeBuffer'
    && entry[1] === 'PbrRenderer.skinMatrices').length, initialSkinWrites, 'unchanged pose is not uploaded per view');

  geometry.updateSkinningMatrices(identityMatrix());
  cache.ensure(geometry);
  assert.equal(log.filter(entry => entry[0] === 'writeBuffer'
    && entry[1] === 'PbrRenderer.skinMatrices').length, initialSkinWrites + 1);

  const ownedBuffers = [
    ...new Set(first.morphBuffers),
    first.skinMatrixBuffer,
    first.skinJointBuffer,
    first.skinWeightBuffer,
  ].filter(Boolean);
  renderer.releaseGeometriesNotIn(new Set());
  assert.equal(ownedBuffers.every(buffer => buffer.destroyed), true);

  const oldOwner = renderer._deformationCache;
  renderer.destroy();
  assert.equal(oldOwner.fallbackSkinMatrixBuffer.destroyed, true);
  renderer.prepare(engine);
  assert.notEqual(renderer._deformationCache, oldOwner, 'device recovery creates a fresh GPU resource owner');
  renderer.destroy();
});
