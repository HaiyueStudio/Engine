import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBitmapFont } from '../dist/font.js';
import { GuiTextRenderer, GuiTextBatch } from '../dist/experimental.js';
import { createAuditGpuDevice, getAuditGpuDeviceState } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
function font() {
  const sizes = [];
  const built = buildBitmapFont({ chars: 'AB ', fontSize: 16, atlasSize: 64,
    canvasFactory(width, height) {
      sizes.push([width, height]);
      return { width, height, getContext: () => ({ measureText: () => ({ width: 9, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 3 }), clearRect() {}, fillText() {} }) };
    },
  });
  return { ...built, sizes };
}
test('font atlas can be built without document using the injected Canvas 2D factory', () => {
  assert.equal(typeof document, 'undefined');
  const built = font();
  assert.deepEqual(built.sizes, [[1, 1], [64, 64]]);
  assert.equal(built.data.chars.size, 3);
  assert.equal(built.data.pageImages[0], built.atlas);
});
test('native GUI uploads RGBA once and releases its owned atlas; invalid readback does not leak', () => {
  const device = createAuditGpuDevice();
  const audit = getAuditGpuDeviceState(device);
  const engine = { device, format: 'bgra8unorm', displayWidth: 320, displayHeight: 180, getDepthFormat: () => 'depth24plus' };
  let reads = 0;
  const renderer = new GuiTextRenderer(canvas => { reads++; return new Uint8Array(canvas.width * canvas.height * 4); });
  renderer.prepare(engine);
  const built = font();
  const batch = new GuiTextBatch();
  batch.addText({ text: 'AB', x: 0, y: 0, width: 100, height: 30, fontSize: 16, color: [1, 1, 1, 1] });
  batch.rebuild(built.data);
  const pass = device.createCommandEncoder().beginRenderPass({ colorAttachments: [] });
  renderer.render(pass, batch, built.data);
  renderer.render(pass, batch, built.data);
  assert.equal(reads, 1);
  renderer.destroy();
  assert.equal(audit.snapshot().resources.texture.live, 0);
  const bad = new GuiTextRenderer(() => new Uint8Array(3));
  bad.prepare(engine);
  assert.throws(() => bad.render(pass, batch, built.data), /RGBA8/);
  bad.destroy();
  assert.equal(audit.snapshot().resources.texture.live, 0);
});
