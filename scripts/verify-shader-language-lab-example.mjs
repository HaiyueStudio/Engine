import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = resolve(root, 'examples/shader-language-lab/bundle.js');
if (!existsSync(bundlePath)) {
  throw new Error('Build example:shader-language-lab before running its browser verification.');
}

const browserBundle = readFileSync(bundlePath, 'utf8');
for (const compilerSymbol of [
  'compileShaderIrProgramToGlslEs300',
  'defineTypedShaderModule',
  'composeShaderModules',
]) {
  if (browserBundle.includes(compilerSymbol)) {
    throw new Error(`Shader Language Lab runtime bundle contains compiler symbol ${compilerSymbol}.`);
  }
}

const result = await runChromeWebGpuFixture({
  root,
  fixture: 'examples/shader-language-lab/index.html',
  query: { regression: 1 },
  timeoutMs: 45_000,
  navigateAwayAfterResult: {
    // Event dispatch is synchronous: requestRender() submits all three GPU
    // readbacks and reaches mapAsync() before CDP issues Page.navigate.
    triggerExpression: "document.dispatchEvent(new Event('showcase-parameters-changed'))",
  },
});

assertEqual(result.schemaVersion, 2, 'schemaVersion');
assertEqual(result.suite, 'shader-language-lab-example', 'suite');
assertEqual(result.status, 'passed', 'status');
assertEqual(result.navigationErrorCount, 0, 'navigationErrorCount');
assertEqual(result.runtimeCompilerIncluded, false, 'runtimeCompilerIncluded');
assertEqual(result.productRendererContract, 'webgpu-only-unchanged', 'productRendererContract');
assertEqual(result.webgpuCompilationErrorCount, 0, 'webgpuCompilationErrorCount');
assertEqual(result.webgpuValidationErrorCount, 0, 'webgpuValidationErrorCount');
assertEqual(result.webglCompileErrorCount, 0, 'webglCompileErrorCount');
assertEqual(result.webglLinkErrorCount, 0, 'webglLinkErrorCount');
assertEqual(result.pipelineCount, 8, 'pipelineCount');
assertEqual(result.pipelineRebuildCount, 0, 'pipelineRebuildCount');
assertHash(result.canonicalHash, 'canonicalHash');
assertHash(result.wgslCompositionHash, 'wgslCompositionHash');
assertHash(result.glslBackendHash, 'glslBackendHash');
if (!Number.isFinite(result.uniformWriteCount) || result.uniformWriteCount < 2) {
  throw new Error(`uniformWriteCount must record both backends, got ${result.uniformWriteCount}.`);
}
if (!Number.isFinite(result.maxChannelDelta) || result.maxChannelDelta > 2) {
  throw new Error(`WGSL/GLSL max channel delta ${result.maxChannelDelta} exceeds 2.`);
}
if (!Number.isFinite(result.meanAbsoluteDelta) || result.meanAbsoluteDelta > 0.25) {
  throw new Error(`WGSL/GLSL mean absolute delta ${result.meanAbsoluteDelta} exceeds 0.25.`);
}
assertHash(result.pbr?.canonicalHash, 'pbr.canonicalHash');
assertHash(result.pbr?.compositionHash, 'pbr.compositionHash');
assertEqual(result.pbr?.compilationErrorCount, 0, 'pbr.compilationErrorCount');
assertEqual(result.pbr?.validationErrorCount, 0, 'pbr.validationErrorCount');
assertEqual(result.pbr?.reachableSpecializationVariants, 1, 'pbr.reachableSpecializationVariants');
assertEqual(result.pbr?.maximumSpecializationVariants, 4, 'pbr.maximumSpecializationVariants');
assertEqual(result.pbr?.reachablePilotFamilyVariants, 1, 'pbr.reachablePilotFamilyVariants');
assertEqual(result.pbr?.maximumPilotFamilyVariants, 8, 'pbr.maximumPilotFamilyVariants');
if (!(result.pbr?.graphNodeCount >= 6)) throw new Error(`PBR graph node count is incomplete: ${result.pbr?.graphNodeCount}.`);
if (!(result.pbr?.visiblePixelCount > 1_000)) throw new Error(`PBR sphere is not visibly rendered: ${result.pbr?.visiblePixelCount}.`);
if (!Array.isArray(result.pbr?.averageRgba8) || result.pbr.averageRgba8.length !== 4) {
  throw new Error('PBR evidence is missing average RGBA8.');
}
if (result.pbr.averageRgba8.slice(0, 3).reduce((sum, channel) => sum + channel, 0) <= 40) {
  throw new Error(`PBR output is alpha-visible but effectively black: ${result.pbr.averageRgba8.join(', ')}.`);
}
assertEqual(result.pbr?.pipelineRebuildCount, 0, 'pbr.pipelineRebuildCount');

const character = result.character;
assertEqual(character?.jointCount, 19, 'character.jointCount');
assertEqual(character?.passCount, 5, 'character.passCount');
assertEqual(character?.compilationErrorCount, 0, 'character.compilationErrorCount');
assertEqual(character?.validationErrorCount, 0, 'character.validationErrorCount');
assertEqual(character?.usesAnimation3DMixer, true, 'character.usesAnimation3DMixer');
assertEqual(character?.usesAnimation3DPoseBuffer, true, 'character.usesAnimation3DPoseBuffer');
assertEqual(character?.silhouetteMismatchPixels, 0, 'character.silhouetteMismatchPixels');
assertEqual(character?.frameUploadCallCount, 2, 'character.frameUploadCallCount');
assertEqual(character?.multiPassDuplicateUploads, 0, 'character.multiPassDuplicateUploads');
assertEqual(character?.pipelineRebuildCount, 0, 'character.pipelineRebuildCount');
assertHash(character?.assetSha256, 'character.assetSha256');
assertHash(character?.deformationModuleHash, 'character.deformationModuleHash');
if (!(character?.assetHttpBytes > 0) || !(character?.vertexCount > 300) || !(character?.indexCount > 0)) {
  throw new Error(`Character provenance is incomplete: ${JSON.stringify({ assetHttpBytes: character?.assetHttpBytes, vertexCount: character?.vertexCount, indexCount: character?.indexCount })}.`);
}
const passNames = ['forward', 'depth', 'shadow', 'motion-vector', 'outline-selection'];
const moduleHashes = passNames.map(pass => character?.passModuleHashes?.[pass]);
if (moduleHashes.some(hash => hash !== character?.deformationModuleHash)) {
  throw new Error(`Character passes do not share one deformation module: ${JSON.stringify(moduleHashes)}.`);
}
for (const pass of passNames) {
  if (!(character?.passes?.[pass]?.visiblePixelCount > 0)) throw new Error(`Character ${pass} has no visible pixels.`);
}
if (!(character?.passes?.['motion-vector']?.maximumNeutralChannelDelta > 1)) {
  throw new Error(`Character motion vector is neutral: ${character?.passes?.['motion-vector']?.maximumNeutralChannelDelta}.`);
}
if (!(character?.totalDrawCount >= 10) || !(character?.totalSubmitCount >= 2)) {
  throw new Error(`Character five-pass work is incomplete: draws=${character?.totalDrawCount}, submits=${character?.totalSubmitCount}.`);
}

console.log(JSON.stringify({
  fixture: 'shader-language-lab-dual-backend-384x384',
  ...result,
  runtimeBundleBytes: Buffer.byteLength(browserBundle),
}, null, 2));

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
}

function assertHash(value, label) {
  if (!/^[0-9a-f]{64}$/.test(String(value))) throw new Error(`${label} is not a SHA-256 digest.`);
}
