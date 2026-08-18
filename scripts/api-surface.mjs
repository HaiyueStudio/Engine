import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = resolve(root, 'review/baselines/api-surface.json');
const publicWorkspaceDirectories = ['animation-spec', 'engine', 'extensions', 'ui'];
const allWorkspaceDirectories = ['shader-language', 'animation-spec', 'engine', 'extensions', 'ui', 'editor', 'examples', 'games'];
const mode = process.argv[2];
const engineExperimentalOnlyExports = new Set([
  'AssetCacheBudget',
  'AssetCacheHierarchy',
  'AssetCacheHierarchyOptions',
  'AssetCacheSnapshot',
  'AssetManagerDebugSnapshot',
  'AssetParser',
  'AssetParserContext',
  'AssetUploadScheduler',
  'AssetUploadSchedulerSnapshot',
  'AssetUploadTask',
  'AssetWorkerClient',
  'AssetWorkerLike',
  'AssetWorkerRequest',
  'AssetWorkerRequestInit',
  'AssetWorkerRequestType',
  'AssetWorkerResponse',
  'BaseRenderer',
  'BudgetedAssetCache',
  'createAssetWorkerClientFromUrl',
  'createAssetWorkerSource',
  'createGPUResourceOwner',
  'createInlineAssetWorkerClient',
  'createInlineKtx2TextureWorkerClient',
  'createKtx2TextureWorkerClientFromUrl',
  'createKtx2TextureWorkerSource',
  'createRegistrationToken',
  'createRenderCapabilities',
  'createSceneSystemPlan',
  'EnginePluginHost',
  'EnginePluginHostOptions',
  'EnginePluginHostScope',
  'EcsIdDomain',
  'EcsIds',
  'FrameDiagnostics',
  'FrameDiagnosticsOptions',
  'FrameMetricCounter',
  'FrameMetricsSnapshot',
  'FrameMetricStage',
  'getSpatialIndexService',
  'getSceneRenderIntegration',
  'getSceneRenderPipeline',
  'getRender3DFramePlanSnapshot',
  'getEngineFrameDiagnostics',
  'getEngineGPUResourceTracker',
  'registerEngineDiagnostics',
  'EngineDiagnosticsState',
  'GpuFrameTimingSnapshot',
  'GpuPassTimingSnapshot',
  'GpuPassTimingType',
  'GPUCacheStats',
  'GPUResourceDebugSnapshot',
  'GPUResourceOwner',
  'GPUResourceOwnerKind',
  'GPUResourceRecord',
  'GPUResourceScope',
  'GPUResourceTracker',
  'GPUResourceTrackerOptions',
  'GPUResourceTrackOptions',
  'GPUResourceTypeStats',
  'GPUResourceUsage',
  'GPUTrackedResourceType',
  'IdAllocator',
  'inspectKtx2Texture',
  'InstalledEnginePlugin',
  'isWorkerInfrastructureError',
  'Ktx2SupercompressionDecoder',
  'Ktx2TextureInfo',
  'Ktx2TexturePayload',
  'Ktx2TextureWorker',
  'Ktx2TextureWorkerClient',
  'Ktx2TextureWorkerOptions',
  'MeshSpatialEntry',
  'normalizeParserError',
  'normalizeSceneOptions',
  'parseAssetWorkerFirst',
  'prepareKtx2TexturePayload',
  'Render3DFramePassKind',
  'Render3DFramePassSnapshot',
  'requireEngineCanvas',
  'resolveRenderProfileFeatures',
  'resolveRenderProfileSettings',
  'SCENE_PRESETS',
  'ScenePresetDefinition',
  'SceneSystemPlanEntry',
  'SceneSystemRole',
  'SpatialIndex',
  'SpatialIndexKey',
  'SpatialIndexService',
  'SpatialIndexStats',
  'uploadKtx2Texture',
  'uploadPreparedKtx2Texture',
  'WorkerFirstParseOptions',
  'Mesh3DRenderer',
  'InstancedMesh3DRenderer',
  'DepthRenderer',
  'NormalRenderer',
  'Mesh2DRenderer',
  'BitmapTextRenderer',
  'MeshHelperRenderer',
  'OutlineMaskRenderer',
  'SkyRenderer',
  'BlinnPhongRenderer',
  'PbrRenderer',
  'RadialShadowRenderer',
  'VolumeRenderer',
  'MaterialRegistryBase',
  'RendererRegistrationRegistry',
  'RenderPipeline',
  'RenderIntegration',
  'RendererCacheMap',
  'RendererObjectSlotCache',
  'RendererPipelineLayoutCache',
  'RendererResourceCache',
  'ObjectTableSlotAllocator',
  'RendererObjectTable',
  'RendererObjectTableOptions',
  'SharedGeometry3DGPUCache',
  'getSharedGeometry3DGPUCache',
  'disposeSharedGeometry3DGPUCache',
  'IndirectDrawCommandBuffer',
  'GpuDrivenBatchBuffer',
  'GpuDrivenBatchCommand',
  'GpuDrivenBatchTables',
  'GpuDrivenInstanceTableEntry',
  'GpuDrivenMaterialTableEntry',
  'GpuDrivenMegaBatchRun',
  'GpuDrivenReadbackDebugSnapshot',
  'GpuDrivenReadbackPathDebugSnapshot',
  'GpuDrivenReadbackRequestOptions',
  'GpuDrivenReadbackResult',
  'GpuDrivenReadbackStatus',
  'MaterialGpuDrivenBatch',
  'TransparentMegaBatch',
  'TransparentMegaBatchEntry',
  'TransparentMegaBatchRun',
  'GpuDrawCommandComputePass',
  'GpuDrawCommandBuffers',
  'Mesh3DGpuCullComputePass',
  'Mesh3DGpuCullBuffers',
  'GpuSortComputePass',
  'GpuSortableBuffers',
  'SceneRenderEnvironment',
  'getSceneRenderEnvironment',
  'FOG_UNIFORM_WGSL',
  'FogUniformLayout',
  'generateWgslUniformStruct',
  'getSceneFrameUniformSnapshot',
  'SCENE_FRAME_UNIFORM_FLOATS',
  'SCENE_FRAME_UNIFORM_WGSL',
  'SceneFrameUniformLayout',
  'writeSceneFrameUniforms',
  'SceneFrameUniformSnapshot',
  'UniformAbiFieldDefinition',
  'UniformAbiFieldLayout',
  'UniformAbiLayout',
  'composeWgsl',
  'createComposedShaderModule',
  'defineWgslFeatureModule',
  'formatWgslCompilationMessage',
  'mapWgslSourceLocation',
  'ComposedWgsl',
  'ComposeWgslOptions',
  'WgslDefineValue',
  'WgslFeatureModule',
  'WgslFeatureModuleOptions',
  'WgslSourceLocation',
  'WgslSourceSpan',
]);
const stableMaterialProtocolExports = new Set([
  'MaterialRenderBatchItem',
  'MaterialRenderContext',
  'MaterialRendererKey',
  'MaterialRendererRegistration',
  'MaterialRendererRegistry',
]);
const stableSurfaceBudgets = new Map([
  // ADR 0035: the default entrypoint is an exact, intentionally small golden path.
  ['.', 30],
  ['./assets', 22],
  // ADR 0070: immutable aggregate snapshots only; mutation remains experimental.
  ['./diagnostics', 12],
  // ADR 0071: narrow, stable SPI consumed by separately published render extensions.
  ['./extension-authoring', 14],
  ['./color', 16],
  // ADR 0065: entity clipping adds one component, one capacity constant, and two focused contracts.
  ['./components', 103],
  ['./compute', 7],
  // ADR 0064: FirstPersonControls adds one class and one options contract.
  ['./controls', 9],
  ['./core', 68],
  ['./ecs', 22],
  ['./font', 13],
  // ADR 0043 + 0045 + 0047 + 0048: async CSG and focused triangle transforms.
  ['./geometry', 53],
  ['./gui', 69],
  ['./input', 3],
  // ADR 0046: one owned equirectangular-to-cubemap factory and its focused contracts.
  ['./lighting', 19],
  ['./material', 69],
  ['./math', 7],
  ['./navigation', 9],
  ['./physics', 37],
  // Backend-free component contract used by tools that must not evaluate a
  // simulation backend while inspecting or serializing a scene.
  ['./physics/components', 13],
  ['./physics/backend', 44],
  // ADR 0060: three focused AO passes plus their shared options contract.
  ['./postprocess', 29],
  ['./rtt', 5],
  ['./scene', 16],
  ['./serialization', 13],
  ['./systems', 41],
  ['./tween', 19],
]);
const experimentalSurfaceBudgets = new Map([
  // Keep the compatibility aggregate bounded while new callers move to owned slices.
  // ADR 0077/0078: shared WorkerChannel, compute ordering, and GUI layout parity seams.
  ['./experimental', 793],
  ['./experimental/assets', 40],
  // ADR 0077 focused WorkerChannel and async primitives for extension consumers.
  ['./experimental/async', 8],
  // Side-effect-only module worker entry; it intentionally exports no symbols.
  ['./experimental/ktx2-worker-runtime', 0],
  ['./experimental/diagnostics', 32],
  ['./experimental/gpu-driven', 32],
  ['./experimental/renderer', 64],
]);
const extensionStableSurfaceBudgets = new Map([
  // ADR 0070 + 0071: reviewed public extension batches.
  ['./animation', 26],
  ['./animation3d', 75],
  ['./canvas-text', 4],
  ['./gltf', 56],
  ['./gltf-animation3d', 5],
  ['./grid', 2],
  ['./hya-state-machine', 13],
  ['./spine', 8],
  ['./tilemap', 8],
  ['./tween', 6],
]);
const extensionExperimentalSurfaceBudgets = new Map([
  ['.', 2],
  ['./experimental/gltf-worker', 12],
  ['./experimental/spine-worker', 10],
]);
const rootOnlyForbiddenExports = new Set([
  'ComponentSerializationRegistry',
  'coreComponentSerializationRegistry',
  'deserializeEntityCore',
  'serializeEntityCore',
]);
const rootGoldenPathExports = new Set([
  'BasicMaterial',
  'Camera2D',
  'Camera3D',
  'CartesianTransform3D',
  'ColorSRGB',
  'Component',
  'createBox3D',
  'createPlane3D',
  'createSphere3D',
  'DirectionalLight',
  'EngineError',
  'EngineErrorCode',
  'Entity',
  'EnvironmentLight',
  'Geometry2D',
  'Geometry3D',
  'HaiyueEngine',
  'HaiyueEngineOptions',
  'Material2D',
  'Mesh2D',
  'Mesh3D',
  'OrbitControl',
  'PbrMaterial',
  'RenderProfileName',
  'Scene',
  'SceneOptions',
  'SphericalTransform3D',
  'System',
  'Transform2D',
  'World',
]);

if (mode !== '--check' && mode !== '--write') {
  console.error('Usage: node scripts/api-surface.mjs --check|--write');
  process.exit(2);
}

const current = createSnapshot();
assertApiStabilityBoundaries(current);
const serialized = `${JSON.stringify(current, null, 2)}\n`;

if (mode === '--write') {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, serialized);
  console.log(`[api-surface] Wrote ${relative(root, baselinePath)}.`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(`[api-surface] Missing ${relative(root, baselinePath)}. Run npm run api:update.`);
  process.exit(1);
}

const expected = readFileSync(baselinePath, 'utf8');
if (expected !== serialized) {
  console.error('[api-surface] Public API or workspace package graph changed.');
  printDiff(JSON.parse(expected), current);
  console.error('[api-surface] Review the change, then run npm run api:update in the same commit if it is intentional.');
  process.exit(1);
}

console.log('[api-surface] Public API and workspace package graph match the baseline.');

function createSnapshot() {
  const manifests = new Map(allWorkspaceDirectories.map(directory => {
    const manifest = JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8'));
    return [directory, manifest];
  }));
  const workspaceByName = new Map([...manifests].map(([directory, manifest]) => [manifest.name, directory]));
  const workspaceGraph = {};

  for (const [directory, manifest] of manifests) {
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    workspaceGraph[directory] = {
      name: manifest.name,
      private: manifest.private === true,
      workspaceDependencies: Object.keys(dependencies)
        .filter(name => workspaceByName.has(name))
        .sort(),
    };
  }

  const packages = {};
  for (const directory of publicWorkspaceDirectories) {
    const manifest = manifests.get(directory);
    const entrypoints = {};
    for (const [exportPath, target] of packageEntrypoints(manifest)) {
      const source = sourceForTarget(directory, target);
      entrypoints[exportPath] = {
        source: relative(root, source),
        exports: collectExports(source),
      };
    }
    packages[manifest.name] = {
      workspace: directory,
      private: manifest.private === true,
      entrypoints,
    };
  }

  return {
    schemaVersion: 1,
    note: 'Haiyue reviewed package facade baseline (2026-08-17). Engine root remains the exact ADR 0035 golden path; M2.5 adds reviewed experimental async and compute-ordering seams while stable growth still requires budget/ADR review.',
    workspaceGraph,
    packages,
  };
}

function assertApiStabilityBoundaries(snapshot) {
  const engine = snapshot.packages['@haiyue/engine'];
  if (!engine) throw new Error('Missing @haiyue/engine API snapshot.');

  const stableEntrypoints = Object.keys(engine.entrypoints)
    .filter(entrypoint => !isExperimentalEntrypoint(entrypoint));
  const unbudgetedStableEntrypoints = stableEntrypoints
    .filter(entrypoint => !stableSurfaceBudgets.has(entrypoint));
  const budgetsWithoutEntrypoints = [...stableSurfaceBudgets.keys()]
    .filter(entrypoint => !stableEntrypoints.includes(entrypoint));
  if (unbudgetedStableEntrypoints.length > 0 || budgetsWithoutEntrypoints.length > 0) {
    console.error('[api-surface] Stable entrypoint budgets do not match package exports.');
    if (unbudgetedStableEntrypoints.length > 0) {
      console.error(`[api-surface] Stable entrypoints without budgets: ${unbudgetedStableEntrypoints.join(', ')}.`);
    }
    if (budgetsWithoutEntrypoints.length > 0) {
      console.error(`[api-surface] Budgets without stable entrypoints: ${budgetsWithoutEntrypoints.join(', ')}.`);
    }
    console.error('[api-surface] Every stable entrypoint requires an explicitly reviewed surface budget.');
    process.exit(1);
  }

  for (const [entrypoint, entry] of Object.entries(engine.entrypoints)) {
    if (isExperimentalEntrypoint(entrypoint)) continue;
    const leaked = entry.exports
      .map(exported => exported.name)
      .filter(name => engineExperimentalOnlyExports.has(name));
    if (leaked.length > 0) {
      console.error(
        `[api-surface] Stable entrypoint ${entrypoint} exposes experimental renderer implementation: ${leaked.join(', ')}.`,
      );
      console.error('[api-surface] Move the export to @haiyue/engine/experimental; do not approve it with api:update.');
      process.exit(1);
    }
  }

  for (const [entrypoint, maximum] of stableSurfaceBudgets) {
    const count = engine.entrypoints[entrypoint]?.exports.length ?? 0;
    if (count > maximum) {
      console.error(`[api-surface] Stable entrypoint ${entrypoint} exports ${count} symbols; budget is ${maximum}.`);
      console.error('[api-surface] Remove implementation detail or explicitly reset the reviewed budget and ADR.');
      process.exit(1);
    }
  }

  const experimentalEntrypoints = Object.keys(engine.entrypoints).filter(isExperimentalEntrypoint);
  const unbudgetedExperimentalEntrypoints = experimentalEntrypoints
    .filter(entrypoint => !experimentalSurfaceBudgets.has(entrypoint));
  const missingExperimentalEntrypoints = [...experimentalSurfaceBudgets.keys()]
    .filter(entrypoint => !experimentalEntrypoints.includes(entrypoint));
  if (unbudgetedExperimentalEntrypoints.length || missingExperimentalEntrypoints.length) {
    console.error('[api-surface] Experimental entrypoint governance does not match package exports.');
    if (unbudgetedExperimentalEntrypoints.length) console.error(`[api-surface] Unbudgeted experimental entrypoints: ${unbudgetedExperimentalEntrypoints.join(', ')}.`);
    if (missingExperimentalEntrypoints.length) console.error(`[api-surface] Missing experimental entrypoints: ${missingExperimentalEntrypoints.join(', ')}.`);
    process.exit(1);
  }
  const aggregateExperimentalNames = new Set(
    engine.entrypoints['./experimental']?.exports.map(exported => `${exported.kind}:${exported.name}`) ?? [],
  );
  for (const [entrypoint, maximum] of experimentalSurfaceBudgets) {
    const exports = engine.entrypoints[entrypoint]?.exports ?? [];
    if (exports.length > maximum) {
      console.error(`[api-surface] Experimental entrypoint ${entrypoint} exports ${exports.length} symbols; budget is ${maximum}.`);
      process.exit(1);
    }
    if (entrypoint === './experimental') continue;
    const outsideAggregate = exports.filter(exported => !aggregateExperimentalNames.has(`${exported.kind}:${exported.name}`));
    if (outsideAggregate.length) {
      console.error(`[api-surface] Focused ${entrypoint} exposes symbols absent from the compatibility aggregate: ${outsideAggregate.map(item => item.name).join(', ')}.`);
      process.exit(1);
    }
  }

  const rootNames = new Set(engine.entrypoints['.']?.exports.map(exported => exported.name) ?? []);
  const missingGoldenPath = [...rootGoldenPathExports].filter(name => !rootNames.has(name));
  const unexpectedRootExports = [...rootNames].filter(name => !rootGoldenPathExports.has(name));
  if (missingGoldenPath.length > 0 || unexpectedRootExports.length > 0) {
    console.error('[api-surface] Default entrypoint must match the ADR 0035 golden path exactly.');
    if (missingGoldenPath.length > 0) console.error(`[api-surface] Missing golden-path exports: ${missingGoldenPath.join(', ')}.`);
    if (unexpectedRootExports.length > 0) console.error(`[api-surface] Unexpected root exports: ${unexpectedRootExports.join(', ')}.`);
    process.exit(1);
  }
  const rootLeaks = [...rootOnlyForbiddenExports].filter(name => rootNames.has(name));
  if (rootLeaks.length > 0) {
    console.error(`[api-surface] Default entrypoint exposes optional serialization infrastructure: ${rootLeaks.join(', ')}.`);
    console.error('[api-surface] Import it from @haiyue/engine/serialization instead.');
    process.exit(1);
  }

  for (const entrypoint of ['./material']) {
    const exportedNames = new Set(engine.entrypoints[entrypoint]?.exports.map(exported => exported.name) ?? []);
    const missing = [...stableMaterialProtocolExports].filter(name => !exportedNames.has(name));
    if (missing.length > 0) {
      console.error(`[api-surface] Stable material protocol is incomplete in ${entrypoint}: ${missing.join(', ')}.`);
      process.exit(1);
    }
  }

  const extensions = snapshot.packages['@haiyue/extensions'];
  if (!extensions || extensions.private) {
    console.error('[api-surface] ADR 0070/0071 requires @haiyue/extensions to be a public workspace.');
    process.exit(1);
  }
  const extensionEntrypoints = Object.keys(extensions.entrypoints);
  const governedExtensionEntrypoints = new Set([
    ...extensionStableSurfaceBudgets.keys(),
    ...extensionExperimentalSurfaceBudgets.keys(),
  ]);
  const ungovernedExtensionEntrypoints = extensionEntrypoints.filter(entrypoint => !governedExtensionEntrypoints.has(entrypoint));
  const missingExtensionEntrypoints = [...governedExtensionEntrypoints].filter(entrypoint => !extensionEntrypoints.includes(entrypoint));
  if (ungovernedExtensionEntrypoints.length || missingExtensionEntrypoints.length) {
    console.error('[api-surface] Extension entrypoint governance does not match package exports.');
    if (ungovernedExtensionEntrypoints.length) console.error(`[api-surface] Ungoverned extension entrypoints: ${ungovernedExtensionEntrypoints.join(', ')}.`);
    if (missingExtensionEntrypoints.length) console.error(`[api-surface] Missing extension entrypoints: ${missingExtensionEntrypoints.join(', ')}.`);
    process.exit(1);
  }
  for (const [entrypoint, maximum] of [...extensionStableSurfaceBudgets, ...extensionExperimentalSurfaceBudgets]) {
    const count = extensions.entrypoints[entrypoint]?.exports.length ?? 0;
    if (count > maximum) {
      console.error(`[api-surface] Extension entrypoint ${entrypoint} exports ${count} symbols; budget is ${maximum}.`);
      process.exit(1);
    }
  }

  assertStableDeclarationBoundary(
    resolve(root, 'engine/src/renderer/MaterialRendererRegistry.ts'),
    'MaterialRenderContext',
    new Set(['gpuDrivenBatch']),
  );
  assertStableDeclarationBoundary(
    resolve(root, 'engine/src/systems/Render3DSystem.ts'),
    'Render3DSystem',
    new Set([
      'addRenderer',
      'gpuDrivenBatchBuffer',
      'getGpuDrivenBatchIndexForEntity',
      'getGpuDrivenMaterialSlot',
    ]),
  );
  assertStableDeclarationBoundary(
    resolve(root, 'engine/src/core/Engine.ts'),
    'HaiyueEngine',
    new Set([
      'frameDiagnostics',
      'frameLoop',
      'getGPUResourceUsage',
      'gpuResourceTracker',
      'pluginHost',
      'registries',
      'renderTargets',
    ]),
  );
  assertStableDeclarationBoundary(
    resolve(root, 'engine/src/core/IEngine.ts'),
    'IEngine',
    new Set(['frameDiagnostics', 'getGPUResourceUsage', 'gpuResourceTracker']),
  );
  assertStableDeclarationBoundary(
    resolve(root, 'engine/src/scene/Scene.ts'),
    'Scene',
    new Set(['pluginHost', 'registries', 'renderIntegration', 'renderPipeline']),
  );
}

function isExperimentalEntrypoint(entrypoint) {
  return entrypoint === './experimental' || entrypoint.startsWith('./experimental/');
}

function assertStableDeclarationBoundary(file, declarationName, forbiddenMemberNames) {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = sourceFile.statements.find(statement =>
    (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement))
      && statement.name?.text === declarationName,
  );
  if (!declaration) throw new Error(`Cannot inspect stable declaration ${declarationName} in ${relative(root, file)}.`);

  const leaks = [];
  for (const member of declaration.members) {
    if (hasModifier(member, ts.SyntaxKind.PrivateKeyword) || hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) continue;
    const name = memberName(member.name);
    if (name && forbiddenMemberNames.has(name)) leaks.push(name);

    const typeNodes = [];
    if ('type' in member && member.type) typeNodes.push(member.type);
    if ('parameters' in member) {
      for (const parameter of member.parameters) if (parameter.type) typeNodes.push(parameter.type);
    }
    for (const typeNode of typeNodes) {
      visitTypeNode(typeNode, identifier => {
        if (engineExperimentalOnlyExports.has(identifier)) leaks.push(`${name ?? '<signature>'}:${identifier}`);
      });
    }
  }
  if (leaks.length > 0) {
    console.error(
      `[api-surface] Stable ${declarationName} leaks experimental renderer implementation: ${[...new Set(leaks)].join(', ')}.`,
    );
    process.exit(1);
  }
}

function hasModifier(node, kind) {
  return node.modifiers?.some(modifier => modifier.kind === kind) === true;
}

function memberName(name) {
  if (!name) return null;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : null;
}

function visitTypeNode(node, onIdentifier) {
  if (ts.isIdentifier(node)) onIdentifier(node.text);
  ts.forEachChild(node, child => visitTypeNode(child, onIdentifier));
}

function packageEntrypoints(manifest) {
  if (!manifest.exports) return [['.', manifest.module ?? manifest.main]];
  return Object.entries(manifest.exports)
    .map(([key, value]) => [key, typeof value === 'string' ? value : value.import ?? value.default])
    .sort(([a], [b]) => a.localeCompare(b));
}

function sourceForTarget(directory, target) {
  if (typeof target !== 'string') throw new Error(`No import target found for ${directory}.`);
  const relativeTarget = target.replace(/^(?:\.\/)?dist\//, '').replace(/\.js$/, '.ts');
  const source = resolve(root, directory, 'src', relativeTarget);
  if (!existsSync(source)) throw new Error(`Cannot map ${directory}/${target} to ${relative(root, source)}.`);
  return source;
}

function collectExports(entryFile) {
  const visited = new Set();
  const exports = new Map();
  collectFromFile(entryFile);
  return [...exports.values()].sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));

  function collectFromFile(file) {
    const canonical = resolve(file);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const sourceText = readFileSync(canonical, 'utf8');
    const sourceFile = ts.createSourceFile(canonical, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    for (const statement of sourceFile.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            addExport(element.name.text, statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value');
          }
        } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
          addExport(statement.exportClause.name.text, 'value');
        } else if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
          const dependency = resolveModule(canonical, statement.moduleSpecifier.text);
          if (dependency) collectFromFile(dependency);
        }
        continue;
      }

      if (ts.isExportAssignment(statement)) {
        addExport('default', 'value');
        continue;
      }

      if (!hasExportModifier(statement)) continue;
      if ('name' in statement && statement.name && ts.isIdentifier(statement.name)) {
        const kind = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ? 'type' : 'value';
        addExport(statement.name.text, kind);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) addExport(declaration.name.text, 'value');
        }
      }
    }
  }

  function addExport(name, kind) {
    const key = `${kind}:${name}`;
    if (!exports.has(key)) exports.set(key, { name, kind });
  }
}

function resolveModule(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const raw = resolve(dirname(importer), specifier);
  const candidates = specifier.endsWith('.js')
    ? [raw.replace(/\.js$/, '.ts'), raw.replace(/\.js$/, '.tsx')]
    : [raw, `${raw}.ts`, `${raw}.tsx`, resolve(raw, 'index.ts'), resolve(raw, 'index.tsx')];
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function hasExportModifier(node) {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function printDiff(expected, current) {
  const expectedEntries = flattenEntries(expected);
  const currentEntries = flattenEntries(current);
  const removed = [...expectedEntries].filter(item => !currentEntries.has(item)).sort();
  const added = [...currentEntries].filter(item => !expectedEntries.has(item)).sort();
  for (const item of removed.slice(0, 30)) console.error(`- removed ${item}`);
  for (const item of added.slice(0, 30)) console.error(`- added ${item}`);
  if (removed.length + added.length > 60) console.error(`- ... ${removed.length + added.length - 60} more changes`);
}

function flattenEntries(snapshot) {
  const result = new Set();
  for (const [workspace, definition] of Object.entries(snapshot.workspaceGraph ?? {})) {
    result.add(`workspace:${workspace}:${definition.name}:${definition.private}:${definition.workspaceDependencies.join(',')}`);
  }
  for (const [packageName, definition] of Object.entries(snapshot.packages ?? {})) {
    for (const [entrypoint, entry] of Object.entries(definition.entrypoints ?? {})) {
      for (const exported of entry.exports ?? []) result.add(`${packageName}${entrypoint}:${exported.kind}:${exported.name}`);
    }
  }
  return result;
}
