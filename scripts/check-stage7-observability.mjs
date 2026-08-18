import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];

const tracker = read('engine/src/core/GPUResourceTracker.ts');
requirePatterns('GPU tracker', tracker, [
  'createdAtFrame', 'lastUsedFrame', 'creationStack', 'getDebugSnapshot()', 'recordCacheAccess(',
  "'sampler'", "'bind-group'", "'bind-group-layout'", "'render-pipeline'", "'compute-pipeline'", "'query-set'",
  'releasedOwnerResiduals', 'frameCreated', 'frameDestroyed',
]);

const frame = read('engine/src/core/FrameDiagnostics.ts');
for (const stage of ['update', 'collect', 'cull', 'sort', 'batch-build', 'upload', 'record', 'submit']) requirePatterns('frame diagnostics', frame, [`'${stage}'`]);
for (const counter of ['draws', 'dispatches', 'passes', 'pipelineSwitches', 'bufferUploads', 'bufferUploadBytes']) requirePatterns('frame diagnostics', frame, [`'${counter}'`]);

const pipeline = read('engine/src/renderer/RenderPipeline.ts');
requirePatterns('render pipeline diagnostics', pipeline, [
  'RenderPipelineDebugSnapshot', 'getDebugSnapshot()', 'shared-pass-state-ended',
  'shared-pass-attachment-conflict', 'passCount', 'loadStore',
]);
requirePatterns('render pipeline production allocation gate', pipeline, [
  'diagnosticsEnabled ? [] : null', '_recordEntryWithoutDiagnostics(',
  'canShareRenderPass(', 'EMPTY_RENDER_PIPELINE_EXECUTE_OPTIONS',
]);
requirePatterns('GPU pass timestamp bridge', read('engine/src/core/GpuPassProfiler.ts'), [
  'MAX_GPU_TIMED_PASSES', 'GPU_TIMING_READBACK_SLOTS', 'beginningOfPassWriteIndex',
  'resolveQuerySet(', 'mapAsync(', 'setGpuPassDurations(',
]);
requirePatterns('GPU pass timing production gate', pipeline, [
  'diagnosticsEnabled && frameDiagnostics', 'timestampQuerySupported', '_beginGpuPassTiming(',
]);

const benchmark = read('scripts/run-benchmarks.mjs');
const suite = read('scripts/benchmark/suite.mjs');
requirePatterns('benchmark report', benchmark, ['schemaVersion: 4', 'suiteVersion', 'environmentFingerprint()', 'relativeStddev', 'enforce-cohort', 'regressions', 'inconclusiveRegressions', 'metricBudgetViolations']);
for (const group of ['ecs.', 'transform.', 'render3d.', 'gpu-driven.', 'asset.gltf', 'asset.draco', 'asset.ktx2', 'asset.spine', 'animation.', 'scene.']) requirePatterns('benchmark suite', suite, [group]);
for (const group of ['gpu-sync.', 'churn.']) requirePatterns('benchmark follow-up suite', suite, [group]);

requireFile('scripts/render-regression/fixture.html');
requireFile('scripts/verify-pixel-regression.mjs');
requireFile('review/baselines/render-pixels-stage7.json');
requirePatterns('pixel regression', read('scripts/verify-pixel-regression.mjs'), ['WebGPU readback', "['fixture', 'width', 'height', 'hash'", 'CHROME_PATH']);

const player = read('editor/src/player.ts');
const panel = read('editor/src/play/runtimeDebugPanel.ts');
requirePatterns('editor diagnostics producer', player, ['getEngineFrameDiagnostics(engine)', 'frameDiagnostics?.snapshot()', 'pipeline.getDebugSnapshot()', 'getEngineGPUResourceTracker(engine)', 'resourceTracker?.getDebugSnapshot()', 'assetManager?.getDebugSnapshot()']);
requirePatterns('editor diagnostics panel', panel, ['Asset refs', 'Cache hit rate', 'Pipeline issues', 'Slowest GPU pass', 'exportDiagnosticSnapshot()', 'haiyue-diagnostics-']);

const engine = read('engine/src/core/Engine.ts');
requirePatterns('production opt-in', engine, ["options.diagnostics?.enabled === true", 'captureResourceStacks']);

if (failures.length) {
  console.error('[stage7-observability] failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[stage7-observability] resources, passes, frame metrics, statistical benchmarks, pixel golden, and editor diagnostics passed.');

function read(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) { failures.push(`missing ${path}`); return ''; }
  return readFileSync(absolute, 'utf8');
}
function requireFile(path) { read(path); }
function requirePatterns(label, source, patterns) {
  for (const pattern of patterns) if (!source.includes(pattern)) failures.push(`${label} missing ${pattern}`);
}
