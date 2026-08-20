import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStudioRepositoryPath } from './studio-repository-layout.mjs';

const root = resolve(import.meta.dirname, '..');
const checkerPath = fileURLToPath(import.meta.url);
const failures = [];

requirePatterns('AssetJob', read('engine/src/assets/AssetJob.ts'), [
  'priority', 'timeoutMs', 'reportProgress', 'AssetOwnerScope', '_generation', 'abortPromise', 'disposeLateResult',
]);
requirePatterns('AssetManager orchestration', read('engine/src/assets/AssetManager.ts'), [
  'AssetJob<', 'AssetCacheHierarchy', 'AssetUploadScheduler', 'waitForRecord', 'abortAll(', 'drainUploadBudget(',
]);
requirePatterns('layered cache', read('engine/src/assets/AssetCache.ts'), [
  "'network'", "'parsed-cpu'", "'gpu-device'", 'maxBytes', 'maxEntries', 'evictToBudget', 'releaseDevice(',
]);
requirePatterns('upload budget', read('engine/src/assets/AssetUploadScheduler.ts'), [
  'frameBudgetBytes', 'drainFrame(', 'pendingBytes', 'priority', 'exceeds the per-frame budget',
]);
requirePatterns('KTX2 worker/main contract', read('engine/src/assets/Ktx2TextureLoader.ts'), [
  'prepareKtx2TexturePayload', 'parseAssetWorkerFirst', 'context.cache.network', 'context.cache.parsed',
  'uploadPreparedKtx2TextureBudgeted',
]);
requirePatterns('versioned WorkerChannel contract', read('engine/src/async/WorkerChannel.ts'), [
  'WORKER_CHANNEL_PROTOCOL_VERSION', 'maxPending', 'latestKey', "'error'", "'messageerror'", 'terminate()',
]);
requirePatterns('dedicated KTX2 worker entry', read('engine/src/experimental/ktx2-worker-runtime.ts'), [
  'value.version', 'prepareKtx2TexturePayload', 'scope.postMessage', 'cancelled',
]);
requirePatterns('KTX2 budgeted upload contract', read('engine/src/assets/Ktx2TextureUpload.ts'), [
  'planKtx2BudgetedUploadBatches', 'rowCount', 'context.scheduleUpload',
]);
requirePatterns('glTF/Draco shared parser', read('extensions/src/gltf/GltfAssetWorkerClient.ts'), [
  'parser.loadParsedGltfAsset', 'parser.prepareGltfGeometryPayloads', "request.type === 'cancel'",
]);
forbidPatterns('glTF worker duplicate parser', read('extensions/src/gltf/GltfAssetWorkerClient.ts'), [
  'function readAccessor', 'function prepareGeometryPayloads', 'function decodeDraco',
]);
requirePatterns('Spine shared parser', read('extensions/src/spine/SpineAssetParser.ts'), [
  'SPINE_ASSET_PARSER', 'normalizeSpineData', 'parseAtlas',
]);
requirePatterns('Spine worker cancellation', read('extensions/src/spine/SpineAssetWorkerClient.ts'), [
  'parser.parseSpineAssetPayload', "request.type === 'cancel'", 'AbortController',
]);
requirePatterns('Scene owner cancellation', read('engine/src/scene/internal/SceneAssets.ts'), [
  'AssetOwnerScope', "abort('scene-destroyed')", '_canCommit(owner',
]);

const contract = read('engine/src/script/ScriptRuntimeContract.ts');
for (const capability of ['read', 'scene', 'asset', 'input', 'physics', 'debug']) requirePatterns('script capabilities', contract, [`'${capability}'`]);
requirePatterns('single script contract', contract, [
  'SCRIPT_RUNTIME_CONTRACT', 'DEFAULT_SCRIPT_CAPABILITIES', 'SCRIPT_RUNTIME_COMPLETION_PATHS', 'generateScriptRuntimeDeclarations', 'filterScriptRuntimeApi',
]);
requirePatterns('script isolation and errors', read('engine/src/components/ScriptComponent.ts'), [
  "'trusted-project'", "'disable-script'", 'ComponentScriptFailed', 'ScriptExecutionScope', 'sourceMap', 'restart()', '_disposeScope()',
]);
requirePatterns('script hot reload notification', read('engine/src/script/ScriptResource.ts'), ['onChange(', '_version++']);
requirePatterns('editor contract hints', read('editor/src/script/scriptAuthoringText.ts'), ['SCRIPT_RUNTIME_COMPLETION_PATHS']);
requirePatterns('export declaration generation', read('editor/src/export/projectTemplate.ts'), [
  'generateScriptRuntimeDeclarations', "'src/haiyue-script-runtime.d.ts'",
]);
requirePatterns('editor runtime capabilities', read('editor/src/player.ts'), [
  'enableTrustedProject', "capabilities: ['read', 'scene', 'asset', 'input', 'physics', 'debug']", 'onError:', "errorPolicy: 'disable-script'",
]);
for (const path of [
  'editor/scene-examples/2048-starter.scene.json',
  'editor/scene-examples/minesweeper-starter.scene.json',
  'editor/scene-examples/hex-minesweeper-starter.scene.json',
  'editor/scene-examples/snake-starter.scene.json',
  'editor/scene-examples/billiards-3d-import.scene.json',
  'editor/scene-examples/rubiks-cube-3d-import.scene.json',
  'games/pad-simulator/scenes/2048-starter.scene.json',
  'games/pad-simulator/scenes/minesweeper-starter.scene.json',
  'games/pad-simulator/scenes/hex-minesweeper-starter.scene.json',
  'games/pad-simulator/scenes/snake-starter.scene.json',
  'games/pad-simulator/scenes/billiards-3d-import.scene.json',
]) {
  const source = read(path);
  requirePatterns('owned scene-script listeners', source, ['api.debug.listen', 'api.debug.addDisposer']);
  forbidPatterns('unowned scene-script listeners', source, ['addEventListener(']);
}

requirePatterns('parser contract tests', read('extensions/test/asset-parser-contract.test.mjs'), [
  'glTF and Draco', 'KTX2 main and worker', 'Spine main and worker', 'code: error.code', 'path: error.path',
]);
requirePatterns('asset/script lifecycle tests', read('engine/test/asset-script-stage8.test.mjs'), [
  'deduplicated peer', 'authoritative transition table', 'frame budget', 'disables only the failing component', 'hot reload disposes',
]);
requirePatterns('WorkerChannel fault tests', read('engine/test/worker-channel.test.mjs'), [
  'versioned responses', 'latest-wins', 'bounded overflow', 'version mismatch', 'messageerror',
]);
requirePatterns('phased KTX2 upload test', read('engine/test/ktx2-basis-transcode.test.mjs'), [
  'splits a large KTX2 upload into frame-budgeted row chunks', 'descriptor.size <= 512',
]);

const suite = read('scripts/benchmark/suite.mjs');
for (const stage of ["stage: 'parse'", "stage: 'upload'", "stage: 'animation-sampling'"]) requirePatterns('asset benchmark stages', suite, [stage]);
requirePatterns('asset benchmark budgets', suite, ['budgetP95Ms', 'asset.upload-budget']);
requirePatterns('benchmark budget report', read('scripts/run-benchmarks.mjs'), ['schemaVersion: 4', "suiteVersion: 'stage9-follow-up-v3'", 'budgetViolations', 'metricBudgetViolations', 'budgetStatus']);

for (const path of [
  'docs/for-ai/adr/0013-asset-pipeline-and-trusted-script-capabilities.md',
  'docs/engine-guide/asset-lifecycle.md',
  'docs/engine-guide/script-runtime.md',
  'docs/api/errors/E_COMPONENT_SCRIPT_FAILED.md',
  'review/baselines/stage-8-asset-script-runtime-2026-07-13.md',
]) requireFile(path);

const migratedSources = collectText([
  'engine/src', 'extensions/src', 'editor/src', 'examples', 'games', 'scripts', 'editor/scene-examples',
]);
forbidPatterns('removed script API', migratedSources, [
  'enableTrustedEval', 'ScriptRuntimeWorldFacade', 'ScriptRuntimeApiAccess', 'trusted-eval',
  'api.world', 'api.data(', 'api.console', 'api.components', 'api.resources', 'api.canvas', 'api.pointer', 'api.engine', 'api.performance',
]);
forbidPatterns('removed serialized script lifecycles', collectText([
  'editor/scene-examples', 'games/pad-simulator/scenes',
]), ['"onStart"', '"onDestroy"', '"onPointerDown"', '"onPointerMove"', '"onPointerUp"', '"onKeyDown"', '"onKeyUp"']);
validateSerializedScripts(['editor/scene-examples', 'games/pad-simulator/scenes']);

if (failures.length) {
  console.error('[stage8-asset-script] failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[stage8-asset-script] shared parsers, cancellable jobs, layered caches, upload budgets, capability declarations, hot reload, and script isolation passed.');

function read(path) {
  const absolute = resolveLogicalPath(path);
  if (!existsSync(absolute)) { failures.push(`missing ${path}`); return ''; }
  return readFileSync(absolute, 'utf8');
}
function requireFile(path) { read(path); }
function requirePatterns(label, source, patterns) {
  for (const pattern of patterns) if (!source.includes(pattern)) failures.push(`${label} missing ${pattern}`);
}
function forbidPatterns(label, source, patterns) {
  for (const pattern of patterns) if (source.includes(pattern)) failures.push(`${label} still contains ${pattern}`);
}
function collectText(paths) {
  let result = '';
  for (const path of paths) walk(resolveLogicalPath(path));
  return result;
  function walk(absolute) {
    if (!existsSync(absolute)) return;
    if (absolute === checkerPath) return;
    if (absolute.endsWith('/bundle.js')) return;
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      for (const name of readdirSync(absolute)) {
        if (name === 'dist' || name === 'dist-test' || name === 'node_modules') continue;
        walk(resolve(absolute, name));
      }
      return;
    }
    if (!['.ts', '.js', '.mjs', '.json'].includes(extname(absolute))) return;
    result += readFileSync(absolute, 'utf8');
  }
}

function validateSerializedScripts(paths) {
  for (const directory of paths) {
    const absoluteDirectory = resolveLogicalPath(directory);
    for (const name of readdirSync(absoluteDirectory)) {
      if (!name.endsWith('.json')) continue;
      const path = `${directory}/${name}`;
      let document;
      try { document = JSON.parse(read(path)); }
      catch (error) { failures.push(`${path} is not valid JSON: ${error.message}`); continue; }
      for (const resource of document.resources?.scripts ?? []) {
        for (const [lifecycle, source] of Object.entries(resource.scripts ?? {})) {
          if (typeof source !== 'string' || !source.trim()) continue;
          try { new Function('entity', 'component', 'world', 'time', 'delta', 'event', 'api', source); }
          catch (error) { failures.push(`${path} ${lifecycle} does not compile: ${error.message}`); }
        }
      }
    }
  }
}

function resolveLogicalPath(path) {
  if (path.startsWith('editor/')) {
    return resolveStudioRepositoryPath('Editor', 'editor', path.slice('editor/'.length));
  }
  if (path.startsWith('games/')) {
    return resolveStudioRepositoryPath('Games', 'games', path.slice('games/'.length));
  }
  return resolve(root, path);
}
