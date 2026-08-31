import { IndexedSpriteRenderer } from '/extensions/dist/experimental-indexed-sprite.js';

const progress = document.querySelector('#progress');
const result = document.querySelector('#result');

try {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available.');
  const firstDevice = await adapter.requestDevice();
  const firstErrors = captureErrors(firstDevice);
  firstDevice.pushErrorScope('validation');
  const renderer = createRenderer(firstDevice);
  renderer.uploadAll();
  const firstRun = [
    await renderAndRead(firstDevice, renderer, 1280, 720, 'main'),
    await renderAndRead(firstDevice, renderer, 1920, 1080, 'alternate'),
  ];
  await firstDevice.queue.onSubmittedWorkDone();
  const firstValidation = await firstDevice.popErrorScope();
  assertNoGpuErrors(firstValidation, firstErrors);

  const recoveryAdapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!recoveryAdapter) throw new Error('No WebGPU adapter is available for recovery.');
  const recoveryDevice = await recoveryAdapter.requestDevice();
  const recoveryErrors = captureErrors(recoveryDevice);
  recoveryDevice.pushErrorScope('validation');
  renderer.recover(recoveryDevice);
  renderer.uploadAll();
  const recoveryRun = await renderAndRead(recoveryDevice, renderer, 1280, 720, 'main');
  await recoveryDevice.queue.onSubmittedWorkDone();
  const recoveryValidation = await recoveryDevice.popErrorScope();
  assertNoGpuErrors(recoveryValidation, recoveryErrors);
  renderer.dispose();
  firstDevice.destroy();
  recoveryDevice.destroy();

  result.dataset.status = 'passed';
  result.textContent = JSON.stringify({
    status: 'passed',
    suite: 'indexed-sprite-generated-shader-readback',
    strictValidation: true,
    firstRun,
    recoveryRun,
  });
  progress.textContent = 'complete';
} catch (error) {
  result.dataset.status = 'failed';
  result.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  progress.textContent = 'failed';
}

function createRenderer(device) {
  return new IndexedSpriteRenderer(device, [
    { id: 'indexed', width: 2, height: 2, format: 'indexed8', pixels: new Uint8Array([1, 2, 2, 1]) },
    { id: 'color', width: 1, height: 1, format: 'rgba8', pixels: new Uint8Array([12, 34, 220, 255]) },
  ], [
    { id: 'main', colorCount: 3, rgba: new Uint8Array([0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255]) },
    { id: 'alternate', colorCount: 3, rgba: new Uint8Array([0, 0, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255]) },
  ], { targetFormat: 'rgba8unorm', sampleCount: 4 });
}

async function renderAndRead(device, renderer, width, height, paletteId) {
  const target = device.createTexture({
    label: `indexed-sprite.${width}x${height}.target`,
    size: { width, height },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const multisample = device.createTexture({
    label: `indexed-sprite.${width}x${height}.msaa`,
    size: { width, height },
    sampleCount: 4,
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{
    view: multisample.createView(), resolveTarget: target.createView(),
    loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 1],
  }] });
  const stats = renderer.render(pass, [
    { spriteId: 'indexed', paletteId, x: 50, y: 50, scaleX: 32, scaleY: 32, priority: 0 },
    { spriteId: 'color', x: 180, y: 50, scaleX: 32, scaleY: 32, priority: 1 },
  ], width, height);
  pass.end();
  const samples = [
    ['index-1', 60, 60],
    ['index-2', 100, 60],
    ['truecolor', 190, 60],
  ];
  const readbacks = samples.map(([name]) => [name, device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })]);
  for (let index = 0; index < samples.length; index++) {
    const [, x, y] = samples[index];
    encoder.copyTextureToBuffer({ texture: target, origin: { x, y } }, { buffer: readbacks[index][1], bytesPerRow: 256, rowsPerImage: 1 }, { width: 1, height: 1 });
  }
  device.queue.submit([encoder.finish()]);
  await Promise.all(readbacks.map(([, buffer]) => buffer.mapAsync(GPUMapMode.READ)));
  const pixels = Object.fromEntries(readbacks.map(([name, buffer]) => {
    const pixel = [...new Uint8Array(buffer.getMappedRange()).slice(0, 4)];
    buffer.unmap(); buffer.destroy();
    return [name, pixel];
  }));
  const expected = paletteId === 'main'
    ? { 'index-1': [255, 0, 0, 255], 'index-2': [0, 255, 0, 255] }
    : { 'index-1': [255, 255, 0, 255], 'index-2': [0, 255, 255, 255] };
  assertPixel(pixels['index-1'], expected['index-1'], 'index-1');
  assertPixel(pixels['index-2'], expected['index-2'], 'index-2');
  assertPixel(pixels.truecolor, [12, 34, 220, 255], 'truecolor');
  target.destroy(); multisample.destroy();
  return { width, height, paletteId, pixels, stats };
}

function assertPixel(actual, expected, label) {
  if (actual.some((value, index) => Math.abs(value - expected[index]) > 1)) throw new Error(`${label} pixel ${actual} differs from ${expected}.`);
}
function captureErrors(device) { const errors = []; device.addEventListener('uncapturederror', event => errors.push(event.error?.message ?? String(event.error))); return errors; }
function assertNoGpuErrors(validation, uncaptured) { if (validation || uncaptured.length > 0) throw new Error(`WebGPU validation failed: ${validation?.message ?? uncaptured.join('; ')}`); }
