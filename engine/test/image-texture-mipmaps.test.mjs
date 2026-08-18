import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetManager, EngineErrorCode } from '../dist/experimental.js';

function ensureGpuConstants() {
  globalThis.GPUTextureUsage ??= {
    TEXTURE_BINDING: 1 << 0,
    COPY_DST: 1 << 1,
    RENDER_ATTACHMENT: 1 << 2,
  };
}

function createMipmapDevice(log) {
  let textureId = 0;
  let pipelineId = 0;
  return {
    queue: {
      copyExternalImageToTexture(source, destination, size) {
        log.push(['copyExternalImageToTexture', source, destination, size]);
      },
      submit(commandBuffers) {
        log.push(['submit', commandBuffers]);
      },
      onSubmittedWorkDone() { return Promise.resolve(); },
    },
    createTexture(descriptor) {
      const texture = {
        id: ++textureId,
        descriptor,
        mipLevelCount: descriptor.mipLevelCount,
        createView(viewDescriptor = {}) {
          const view = { texture, descriptor: viewDescriptor };
          log.push(['createView', texture.id, viewDescriptor]);
          return view;
        },
        destroy() { log.push(['destroyTexture', texture.id]); },
      };
      log.push(['createTexture', texture.id, descriptor]);
      return texture;
    },
    createSampler(descriptor) {
      log.push(['createSampler', descriptor]);
      return { descriptor };
    },
    createShaderModule(descriptor) {
      log.push(['createShaderModule', descriptor]);
      return { descriptor };
    },
    createBindGroupLayout(descriptor) {
      log.push(['createBindGroupLayout', descriptor]);
      return { descriptor };
    },
    createPipelineLayout(descriptor) {
      log.push(['createPipelineLayout', descriptor]);
      return { descriptor };
    },
    createRenderPipeline(descriptor) {
      const pipeline = {
        id: ++pipelineId,
        descriptor,
        getBindGroupLayout(index) { return { pipeline: this.id, index }; },
      };
      log.push(['createRenderPipeline', pipeline.id, descriptor]);
      return pipeline;
    },
    createBindGroup(descriptor) {
      log.push(['createBindGroup', descriptor]);
      return { descriptor };
    },
    createCommandEncoder(descriptor) {
      log.push(['createCommandEncoder', descriptor]);
      const passes = [];
      return {
        beginRenderPass(passDescriptor) {
          const commands = [];
          passes.push({ descriptor: passDescriptor, commands });
          log.push(['beginRenderPass', passDescriptor]);
          return {
            setPipeline(pipeline) { commands.push(['setPipeline', pipeline.id]); },
            setBindGroup(index, bindGroup) { commands.push(['setBindGroup', index, bindGroup]); },
            draw(vertexCount) { commands.push(['draw', vertexCount]); },
            end() { commands.push(['end']); },
          };
        },
        finish() {
          const commandBuffer = { passes };
          log.push(['finish', commandBuffer]);
          return commandBuffer;
        },
      };
    },
  };
}

test('AssetManager generates and submits a complete ordinary-image mip chain', async () => {
  ensureGpuConstants();
  const log = [];
  const manager = new AssetManager(createMipmapDevice(log));
  const source = { width: 8, height: 4 };
  const handle = await manager.loadTexture(source, {
    label: 'albedo',
    format: 'rgba8unorm-srgb',
    mipmaps: 'generate',
  });

  assert.equal(handle.value.descriptor.mipLevelCount, 4);
  assert.equal(handle.value.descriptor.format, 'rgba8unorm-srgb');
  assert.equal(log.filter(entry => entry[0] === 'copyExternalImageToTexture').length, 1);
  const passes = log.filter(entry => entry[0] === 'beginRenderPass');
  assert.equal(passes.length, 3);
  assert.deepEqual(
    passes.map(entry => entry[1].colorAttachments[0].view.descriptor.baseMipLevel),
    [1, 2, 3],
  );
  assert.equal(log.filter(entry => entry[0] === 'submit').length, 1);
  assert.equal(log.filter(entry => entry[0] === 'createRenderPipeline').length, 1);
  handle.release();
});

test('texture cache identity includes image format and mip policy while equivalent requests deduplicate', async () => {
  ensureGpuConstants();
  const log = [];
  const manager = new AssetManager(createMipmapDevice(log));
  const source = { width: 4, height: 4 };
  const [generatedA, generatedB, baseOnly, linear] = await Promise.all([
    manager.loadTexture(source, { format: 'rgba8unorm-srgb', mipmaps: 'generate' }),
    manager.loadTexture(source, { format: 'rgba8unorm-srgb', mipmaps: 'generate' }),
    manager.loadTexture(source, { format: 'rgba8unorm-srgb', mipmaps: 'none' }),
    manager.loadTexture(source, { format: 'rgba8unorm', mipmaps: 'generate' }),
  ]);

  assert.equal(generatedA.value, generatedB.value);
  assert.notEqual(generatedA.value, baseOnly.value);
  assert.notEqual(generatedA.value, linear.value);
  assert.equal(generatedA.value.descriptor.mipLevelCount, 3);
  assert.equal(baseOnly.value.descriptor.mipLevelCount, 1);
  assert.equal(log.filter(entry => entry[0] === 'createTexture').length, 3);
  assert.equal(log.filter(entry => entry[0] === 'createRenderPipeline').length, 2);

  generatedA.release();
  generatedB.release();
  baseOnly.release();
  linear.release();
});

test('logical texture cache keys de-duplicate temporary source identities without merging color spaces', async () => {
  ensureGpuConstants();
  const log = [];
  const manager = new AssetManager(createMipmapDevice(log));
  const [srgbA, srgbB, linear] = await Promise.all([
    manager.loadTexture({ width: 4, height: 4 }, {
      cacheKey: 'gltf:model:image:0',
      format: 'rgba8unorm-srgb',
      mipmaps: 'generate',
    }),
    manager.loadTexture({ width: 4, height: 4 }, {
      cacheKey: 'gltf:model:image:0',
      format: 'rgba8unorm-srgb',
      mipmaps: 'generate',
    }),
    manager.loadTexture({ width: 4, height: 4 }, {
      cacheKey: 'gltf:model:image:0',
      format: 'rgba8unorm',
      mipmaps: 'generate',
    }),
  ]);

  assert.equal(srgbA.value, srgbB.value);
  assert.notEqual(srgbA.value, linear.value);
  assert.equal(log.filter(entry => entry[0] === 'createTexture').length, 2);
  srgbA.release();
  assert.equal(log.filter(entry => entry[0] === 'destroyTexture').length, 0);
  srgbB.release();
  assert.equal(log.filter(entry => entry[0] === 'destroyTexture').length, 1);
  linear.release();
  assert.equal(log.filter(entry => entry[0] === 'destroyTexture').length, 2);
});

test('ordinary-image mip generation rejects unsupported render-target formats before allocation', async () => {
  ensureGpuConstants();
  const log = [];
  const manager = new AssetManager(createMipmapDevice(log));
  await assert.rejects(
    () => manager.loadTexture({ width: 8, height: 8 }, { format: 'rgba32float', mipmaps: 'generate' }),
    error => error.code === EngineErrorCode.AssetInvalidData
      && error.context.format === 'rgba32float'
      && error.context.mipmaps === 'generate',
  );
  assert.equal(log.filter(entry => entry[0] === 'createTexture').length, 0);
});

test('URL textures fall back to the browser image decoder when createImageBitmap rejects SVG', async () => {
  ensureGpuConstants();
  const log = [];
  const previous = {
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
    Image: globalThis.Image,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  const revoked = [];
  class FakeImage {
    width = 16;
    height = 8;
    naturalWidth = 16;
    naturalHeight = 8;
    decoding = 'auto';
    onload = null;
    onerror = null;
    set src(value) {
      this._src = value;
      if (value) queueMicrotask(() => this.onload?.());
    }
    get src() { return this._src ?? ''; }
  }
  try {
    globalThis.fetch = async () => new Response(new Blob(['<svg/>'], { type: 'image/svg+xml' }));
    globalThis.createImageBitmap = async () => { throw new Error('SVG ImageBitmap unsupported'); };
    globalThis.Image = FakeImage;
    URL.createObjectURL = () => 'blob:test-svg';
    URL.revokeObjectURL = value => revoked.push(value);

    const manager = new AssetManager(createMipmapDevice(log));
    const handle = await manager.loadTexture('/shape.svg');
    const copy = log.find(entry => entry[0] === 'copyExternalImageToTexture');
    assert.ok(copy[1].source instanceof FakeImage);
    assert.deepEqual(copy[3], [16, 8]);
    assert.deepEqual(revoked, ['blob:test-svg']);
    handle.release();
  } finally {
    globalThis.fetch = previous.fetch;
    globalThis.createImageBitmap = previous.createImageBitmap;
    globalThis.Image = previous.Image;
    URL.createObjectURL = previous.createObjectURL;
    URL.revokeObjectURL = previous.revokeObjectURL;
  }
});
