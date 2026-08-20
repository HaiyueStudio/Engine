import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const editorRoot = resolve(root, '../Editor/editor');
const engineEntryPath = resolve(root, 'engine/src/core/Engine.ts');
const failures = [];
const requiredContracts = new Map([
  ['engine/src/core/Engine.ts', ['_handleDeviceLost', "_setState('recovering')", 'instrumentDevice', "emit('recovery-progress'", 'registerDeviceRecoveryParticipant']],
  ['engine/src/core/GPUResourceTracker.ts', ['releaseOwner', 'getOwnerUsages', 'instrumentDevice', 'withOwner']],
  ['engine/src/assets/AssetManager.ts', ['pendingJobCount', 'suspendForDeviceLoss', 'recoverDevice', 'AbortSignal']],
  ['engine/src/scene/Scene.ts', ['suspendForDeviceLoss', 'recoverDevice', 'this._assets.destroy()', 'this._runtime.finishDestroy()']],
  ['engine/src/scene/internal/SceneRuntime.ts', ["_state: SceneLifecycleState", "_state = 'destroying'", "_state = 'destroyed'", '_resourceScope?.release()']],
  ['engine/src/scene/internal/SceneAssets.ts', ['AssetOwnerScope', "_owner.abort('device-lost')", 'owner === this._owner', 'handle.release()', 'releaseAll()']],
  ['engine/src/core/EnginePluginHost.ts', ['PluginDependencyCycle', 'PluginDependencyInUse', '_topologicalOrder().reverse()']],
  ['editor/src/engine-adapter/EditorViewportBootstrap.ts', ["engine.on('recovery-progress'", "engine.on('recovery-failed'"]],
  ['editor/src/domain/runtime/RuntimeOwnershipScope.ts', ['engine?.stop()', 'world?.destroy()', 'pointer?.destroy()', 'engine?.destroy()']],
  ['engine/test/lifecycle-stage4.test.mjs', ['Engine recovers device', 'unrecoverable device replacement', 'late owner writeback']],
]);

for (const [path, snippets] of requiredContracts) {
  const source = readFileSync(resolveContract(path), 'utf8');
  for (const snippet of snippets) {
    if (!source.includes(snippet)) failures.push(`${path} is missing stage-4 contract: ${snippet}`);
  }
}

function resolveContract(path) {
  return path.startsWith('editor/') ? resolve(editorRoot, path.slice('editor/'.length)) : resolve(root, path);
}

for (const file of walk(resolve(root, 'engine/src'))) {
  if (!file.endsWith('.ts')) continue;
  const path = relative(root, file);
  if (file === engineEntryPath) continue;
  if (readFileSync(file, 'utf8').includes('.requestDevice(')) {
    failures.push(`${path} requests a GPUDevice outside HaiyueEngine recovery/ownership instrumentation.`);
  }
}

if (failures.length) {
  console.error('[stage4-lifecycle] Lifecycle contract regression detected:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[stage4-lifecycle] state machines, owner audit, recovery, cancellation, plugin graph, and editor status contracts are present.');

function walk(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(path));
    else result.push(path);
  }
  return result;
}
