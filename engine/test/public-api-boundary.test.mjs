import test from 'node:test';
import assert from 'node:assert/strict';

const stableEntrypoints = {
  root: await import('../dist/index.js'),
  core: await import('../dist/core.js'),
  assets: await import('../dist/assets.js'),
  diagnostics: await import('../dist/diagnostics.js'),
  extensionAuthoring: await import('../dist/extension-authoring.js'),
  ecs: await import('../dist/ecs.js'),
  scene: await import('../dist/scene.js'),
  systems: await import('../dist/systems.js'),
  renderer: await import('../dist/renderer.js'),
};
const experimental = await import('../dist/experimental.js');
const experimentalAssets = await import('../dist/experimental/assets.js');
const experimentalAsync = await import('../dist/experimental/async.js');
const experimentalDiagnostics = await import('../dist/experimental/diagnostics.js');
const experimentalGpuDriven = await import('../dist/experimental/gpu-driven.js');
const experimentalRenderer = await import('../dist/experimental/renderer.js');
const serialization = await import('../dist/serialization.js');

function assertDoesNotExport(entrypoint, names) {
  for (const name of names) {
    assert.equal(name in entrypoint, false, `stable entrypoint unexpectedly exports ${name}`);
  }
}

test('stable root keeps optional serialization on its explicit subpath', () => {
  assertDoesNotExport(stableEntrypoints.root, [
    'ComponentSerializationRegistry',
    'coreComponentSerializationRegistry',
    'deserializeEntityCore',
    'serializeEntityCore',
  ]);
  assert.equal(typeof serialization.serializeEntityCore, 'function');
  assert.equal(typeof serialization.deserializeEntityCore, 'function');
});

test('stable domain facades do not re-export implementation infrastructure', () => {
  assert.deepEqual(Object.keys(stableEntrypoints.diagnostics), ['getEngineDiagnosticsSnapshot']);
  assertDoesNotExport(stableEntrypoints.diagnostics, [
    'FrameDiagnostics',
    'GPUResourceTracker',
    'getEngineFrameDiagnostics',
    'getEngineGPUResourceTracker',
    'registerEngineDiagnostics',
  ]);
  assertDoesNotExport(stableEntrypoints.core, [
    'EnginePluginHost',
    'FrameDiagnostics',
    'GPUResourceTracker',
    'createRenderCapabilities',
    'getEngineFrameDiagnostics',
    'getEngineGPUResourceTracker',
    'requireEngineDevice',
  ]);
  assertDoesNotExport(stableEntrypoints.assets, [
    'AssetCacheHierarchy',
    'AssetParser',
    'AssetUploadScheduler',
    'AssetWorkerClient',
    'inspectKtx2Texture',
    'uploadKtx2Texture',
  ]);
  assertDoesNotExport(stableEntrypoints.ecs, [
    'EcsIds',
    'IdAllocator',
    'SpatialIndex',
    'getSpatialIndexService',
    'isEntityDisabledInHierarchyCached',
  ]);
  assertDoesNotExport(stableEntrypoints.scene, [
    'SCENE_PRESETS',
    'createSceneSystemPlan',
    'normalizeSceneOptions',
    'getSceneRenderIntegration',
    'getSceneRenderPipeline',
  ]);
  assertDoesNotExport(stableEntrypoints.systems, [
    'Render3DFramePassKind',
    'Render3DFramePassSnapshot',
    'getRender3DFramePlanSnapshot',
  ]);
});

test('stable extension authoring SPI stays narrow and capability-oriented', () => {
  assert.deepEqual(Object.keys(stableEntrypoints.extensionAuthoring).sort(), [
    'alignUp4',
    'beginRenderCommandPass',
    'cloneRenderPassDescriptor',
    'estimateTextureBytes',
    'getExtensionGPUResourceTracker',
    'getExtensionSharedRendererResource',
    'isEntityDisabledInHierarchyCached',
    'requireEngineDevice',
  ]);
  assertDoesNotExport(stableEntrypoints.extensionAuthoring, [
    'FrameDiagnostics',
    'GPUResourceTracker',
    'RendererResourceCache',
    'getEngineGPUResourceTracker',
    'registerEngineDiagnostics',
  ]);
});

test('removed compatibility aliases stay absent from public entrypoints', () => {
  assertDoesNotExport(stableEntrypoints.root, [
    'RadialShadowRenderSystem',
    'RadialShadowRenderSystemOptions',
  ]);
  assertDoesNotExport(stableEntrypoints.systems, [
    'RadialShadowRenderSystem',
    'RadialShadowRenderSystemOptions',
  ]);
  assertDoesNotExport(stableEntrypoints.renderer, ['LightInfo']);
  assertDoesNotExport(experimental, [
    'LightInfo',
    'RadialShadowRenderSystem',
    'RadialShadowRenderSystemOptions',
  ]);
});

test('advanced infrastructure remains reachable only through experimental', () => {
  for (const name of [
    'AssetCacheHierarchy',
    'EnginePluginHost',
    'getEngineFrameDiagnostics',
    'getEngineGPUResourceTracker',
    'GPUResourceTracker',
    'SpatialIndex',
    'getRender3DFramePlanSnapshot',
    'getSceneRenderPipeline',
    'getSpatialIndexService',
    'inspectKtx2Texture',
  ]) {
    assert.equal(name in experimental, true, `experimental entrypoint is missing ${name}`);
  }
});

test('focused experimental subpaths are bounded slices of the compatibility aggregate', () => {
  const slices = [
    [experimentalAssets, ['AssetCacheHierarchy', 'AssetUploadScheduler', 'AssetWorkerClient', 'inspectKtx2Texture']],
    [experimentalAsync, ['WorkerChannel', 'WORKER_CHANNEL_PROTOCOL_VERSION', 'createAbortError', 'monotonicNow']],
    [experimentalDiagnostics, ['FrameDiagnostics', 'GPUResourceTracker', 'getEngineFrameDiagnostics']],
    [experimentalGpuDriven, ['GpuDrivenBatchBuffer', 'GpuDrawCommandComputePass', 'TransparentMegaBatch']],
    [experimentalRenderer, ['BaseRenderer', 'RenderPipeline', 'RendererResourceCache']],
  ];
  for (const [slice, expected] of slices) {
    for (const name of Object.keys(slice)) {
      assert.equal(name in experimental, true, `focused experimental symbol ${name} is missing from compatibility aggregate`);
    }
    for (const name of expected) assert.equal(name in slice, true, `focused experimental entrypoint is missing ${name}`);
  }
});
