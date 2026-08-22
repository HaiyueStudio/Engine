const progress = document.querySelector('#progress'), resultNode = document.querySelector('#result');
try {
  if (!navigator.gpu) throw new Error('navigator.gpu unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); if (!adapter) throw new Error('No WebGPU adapter');
  const build = new URL(location.href).searchParams.get('build'); if (!build) throw new Error('Missing compiled runtime mount');
  const { LayoutGpuRenderer } = await import(`${build}/animation/layout/parameterized/index.js`);
  const firstDevice = await adapter.requestDevice(), renderer = new LayoutGpuRenderer(firstDevice);
  const first = await renderAndRead(firstDevice, renderer, true); firstDevice.destroy();
  const recoveryAdapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); if (!recoveryAdapter) throw new Error('No recovery adapter');
  const secondDevice = await recoveryAdapter.requestDevice(); renderer.recoverDevice(secondDevice, 7); const recovered = await renderAndRead(secondDevice, renderer, false);
  if (first.opaque !== recovered.opaque) throw new Error(`Recovery pixel trace changed: ${first.opaque} != ${recovered.opaque}`);
  renderer.dispose(); const residual = renderer.stats; secondDevice.destroy();
  if (residual.bufferCount !== 0 || residual.allocatedBytes !== 0) throw new Error(`GPU residual: ${JSON.stringify(residual)}`);
  resultNode.textContent = JSON.stringify({ status: 'passed', suite: 'animation.layout-webgpu', strictValidation: true, pixelCases: 2, firstOpaquePixels: first.opaque, recoveredOpaquePixels: recovered.opaque, recoveredGeneration: residual.generation, residual }); resultNode.dataset.status = 'passed'; progress.textContent = 'complete';
} catch (error) { resultNode.textContent = error instanceof Error ? error.stack ?? error.message : String(error); resultNode.dataset.status = 'failed'; progress.textContent = 'failed'; }

async function renderAndRead(device, renderer, upload) {
  device.pushErrorScope('validation');
  if (upload) renderer.upload(evaluation());
  const texture = device.createTexture({ size: [64, 64], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] }); renderer.render(pass); pass.end();
  const readback = device.createBuffer({ size: 256 * 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 256 }, [64, 64]); device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange()); let opaque = 0; for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (bytes[y * 256 + x * 4 + 3] > 200) opaque++;
  readback.unmap(); readback.destroy(); texture.destroy(); if (opaque < 1800) throw new Error(`Expected visible layout raster, got ${opaque} opaque pixels`); const validation = await device.popErrorScope(); if (validation) throw validation; return { opaque };
}

function evaluation() { return { viewport: [64, 64], dpr: 1, time: 0, visibleListItems: 0, layoutPasses: 2, instances: [], nodes: [{ key: 'stage/root', instanceId: 'stage', artboardId: 'main', nodeId: 'root', kind: 'container', rect: { x: 8, y: 8, width: 48, height: 48 }, opacity: 1, background: [0.8, 0.1, 0.1, 1], borderWidth: [0, 0, 0, 0], cornerRadius: [0, 0, 0, 0], text: { id: 'label', width: 32, height: 16, contentWidth: 32, contentHeight: 16, lines: [], controls: [{ kind: 'selection', x: 12, y: 12, width: 20, height: 10, radius: 0 }], glyphs: [{ glyphId: 1, sequence: 'A', logicalIndex: 0, line: 0, fontAsset: 'font', x: 18, y: 20, width: 20, height: 24, advance: 20, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, axes: {}, fills: [{ source: { kind: 'solid', color: [1, 0.9, 0.1, 1] } }], strokes: [{ source: { kind: 'solid', color: [0, 0, 0, 1] }, width: 1 }] }] }, nSlice: [{ x: 40, y: 40, width: 8, height: 8, source: [0, 0, 8, 8], tileMode: 'stretch' }] }] }; }
