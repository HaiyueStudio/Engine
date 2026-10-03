import { GrayscalePass, GaussianBlurPass, OutlinePass } from '../../engine/dist/experimental.js';
import { GtaoPass } from '../../engine/dist/postprocess.js';
import { createAuditTarget, createRealRendererBenchmarkScenario, destroyRealRendererBenchmarkScenario,
  runRealRendererBenchmarkFrame, warmRealRendererBenchmarkPipelines, resetRealRendererBenchmarkMetrics } from '../benchmark/real-renderer-scenario.mjs';
import { readFloatTexture } from './float-texture-readback.mjs';

// Inherited implementations render identically but deliberately keep the conservative custom-pass contract.
class RetainedGray extends GrayscalePass {}
class RetainedBlur extends GaussianBlurPass {}
class RetainedOutline extends OutlinePass {}
const node = document.querySelector('#result');
try {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: new URLSearchParams(location.search).get('powerPreference') ?? 'high-performance' });
  check(adapter, 'native WebGPU adapter required');
  const errors = [];
  async function capture(mode, retained, direct = false) {
    // The shared benchmark instrumentation owns one device lifetime per scenario.
    const captureAdapter = await navigator.gpu.requestAdapter({ powerPreference: new URLSearchParams(location.search).get('powerPreference') ?? 'high-performance' });
    check(captureAdapter && !captureAdapter.info.isFallbackAdapter && captureAdapter.info.vendor === adapter.info.vendor, 'capture adapter must remain native and consistent');
    const device = await captureAdapter.requestDevice();
    device.addEventListener('uncapturederror', e => errors.push(e.error.message));
    device.pushErrorScope('validation');
    const target = createAuditTarget(device, 192, 128);
    let state;
    const cleanup = {};
    try {
      state = await createRealRendererBenchmarkScenario({ device, target, entityCount: 7, viewCount: 1, dynamicRatio: 0 });
      const ao = new GtaoPass({ displayMode: mode, quality: 'low' });
      const passes = direct ? [ao] : retained
        ? [new RetainedGray(), new RetainedBlur(), new RetainedOutline(), ao]
        : [new GrayscalePass(), new GaussianBlurPass(), new OutlinePass(), ao];
      state.render3d.passes.splice(0, state.render3d.passes.length, ...passes);
      await warmRealRendererBenchmarkPipelines(state);
      await runRealRendererBenchmarkFrame(state);
      resetRealRendererBenchmarkMetrics(state);
      const start = state.audit.renderPasses;
      await runRealRendererBenchmarkFrame(state);
      const actualPasses = state.audit.renderPasses - start;
      const post = state.render3d._postScenePasses._postRenderer;
      const stats = { ...post._graph.stats };
      const labels = post._graph.snapshot.map(p => p.name);
      const outlineResources = state.tracker.getDebugSnapshot().resources.filter(r => /outline(Mask|VisibleMask)/i.test(r.label)).length;
      const pixels = await readFloatTexture(device, target.colorTexture);
      return { mode, retained, direct, actualPasses, stats, labels, outlineResources, pixels, cleanup };
    } finally {
      try {
        if (state) {
          await destroyRealRendererBenchmarkScenario(state);
          cleanup.ownerResidual = state.finalMetrics.ownerResidual;
          cleanup.liveGpuResources = state.finalMetrics.liveGpuResources;
          check(cleanup.ownerResidual === 0 && cleanup.liveGpuResources === 0, 'scenario cleanup must release all owned GPU resources');
        }
      } finally {
        target.destroy();
        const validation = await device.popErrorScope(); if (validation) errors.push(validation.message);
        device.destroy();
      }
    }
  }
  const before = await capture('occlusion', true);
  const after = await capture('occlusion', false);
  const direct = await capture('occlusion', false, true);
  const compositeBefore = await capture('composite', true);
  const compositeAfter = await capture('composite', false);
  function difference(a, b) {
    check(a.length === b.length, 'pixel dimensions differ');
    let max = 0, sum = 0;
    for (let i = 0; i < a.length; i++) { const delta = Math.abs(a[i] - b[i]); check(Number.isFinite(delta), 'non-finite pixel'); max = Math.max(max, delta); sum += delta; }
    check(max <= 1 / 255, `pixel mismatch ${max}`);
    return { max, mean: sum / a.length };
  }
  const parity = difference(before.pixels, after.pixels), directParity = difference(direct.pixels, after.pixels);
  const compositeParity = difference(compositeBefore.pixels, compositeAfter.pixels);
  check(after.stats.culledPassCount === 3, 'three unused color effects must be culled');
  check(compositeAfter.stats.culledPassCount === 0, 'composite AO must preserve the color chain');
  check(before.outlineResources > 0 && after.outlineResources === 0, 'unused outline resources must be eliminated');
  check(after.actualPasses < before.actualPasses, 'real GPU pass count must decrease');
  check(after.actualPasses === direct.actualPasses, 'culled chain must execute only direct AO work');
  check(errors.length === 0, errors.join('\n'));
  const compact = ({ pixels, ...rest }) => rest;
  node.textContent = JSON.stringify({ schemaVersion: 1, status: 'passed', scope: 'dependency-culling-correctness-and-structural-counts-not-performance',
    adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, isFallbackAdapter: adapter.info.isFallbackAdapter },
    before: compact(before), after: compact(after), direct: compact(direct), compositeBefore: compact(compositeBefore), compositeAfter: compact(compositeAfter),
    parity, directParity, compositeParity, errors });
  node.dataset.status = 'passed';
} catch (error) { node.textContent = error.stack ?? String(error); node.dataset.status = 'failed'; }
function check(value, message) { if (!value) throw Error(message); }
