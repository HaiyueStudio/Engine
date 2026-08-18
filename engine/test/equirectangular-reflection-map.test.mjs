import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineErrorCode } from '../dist/core.js';
import { createEquirectangularReflectionMap } from '../dist/lighting.js';

function ensureGpuConstants() {
  globalThis.GPUTextureUsage ??= {
    TEXTURE_BINDING: 1 << 0,
    COPY_DST: 1 << 1,
    RENDER_ATTACHMENT: 1 << 2,
  };
}

function createDevice(log, options = {}) {
  let textureId = 0;
  let pipelineId = 0;
  return {
    limits: { maxTextureDimension2D: options.maxTextureDimension2D ?? 4096 },
    queue: {
      copyExternalImageToTexture(source, destination, size) {
        log.push(['copyExternalImageToTexture', source, destination, size]);
      },
      submit(commandBuffers) { log.push(['submit', commandBuffers]); },
      onSubmittedWorkDone() { return options.submittedWork ?? Promise.resolve(); },
    },
    createTexture(descriptor) {
      const texture = {
        id: ++textureId,
        descriptor,
        destroyed: false,
        createView(viewDescriptor = {}) {
          return { texture, descriptor: viewDescriptor };
        },
        destroy() {
          if (this.destroyed) return;
          this.destroyed = true;
          log.push(['destroyTexture', this.id]);
        },
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
    async createRenderPipelineAsync(descriptor) {
      if (options.pipelineError) throw options.pipelineError;
      const pipeline = {
        id: ++pipelineId,
        descriptor,
        getBindGroupLayout(index) { return { pipeline: this.id, index }; },
      };
      log.push(['createRenderPipelineAsync', pipeline.id, descriptor]);
      return pipeline;
    },
    createBindGroup(descriptor) {
      log.push(['createBindGroup', descriptor]);
      return { descriptor };
    },
    createCommandEncoder(descriptor) {
      const passes = [];
      log.push(['createCommandEncoder', descriptor]);
      return {
        beginRenderPass(passDescriptor) {
          const commands = [];
          passes.push({ descriptor: passDescriptor, commands });
          return {
            setPipeline(pipeline) { commands.push(['setPipeline', pipeline.id]); },
            setBindGroup(index, bindGroup) { commands.push(['setBindGroup', index, bindGroup]); },
            draw(...args) { commands.push(['draw', ...args]); },
            end() { commands.push(['end']); },
          };
        },
        finish() { return { passes }; },
      };
    },
  };
}

test('equirectangular conversion renders all six cubemap faces and owns its result', async () => {
  ensureGpuConstants();
  const log = [];
  const reflectionMap = await createEquirectangularReflectionMap(
    createDevice(log),
    { width: 1024, height: 512 },
    { label: 'test-panorama' },
  );

  assert.equal(reflectionMap.kind, 'equirectangular-reflection-map');
  assert.equal(reflectionMap.faceSize, 256);
  assert.equal(reflectionMap.sourceWidth, 1024);
  assert.equal(reflectionMap.sourceHeight, 512);
  assert.equal(reflectionMap.mipLevelCount, 1);
  const textures = log.filter(entry => entry[0] === 'createTexture');
  assert.equal(textures.length, 2);
  assert.equal(textures[0][2].format, 'rgba8unorm-srgb');
  assert.deepEqual(textures[1][2].size, { width: 256, height: 256, depthOrArrayLayers: 6 });
  assert.equal(textures[1][2].format, 'rgba8unorm');

  const submission = log.find(entry => entry[0] === 'submit')[1][0];
  assert.equal(submission.passes.length, 6);
  assert.deepEqual(
    submission.passes.map(pass => pass.descriptor.colorAttachments[0].view.descriptor.baseArrayLayer),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    submission.passes.map(pass => pass.commands.find(command => command[0] === 'draw')),
    [
      ['draw', 3, 1, 0, 0],
      ['draw', 3, 1, 0, 1],
      ['draw', 3, 1, 0, 2],
      ['draw', 3, 1, 0, 3],
      ['draw', 3, 1, 0, 4],
      ['draw', 3, 1, 0, 5],
    ],
  );
  assert.deepEqual(log.filter(entry => entry[0] === 'destroyTexture'), [['destroyTexture', 1]]);

  reflectionMap.destroy();
  reflectionMap.destroy();
  assert.deepEqual(log.filter(entry => entry[0] === 'destroyTexture'), [
    ['destroyTexture', 1],
    ['destroyTexture', 2],
  ]);
});

test('equirectangular conversion validates aspect ratio and face limits before allocating', async () => {
  ensureGpuConstants();
  const log = [];
  const device = createDevice(log, { maxTextureDimension2D: 512 });
  await assert.rejects(
    createEquirectangularReflectionMap(device, { width: 640, height: 480 }),
    error => error.code === EngineErrorCode.AssetInvalidData && error.path === 'source',
  );
  await assert.rejects(
    createEquirectangularReflectionMap(device, { width: 1024, height: 512 }, { faceSize: 1024 }),
    error => error.code === EngineErrorCode.AssetInvalidData && error.path === 'options.faceSize',
  );
  assert.equal(log.filter(entry => entry[0] === 'createTexture').length, 0);
});

test('equirectangular conversion reports abort without allocating or leaking a cubemap', async () => {
  ensureGpuConstants();
  const earlyLog = [];
  const earlyController = new AbortController();
  earlyController.abort('cancelled before conversion');
  await assert.rejects(
    createEquirectangularReflectionMap(
      createDevice(earlyLog),
      { width: 1024, height: 512 },
      { signal: earlyController.signal },
    ),
    error => error.code === EngineErrorCode.AssetJobAborted,
  );
  assert.equal(earlyLog.length, 0);

  const deferred = Promise.withResolvers();
  const inFlightLog = [];
  const inFlightController = new AbortController();
  const pending = createEquirectangularReflectionMap(
    createDevice(inFlightLog, { submittedWork: deferred.promise }),
    { width: 1024, height: 512 },
    { signal: inFlightController.signal },
  );
  await new Promise(resolve => setImmediate(resolve));
  inFlightController.abort('cancelled after submission');
  deferred.resolve();
  await assert.rejects(pending, error => error.code === EngineErrorCode.AssetJobAborted);
  assert.deepEqual(inFlightLog.filter(entry => entry[0] === 'destroyTexture'), [
    ['destroyTexture', 1],
    ['destroyTexture', 2],
  ]);
});
