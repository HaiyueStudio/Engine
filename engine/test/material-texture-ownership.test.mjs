import test from 'node:test';
import assert from 'node:assert/strict';
import {BasicMaterial} from '../dist/index.js';
import {Mesh3DRenderer} from '../dist/experimental.js';
import {createAuditGpuDevice} from '../../scripts/benchmark/real-renderer-audit-device.mjs';

globalThis.GPUBufferUsage ??= {UNIFORM: 64, COPY_DST: 8};
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const device = createAuditGpuDevice(), renderer = new Mesh3DRenderer(), requests = [];
  renderer.engine = {device};
  renderer.rendererCore = {destroyed: false, destroy() {this.destroyed = true;}};
  renderer.defaultTexture = device.createTexture({size: [1, 1], format: 'rgba8unorm', usage: 4});
  renderer.defaultSampler = device.createSampler();
  renderer.bgl2 = device.createBindGroupLayout({entries: []});
  const material = new BasicMaterial(), data = renderer._createMatGPUData(material);
  renderer.matCache.set(material.id, data);
  renderer._loadTexture = source => new Promise(resolve => requests.push({source, resolve}));
  const handle = () => {
    const texture = device.createTexture({size: [1, 1], format: 'rgba8unorm', usage: 4});
    return {value: texture, releases: 0, release() {this.releases++; texture.destroy();}};
  };
  return {renderer, material, data, requests, handle, cleanup() {renderer.destroy(); renderer.defaultTexture.destroy();}};
}

for (const slot of ['base', 'emissive']) {
  for (const eviction of ['single', 'sweep']) {
    test(`Basic ${slot} releases a late texture after ${eviction} material eviction`, async () => {
      const f = fixture();
      try {
        f.renderer._syncMaterialTexture('late.png', f.data, slot);
        const before = f.data.bindGroup;
        if (eviction === 'single') f.renderer.releaseMaterial(f.material.id);
        else f.renderer.releaseMaterialsNotIn(new Set());
        const late = f.handle(); f.requests[0].resolve(late); await settle();
        assert.equal(f.renderer.matCache.size, 0);
        assert.equal(late.releases, 1);
        assert.equal(f.data.bindGroup, before, 'eviction must prevent rebuilding a retired binding');
        assert.equal(f.data.textureHandle, null);
        assert.equal(f.data.emissiveTextureHandle, null);
      } finally {f.cleanup();}
    });
  }

  test(`Basic ${slot} keeps the newest request when a source changes A to B to A`, async () => {
    const f = fixture();
    try {
      for (const source of ['a.png', 'b.png', 'a.png']) f.renderer._syncMaterialTexture(source, f.data, slot);
      const handles = f.requests.map(() => f.handle());
      f.requests[2].resolve(handles[2]); await settle();
      const before = f.data.bindGroup;
      f.requests[0].resolve(handles[0]); f.requests[1].resolve(handles[1]); await settle();
      assert.equal(f.data.bindGroup, before, 'an older request for the same source must not replace the new result');
      assert.equal(slot === 'base' ? f.data.textureHandle : f.data.emissiveTextureHandle, handles[2]);
      assert.deepEqual(handles.map(h => h.releases), [1, 1, 0]);
      f.renderer.releaseMaterial(f.material.id);
      assert.deepEqual(handles.map(h => h.releases), [1, 1, 1]);
    } finally {f.cleanup();}
  });
}
