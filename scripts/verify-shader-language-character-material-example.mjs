import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = resolve(root, 'examples/shader-language-character-material/bundle.js');
if (!existsSync(bundlePath)) {
  throw new Error('Build example:shader-language-character-material before browser verification.');
}

const browserBundle = readFileSync(bundlePath, 'utf8');
for (const compilerSymbol of [
  'compileShaderIrProgramToGlslEs300',
  'defineTypedShaderModule',
  'composeShaderModules',
]) {
  if (browserBundle.includes(compilerSymbol)) {
    throw new Error(`Character Material runtime bundle contains compiler symbol ${compilerSymbol}.`);
  }
}

const result = await runChromeWebGpuFixture({
  root,
  fixture: 'examples/shader-language-character-material/index.html',
  query: { regression: 1 },
  timeoutMs: 45_000,
});

assertEqual(result.schemaVersion, 1, 'schemaVersion');
assertEqual(result.suite, 'shader-language-character-material-example', 'suite');
assertEqual(result.status, 'passed', 'status');
assertEqual(result.runtimeCompilerIncluded, false, 'runtimeCompilerIncluded');
assertEqual(result.productRendererContract, 'webgpu-only-unchanged', 'productRendererContract');
assertEqual(result.jointCount, 19, 'jointCount');
assertEqual(result.passCount, 5, 'passCount');
assertEqual(result.compilationErrorCount, 0, 'compilationErrorCount');
assertEqual(result.validationErrorCount, 0, 'validationErrorCount');
assertEqual(result.usesAnimation3DMixer, true, 'usesAnimation3DMixer');
assertEqual(result.usesAnimation3DPoseBuffer, true, 'usesAnimation3DPoseBuffer');
assertEqual(result.historySemantics, 'current-and-previous-same-ir', 'historySemantics');
assertEqual(result.silhouetteMismatchPixels, 0, 'silhouetteMismatchPixels');
assertEqual(result.frameUploadCallCount, 2, 'frameUploadCallCount');
assertEqual(result.multiPassDuplicateUploads, 0, 'multiPassDuplicateUploads');
assertEqual(result.pipelineRebuildCount, 0, 'pipelineRebuildCount');
assertEqual(result.material?.pipelineRebuildCount, 0, 'material.pipelineRebuildCount');
assertHash(result.assetSha256, 'assetSha256');
assertHash(result.deformationModuleHash, 'deformationModuleHash');
if (!(result.assetHttpBytes > 0) || !(result.vertexCount > 300) || !(result.indexCount > 0)) {
  throw new Error(`Character provenance is incomplete: ${JSON.stringify({ assetHttpBytes: result.assetHttpBytes, vertexCount: result.vertexCount, indexCount: result.indexCount })}.`);
}
if (!Array.isArray(result.deformationOrder) || result.deformationOrder.join('>') !== 'morph>skinning>displacement') {
  throw new Error(`Unexpected deformation order: ${JSON.stringify(result.deformationOrder)}.`);
}
if (!(result.material?.pixelDeltaFromReference > 8)) {
  throw new Error(`Material uniform did not visibly change forward output: ${result.material?.pixelDeltaFromReference}.`);
}
const passNames = ['forward', 'depth', 'shadow', 'motion-vector', 'outline-selection'];
for (const pass of passNames) {
  assertEqual(result.passModuleHashes?.[pass], result.deformationModuleHash, `passModuleHashes.${pass}`);
  if (!(result.passes?.[pass]?.visiblePixelCount > 0)) throw new Error(`${pass} has no visible pixels.`);
}
if (!(result.passes?.['motion-vector']?.maximumNeutralChannelDelta > 1)) {
  throw new Error(`Motion-vector pass is neutral: ${result.passes?.['motion-vector']?.maximumNeutralChannelDelta}.`);
}
if (!(result.totalDrawCount >= 15) || !(result.totalSubmitCount >= 3)) {
  throw new Error(`Expected three complete five-pass frames, got draws=${result.totalDrawCount}, submits=${result.totalSubmitCount}.`);
}

console.log(JSON.stringify({
  fixture: 'shader-language-character-material-five-pass-160x208',
  ...result,
  runtimeBundleBytes: Buffer.byteLength(browserBundle),
}, null, 2));

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
}

function assertHash(value, label) {
  if (!/^[0-9a-f]{64}$/.test(String(value))) throw new Error(`${label} is not a SHA-256 digest.`);
}
