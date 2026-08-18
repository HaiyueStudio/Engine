import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '..');
const violations = [];

const contract = readJson('stage0-contract.json');
const graphSchema = readJson('graph-v1.schema.json');
const reflectionSchema = readJson('reflection-v1.schema.json');
const graph = readJson('pilot-pbr-composition.graph.json');
const postprocessGraph = readJson('pilot-motion-blur-postprocess.graph.json');
const stage5Contract = readJson('stage5-contract.json');
const stage6Contract = readJson('stage6-contract.json');
const artifactV2Schema = readJson('precompiled-artifact-v2.schema.json');
const stage7Contract = readJson('stage7-contract.json');
const builtinPostprocessSchema = readJson('builtin-postprocess-family.schema.json');
const builtinPostprocessFamily = readJson('builtin-postprocess-family.json');
const stage8Contract = readJson('stage8-contract.json');
const ambientOcclusionPostprocessExtension = readJson('ambient-occlusion-postprocess-extension-contract.json');
const builtinRenderSchema = readJson('builtin-render-family.schema.json');
const builtinRenderFamilies = [
  readJson('builtin-engine-2d-ui-family.json'),
  readJson('builtin-components-2d-ui-family.json'),
  readJson('builtin-simple-3d-family.json'),
];
const stage9Contract = readJson('stage9-contract.json');
const deformationFamilySchema = readJson('builtin-deformation-family.schema.json');
const deformationFamily = readJson('builtin-deformation-family.json');
const stage10Contract = readJson('stage10-contract.json');
const materialLightingFamilySchema = readJson('builtin-material-lighting-family.schema.json');
const materialLightingFamily = readJson('builtin-material-lighting-family.json');
const stage11Contract = readJson('stage11-contract.json');
const specializedRenderingFamilySchema = readJson('builtin-specialized-rendering-family.schema.json');
const specializedRenderingFamily = readJson('builtin-specialized-rendering-family.json');
const stage12Contract = readJson('stage12-contract.json');
const computeFamilySchema = readJson('builtin-compute-family.schema.json');
const computeFamily = readJson('builtin-compute-family.json');
const stage13Contract = readJson('stage13-contract.json');
const stage14Contract = readJson('stage14-contract.json');

expect(contract.contractVersion === 1, 'stage0 contractVersion must be 1');
expect(contract.phase === 0, 'stage0 phase must be 0');
expect(contract.status === 'accepted', 'stage0 status must be accepted');
expect(contract.canonicalRepresentation === 'typed-ir', 'Typed Shader IR must remain the canonical representation');
expect(contract.packageStatus === 'standalone-specification', 'stage 0 must not silently become a public/runtime package');

expectUniqueIds(contract.authoringFrontends, 'authoring frontend');
expectUniqueIds(contract.targets, 'target');
expectUnique(contract.capabilityProfiles, 'capability profile');
expectUniqueIds(contract.logicalResourceSpaces, 'logical resource space');
expectUnique(contract.coordinateSpaces, 'coordinate space');
expectUnique(contract.materialSurfaceOutputs, 'material surface output');
expectUnique(contract.variantClasses, 'variant class');
expectUniqueIds(contract.pilots, 'pilot');
expectUnique(contract.deferredCapabilities, 'deferred capability');
expectUnique(contract.requiredDocuments, 'required document');

expectSet(
  contract.authoringFrontends.map(frontend => `${frontend.id}:${frontend.status}`),
  ['typescript-dsl:planned', 'shader-graph-json:specified', 'text-language:deferred'],
  'authoring frontends',
);
expectSet(
  contract.targets.map(target => `${target.id}:${target.status}`),
  ['webgpu-wgsl:primary', 'webgl2-glsl-es300:feasibility-only'],
  'shader targets',
);
expectSet(
  contract.capabilityProfiles,
  ['webgpu-portable', 'webgpu-enhanced', 'webgl2-compatible'],
  'capability profiles',
);
expectSet(contract.variantClasses, ['dynamic', 'specialization', 'capability'], 'variant classes');
expectSet(
  contract.coordinateSpaces,
  ['geometry-local', 'object', 'world', 'view', 'tangent', 'clip', 'screen'],
  'coordinate spaces',
);
expectSet(
  contract.pilots.map(pilot => pilot.id),
  ['pbr-composition', 'deformation-pass-coherence', 'motion-blur-postprocess'],
  'pilot ids',
);

const expectedSpaces = new Map([
  ['frame', 0],
  ['object', 1],
  ['material', 2],
  ['pass', 3],
]);
for (const space of contract.logicalResourceSpaces) {
  expect(expectedSpaces.get(space.id) === space.webgpuGroup, `${space.id} must map to WebGPU group ${expectedSpaces.get(space.id)}`);
}
expectSet([...expectedSpaces.keys()], contract.logicalResourceSpaces.map(space => space.id), 'logical resource spaces');

for (const required of [
  'baseColor',
  'opacity',
  'normalTS',
  'metallic',
  'roughness',
  'occlusion',
  'emissive',
  'transmission',
  'thickness',
  'clearcoat',
  'clearcoatRoughness',
  'clearcoatNormalTS',
  'sheenColor',
  'sheenRoughness',
]) {
  expect(contract.materialSurfaceOutputs.includes(required), `material surface is missing ${required}`);
}

for (const path of contract.requiredDocuments) requireFile(path);
requireFile('../docs/for-ai/adr/0050-typed-shader-ir-and-authoring-frontends.md');

expect(graphSchema.$schema === 'https://json-schema.org/draft/2020-12/schema', 'graph schema must use JSON Schema 2020-12');
expect(graphSchema.title === 'Haiyue Shader Graph v1', 'graph schema title changed unexpectedly');
expect(graphSchema.properties?.version?.const === 1, 'graph schema version must be 1');
expect(graphSchema.properties?.format?.const === 'haiyue-shader-graph', 'graph schema format is invalid');
expect(graphSchema.$defs?.value?.oneOf?.length === 4, 'graph values must support exactly literal/node/semantic/resource references in v1');

expect(reflectionSchema.$schema === 'https://json-schema.org/draft/2020-12/schema', 'reflection schema must use JSON Schema 2020-12');
expect(reflectionSchema.title === 'Haiyue Shader Reflection v1', 'reflection schema title changed unexpectedly');
expect(reflectionSchema.properties?.version?.const === 1, 'reflection schema version must be 1');
for (const required of ['resources', 'uniformBlocks', 'varyings', 'capabilities', 'passRequirements', 'sourceMap']) {
  expect(reflectionSchema.required?.includes(required), `reflection schema must require ${required}`);
}

validateGraph(graph);
validatePostprocessGraph(postprocessGraph);
expect(stage5Contract.phase === 5, 'stage5 phase must be 5');
expect(stage5Contract.status === 'implemented', 'stage5 status must be implemented');
expect(stage5Contract.packageStatus === 'private-workspace', 'stage5 must remain a private workspace');
expect(stage5Contract.productionMigrations?.length === 0, 'stage5 must not claim an implicit production migration');
expect(stage6Contract.phase === 6, 'stage6 phase must be 6');
expect(stage6Contract.status === 'implemented', 'stage6 status must be implemented');
expect(stage6Contract.productionMigrations?.length === 1, 'stage6 must contain exactly one reviewed production migration');
expect(stage6Contract.productionMigrations?.[0]?.id === 'engine-motion-blur-postprocess-shaders', 'stage6 production migration changed unexpectedly');
expect(artifactV2Schema.title === 'Haiyue Precompiled Shader Artifact v2', 'artifact v2 schema title changed unexpectedly');
expect(artifactV2Schema.properties?.version?.const === 2, 'artifact schema version must be 2');
expect(artifactV2Schema.$defs?.bindingLayout?.oneOf?.length === 5, 'artifact v2 must cover five binding layout kinds');
expectSet(artifactV2Schema.$defs?.bindGroup?.properties?.owner?.enum, ['artifact', 'renderer'], 'artifact layout owners');
expect(stage7Contract.phase === 7, 'stage7 phase must be 7');
expect(stage7Contract.status === 'implemented', 'stage7 status must be implemented');
expect(stage7Contract.artifact?.multiBindGroup === true, 'stage7 must retain multi bind-group delivery');
expectSet(stage7Contract.artifact?.layoutOwners, ['artifact', 'renderer'], 'stage7 layout owners');
expect(JSON.stringify(stage7Contract.artifact?.compatibleVersions) === JSON.stringify([1, 2]), 'stage7 must read artifact v1 and v2');
expect(stage7Contract.productionMigrations?.length === 0, 'stage7 must not claim an implicit production migration');
expect(stage7Contract.inventory?.wgslSourceCount === 57, 'stage7 WGSL inventory changed without contract review');
expect(builtinPostprocessSchema.properties?.format?.const === 'haiyue-builtin-postprocess-family', 'builtin postprocess schema format is invalid');
expect(builtinPostprocessSchema.properties?.version?.const === 1, 'builtin postprocess schema version must be 1');
expect(builtinPostprocessFamily.format === 'haiyue-builtin-postprocess-family', 'builtin postprocess family format is invalid');
expect(builtinPostprocessFamily.version === 1, 'builtin postprocess family version must be 1');
expectUniqueIds(builtinPostprocessFamily.passes, 'builtin postprocess pass');
expectSet(
  builtinPostprocessFamily.passes.map(pass => pass.operation),
  [...stage8Contract.moduleFamily.operations, ...ambientOcclusionPostprocessExtension.moduleFamily.addedOperations],
  'builtin postprocess operations',
);
expect(stage8Contract.phase === 8, 'stage8 phase must be 8');
expect(stage8Contract.status === 'implemented', 'stage8 status must be implemented');
expect(stage8Contract.moduleFamily?.operationCount === 9, 'stage8 must contain nine builtin postprocess operations');
expect(stage8Contract.artifact?.formatVersion === 2, 'stage8 production family must use Artifact V2');
expect(stage8Contract.productionMigrations?.length === 9, 'stage8 must record nine production postprocess migrations');
expect(stage8Contract.inventory?.wgslSourceCount === 58, 'stage8 WGSL inventory changed without contract review');
expect(stage8Contract.inventory?.generatedSourceCount === 13, 'stage8 generated WGSL inventory changed without contract review');
expect(stage8Contract.publicApiChanges?.length === 0, 'stage8 must not expand public API');
expect(ambientOcclusionPostprocessExtension.contractVersion === 1, 'AO postprocess extension contractVersion must be 1');
expect(ambientOcclusionPostprocessExtension.status === 'implemented', 'AO postprocess extension must be implemented');
expect(ambientOcclusionPostprocessExtension.basePhase === 8, 'AO postprocess extension must extend the stage8 family');
expect(ambientOcclusionPostprocessExtension.moduleFamily?.operationCount === 14, 'current builtin postprocess family must contain fourteen operations');
expectSet(ambientOcclusionPostprocessExtension.moduleFamily?.addedOperations, ['ssao', 'sao', 'gtao', 'ao-denoise', 'ao-upscale'], 'AO postprocess operations');
expectSet(ambientOcclusionPostprocessExtension.moduleFamily?.algorithmOperations, ['ssao', 'sao', 'gtao'], 'AO algorithm operations');
expectSet(ambientOcclusionPostprocessExtension.moduleFamily?.supportOperations, ['ao-denoise', 'ao-upscale'], 'AO support operations');
expectSet(ambientOcclusionPostprocessExtension.productionMigrations, ['SsaoPass', 'SaoPass', 'GtaoPass'], 'AO production migrations');
expect(ambientOcclusionPostprocessExtension.inventoryDelta?.generatedSourceCount === 5, 'AO extension must record five generated shaders');
expect(ambientOcclusionPostprocessExtension.runtime?.sharedDepthNormalAbi === true, 'AO extension must retain its shared depth/normal ABI');
expect(ambientOcclusionPostprocessExtension.runtime?.depthTextureFormat === 'r32float', 'AO extension must retain full-precision linear depth');
expect(ambientOcclusionPostprocessExtension.runtime?.normalTextureFormat === 'rgba16float', 'AO extension must retain high-precision view normals');
expect(ambientOcclusionPostprocessExtension.runtime?.depthSampling === 'point', 'AO extension must not interpolate linear depth across silhouettes');
expect(ambientOcclusionPostprocessExtension.runtime?.positionNormalLumaDenoise === 'rotated-poisson-16', 'AO extension must retain position/normal/luma Poisson denoising');
expect(ambientOcclusionPostprocessExtension.runtime?.renderPassCount === 3, 'AO extension must retain raw AO, denoise, and upscale/composite passes');
expect(ambientOcclusionPostprocessExtension.runtime?.resolutionScale === 0.5, 'AO extension must default to half resolution');
expect(ambientOcclusionPostprocessExtension.runtime?.defaultScratchFormat === 'r8unorm', 'AO extension must default to r8unorm scratch');
expect(ambientOcclusionPostprocessExtension.evidence?.webgpuValidationErrorCount === 0, 'AO browser evidence contains WebGPU validation errors');
expect(ambientOcclusionPostprocessExtension.evidence?.unclassifiedFailureCount === 0, 'AO browser evidence contains unclassified failures');
expect(builtinRenderSchema.properties?.format?.const === 'haiyue-builtin-render-family', 'builtin render schema format is invalid');
expect(builtinRenderSchema.properties?.version?.const === 1, 'builtin render schema version must be 1');
expectSet(builtinRenderFamilies.map(family => family.kind), ['2d-ui', '2d-ui', 'simple-3d'], 'stage9 render family kinds');
for (const family of builtinRenderFamilies) expectUniqueIds(family.passes, `builtin render ${family.id} pass`);
expect(stage9Contract.phase === 9, 'stage9 phase must be 9');
expect(stage9Contract.status === 'implemented', 'stage9 status must be implemented');
expect(stage9Contract.families?.length === 3, 'stage9 must contain three delivery slices');
expect(stage9Contract.artifact?.formatVersion === 2, 'stage9 production families must use Artifact V2');
expect(stage9Contract.artifact?.passCount === 17, 'stage9 must record seventeen production passes');
expect(stage9Contract.artifact?.layoutOwner === 'renderer', 'stage9 must retain renderer-owned layouts');
expect(stage9Contract.inventory?.wgslSourceCount === 58, 'stage9 WGSL inventory changed without contract review');
expect(stage9Contract.inventory?.generatedSourceCount === 30, 'stage9 generated WGSL inventory changed without contract review');
expect(stage9Contract.bundle?.engineArtifactGzipBytes <= stage9Contract.bundle?.engineArtifactGzipBudgetBytes, 'stage9 artifact bundle exceeds its budget');
expect(stage9Contract.publicApiChanges?.length === 0, 'stage9 must not expand public API');
expect(deformationFamilySchema.properties?.format?.const === 'haiyue-production-deformation-family', 'deformation family schema format is invalid');
expect(deformationFamilySchema.properties?.abiVersion?.const === 1, 'deformation ABI schema version must be 1');
expect(deformationFamily.format === 'haiyue-production-deformation-family', 'deformation family format is invalid');
expect(deformationFamily.version === 1 && deformationFamily.abiVersion === 1, 'deformation family identity is invalid');
expectUniqueIds(deformationFamily.passes, 'production deformation pass');
expect(deformationFamily.passes?.length === 9, 'production deformation family must contain nine variants');
expect(stage10Contract.phase === 10 && stage10Contract.status === 'implemented', 'stage10 contract identity is invalid');
expect(stage10Contract.family?.abiVersion === 1, 'stage10 must freeze deformation ABI v1');
expect(stage10Contract.family?.passCount === 9, 'stage10 must record nine production deformation variants');
expect(stage10Contract.inventory?.wgslSourceCount === 58, 'stage10 WGSL inventory changed without contract review');
expect(stage10Contract.inventory?.generatedSourceCount === 39, 'stage10 generated WGSL inventory changed without contract review');
expect(stage10Contract.bundle?.deformationArtifactGzipBytes <= stage10Contract.bundle?.deformationArtifactGzipBudgetBytes, 'stage10 deformation artifact exceeds gzip budget');
expect(stage10Contract.publicApiChanges?.length === 0, 'stage10 must not expand public API');
expect(materialLightingFamilySchema.properties?.format?.const === 'haiyue-production-material-lighting-family', 'material-lighting family schema format is invalid');
expect(materialLightingFamilySchema.properties?.abiVersion?.const === 1, 'material-lighting ABI schema version must be 1');
expect(materialLightingFamily.format === 'haiyue-production-material-lighting-family', 'material-lighting family format is invalid');
expect(materialLightingFamily.version === 1 && materialLightingFamily.abiVersion === 1, 'material-lighting family identity is invalid');
expectUniqueIds(materialLightingFamily.passes, 'production material-lighting pass');
expect(materialLightingFamily.passes?.length === 6, 'production material-lighting family must contain six passes');
expect(stage11Contract.phase === 11 && stage11Contract.status === 'implemented', 'stage11 contract identity is invalid');
expect(stage11Contract.family?.abiVersion === 1, 'stage11 must freeze material-lighting ABI v1');
expect(stage11Contract.family?.passCount === 6, 'stage11 must record six production material-lighting passes');
expect(stage11Contract.abi?.lightCapacity === 8, 'stage11 must retain the reviewed eight-light capacity');
expect(stage11Contract.abi?.pbrDirectionalShadowCapacity === 3, 'stage11 must retain three PBR directional shadow slots');
expect(stage11Contract.inventory?.wgslSourceCount === 58, 'stage11 WGSL inventory changed without contract review');
expect(stage11Contract.inventory?.generatedSourceCount === 47, 'stage11 generated WGSL inventory changed without contract review');
expect(stage11Contract.bundle?.materialLightingArtifactGzipBytes <= stage11Contract.bundle?.materialLightingArtifactGzipBudgetBytes, 'stage11 material-lighting artifact exceeds gzip budget');
expect(stage11Contract.publicApiChanges?.length === 0, 'stage11 must not expand public API');
expect(specializedRenderingFamilySchema.properties?.format?.const === 'haiyue-production-specialized-rendering-family', 'specialized-rendering family schema format is invalid');
expect(specializedRenderingFamilySchema.properties?.abiVersion?.const === 1, 'specialized-rendering ABI schema version must be 1');
expect(specializedRenderingFamily.format === 'haiyue-production-specialized-rendering-family', 'specialized-rendering family format is invalid');
expect(specializedRenderingFamily.version === 1 && specializedRenderingFamily.abiVersion === 1, 'specialized-rendering family identity is invalid');
expectUniqueIds(specializedRenderingFamily.passes, 'production specialized-rendering pass');
expect(specializedRenderingFamily.passes?.length === 7, 'production specialized-rendering family must contain seven passes');
expect(stage12Contract.phase === 12 && stage12Contract.status === 'implemented', 'stage12 contract identity is invalid');
expect(stage12Contract.family?.abiVersion === 1, 'stage12 must freeze specialized-rendering ABI v1');
expect(stage12Contract.family?.passCount === 7, 'stage12 must record seven production specialized-rendering passes');
expect(stage12Contract.family?.renderPassCount === 6 && stage12Contract.family?.computePassCount === 1, 'stage12 render/compute pass classification changed');
expect(stage12Contract.abi?.instancedLightCapacity === 8, 'stage12 must retain the reviewed eight-light instanced capacity');
expect(stage12Contract.abi?.volumeObjectTable === 'shared-storage-buffer', 'stage12 must retain the shared volume object table');
expect(stage12Contract.inventory?.wgslSourceCount === 60, 'stage12 WGSL inventory changed without contract review');
expect(stage12Contract.inventory?.generatedSourceCount === 54, 'stage12 generated WGSL inventory changed without contract review');
expect(stage12Contract.inventory?.handwrittenSourceCount === 6, 'stage12 handwritten WGSL inventory changed without contract review');
expect(stage12Contract.bundle?.specializedRenderingArtifactGzipBytes <= stage12Contract.bundle?.specializedRenderingArtifactGzipBudgetBytes, 'stage12 specialized-rendering artifact exceeds gzip budget');
expect(stage12Contract.publicApiChanges?.length === 0, 'stage12 must not expand public API');
expect(computeFamilySchema.properties?.format?.const === 'haiyue-production-compute-family', 'compute family schema format is invalid');
expect(computeFamilySchema.properties?.abiVersion?.const === 1, 'compute ABI schema version must be 1');
expect(computeFamily.format === 'haiyue-production-compute-family', 'compute family format is invalid');
expect(computeFamily.version === 1 && computeFamily.abiVersion === 1, 'compute family identity is invalid');
expectUniqueIds(computeFamily.passes, 'production compute pass');
expect(computeFamily.passes?.length === 5, 'production compute family must contain five passes');
expect(stage13Contract.phase === 13 && stage13Contract.status === 'implemented', 'stage13 contract identity is invalid');
expect(stage13Contract.family?.abiVersion === 1 && stage13Contract.family?.passCount === 5, 'stage13 must freeze five compute passes at ABI v1');
expect(stage13Contract.abi?.workgroupSize?.join('x') === '64x1x1', 'stage13 workgroup ABI changed');
expect(stage13Contract.inventory?.wgslSourceCount === 60, 'stage13 WGSL inventory changed without contract review');
expect(stage13Contract.inventory?.generatedSourceCount === 59, 'stage13 generated WGSL inventory changed without contract review');
expect(stage13Contract.inventory?.handwrittenSourceCount === 1, 'stage13 handwritten WGSL inventory changed without contract review');
expect(stage13Contract.bundle?.computeArtifactGzipBytes <= stage13Contract.bundle?.computeArtifactGzipBudgetBytes, 'stage13 compute artifact exceeds gzip budget');
expect(stage13Contract.publicApiChanges?.length === 0, 'stage13 must not expand engine public API');
expect(stage14Contract.phase === 14 && stage14Contract.status === 'implemented', 'stage14 contract identity is invalid');
expect(stage14Contract.implementation === 'typed-ir-glsl-es300-codegen-feasibility', 'stage14 implementation boundary changed');
expect(stage14Contract.productRendererContract === 'webgpu-only-unchanged', 'stage14 must preserve the WebGPU-only product renderer contract');
expect(stage14Contract.backend?.input === 'canonical-typed-expression-ir' && stage14Contract.backend?.wgslTextTranslation === false, 'stage14 GLSL backend must consume Typed IR directly');
expect(stage14Contract.backend?.uniformLayout === 'std140', 'stage14 GLSL backend must own std140 reflection');
expect(/^[a-f0-9]{64}$/.test(stage14Contract.evidence?.canonicalHash ?? '') && /^[a-f0-9]{64}$/.test(stage14Contract.evidence?.glslBackendHash ?? ''), 'stage14 evidence hashes are invalid');
expect(stage14Contract.evidence?.crossBackendMaxPixelDelta <= 1, 'stage14 cross-backend pixel evidence exceeds tolerance');
expect(stage14Contract.evidence?.webgpuValidationErrorCount === 0, 'stage14 WebGPU evidence contains validation errors');
expect(stage14Contract.evidence?.webgl2CompileErrorCount === 0 && stage14Contract.evidence?.webgl2LinkErrorCount === 0, 'stage14 WebGL2 evidence contains compile/link errors');
expect(stage14Contract.productionMigrations?.length === 0, 'stage14 must not claim production shader migrations');
expect(stage14Contract.publicApiChanges?.length === 0 && stage14Contract.apiBaselineUpdated === false, 'stage14 must not expand engine public API or update its baseline');
for (const path of [
  'README.md',
  'pilots.md',
  'stage5.md',
  'stage5-contract.json',
  'stage6.md',
  'stage6-contract.json',
  'scripts/generate-motion-blur-production.mjs',
  '../engine/src/shaders/generated/motion-blur-artifact.generated.ts',
  '../engine/src/shaders/generated/motion-tile-max.generated.wgsl',
  '../engine/src/shaders/generated/motion-neighbor-max.generated.wgsl',
  '../engine/src/shaders/generated/motion-blur-resolve.generated.wgsl',
  '../docs/for-ai/adr/0051-build-time-shader-artifacts-and-runtime-adapter.md',
  'stage7.md',
  'stage7-contract.json',
  'precompiled-artifact-v2.schema.json',
  'migration-manifest.json',
  'scripts/check-migration-manifest.mjs',
  'scripts/generate-production-shaders.mjs',
  '../engine/test/precompiled-shader-runtime-v2.test.mjs',
  '../scripts/verify-webgpu-shader-language-stage7.mjs',
  '../scripts/webgpu-gate/shader-language-stage7-fixture.html',
  '../scripts/webgpu-gate/shader-language-stage7-fixture.mjs',
  '../docs/for-ai/adr/0052-precompiled-shader-artifact-v2-and-layout-ownership.md',
  'stage8.md',
  'stage8-contract.json',
  'ambient-occlusion-postprocess-extension-contract.json',
  'builtin-postprocess-family.schema.json',
  'builtin-postprocess-family.json',
  'scripts/generate-builtin-postprocess-production.mjs',
  '../engine/src/postprocess/BuiltinPostprocessShader.ts',
  '../engine/src/postprocess/AmbientOcclusionShader.ts',
  '../engine/src/shaders/generated/postprocess-builtins-artifact.generated.ts',
  '../engine/src/shaders/generated/postprocess-ambient-occlusion-artifact.generated.ts',
  '../engine/src/shaders/generated/postprocess-fullscreen.generated.wgsl',
  '../engine/src/shaders/generated/postprocess-present.generated.wgsl',
  '../engine/src/shaders/generated/postprocess-grayscale.generated.wgsl',
  '../engine/src/shaders/generated/postprocess-sobel.generated.wgsl',
  '../engine/src/shaders/generated/postprocess-fxaa.generated.wgsl',
  '../engine/src/shaders/generated/postprocess-gaussian-blur.generated.wgsl',
  '../engine/src/shaders/generated/postprocess-outline-edge.generated.wgsl',
  '../engine/src/shaders/generated/postprocess-outline-blur.generated.wgsl',
  '../engine/src/shaders/generated/postprocess-outline-overlay.generated.wgsl',
  '../engine/src/shaders/generated/postprocess-taa.generated.wgsl',
  '../engine/test/postprocess-generated-shader.test.mjs',
  '../scripts/verify-webgpu-shader-language-stage8.mjs',
  '../scripts/webgpu-gate/shader-language-stage8-fixture.html',
  '../scripts/webgpu-gate/shader-language-stage8-fixture.mjs',
  '../docs/for-ai/adr/0053-builtin-postprocess-module-family-and-production-migration.md',
  '../docs/for-ai/adr/0060-ambient-occlusion-postprocess-family.md',
  'stage9.md',
  'stage9-contract.json',
  'builtin-render-family.schema.json',
  'builtin-engine-2d-ui-family.json',
  'builtin-components-2d-ui-family.json',
  'builtin-simple-3d-family.json',
  'scripts/generate-builtin-render-production.mjs',
  'scripts/check-stage9-bundle.mjs',
  'src/render-family/contracts.ts',
  'src/render-family/definitions.ts',
  'src/render-family/family.ts',
  '../engine/src/shader/BuiltinRenderShader.ts',
  '../engine/src/shader/BuiltinSimple3dShader.ts',
  '../engine/src/shaders/generated/2d-ui-artifact.generated.ts',
  '../engine/src/shaders/generated/simple3d-artifact.generated.ts',
  '../extensions/src/shaders/generated/2d-ui-artifact.generated.ts',
  'test/stage9-render-families.test.mjs',
  '../scripts/verify-webgpu-shader-language-stage9.mjs',
  '../scripts/webgpu-gate/shader-language-stage9-fixture.html',
  '../scripts/webgpu-gate/shader-language-stage9-fixture.mjs',
  '../docs/for-ai/adr/0054-2d-ui-simple3d-shader-module-family-migration.md',
  'stage10.md',
  'stage10-contract.json',
  'builtin-deformation-family.schema.json',
  'builtin-deformation-family.json',
  'builtin-simple-3d-runtime-family.json',
  'scripts/generate-deformation-production.mjs',
  'scripts/check-stage10-bundle.mjs',
  'src/deformation/production-contracts.ts',
  'src/deformation/production-definitions.ts',
  'src/deformation/production-family.ts',
  '../engine/src/shader/BuiltinDeformationShader.ts',
  '../engine/src/renderer/CurrentDeformationGpuCache.ts',
  '../engine/src/shaders/generated/deformation-artifact.generated.ts',
  '../engine/src/shaders/generated/deformation-forward.generated.wgsl',
  '../engine/src/shaders/generated/deformation-motion-vector.generated.wgsl',
  '../engine/src/shaders/generated/deformation-outline.generated.wgsl',
  'test/stage10-deformation-production.test.mjs',
  '../engine/test/deformation-shader-family.test.mjs',
  '../engine/test/deformation-history-lifecycle.test.mjs',
  '../scripts/verify-webgpu-shader-language-stage10.mjs',
  '../scripts/webgpu-gate/shader-language-stage10-fixture.html',
  '../scripts/webgpu-gate/shader-language-stage10-fixture.mjs',
  '../docs/for-ai/adr/0055-atomic-production-deformation-pass-family.md',
  'stage11.md',
  'stage11-contract.json',
  'builtin-material-lighting-family.schema.json',
  'builtin-material-lighting-family.json',
  'scripts/generate-material-lighting-production.mjs',
  'scripts/check-stage11-bundle.mjs',
  'src/material-lighting/contracts.ts',
  'src/material-lighting/definitions.ts',
  'src/material-lighting/family.ts',
  '../engine/src/shader/BuiltinMaterialLightingShader.ts',
  '../engine/src/shaders/generated/material-lighting-artifact.generated.ts',
  '../engine/src/shaders/generated/material-lighting-pbr.generated.wgsl',
  '../engine/src/shaders/generated/material-lighting-blinn-phong.generated.wgsl',
  '../engine/src/shaders/generated/material-lighting-toon.generated.wgsl',
  'test/stage11-material-lighting-production.test.mjs',
  '../engine/test/material-lighting-shader-family.test.mjs',
  '../scripts/verify-webgpu-shader-language-stage11.mjs',
  '../scripts/webgpu-gate/shader-language-stage11-fixture.html',
  '../scripts/webgpu-gate/shader-language-stage11-fixture.mjs',
  '../docs/for-ai/adr/0056-atomic-production-material-lighting-family.md',
  'stage12.md',
  'stage12-contract.json',
  'builtin-specialized-rendering-family.schema.json',
  'builtin-specialized-rendering-family.json',
  'scripts/generate-specialized-rendering-production.mjs',
  'scripts/check-stage12-bundle.mjs',
  'src/specialized-rendering/contracts.ts',
  'src/specialized-rendering/definitions.ts',
  'src/specialized-rendering/family.ts',
  '../engine/src/shader/BuiltinSpecializedRenderingShader.ts',
  '../engine/src/shaders/generated/specialized-rendering-artifact.generated.ts',
  '../engine/src/shaders/generated/specialized-instanced-mesh3d.generated.wgsl',
  '../engine/src/shaders/generated/specialized-line3d.generated.wgsl',
  '../engine/src/shaders/generated/specialized-planar-mirror.generated.wgsl',
  '../engine/src/shaders/generated/specialized-volume.generated.wgsl',
  '../engine/src/shaders/generated/specialized-texture-convolution.generated.wgsl',
  '../engine/src/shaders/generated/specialized-mipmap.generated.wgsl',
  '../engine/src/shaders/generated/specialized-equirectangular-to-cube.generated.wgsl',
  'test/stage12-specialized-rendering-production.test.mjs',
  '../engine/test/specialized-rendering-shader-family.test.mjs',
  '../scripts/verify-webgpu-shader-language-stage12.mjs',
  '../scripts/webgpu-gate/shader-language-stage12-fixture.html',
  '../scripts/webgpu-gate/shader-language-stage12-fixture.mjs',
  '../docs/for-ai/adr/0057-specialized-rendering-family-and-fixed-texture-utilities.md',
  'stage13.md',
  'stage13-contract.json',
  'builtin-compute-family.schema.json',
  'builtin-compute-family.json',
  'scripts/generate-compute-production.mjs',
  'scripts/check-stage13-bundle.mjs',
  'src/compute/contracts.ts',
  'src/compute/definitions.ts',
  'src/compute/family.ts',
  '../engine/src/shader/BuiltinComputeShader.ts',
  '../engine/src/shaders/generated/compute-artifact.generated.ts',
  '../engine/src/shaders/generated/compute-gpu-draw-command.generated.wgsl',
  '../engine/src/shaders/generated/compute-gpu-sort-bitonic.generated.wgsl',
  '../engine/src/shaders/generated/compute-instanced-cull.generated.wgsl',
  '../engine/src/shaders/generated/compute-instanced-depth-sort-key.generated.wgsl',
  '../engine/src/shaders/generated/compute-mesh3d-cull.generated.wgsl',
  'test/stage13-compute-production.test.mjs',
  '../engine/test/compute-shader-family.test.mjs',
  '../scripts/verify-webgpu-shader-language-stage13.mjs',
  '../scripts/webgpu-gate/shader-language-stage13-fixture.html',
  '../scripts/webgpu-gate/shader-language-stage13-fixture.mjs',
  '../docs/for-ai/adr/0058-typed-compute-effects-and-production-family.md',
  'stage14.md',
  'stage14-contract.json',
  'shader-cost-budgets.json',
  'src/backend/glslEs300.ts',
  'scripts/check-stage14-boundary.mjs',
  'scripts/shader-cost-policy.mjs',
  'scripts/verify-production-cache.mjs',
  'test/stage14-glsl-es300.test.mjs',
  '../scripts/shader-language-browser-dag.mjs',
  '../scripts/verify-shader-language-stage14-dag.mjs',
  '../scripts/verify-webgpu-shader-language-stage14.mjs',
  '../scripts/webgpu-gate/shader-language-stage14-fixture.html',
  '../scripts/webgpu-gate/shader-language-stage14-fixture.mjs',
  '../docs/for-ai/adr/0059-glsl-es300-backend-feasibility-boundary.md',
]) requireFile(path);
for (const removed of [
  '../engine/src/shaders/postprocess/motion-blur-frag.wgsl',
  '../engine/src/shaders/postprocess/motion-tile-max-frag.wgsl',
  '../engine/src/shaders/postprocess/motion-neighbor-max-frag.wgsl',
  '../engine/src/shaders/postprocess/fullscreen-vert.wgsl',
  '../engine/src/shaders/postprocess/grayscale-frag.wgsl',
  '../engine/src/shaders/postprocess/sobel-frag.wgsl',
  '../engine/src/shaders/postprocess/fxaa-frag.wgsl',
  '../engine/src/shaders/postprocess/gaussian-blur-frag.wgsl',
  '../engine/src/shaders/postprocess/outline-edge-frag.wgsl',
  '../engine/src/shaders/postprocess/outline-blur-frag.wgsl',
  '../engine/src/shaders/postprocess/outline-overlay-frag.wgsl',
  '../engine/src/shaders/postprocess/taa-frag.wgsl',
  '../extensions/src/shaders/animation-2d.wgsl',
  '../extensions/src/shaders/canvas-text-2d.wgsl',
  '../extensions/src/shaders/spine2d.wgsl',
  '../extensions/src/shaders/tilemap2d.wgsl',
  '../engine/src/shaders/basic-material-skinned.wgsl',
  '../engine/src/shaders/basic-material.wgsl',
  '../engine/src/shaders/bitmap-text.wgsl',
  '../engine/src/shaders/gui-image.wgsl',
  '../engine/src/shaders/gui-shape.wgsl',
  '../engine/src/shaders/gui-text.wgsl',
  '../engine/src/shaders/mesh-helper.wgsl',
  '../engine/src/shaders/mesh2d.wgsl',
  '../engine/src/shaders/normal-material.wgsl',
  '../engine/src/shaders/particle2d.wgsl',
  '../engine/src/shaders/particle3d.wgsl',
  '../engine/src/shaders/radial-shadow.wgsl',
  '../engine/src/shaders/sky.wgsl',
  '../engine/src/shaders/depth-material.wgsl',
  '../engine/src/shaders/motion-vector.wgsl',
  '../engine/src/shaders/outline-mask.wgsl',
  '../engine/src/shaders/shadow-map.wgsl',
  '../engine/src/shaders/shadow-map-morph.wgsl',
  '../engine/src/shaders/shadow-map-skinned.wgsl',
  '../engine/src/shaders/shadow-map-skinned-morph.wgsl',
  '../engine/src/shaders/features/morph.wgsl',
  '../engine/src/shaders/features/skinning.wgsl',
  '../engine/src/shaders/generated/simple3d-basic-material.generated.wgsl',
  '../engine/src/shaders/generated/simple3d-basic-material-skinned.generated.wgsl',
  '../engine/src/shaders/pbr-metallic-roughness.wgsl',
  '../engine/src/shaders/blinn-phong.wgsl',
  '../engine/src/shaders/toon.wgsl',
  '../engine/src/shaders/fog.wgsl',
  '../engine/src/shaders/features/pbr-brdf.wgsl',
  '../engine/src/shaders/features/pbr-clearcoat.wgsl',
  '../engine/src/shaders/features/pbr-sheen.wgsl',
  '../engine/src/shaders/features/pbr-shadow.wgsl',
  '../engine/src/shaders/instanced-mesh3d.wgsl',
  '../engine/src/shaders/line3d.wgsl',
  '../engine/src/shaders/planar-mirror-material.wgsl',
  '../engine/src/shaders/texture-convolution.wgsl',
  '../engine/src/shaders/volume-material.wgsl',
  '../engine/src/shaders/gpu-draw-command.comp.wgsl',
  '../engine/src/shaders/gpu-sort-bitonic.comp.wgsl',
  '../engine/src/shaders/instanced-cull.comp.wgsl',
  '../engine/src/shaders/instanced-depth-sort-key.comp.wgsl',
  '../engine/src/shaders/mesh3d-cull.comp.wgsl',
]) expect(!existsSync(resolve(directory, removed)), `migration retained replaced handwritten source ${removed}`);
validateMarkdownLinks();
validateRepositoryIntegration();

if (violations.length > 0) {
  console.error('[shader-language:stage0] Contract violations:');
  for (const violation of [...new Set(violations)].sort()) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('[shader-language:stage0] Typed IR, graph/reflection v1, Artifact V2, migration inventory, escape hatch, and stages 0–14 contracts passed.');

function validateGraph(value) {
  expect(value.format === 'haiyue-shader-graph', 'pilot graph format is invalid');
  expect(value.version === 1, 'pilot graph version must be 1');
  expect(value.kind === 'material', 'PBR pilot must be a material graph');
  expect(contract.capabilityProfiles.includes(value.profile), `pilot graph has unknown profile ${value.profile}`);
  expect(Array.isArray(value.resources), 'pilot graph resources must be an array');
  expect(Array.isArray(value.nodes), 'pilot graph nodes must be an array');
  expect(value.outputs && typeof value.outputs === 'object' && !Array.isArray(value.outputs), 'pilot graph outputs must be an object');

  const resources = new Map();
  for (const resource of value.resources ?? []) {
    if (!resource || typeof resource !== 'object') {
      violations.push('pilot graph contains a non-object resource');
      continue;
    }
    expect(typeof resource.id === 'string' && resource.id.length > 0, 'pilot graph resource id is required');
    if (resources.has(resource.id)) violations.push(`pilot graph has duplicate resource ${resource.id}`);
    resources.set(resource.id, resource);
    expect(resource.space === 'material', `graph asset may only declare material resources: ${resource.id}`);
    expect(!('group' in resource) && !('binding' in resource), `graph resource ${resource.id} must not declare target binding numbers`);
  }

  const nodes = new Map();
  for (const node of value.nodes ?? []) {
    if (!node || typeof node !== 'object') {
      violations.push('pilot graph contains a non-object node');
      continue;
    }
    expect(typeof node.id === 'string' && node.id.length > 0, 'pilot graph node id is required');
    if (nodes.has(node.id)) violations.push(`pilot graph has duplicate node ${node.id}`);
    nodes.set(node.id, node);
    expect(typeof node.type === 'string' && node.type.includes('.'), `node ${node.id} must use a namespaced type`);
    expect(Number.isInteger(node.typeVersion) && node.typeVersion >= 1, `node ${node.id} has invalid typeVersion`);
  }

  for (const node of value.nodes ?? []) {
    for (const [port, input] of Object.entries(node.inputs ?? {})) {
      validateGraphValue(input, `node ${node.id}.${port}`, nodes, resources);
    }
  }
  for (const [output, outputValue] of Object.entries(value.outputs ?? {})) {
    expect(contract.materialSurfaceOutputs.includes(output), `pilot graph has unknown material output ${output}`);
    validateGraphValue(outputValue, `output ${output}`, nodes, resources);
  }
  for (const required of ['baseColor', 'normalTS', 'metallic', 'roughness']) {
    expect(required in (value.outputs ?? {}), `PBR pilot graph is missing output ${required}`);
  }
  expect(value.sceneFeatures?.includes('scene.fog'), 'PBR pilot must compose Fog as a scene feature');

  validateNodeGraphAcyclic(nodes);
  scanForEmbeddedSource(value, 'pilot graph');
}

function validatePostprocessGraph(value) {
  expect(value.format === 'haiyue-shader-graph', 'postprocess pilot graph format is invalid');
  expect(value.version === 1, 'postprocess pilot graph version must be 1');
  expect(value.kind === 'postprocess', 'motion blur pilot must be a postprocess graph');
  expect(contract.capabilityProfiles.includes(value.profile), `postprocess pilot graph has unknown profile ${value.profile}`);
  expect(Array.isArray(value.resources), 'postprocess pilot resources must be an array');
  expect(Array.isArray(value.nodes), 'postprocess pilot nodes must be an array');

  const resources = new Map();
  for (const resource of value.resources ?? []) {
    if (!resource || typeof resource !== 'object') {
      violations.push('postprocess pilot contains a non-object resource');
      continue;
    }
    expect(typeof resource.id === 'string' && resource.id.length > 0, 'postprocess pilot resource id is required');
    if (resources.has(resource.id)) violations.push(`postprocess pilot has duplicate resource ${resource.id}`);
    resources.set(resource.id, resource);
    expect(resource.space === 'pass', `postprocess graph asset may only declare pass resources: ${resource.id}`);
    expect(resource.frequency === 'pass', `postprocess resource ${resource.id} must use pass frequency`);
    expect(!('group' in resource) && !('binding' in resource), `postprocess resource ${resource.id} must not declare target binding numbers`);
  }

  const nodes = new Map();
  for (const node of value.nodes ?? []) {
    if (!node || typeof node !== 'object') {
      violations.push('postprocess pilot contains a non-object node');
      continue;
    }
    if (nodes.has(node.id)) violations.push(`postprocess pilot has duplicate node ${node.id}`);
    nodes.set(node.id, node);
    expect(node.type === 'haiyue.postprocess.motion-blur', `postprocess pilot has unsupported node type ${node.type}`);
    expect(node.typeVersion === 1, `postprocess node ${node.id} must use typeVersion 1`);
    for (const [port, input] of Object.entries(node.inputs ?? {})) {
      validateGraphValue(input, `postprocess node ${node.id}.${port}`, nodes, resources);
    }
  }
  expect(nodes.size === 1, 'postprocess pilot must contain exactly one aggregate node');
  expect(Object.keys(value.outputs ?? {}).length === 1 && 'color' in (value.outputs ?? {}), 'postprocess pilot must expose only color');
  for (const [output, outputValue] of Object.entries(value.outputs ?? {})) {
    validateGraphValue(outputValue, `postprocess output ${output}`, nodes, resources);
  }
  expect((value.sceneFeatures ?? []).length === 0, 'postprocess pilot must not schedule scene features');
  validateNodeGraphAcyclic(nodes);
  scanForEmbeddedSource(value, 'postprocess pilot graph');
}

function validateGraphValue(value, path, nodes, resources) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    violations.push(`${path} must be a graph value object`);
    return;
  }
  const discriminators = ['literal', 'node', 'semantic', 'resource'].filter(key => key in value);
  expect(discriminators.length === 1, `${path} must contain exactly one value discriminator`);
  expect(Object.keys(value).every(key => discriminators.includes(key) || key === 'output'), `${path} contains unsupported fields`);

  if ('literal' in value) {
    const literal = value.literal;
    expect(literal && typeof literal.type === 'string', `${path}.literal.type is required`);
    validateFiniteLiteral(literal?.value, `${path}.literal.value`);
  } else if ('node' in value) {
    expect(nodes.has(value.node), `${path} references unknown node ${value.node}`);
    expect(typeof value.output === 'string' && value.output.length > 0, `${path}.output is required`);
  } else if ('semantic' in value) {
    expect(typeof value.semantic === 'string' && value.semantic.includes('.'), `${path} has invalid semantic`);
  } else if ('resource' in value) {
    expect(resources.has(value.resource), `${path} references unknown resource ${value.resource}`);
  }
}

function validateFiniteLiteral(value, path) {
  if (typeof value === 'boolean') return;
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    expect(value.length >= 2 && value.length <= 16, `${path} array length must be 2..16`);
    for (const item of value) expect(typeof item === 'number' && Number.isFinite(item), `${path} array values must be finite numbers`);
    return;
  }
  violations.push(`${path} has unsupported literal value`);
}

function validateNodeGraphAcyclic(nodes) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, path) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      violations.push(`pilot graph dependency cycle: ${[...path, id].join(' -> ')}`);
      return;
    }
    visiting.add(id);
    const node = nodes.get(id);
    for (const input of Object.values(node?.inputs ?? {})) {
      if (input && typeof input === 'object' && typeof input.node === 'string' && nodes.has(input.node)) {
        visit(input.node, [...path, id]);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) visit(id, []);
}

function scanForEmbeddedSource(value, path) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['source', 'wgsl', 'glsl', 'javascript', 'script'].includes(key.toLowerCase())) {
      violations.push(`${path} embeds forbidden executable source field ${key}`);
    }
    scanForEmbeddedSource(child, `${path}.${key}`);
  }
}

function validateMarkdownLinks() {
  const paths = [...new Set([
    ...contract.requiredDocuments.filter(path => path.endsWith('.md')),
    'README.md',
    'pilots.md',
    'stage5.md',
    'stage6.md',
    'stage7.md',
    'stage8.md',
    'stage9.md',
    'stage10.md',
    'stage11.md',
    'stage12.md',
    'stage13.md',
    'stage14.md',
  ])];
  for (const path of paths) {
    const absolute = resolve(directory, path);
    const source = readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const destination = normalizeDestination(match[1]);
      if (!destination || /^(?:[a-z][a-z\d+.-]*:|#)/i.test(destination)) continue;
      const withoutFragment = destination.split('#', 1)[0].split('?', 1)[0];
      if (!withoutFragment) continue;
      let decoded;
      try {
        decoded = decodeURIComponent(withoutFragment);
      } catch {
        violations.push(`${path} contains invalid encoded link ${destination}`);
        continue;
      }
      const target = resolve(dirname(absolute), decoded);
      const fromRoot = relative(root, target);
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) violations.push(`${path} links outside the repository: ${destination}`);
      else if (!existsSync(target)) violations.push(`${path} has broken link: ${destination}`);
    }
  }
}

function validateRepositoryIntegration() {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const stage14Dag = readFileSync(resolve(root, 'scripts/verify-shader-language-stage14-dag.mjs'), 'utf8');
  const browserDag = readFileSync(resolve(root, 'scripts/shader-language-browser-dag.mjs'), 'utf8');
  expect(manifest.scripts?.['shader-language:check']?.includes('node shader-language/verify-stage0.mjs'), 'package.json is missing the shader-language:check command');
  expect(manifest.scripts?.['check:fast']?.includes('npm run shader-language:check'), 'check:fast does not include shader-language:check');
  expect(manifest.scripts?.['verify:shader-language-stage5']?.includes('verify-webgpu-shader-language-stage5.mjs'), 'package.json is missing the stage5 WebGPU command');
  expect(manifest.scripts?.['shader-language:check']?.includes('verify-production-cache.mjs'), 'shader-language:check does not use the content-addressed production generator gate');
  expect(manifest.scripts?.['verify:shader-language-stage6']?.includes('verify:shader-language-stage5'), 'stage6 gate does not retain generated/production pixel parity');
  expect(manifest.scripts?.['verify:shader-language-stage6']?.includes('verify:motion-blur'), 'stage6 gate does not run the production Motion Blur browser case');
  expect(manifest.scripts?.['verify:shader-language-stage7']?.includes('verify:shader-language-stage6'), 'stage7 gate does not retain stage6 production evidence');
  expect(manifest.scripts?.['verify:shader-language-stage7']?.includes('verify-webgpu-shader-language-stage7.mjs'), 'stage7 gate does not run the multi-group WebGPU fixture');
  expect(manifest.scripts?.['verify:shader-language-stage8']?.includes('verify:shader-language-stage7'), 'stage8 gate does not retain stage7 evidence');
  expect(manifest.scripts?.['verify:shader-language-stage8']?.includes('verify-webgpu-shader-language-stage8.mjs'), 'stage8 gate does not run the production postprocess WebGPU fixture');
  expect(manifest.scripts?.['verify:shader-language-stage9']?.includes('verify:shader-language-stage8'), 'stage9 gate does not retain stage8 evidence');
  expect(manifest.scripts?.['verify:shader-language-stage9']?.includes('verify-webgpu-shader-language-stage9.mjs'), 'stage9 gate does not run the renderer family WebGPU fixture');
  expect(manifest.scripts?.['verify:shader-language-stage10']?.includes('verify:shader-language-stage9'), 'stage10 gate does not retain stage9 evidence');
  expect(manifest.scripts?.['verify:shader-language-stage10']?.includes('verify-webgpu-shader-language-stage10.mjs'), 'stage10 gate does not run the deformation WebGPU fixture');
  expect(manifest.scripts?.['verify:shader-language-stage11']?.includes('verify:shader-language-stage10'), 'stage11 gate does not retain stage10 evidence');
  expect(manifest.scripts?.['verify:shader-language-stage11']?.includes('verify-webgpu-shader-language-stage11.mjs'), 'stage11 gate does not run the material-lighting WebGPU fixture');
  expect(manifest.scripts?.['verify:shader-language-stage12']?.includes('verify:shader-language-stage11'), 'stage12 gate does not retain stage11 evidence');
  expect(manifest.scripts?.['verify:shader-language-stage12']?.includes('verify-webgpu-shader-language-stage12.mjs'), 'stage12 gate does not run the specialized-rendering WebGPU fixture');
  expect(manifest.scripts?.['verify:shader-language-stage13']?.includes('verify:shader-language-stage12'), 'stage13 gate does not retain stage12 evidence');
  expect(manifest.scripts?.['verify:shader-language-stage13']?.includes('verify-webgpu-shader-language-stage13.mjs'), 'stage13 gate does not run the compute WebGPU fixture');
  expect(manifest.scripts?.['shader-language:check']?.includes('check-stage14-boundary.mjs'), 'shader-language:check does not preserve the stage14 private compiler boundary');
  expect(manifest.scripts?.['verify:shader-language-stage14'] === 'node scripts/verify-shader-language-stage14-dag.mjs', 'stage14 gate does not use the explicit build DAG');
  for (const phase of [2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14]) {
    expect(browserDag.includes(`verify-webgpu-shader-language-stage${phase}.mjs`), `stage14 browser DAG does not retain stage${phase} evidence`);
  }
  for (const phase of [9, 10, 11, 12, 13]) {
    expect(stage14Dag.includes(`check-stage${phase}-bundle.mjs`), `stage14 DAG does not retain stage${phase} bundle evidence`);
  }
  expect(browserDag.includes('browserCase(6'), 'stage14 browser DAG does not retain stage6 production evidence');
  expect(stage14Dag.includes('SHADER_LANGUAGE_BROWSER_DAG.map'), 'stage14 DAG does not consume the stage2–14 browser DAG');
  expect(stage14Dag.includes("node('generate:production'"), 'stage14 DAG does not retain the production generator registry');
  expect(stage14Dag.includes('shader-language/test'), 'stage14 DAG does not retain Shader Language contract tests');
  expect(manifest.scripts?.['verify:render']?.includes('npm run verify:motion-blur'), 'production render gate no longer covers motion blur');

  const rootReadme = readFileSync(resolve(root, 'README.md'), 'utf8');
  expect(rootReadme.includes('shader-language'), 'root README does not index shader-language');

  const repositoryMap = readFileSync(resolve(root, 'docs/for-ai/repository-map.md'), 'utf8');
  expect(repositoryMap.includes('`shader-language/`'), 'repository map does not own shader-language');

  const adrIndex = readFileSync(resolve(root, 'docs/for-ai/adr/README.md'), 'utf8');
  expect(adrIndex.includes('0050-typed-shader-ir-and-authoring-frontends.md'), 'ADR index does not include ADR 0050');
  expect(adrIndex.includes('0051-build-time-shader-artifacts-and-runtime-adapter.md'), 'ADR index does not include ADR 0051');
  expect(adrIndex.includes('0052-precompiled-shader-artifact-v2-and-layout-ownership.md'), 'ADR index does not include ADR 0052');
  expect(adrIndex.includes('0053-builtin-postprocess-module-family-and-production-migration.md'), 'ADR index does not include ADR 0053');
  expect(adrIndex.includes('0054-2d-ui-simple3d-shader-module-family-migration.md'), 'ADR index does not include ADR 0054');
  expect(adrIndex.includes('0055-atomic-production-deformation-pass-family.md'), 'ADR index does not include ADR 0055');
  expect(adrIndex.includes('0056-atomic-production-material-lighting-family.md'), 'ADR index does not include ADR 0056');
  expect(adrIndex.includes('0057-specialized-rendering-family-and-fixed-texture-utilities.md'), 'ADR index does not include ADR 0057');
  expect(adrIndex.includes('0058-typed-compute-effects-and-production-family.md'), 'ADR index does not include ADR 0058');
  expect(adrIndex.includes('0059-glsl-es300-backend-feasibility-boundary.md'), 'ADR index does not include ADR 0059');

  const maintainersIndex = readFileSync(resolve(root, 'docs/for-ai/README.md'), 'utf8');
  expect(maintainersIndex.includes('../../shader-language/README.md'), 'For AI index does not link the shader-language contract');
}

function normalizeDestination(raw) {
  const value = raw.trim();
  if (value.startsWith('<')) {
    const closing = value.indexOf('>');
    return closing < 0 ? value : value.slice(1, closing);
  }
  return value.split(/\s+/, 1)[0];
}

function requireFile(path) {
  const absolute = resolve(directory, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) violations.push(`missing ${path}`);
}

function readJson(path) {
  const absolute = resolve(directory, path);
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    console.error(`[shader-language:stage0] Failed to read ${path}:`, error);
    process.exit(1);
  }
}

function expectUniqueIds(values, label) {
  expect(Array.isArray(values), `${label} collection must be an array`);
  expectUnique((values ?? []).map(value => value?.id), `${label} id`);
}

function expectUnique(values, label) {
  const seen = new Set();
  for (const value of values ?? []) {
    if (typeof value !== 'string' || value.length === 0) violations.push(`${label} must be a non-empty string`);
    if (seen.has(value)) violations.push(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function expectSet(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  expect(JSON.stringify(left) === JSON.stringify(right), `${label} changed: expected ${right.join(', ')}, got ${left.join(', ')}`);
}

function expect(condition, message) {
  if (!condition) violations.push(message);
}
