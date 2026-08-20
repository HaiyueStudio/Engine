import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { resolveStudioRepositoryPath } from './studio-repository-layout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const ownerSizeBudgets = [
  { path: 'engine/src/systems/Render3DSystem.ts', maxLines: 1270 },
  { path: 'engine/src/assets/Ktx2TextureLoader.ts', maxLines: 1300 },
  { path: 'engine/src/renderer/PbrRenderer.ts', maxLines: 1070 },
  { path: 'extensions/src/spine/Spine2DRuntime.ts', maxLines: 1540 },
  { path: 'voxelEditor/src/model.ts', maxLines: 1490 },
  { path: 'voxelEditor/src/commands.ts', maxLines: 1240 },
  { path: 'voxelEditor/src/VoxelRenderer.ts', maxLines: 1170 },
  { path: 'editor/src/infra/resource-ui/resourceDetails.ts', maxLines: 600 },
  { path: 'scripts/benchmark/real-renderer-scenario.mjs', maxLines: 1250 },
];

const contracts = [
  {
    owner: 'engine/src/renderer/RenderPipeline.ts',
    module: 'engine/src/renderer/frame-plan/RenderFramePlan.ts',
    specifier: './frame-plan/RenderFramePlan',
    moduleClass: 'RenderFramePlanCompiler',
    forbiddenOwnerDeclarations: [
      'RenderFrameItemInput', 'RenderFramePlanItem', 'RenderFramePlan', 'RenderFramePlanCompiler',
    ],
  },
  {
    owner: 'engine/src/renderer/RenderPipeline.ts',
    module: 'engine/src/renderer/frame-plan/RenderPassCompatibility.ts',
    specifier: './frame-plan/RenderPassCompatibility',
    forbiddenOwnerDeclarations: [
      'canShareRenderPass', 'sharedPassConflictMessage', 'getResolvedRenderPassKey',
      'hasSameRenderTarget', 'hasSameRequiredPassState',
    ],
  },
  {
    owner: 'engine/src/systems/Render3DSystem.ts',
    module: 'engine/src/systems/Render3DViewPreparation.ts',
    specifier: './Render3DViewPreparation',
    moduleClass: 'Render3DViewPreparation',
    forbiddenOwnerDeclarations: ['Render3DViewPreparationSortResult'],
  },
  {
    owner: 'engine/src/systems/Render3DSystem.ts',
    module: 'engine/src/systems/Render3DContracts.ts',
    specifier: './Render3DContracts',
    forbiddenOwnerDeclarations: [
      'Render3DSystemOptions', 'DefaultMaterialRendererOptions',
      'Render3DRenderItem', 'TransparentMaterialInfo', 'Render3DHelperItem',
    ],
  },
  {
    owner: 'engine/src/systems/Render3DSystem.ts',
    module: 'engine/src/systems/Render3DLiveCache.ts',
    specifier: './Render3DLiveCache',
    moduleClass: 'Render3DLiveCache',
    forbiddenOwnerDeclarations: ['LiveFrameMarker'],
  },
  {
    owner: 'engine/src/systems/Render3DSystem.ts',
    module: 'engine/src/systems/Render3DRendererSuite.ts',
    specifier: './Render3DRendererSuite',
    moduleClass: 'Render3DRendererSuite',
  },
  {
    owner: 'engine/src/systems/Render3DSystem.ts',
    module: 'engine/src/systems/Render3DSystemAccess.ts',
    specifier: './Render3DSystemAccess',
    forbiddenOwnerDeclarations: [
      'ExperimentalRender3DSystemAccess', 'experimentalAccess',
      'installRender3DMeshRenderer', 'readRender3DGpuDrivenBatchBuffer',
      'readRender3DGpuDrivenBatchIndexForEntity', 'readRender3DGpuDrivenMaterialSlot',
    ],
  },
  {
    owner: 'engine/src/systems/Render3DSystem.ts',
    module: 'engine/src/systems/Render3DDefaultRendererRegistry.ts',
    specifier: './Render3DDefaultRendererRegistry',
    forbiddenOwnerDeclarations: ['DefaultRendererAccess', 'registerDefaultMaterialRenderers'],
  },
  {
    owner: 'engine/src/systems/Render3DSystem.ts',
    module: 'engine/src/systems/Render3DDirectionalShadowOrchestrator.ts',
    specifier: './Render3DDirectionalShadowOrchestrator',
    moduleClass: 'Render3DDirectionalShadowOrchestrator',
    forbiddenOwnerDeclarations: ['Render3DShadowCollectionOptions'],
    forbiddenOwnerCalls: ['collectShadowCasters', 'writeDirectionalShadowViewProjection'],
  },
  {
    owner: 'engine/src/systems/Render3DDirectionalShadowOrchestrator.ts',
    module: 'engine/src/systems/Render3DDirectionalShadowCache.ts',
    specifier: './Render3DDirectionalShadowCache',
    moduleClass: 'Render3DDirectionalShadowCache',
  },
  {
    owner: 'engine/src/systems/Render3DSystem.ts',
    module: 'engine/src/systems/Render3DSpatialCandidateResolver.ts',
    specifier: './Render3DSpatialCandidateResolver',
    moduleClass: 'Render3DSpatialCandidateResolver',
    forbiddenOwnerCalls: ['getSpatialIndexService', 'queryFrustum'],
  },
  {
    owner: 'engine/src/systems/Render3DViewPreparation.ts',
    module: 'engine/src/systems/Render3DTransparentViewResources.ts',
    specifier: './Render3DTransparentViewResources',
    moduleClass: 'Render3DTransparentViewResources',
    forbiddenOwnerDeclarations: ['TransparentViewGeneration'],
    forbiddenOwnerCalls: ['getTransparentViewBatch', 'getTransparentViewSortPass'],
  },
  {
    owner: 'engine/src/systems/Render3DViewPreparation.ts',
    module: 'engine/src/systems/Render3DGpuDrivenBatchBuilder.ts',
    specifier: './Render3DGpuDrivenBatchBuilder',
    moduleClass: 'Render3DGpuDrivenBatchBuilder',
  },
  {
    owner: 'engine/src/systems/Render3DViewPreparation.ts',
    module: 'engine/src/systems/Render3DFrameItems.ts',
    specifier: './Render3DFrameItems',
    moduleClass: 'Render3DFrameItems',
  },
  {
    owner: 'engine/src/systems/Render3DSystem.ts',
    module: 'engine/src/systems/Render3DBoundsCache.ts',
    specifier: './Render3DBoundsCache',
    moduleClass: 'Render3DBoundsCache',
    forbiddenOwnerDeclarations: ['BoundingSphereCacheEntry'],
    forbiddenOwnerCalls: ['computeBoundingSphere', 'transformBoundingSphere'],
  },
  {
    owner: 'engine/src/renderer/Mesh3DRenderer.ts',
    module: 'engine/src/renderer/Mesh3DPipelineFactory.ts',
    specifier: './Mesh3DPipelineFactory',
    moduleClass: 'Mesh3DPipelineFactory',
    forbiddenOwnerDeclarations: ['Mesh3DPipelineOptions'],
    forbiddenOwnerCalls: ['createRenderPipeline'],
  },
  {
    owner: 'engine/src/renderer/PbrRenderer.ts',
    module: 'engine/src/renderer/PbrDeformationGpuCache.ts',
    specifier: './PbrDeformationGpuCache',
    moduleClass: 'PbrDeformationGpuCache',
    forbiddenOwnerDeclarations: ['PbrDeformationGpuData', 'PbrDeformationGpuCacheOptions'],
  },
  {
    owner: 'engine/src/renderer/PbrRenderer.ts',
    module: 'engine/src/renderer/PbrTextureBindings.ts',
    specifier: './PbrTextureBindings',
    forbiddenOwnerDeclarations: [
      'pbrTextureSource', 'writeTextureMapping', 'unwrapTexture',
      'unwrapCubeTexture', 'getCubeMipCount', 'getCubeVersion', 'isGpuTextureLike',
    ],
  },
  {
    owner: 'extensions/src/gltf/gltfLoader.ts',
    module: 'extensions/src/gltf/GltfLoaderContract.ts',
    specifier: './GltfLoaderContract',
    forbiddenOwnerDeclarations: [
      'LoadGltfOptions', 'LoadedGltfModel', 'GltfLoadContext',
      'GltfAnimationClip', 'DracoDecoderConfig',
    ],
  },
  {
    owner: 'extensions/src/gltf/gltfLoader.ts',
    module: 'extensions/src/gltf/GltfAccessorReader.ts',
    specifier: './GltfAccessorReader',
    forbiddenOwnerDeclarations: [
      'readAccessorFloat', 'readAccessorIndices', 'readAccessorMat4',
      'readAccessorUnsigned', 'generateFlatNormals',
    ],
  },
  {
    owner: 'extensions/src/gltf/gltfLoader.ts',
    module: 'extensions/src/gltf/GltfDracoDecoder.ts',
    specifier: './GltfDracoDecoder',
    forbiddenOwnerDeclarations: ['decodeDracoPrimitive'],
  },
  {
    owner: 'extensions/src/gltf/gltfLoader.ts',
    module: 'extensions/src/gltf/GltfAnimationRuntime.ts',
    specifier: './GltfAnimationRuntime',
    forbiddenOwnerDeclarations: [
      'createAnimationClips', 'applyGltfAnimationClip', 'sampleAnimationChannel',
      'composeTrsMatrix', 'updateSkinnedPrimitive',
    ],
  },
  {
    owner: 'extensions/src/gltf/gltfLoader.ts',
    module: 'extensions/src/gltf/GltfMaterialLoader.ts',
    specifier: './GltfMaterialLoader',
    forbiddenOwnerDeclarations: [
      'createGltfMaterial', 'preloadGltfTextures', 'resolveGltfTextureMapping',
      'createSamplerDescriptor', 'resolveTextureReference',
    ],
  },
  {
    owner: 'extensions/src/gltf/gltfLoader.ts',
    module: 'extensions/src/gltf/GltfLoaderErrors.ts',
    specifier: './GltfLoaderErrors',
    forbiddenOwnerDeclarations: ['throwIfGltfLoadAborted', 'attachGltfSource', 'gltfDataError'],
  },
  {
    owner: 'extensions/src/gltf/gltfLoader.ts',
    module: 'extensions/src/gltf/GltfSchema.ts',
    specifier: './GltfSchema',
    forbiddenOwnerDeclarations: ['GltfAsset', 'GltfAccessor', 'GltfMaterial', 'isGltfAsset'],
  },
  {
    owner: 'extensions/src/gltf/gltfLoader.ts',
    module: 'extensions/src/gltf/GltfConservativeBounds.ts',
    specifier: './GltfConservativeBounds',
    moduleClass: 'GltfConservativeBounds',
    forbiddenOwnerDeclarations: ['Bounds3', 'GltfConservativeBounds'],
  },
  {
    owner: 'extensions/src/gltf/gltfLoader.ts',
    module: 'extensions/src/gltf/GltfExtensionAdapter.ts',
    specifier: './GltfExtensionAdapter',
    forbiddenOwnerDeclarations: [
      'GltfExtensionAdapter', 'GltfMaterialExtensionPatch',
      'collectGltfMaterialExtensionPatches', 'collectGltfMaterialVariantReferences',
    ],
  },
  {
    owner: 'extensions/src/gltf/GltfMaterialLoader.ts',
    module: 'extensions/src/gltf/GltfMaterialDescriptor.ts',
    specifier: './GltfMaterialDescriptor',
    forbiddenOwnerDeclarations: [
      'createPbrMaterialState', 'createPbrTextureMappings',
      'createPbrTextureSamplers', 'linearBaseColorFactorToSrgb',
    ],
  },
  {
    owner: 'extensions/src/gltf/GltfUvSemanticPlanner.ts',
    module: 'extensions/src/gltf/GltfMaterialDescriptor.ts',
    specifier: './GltfMaterialDescriptor',
    forbiddenOwnerDeclarations: ['getMaterialTextureInfos'],
  },
  {
    owner: 'engine/src/assets/Ktx2TextureLoader.ts',
    module: 'engine/src/assets/Ktx2ContainerParser.ts',
    specifier: './Ktx2ContainerParser',
    forbiddenOwnerDeclarations: ['Ktx2Header', 'Ktx2Level', 'readKtx2Header', 'parseKtx2Container'],
  },
  {
    owner: 'engine/src/assets/Ktx2TextureLoader.ts',
    module: 'engine/src/assets/Ktx2TextureUpload.ts',
    specifier: './Ktx2TextureUpload',
    forbiddenOwnerDeclarations: ['Ktx2TexturePayload', 'uploadPreparedKtx2Texture', 'createPreparedKtx2Texture'],
  },
  {
    owner: 'engine/src/assets/Ktx2TextureLoader.ts',
    module: 'engine/src/assets/Ktx2TextureFormats.ts',
    specifier: './Ktx2TextureFormats',
    forbiddenOwnerDeclarations: [
      'Ktx2FormatInfo', 'BasisOutputOptions', 'selectBasisOutputOptions',
      'mapTextureFormat', 'mapVkFormat', 'mapAstcVkFormat',
    ],
  },
  {
    owner: 'engine/src/assets/Ktx2TextureLoader.ts',
    module: 'engine/src/assets/Ktx2TextureWorkerClient.ts',
    specifier: './Ktx2TextureWorkerClient',
    moduleClass: 'Ktx2TextureWorkerClient',
    forbiddenOwnerDeclarations: [
      'Ktx2TextureWorkerOptions', 'Ktx2TextureWorker', 'Ktx2TextureWorkerPoolOptions',
      'Ktx2TextureWorkerClient', 'createKtx2TextureWorkerSource',
      'createKtx2TextureWorkerClientFromUrl', 'createInlineKtx2TextureWorkerClient',
    ],
  },
  {
    owner: 'editor/src/player.ts',
    module: 'editor/src/player/PlayerProtocol.ts',
    specifier: './player/PlayerProtocol',
    forbiddenOwnerDeclarations: [
      'RuntimeInspectorFieldEdit', 'getEditorOrigin', 'getPlayerCommand',
      'isTrustedEditorMessage', 'postError', 'postLifecycle', 'postLog',
    ],
  },
  {
    owner: 'editor/src/player.ts',
    module: 'editor/src/player/PlayerDebugRuntime.ts',
    specifier: './player/PlayerDebugRuntime',
    dependencyKind: 'dynamic',
  },
  {
    owner: 'editor/src/player/PlayerDebugRuntime.ts',
    module: 'editor/src/player/RuntimeInspectorBridge.ts',
    specifier: './RuntimeInspectorBridge',
    moduleClass: 'RuntimeInspectorBridge',
  },
  {
    owner: 'editor/src/player/PlayerDebugRuntime.ts',
    module: 'editor/src/player/ScriptBreakpointController.ts',
    specifier: './ScriptBreakpointController',
    moduleClass: 'ScriptBreakpointController',
  },
  {
    owner: 'editor/src/resources/ResourcePool.ts',
    module: 'editor/src/resources/ResourceChangeJournal.ts',
    specifier: './ResourceChangeJournal',
    moduleClass: 'ResourceChangeJournal',
    forbiddenOwnerDeclarations: [
      'ResourceKind', 'ResourceAssetId', 'ResourceChangeKind', 'ResourceChangeSet',
    ],
  },
  {
    owner: 'editor/src/resources/ResourcePool.ts',
    module: 'editor/src/resources/ResourceLookupIndex.ts',
    specifier: './ResourceLookupIndex',
    moduleClass: 'ResourceLookupIndex',
  },
  {
    owner: 'editor/src/resources/ResourcePool.ts',
    module: 'editor/src/resources/PrefabVariant.ts',
    specifier: './PrefabVariant',
    forbiddenOwnerDeclarations: [
      'cloneSerializedEntity', 'applyVariantOverrides', 'diffSerializedEntity',
      'clearVariantOverrideField',
    ],
  },
  {
    owner: 'editor/src/resources/ResourcePool.ts',
    module: 'editor/src/resources/ResourceUsage.ts',
    specifier: './ResourceUsage',
    forbiddenOwnerDeclarations: ['EntityResourceUsage', 'createEmptyEntityResourceUsage', 'addAssetIdToUsage'],
  },
  {
    owner: 'editor/src/infra/resource-ui/resourceDetails.ts',
    module: 'editor/src/infra/resource-ui/ResourceDetailView.ts',
    specifier: './ResourceDetailView',
    forbiddenOwnerDeclarations: [
      'ResourceDetailElements', 'ResourceDetailDeps', 'selectResource',
      'prepareDetailPanel', 'addDetailRow', 'addDetailControl',
      'createDetailSelect', 'setDetailTitle', 'createNameInput',
    ],
  },
  {
    owner: 'editor/src/infra/resource-ui/resourceDetails.ts',
    module: 'editor/src/infra/resource-ui/MaterialResourceDetails.ts',
    specifier: './MaterialResourceDetails',
    forbiddenOwnerDeclarations: ['showMaterialDetails', 'showMaterial2DDetails'],
  },
  {
    owner: 'editor/src/export/runtimeScene.ts',
    module: 'editor/src/export/RuntimeSceneContract.ts',
    specifier: './RuntimeSceneContract',
    forbiddenOwnerDeclarations: [
      'SerializedEditorScene', 'RuntimeScene', 'RuntimeExportResult',
      'RuntimeExportManifest', 'validateRuntimeScene',
    ],
  },
  {
    owner: 'editor/src/export/projectTemplate.ts',
    module: 'editor/src/export/RuntimeSourceGenerator.ts',
    specifier: './RuntimeSourceGenerator',
    forbiddenOwnerDeclarations: [
      'createRuntimePlayerTs', 'createRuntimeDeserializationTs',
      'createInstallRuntimeSystemsBody',
    ],
  },
  {
    owner: 'voxelEditor/src/main.ts',
    module: 'voxelEditor/src/controllers/VoxelSelectionController.ts',
    specifier: './controllers/VoxelSelectionController',
    moduleClass: 'VoxelSelectionController',
    forbiddenOwnerDeclarations: [
      'syncSelectionUi', 'selectedViewVoxels', 'selectedEditableVoxels',
      'selectedBaseVoxels', 'executeSelectionReplacement', 'copySelectedVoxels',
      'moveSelection', 'duplicateSelection', 'rotateSelection', 'flipSelection',
      'copySelection', 'cutSelection', 'pasteSelection', 'deleteSelection',
    ],
  },
  {
    owner: 'voxelEditor/src/main.ts',
    module: 'voxelEditor/src/controllers/ModuleGizmoController.ts',
    specifier: './controllers/ModuleGizmoController',
    moduleClass: 'ModuleGizmoController',
    forbiddenOwnerDeclarations: [
      'ActiveGizmoDrag', 'beginGizmoInteraction',
      'updateGizmoInteraction', 'finishGizmoInteraction',
    ],
  },
  {
    owner: 'voxelEditor/src/main.ts',
    module: 'voxelEditor/src/controllers/ViewportInputController.ts',
    specifier: './controllers/ViewportInputController',
    moduleClass: 'ViewportInputController',
    forbiddenOwnerDeclarations: [
      'SelectionKind', 'selectionApplyMode', 'updateSelectionRect', 'finishSelectionDrag',
      'pointerStart', 'selectionDrag',
    ],
  },
  {
    owner: 'voxelEditor/src/model.ts',
    module: 'voxelEditor/src/document/VoxelDocumentContract.ts',
    specifier: './document/VoxelDocumentContract',
    forbiddenOwnerDeclarations: [
      'SceneSize', 'Voxel', 'VoxelPosition', 'BatchVoxelResult', 'VoxelPatchEntry',
      'VoxelModuleData', 'ModuleSummary', 'AnimationSummary', 'VoxelModuleInstance',
      'VoxelAnimationKeyframe', 'VoxelAnimationTrack', 'AnimationKeyframeSnapshot',
      'VoxelAnimationClip', 'VoxelLayer', 'PbrPaletteMaterial', 'RenderableVoxel',
      'VoxelProject', 'VoxelDocumentChangeReason', 'VoxelDocumentDirtyFlags',
      'VoxelDocumentChangeDetail', 'PackedVoxelKey', 'VoxelDocumentChangeImpact',
      'DEFAULT_SCENE_SIZE', 'MAX_SCENE_AXIS', 'MAX_VOXELS', 'DEFAULT_LAYER_ID',
      'DEFAULT_PBR_METALLIC', 'DEFAULT_PBR_ROUGHNESS', 'DEFAULT_PALETTE',
      'voxelKey', 'packVoxelKey', 'unpackVoxelKey', 'normalizeColor',
    ],
  },
  {
    owner: 'voxelEditor/src/model.ts',
    module: 'voxelEditor/src/document/VoxelDocumentNormalization.ts',
    specifier: './document/VoxelDocumentNormalization',
    moduleClass: 'StringKeyVoxelMapView',
    forbiddenOwnerDeclarations: [
      'StringKeyVoxelMapView', 'packedVoxelKeyFromString',
      'normalizeAxis', 'normalizeUnit', 'isRecord',
      'parseVoxMaterialExtension', 'cloneVoxMaterialExtension',
    ],
  },
  {
    owner: 'extensions/src/spine/Spine2DRuntime.ts',
    module: 'extensions/src/spine/SpineSlotAnimation.ts',
    specifier: './SpineSlotAnimation',
    forbiddenOwnerDeclarations: [
      'getSlotAttachmentName', 'getAttachmentRegionName', 'getSequenceFrames',
      'sampleSequenceIndex', 'clampSequenceIndex', 'getSlotColor',
      'mixColorInto', 'copyColor',
    ],
  },
  {
    owner: 'scripts/benchmark/real-renderer-scenario.mjs',
    module: 'scripts/benchmark/real-renderer-audit-device.mjs',
    specifier: './real-renderer-audit-device.mjs',
    forbiddenOwnerDeclarations: [
      'ensureRealRendererGpuConstants',
      'createRealRendererAuditDevice',
    ],
  },
];

for (const contract of contracts) {
  const owner = parse(contract.owner);
  const module = parse(contract.module);
  const ownerDependencies = dependencies(owner);
  const dependencyKind = contract.dependencyKind ?? 'static';
  if (!ownerDependencies[dependencyKind].includes(contract.specifier)) {
    failures.push(`${contract.owner} must ${dependencyKind}-depend on ${contract.specifier}`);
  }
  if (allDependencies(module).some(specifier => resolvesToOwner(specifier, contract.owner))) {
    failures.push(`${contract.module} must not depend back on ${contract.owner}`);
  }
  const ownerDeclarations = declarations(owner);
  for (const name of contract.forbiddenOwnerDeclarations ?? []) {
    if (ownerDeclarations.has(name)) failures.push(`${contract.owner} reclaims ${name} ownership`);
  }
  for (const name of contract.forbiddenOwnerCalls ?? []) {
    if (calledProperties(owner).has(name)) failures.push(`${contract.owner} directly calls ${name}`);
  }
  if (contract.moduleClass && !declarations(module).has(contract.moduleClass)) {
    failures.push(`${contract.module} must declare ${contract.moduleClass}`);
  }
}

for (const budget of ownerSizeBudgets) {
  const lines = readFileSync(resolveContractPath(budget.path), 'utf8').split(/\r?\n/).length;
  if (lines > budget.maxLines) {
    failures.push(
      `${budget.path} grew to ${lines} lines (budget ${budget.maxLines}); assign the new responsibility before extending the orchestrator`,
    );
  }
}

if (failures.length > 0) {
  console.error('[responsibility-boundaries] Contract violations:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[responsibility-boundaries] render/voxel orchestration, glTF loading/runtime, resource, player, runtime export, KTX2, and pipeline ownership passed.');

function parse(path) {
  const content = readFileSync(resolveContractPath(path), 'utf8');
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function resolveContractPath(path) {
  if (path.startsWith('editor/')) {
    return resolveStudioRepositoryPath('Editor', 'editor', path.slice('editor/'.length));
  }
  if (path.startsWith('AnimationEditor/')) {
    return resolveStudioRepositoryPath('Editor', 'AnimationEditor', path.slice('AnimationEditor/'.length));
  }
  if (path.startsWith('voxelEditor/')) {
    return resolveStudioRepositoryPath('Editor', 'voxelEditor', path.slice('voxelEditor/'.length));
  }
  return resolve(root, path);
}

function dependencies(sourceFile) {
  const staticDependencies = sourceFile.statements
    .filter(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    .map(node => node.moduleSpecifier)
    .filter(Boolean)
    .filter(ts.isStringLiteralLike)
    .map(node => node.text);
  const dynamicDependencies = [];
  visit(sourceFile);
  return { static: staticDependencies, dynamic: dynamicDependencies };

  function visit(node) {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
    ) dynamicDependencies.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
}

function allDependencies(sourceFile) {
  const discovered = dependencies(sourceFile);
  return [...discovered.static, ...discovered.dynamic];
}

function declarations(sourceFile) {
  const names = new Set();
  visit(sourceFile);
  return names;
  function visit(node) {
    if (
      (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
        || ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node))
      && node.name && ts.isIdentifier(node.name)
    ) names.add(node.name.text);
    ts.forEachChild(node, visit);
  }
}

function calledProperties(sourceFile) {
  const names = new Set();
  visit(sourceFile);
  return names;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) names.add(node.expression.text);
      if (ts.isPropertyAccessExpression(node.expression)) names.add(node.expression.name.text);
    }
    ts.forEachChild(node, visit);
  }
}

function resolvesToOwner(specifier, ownerPath) {
  const ownerName = ownerPath.split('/').pop()?.replace(/\.ts$/, '');
  return specifier === `./${ownerName}` || specifier.endsWith(`/${ownerName}`);
}
