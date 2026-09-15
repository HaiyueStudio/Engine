import test from 'node:test';
import assert from 'node:assert/strict';
import { GuiImageBatch, GuiImageRenderer } from '../dist/experimental.js';
import { GuiElement, GuiImage } from '../dist/gui.js';
import { createAuditGpuDevice, getAuditGpuDeviceState } from '../../scripts/benchmark/real-renderer-audit-device.mjs';

function fixture() {
  const device = createAuditGpuDevice();
  const audit = getAuditGpuDeviceState(device);
  const renderer = new GuiImageRenderer();
  renderer.prepare({ device, format: 'bgra8unorm', displayWidth: 320, displayHeight: 180, getDepthFormat: () => 'depth24plus' });
  const source = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
  const pass = device.createCommandEncoder().beginRenderPass({ colorAttachments: [] });
  const command = { source, x: 0, y: 0, width: 32, height: 32, uv: [0, 0, 1, 1], color: [1, 1, 1, 1] };
  return { device, audit, renderer, source, pass, command };
}

test('HUD rebuilds reuse image GPU buffers and release them when a batch becomes empty', () => {
  const f = fixture();
  const batch = new GuiImageBatch();
  const baseline = f.audit.snapshot().resources.buffer;
  for (let frame = 0; frame < 1000; frame++) {
    batch.clear();
    batch.addImage({ ...f.command, x: frame % 320 });
    batch.rebuild();
    f.renderer.render(f.pass, batch);
  }
  const active = f.audit.snapshot().resources.buffer;
  assert.equal(active.live - baseline.live, 1, 'only one image buffer may remain live');
  assert.equal(active.created - baseline.created, 1, 'rebuilding a HUD must not allocate a buffer every frame');
  batch.clear();
  batch.rebuild();
  f.renderer.render(f.pass, batch);
  assert.equal(f.audit.snapshot().resources.buffer.live, baseline.live);
  f.renderer.destroy();
  f.source.destroy();
  assert.equal(f.audit.snapshot().resources.buffer.live, 0);
});

test('batch ownership survives rebuild before release and isolates batches sharing a texture', () => {
  const f = fixture();
  const a = new GuiImageBatch(), b = new GuiImageBatch();
  for (const batch of [a, b]) {
    batch.addImage(f.command); batch.rebuild(); f.renderer.render(f.pass, batch);
  }
  a.clear();
  f.renderer.releaseBatch(a);
  assert.equal(f.audit.snapshot().resources.buffer.live, 2, 'viewport plus second batch');
  b.clear();
  for (let n = 0; n < 8; n++) b.addImage({ ...f.command, x: n * 32 });
  b.rebuild(); f.renderer.render(f.pass, b);
  assert.equal(f.audit.snapshot().resources.buffer.live, 2, 'growing a buffer retires the smaller buffer');
  f.renderer.releaseBatch(b);
  f.renderer.releaseBatch(b);
  f.renderer.destroy(); f.source.destroy();
  assert.equal(f.audit.snapshot().resources.buffer.live, 0);
});

test('unmodified image geometry is not reuploaded when neighbouring HUD text changes', () => {
  const f = fixture();
  const batch = new GuiImageBatch();
  const rebuild = command => {
    batch.clear(); batch.addImage(command); batch.rebuild(); f.renderer.render(f.pass, batch);
  };
  rebuild(f.command);
  const initial = f.audit.getUploadCount('gui-image:vertices');
  const data = batch.groups[0].vertexData;
  for (let frame = 0; frame < 100; frame++) rebuild({ ...f.command });
  assert.equal(f.audit.getUploadCount('gui-image:vertices'), initial);
  assert.equal(batch.groups[0].vertexData, data);
  rebuild({ ...f.command, clip: { x: 4, y: 0, width: 16, height: 32 } });
  rebuild({ ...f.command, uv: [0.25, 0, 0.5, 1] });
  rebuild({ ...f.command, color: [1, 1, 1, 0.5] });
  assert.equal(f.audit.getUploadCount('gui-image:vertices'), initial + 3);
  f.renderer.destroy();
  f.renderer.prepare({ device: f.device, format: 'bgra8unorm', displayWidth: 320, displayHeight: 180, getDepthFormat: () => 'depth24plus' });
  f.renderer.render(f.pass, batch);
  assert.equal(f.audit.getUploadCount('gui-image:vertices'), initial + 4, 'recreated renderer uploads even unchanged data');
  f.renderer.destroy(); f.source.destroy();
  assert.equal(f.audit.snapshot().resources.buffer.live, 0);
});

test('same style and UV values keep a clean GUI subtree clean', () => {
  const element = new GuiElement({ style: { color: '#fff', radius: 3 } });
  const image = new GuiImage();
  element.clearDirty(); image.clearDirty();
  element.setStyle({ color: '#fff' }); element.setStyle({});
  image.setUv([0, 0, 1, 1]);
  assert.equal(element.dirty, false); assert.equal(image.dirty, false);
  element.setStyle({ radius: 4 }); image.setUv([0, 0, 0.5, 1]);
  assert.equal(element.dirty, true); assert.equal(image.dirty, true);
});
