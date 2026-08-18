import test from 'node:test';
import assert from 'node:assert/strict';
import { RttTexture } from '../dist/experimental.js';
import { RttEngine } from '../dist/rtt.js';

function ensureGpuConstants() {
  globalThis.GPUTextureUsage ??= {
    RENDER_ATTACHMENT: 1 << 0,
    TEXTURE_BINDING: 1 << 1,
  };
}

function createRttMockEngine(log = []) {
  ensureGpuConstants();
  let textureId = 0;
  return {
    device: {
      createTexture(descriptor) {
        const texture = {
          id: ++textureId,
          descriptor,
          destroyed: false,
          createView(options) {
            return { textureId: this.id, options };
          },
          destroy() {
            this.destroyed = true;
            log.push(['destroyTexture', this.id]);
          },
        };
        log.push(['createTexture', texture.id, descriptor.size, descriptor.sampleCount ?? 1, descriptor.usage]);
        return texture;
      },
    },
    adapter: null,
    context: null,
    canvas: null,
    assetManager: null,
    format: 'rgba8unorm',
    getDepthFormat() {
      return 'depth24plus';
    },
  };
}

test('RttTexture exposes a resize-stable material texture source', () => {
  const log = [];
  const engine = createRttMockEngine(log);
  const rtt = new RttTexture(engine, { width: 64, height: 32 });
  const source = rtt.textureSource;
  const firstTexture = source.texture;

  assert.equal(source, rtt.textureSource);
  assert.equal(firstTexture, rtt.texture);
  assert.equal(source.version, 0);

  rtt.resize(128, 64);

  assert.equal(source, rtt.textureSource);
  assert.notEqual(source.texture, firstTexture);
  assert.equal(source.texture, rtt.texture);
  assert.equal(source.version, 1);
  assert.equal(log.some(entry => entry[0] === 'destroyTexture'), true);

  rtt.destroy();
});

test('RttEngine caches per-view attachments without changing target defaults', () => {
  const log = [];
  const engine = createRttMockEngine(log);
  const rtt = new RttEngine(engine, 64, 32);
  const output = rtt.colorTexture;
  const standard = rtt.getRenderPassDescriptor({
    clearColor: { r: 0, g: 0, b: 0, a: 1 },
    depthConvention: 'standard',
    sampleCount: 1,
  });
  const reverseMsaa = rtt.getRenderPassDescriptor({
    clearColor: { r: 0.2, g: 0.3, b: 0.4, a: 1 },
    depthConvention: 'reverse',
    sampleCount: 4,
  });
  const textureCount = log.filter(entry => entry[0] === 'createTexture').length;

  assert.equal(rtt.colorTexture, output);
  assert.equal(rtt.reverseZ, false);
  assert.equal(rtt.msaaSamples, 1);
  assert.equal(standard.depthStencilAttachment.depthClearValue, 1);
  assert.equal(reverseMsaa.depthStencilAttachment.depthClearValue, 0);
  assert.ok(reverseMsaa.colorAttachments[0].resolveTarget);

  rtt.getRenderPassDescriptor({
    clearColor: { r: 1, g: 1, b: 1, a: 1 },
    depthConvention: 'reverse',
    sampleCount: 4,
  });
  assert.equal(log.filter(entry => entry[0] === 'createTexture').length, textureCount);
  rtt.destroy();
});
