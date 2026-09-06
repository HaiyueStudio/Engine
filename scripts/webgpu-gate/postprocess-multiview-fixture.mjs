import { GrayscalePass, RenderView } from '../../engine/dist/experimental.js';
import {
  createAuditTarget, createRealRendererBenchmarkScenario, destroyRealRendererBenchmarkScenario,
  resetRealRendererBenchmarkMetrics, runRealRendererBenchmarkFrame, warmRealRendererBenchmarkPipelines,
} from '../benchmark/real-renderer-scenario.mjs';

const resultNode = document.querySelector('#result');
const textureNames = ['depth', 'normal', 'motion', 'outlineMask', 'outlineVisibleMask'];

class AuxiliaryProbePass extends GrayscalePass {
  needsDepthTexture = true;
  needsNormalTexture = true;
  needsMotionTexture = true;
  needsOutlineMask = true;
  seen = [];
  observed = new Set();

  setSceneTextures(textures) {
    this.seen.push(textures);
    for (const name of textureNames) {
      const texture = textures[name];
      check(texture, `missing ${name}`);
      check(texture.width === textures.frame.width && texture.height === textures.frame.height, `${name} size mismatch`);
      this.observed.add(texture);
    }
  }
}

try {
  check(navigator.gpu, 'navigator.gpu is unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  check(adapter, 'No WebGPU adapter');
  const device = await adapter.requestDevice();
  const validationErrors = [];
  device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  const large = createAuditTarget(device, 320, 180);
  const small = createAuditTarget(device, 128, 96);
  let state;
  let failure;
  let allocatedAuxiliaryTextures = 0;
  const probe = new AuxiliaryProbePass();
  device.pushErrorScope('validation');
  try {
    state = await createRealRendererBenchmarkScenario({ device, target: large, entityCount: 7, viewCount: 2 });
    state.render3d.passes.splice(0, state.render3d.passes.length, probe);
    const first = new RenderView({ key: 'large', camera: state.views[0].camera, target: large }).snapshot();
    const second = new RenderView({ key: 'small', camera: state.views[1].camera, target: small }).snapshot();
    const third = new RenderView({ key: 'large-again', camera: first.camera, target: large }).snapshot();
    state.views = [first, second, third];
    await warmRealRendererBenchmarkPipelines(state);
    resetRealRendererBenchmarkMetrics(state);
    for (let frame = 0; frame < 3; frame++) {
      probe.seen.length = 0;
      await runRealRendererBenchmarkFrame(state);
      check(probe.seen.length === 3, 'all three views must render');
      for (const name of textureNames) {
        check(probe.seen[0][name] === probe.seen[2][name], `${name} did not reuse large target`);
        check(probe.seen[0][name] !== probe.seen[1][name], `${name} aliased different sizes`);
      }
      check(liveAuxiliaryTextures(state) === 12, 'active multiview resources were destroyed');
      allocatedAuxiliaryTextures = liveAuxiliaryTextures(state);
      check(probe.observed.size === 10, 'stable multiview rendering allocated new auxiliary textures');
    }
    state.views = [first];
    await runRealRendererBenchmarkFrame(state);
    check(liveAuxiliaryTextures(state) === 6, 'unused small-view textures were not retired');
    state.render3d.passes.length = 0;
    await runRealRendererBenchmarkFrame(state);
    check(liveAuxiliaryTextures(state) === 0, 'disabling effects did not release auxiliary textures');
    const validationError = await device.popErrorScope();
    if (validationError) validationErrors.push(validationError.message);
    check(validationErrors.length === 0, validationErrors.join('\n'));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (state) await destroyRealRendererBenchmarkScenario(state);
    } catch (error) {
      if (!failure) throw error;
    } finally {
      large.destroy();
      small.destroy();
      device.destroy();
    }
  }
  resultNode.textContent = JSON.stringify({
    schemaVersion: 1, suite: 'postprocess.multiview-lifecycle', status: 'passed',
    role: 'diagnostic-regression', generatedAt: new Date().toISOString(), browser: navigator.userAgent,
    adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description },
    frames: 5, dimensions: [[320, 180], [128, 96]],
    observedAuxiliaryTextures: allocatedAuxiliaryTextures, retiredAuxiliaryTextures: allocatedAuxiliaryTextures,
    validationErrors,
  });
  resultNode.dataset.status = 'passed';
} catch (error) {
  resultNode.textContent = error.stack ?? String(error);
  resultNode.dataset.status = 'failed';
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function liveAuxiliaryTextures(state) {
  return state.tracker.getDebugSnapshot().resources.filter(resource =>
    resource.type === 'texture' && resource.label.startsWith('PostProcessSceneTextureStore.')).length;
}
