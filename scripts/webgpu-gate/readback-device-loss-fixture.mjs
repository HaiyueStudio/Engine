import { GpuReadbackRing } from '../../engine/dist/experimental/gpu-driven.js';
const node = document.querySelector('#result');
const check = (value, message) => { if (!value) throw Error(message); };
const cases = [];
try {
  const preference = new URLSearchParams(location.search).get('powerPreference') ?? 'high-performance';
  for (const mode of ['reserved', 'mapping', 'disposed-reservation']) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: preference });
    check(adapter && !adapter.info.isFallbackAdapter, 'Native GPU required');
    const device = await adapter.requestDevice(), errors = [], callbacks = [];
    device.addEventListener('uncapturederror', e => errors.push(e.error.message));
    const ring = new GpuReadbackRing(device, 16, 2);
    const source = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
    new Uint32Array(source.getMappedRange()).set([1, 2, 3, 4]); source.unmap();
    let timer;
    try {
      const encoder = device.createCommandEncoder();
      const request = ring.request({ device, encoder, afterSubmit: callback => callbacks.push(callback) }, source, 0, 16, mode);
      check(request, 'Request unexpectedly skipped');
      if (mode === 'mapping') {
        device.queue.submit([encoder.finish()]); for (const callback of callbacks) callback();
        // Let the ring call native mapAsync before destroying the device.
        await Promise.resolve();
      } else if (mode === 'disposed-reservation') ring.destroy();
      device.destroy(); await device.lost;
      const result = await Promise.race([request, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Lost-device request remained pending')), 5000); })]);
      check(result.status === (mode === 'disposed-reservation' ? 'cancelled' : 'failed'), `${mode}: ${result.status}`);
      check(result.bytes === null, 'Lost-device bytes published');
      if (mode !== 'mapping') for (const callback of callbacks) callback();
      // Native map rejection arrives on a later browser task, independently of
      // device.lost. Wait for bounded cleanup instead of assuming one timer tick.
      const cleanupStarted = performance.now();
      while (ring.stats.pending && performance.now() - cleanupStarted < 5000)
        await new Promise(resolve => setTimeout(resolve, 10));
      check(ring.stats.pending === 0, `${mode}: pending slot leaked`);
      let rejected = false;
      try { ring.request({ device, encoder, afterSubmit() {} }, source, 0, 16); } catch { rejected = true; }
      check(rejected, 'Lost ring accepted another request'); check(errors.length === 0, errors.join('\n'));
      cases.push({ mode, status: result.status, bytes: result.bytes, stats: ring.stats, cleanupMs: performance.now() - cleanupStarted,
        adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, isFallbackAdapter: adapter.info.isFallbackAdapter }, errors });
    } finally { clearTimeout(timer); ring.destroy(); source.destroy(); device.destroy(); }
  }
  node.textContent = JSON.stringify({ schemaVersion: 1, status: 'passed', scope: 'readback-device-loss-lifecycle', performanceQualified: false, cases }); node.dataset.status = 'passed';
} catch (error) {
  node.textContent = JSON.stringify({ schemaVersion: 1, status: 'failed', error: error.stack, cases }); node.dataset.status = 'failed';
}
