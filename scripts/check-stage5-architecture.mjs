import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];
const sceneServices = ['SceneRuntime', 'SceneSystems', 'SceneAssets', 'ScenePlugins', 'ScenePresetFactory'];

for (const service of sceneServices) {
  requireFile(`engine/src/scene/internal/${service}.ts`);
}

const scene = source('engine/src/scene/Scene.ts');
for (const service of sceneServices.slice(0, 4)) {
  requireMatch(scene, new RegExp(`new ${service}\\b`), `Scene facade does not compose ${service}`);
}
requireMatch(scene, /normalizeSceneOptions.*ScenePresetFactory/, 'Scene preset factory is not a separate facade dependency');

const plugin = source('engine/src/core/EnginePlugin.ts');
for (const method of [
  'registerComponent',
  'registerAssetLoader',
  'addSystem',
  'registerMaterialRenderer',
  'registerComponentDescriptor',
  'registerInspectorRenderer',
  'registerResourceImporter',
  'registerStarterKit',
]) {
  requireMatch(plugin, new RegExp(`${method}(?:<[^>]+>)?\\([^;]+\\): RegistrationToken`, 's'), `${method} does not return RegistrationToken`);
}
requireMatch(plugin, /track\(cleanup: \(\) => void\): RegistrationToken/, 'rollback tracker does not return RegistrationToken');

const pipeline = source('engine/src/renderer/RenderPipeline.ts');
for (const forbidden of ['GPUResourceTracker', 'GPUResourceOwner', 'createGPUResourceOwner']) {
  if (pipeline.includes(forbidden)) violations.push(`RenderPipeline contains concrete ownership concern ${forbidden}`);
}
requireMatch(pipeline, /RenderPipelineExecutionBoundary/, 'RenderPipeline has no public execution boundary contract');

const profile = source('engine/src/core/RenderProfile.ts');
requireMatch(profile, /DEFAULT_RENDER_PROFILE(?:\s*:\s*RenderProfileName)?\s*=\s*'batched'/, '3D-first default RenderProfile is missing');
requireMatch(profile, /RENDER_PROFILES/, 'stable RenderProfile catalog is missing');
requireMatch(profile, /createRenderCapabilities/, 'render capability snapshot contract is missing');

requireFile('engine/src/frame/SceneRenderEnvironment.ts');
const sceneEnvironment = source('engine/src/frame/SceneRenderEnvironment.ts');
requireMatch(sceneEnvironment, /iterQueryCandidates\(FOG_ENVIRONMENT_QUERY\)/, 'SceneRenderEnvironment does not consume the Fog component index');
requireMatch(sceneEnvironment, /iterQueryCandidates\(IMAGE_BASED_ENVIRONMENT_QUERY\)/, 'SceneRenderEnvironment does not consume the EnvironmentLight component index');
requireMatch(sceneEnvironment, /iterQueryCandidates\(LIGHT_ENVIRONMENT_QUERY\)/, 'SceneRenderEnvironment does not consume the LightComponent index');
if (/world\.entities\.values\(\)/.test(sceneEnvironment)) violations.push('SceneRenderEnvironment regressed to a full World scan');
const render3D = source('engine/src/systems/Render3DSystem.ts');
const instanced3D = source('engine/src/systems/InstancedMesh3DRenderSystem.ts');
const blinnPhong = source('engine/src/systems/BlinnPhongRenderSystem.ts');
requireMatch(render3D, /getSceneRenderEnvironment\(frameData, world\)/, 'Render3DSystem does not consume the shared scene render environment');
requireMatch(instanced3D, /getSceneRenderEnvironment\(frameData, world\)/, 'InstancedMesh3DRenderSystem does not consume the shared scene render environment');
requireMatch(render3D, /getSceneFrameUniformSnapshot\(cameraFrame, sceneEnvironment\.fog\)/, 'Render3DSystem does not build the shared scene frame uniform snapshot');
requireMatch(instanced3D, /getSceneFrameUniformSnapshot\(cameraFrame, sceneEnvironment\.fog\)/, 'InstancedMesh3DRenderSystem does not share the scene frame uniform snapshot');
requireMatch(blinnPhong, /sceneEnvironment\.pbrLights/, 'BlinnPhongRenderSystem does not consume the shared light snapshot');
requireMatch(blinnPhong, /sceneFrameUniforms/, 'BlinnPhongRenderSystem does not consume the shared scene frame uniform snapshot');
for (const [name, value] of [['Render3DSystem', render3D], ['InstancedMesh3DRenderSystem', instanced3D], ['BlinnPhongRenderSystem', blinnPhong]]) {
  if (/world\.entities\.values\(\)/.test(value)) violations.push(`${name} performs an independent full World environment scan`);
}

requireFile('engine/src/shader/WgslFeatureComposer.ts');
requireFile('engine/src/frame/SceneFrameUniformLayout.ts');
requireFile('engine/src/renderer/SceneFrameGpuArena.ts');
if (existsSync(resolve(root, 'engine/src/renderer/FogUniform.ts'))) violations.push('legacy renderer/FogUniform.ts duplicates the scene frame ABI');
const shaderFeatures = source('engine/src/shader/features.ts');
const sceneFrameGpuArena = source('engine/src/renderer/SceneFrameGpuArena.ts');
const parameterizedRendererCore = source('engine/src/renderer/ParameterizedRendererCore.ts');
requireMatch(shaderFeatures, /material-lighting-fog\.generated\.wgsl/, 'shader features do not consume the generated self-contained Fog module');
requireMatch(shaderFeatures, /SCENE_FRAME_UNIFORM_WGSL/, 'shader features are not generated from the shared scene frame ABI schema');
requireMatch(sceneFrameGpuArena, /minUniformBufferOffsetAlignment/, 'SceneFrameGpuArena does not align slots to device limits');
requireMatch(sceneFrameGpuArena, /hasDynamicOffset:\s*true/, 'SceneFrameGpuArena does not expose dynamic uniform offsets');
requireMatch(sceneFrameGpuArena, /SceneFrameUniformLayout\.size/, 'SceneFrameGpuArena does not allocate from the shared ABI');
requireMatch(parameterizedRendererCore, /encodeShaderPipelineKey\(/, 'ParameterizedRendererCore pipeline keys omit the shader feature set');
for (const path of [
  'engine/src/shader/features.ts',
  'engine/src/shaders/generated/deformation-morph.generated.wgsl',
  'engine/src/shaders/generated/deformation-skinning.generated.wgsl',
  'engine/src/shaders/generated/material-lighting-fog.generated.wgsl',
  'engine/src/shaders/generated/material-lighting-pbr-brdf.generated.wgsl',
  'engine/src/shaders/generated/material-lighting-artifact.generated.ts',
  'engine/src/shaders/generated/specialized-rendering-artifact.generated.ts',
  'engine/src/shaders/generated/compute-artifact.generated.ts',
]) requireFile(path);
for (const path of [
  'engine/src/renderer/Mesh3DRenderer.ts',
  'engine/src/renderer/InstancedMesh3DRenderer.ts',
  'engine/src/renderer/PbrRenderer.ts',
  'engine/src/renderer/BlinnPhongRenderer.ts',
  'engine/src/renderer/ToonRenderer.ts',
]) {
  const renderer = source(path);
  if (path.endsWith('/Mesh3DRenderer.ts')) {
    requireMatch(renderer, /getBuiltinDeformationShader\(/, `${path} bypasses the Stage 10 deformation artifact runtime`);
  } else if (path.endsWith('/PbrRenderer.ts') || path.endsWith('/BlinnPhongRenderer.ts') || path.endsWith('/ToonRenderer.ts')) {
    requireMatch(renderer, /getBuiltinMaterialLightingShader\(/, `${path} bypasses the Stage 11 material-lighting artifact runtime`);
  } else if (/\/(?:InstancedMesh3D|Line3D|PlanarMirror|Volume)Renderer\.ts$/.test(path)) {
    requireMatch(renderer, /getBuiltinSpecializedRenderingShader\(/, `${path} bypasses the Stage 12 specialized-rendering artifact runtime`);
  } else {
    requireMatch(renderer, /createComposedShaderModule\(/, `${path} bypasses the WGSL feature composer`);
  }
  requireMatch(renderer, /(?:rendererCore|_rendererCore)\.pipelineKey\(/, `${path} bypasses the shared shader-aware pipeline key owner`);
  requireMatch(renderer, /getSceneFrameGpuArena\(device\)\.createBinding\(\)/, `${path} does not use the device-level SceneFrame GPU arena`);
  requireMatch(renderer, /SceneFrameUniformSnapshot/, `${path} does not consume the shared CPU frame snapshot`);
  if (/writeFogUniform|_cameraData|CAMERA_(?:BYTES|FLOATS)|CAM_SIZE/.test(renderer)) {
    violations.push(`${path} maintains a private scene frame ABI writer or offset`);
  }
}
for (const path of [
  'engine/src/renderer/InstancedMesh3DRenderer.ts',
  'engine/src/renderer/Line3DRenderer.ts',
  'engine/src/renderer/PlanarMirrorRenderer.ts',
  'engine/src/renderer/VolumeRenderer.ts',
]) {
  requireMatch(source(path), /getBuiltinSpecializedRenderingShader\(/, `${path} bypasses the Stage 12 specialized-rendering artifact runtime`);
}
for (const path of [
  'engine/src/assets/ImageTextureUpload.ts',
  'engine/src/lighting/EquirectangularReflectionMap.ts',
  'engine/src/compute/TextureConvolutionProcessor.ts',
]) {
  const utility = source(path);
  requireMatch(utility, /getBuiltinSpecializedRenderingShader\(/, `${path} bypasses the Stage 12 specialized-rendering artifact runtime`);
  if (/\/\*\s*wgsl\s*\*\//.test(utility)) violations.push(`${path} retains an inline production WGSL source`);
}
for (const path of [
  'engine/src/compute/GpuDrawCommandComputePass.ts',
  'engine/src/compute/GpuSortComputePass.ts',
  'engine/src/compute/Mesh3DGpuCullComputePass.ts',
  'engine/src/renderer/InstancedMesh3DRenderer.ts',
]) {
  requireMatch(source(path), /getBuiltinComputeShader/, `${path} bypasses the Stage 13 compute artifact adapter`);
}
for (const path of [
  'engine/src/shaders/generated/deformation-forward.generated.wgsl',
  'engine/src/shaders/generated/deformation-forward-skinned.generated.wgsl',
  'engine/src/shaders/generated/specialized-instanced-mesh3d.generated.wgsl',
  'engine/src/shaders/generated/material-lighting-pbr.generated.wgsl',
  'engine/src/shaders/generated/material-lighting-blinn-phong.generated.wgsl',
  'engine/src/shaders/generated/material-lighting-toon.generated.wgsl',
]) {
  const shader = source(path);
  requireMatch(shader, /var<uniform>\s+sceneFrame\s*:\s*SceneFrameUniforms/, `${path} does not use the generated scene frame ABI`);
  if (/struct\s+(?:Camera|CameraUniforms)\b/.test(shader)) violations.push(`${path} redeclares a private camera uniform ABI`);
}
for (const path of filesUnder('engine/src')) {
  const value = source(path);
  if (/\.replace(?:All)?\(\s*['"`]__[A-Z0-9_]+__/.test(value)) {
    violations.push(`${path} performs direct shader sentinel replacement`);
  }
  if (path.endsWith('.wgsl') && /__[A-Z0-9_]+__/.test(value)) {
    violations.push(`${path} contains a legacy shader sentinel`);
  }
}

if (violations.length > 0) {
  console.error('[stage5-architecture] Contract violations:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}
console.log('[stage5-architecture] Scene services, shared render environment/uniform ABI, WGSL composition, registration tokens, pipeline boundary, and RenderProfile contracts passed.');

function source(path) {
  const absolute = resolve(root, path);
  requireFile(path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
}

function requireFile(path) {
  if (!existsSync(resolve(root, path))) violations.push(`missing ${path}`);
}

function requireMatch(value, pattern, message) {
  if (!pattern.test(value)) violations.push(message);
}

function filesUnder(directory) {
  const result = [];
  const visit = relativeDirectory => {
    const absoluteDirectory = resolve(root, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const path = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && (path.endsWith('.ts') || path.endsWith('.wgsl'))) result.push(path);
    }
  };
  visit(directory);
  return result;
}
