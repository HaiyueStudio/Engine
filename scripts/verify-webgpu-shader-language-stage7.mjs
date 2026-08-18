import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/shader-language-stage7-fixture.html',
  timeoutMs: 60_000,
});
const failures = [];
if (result.schemaVersion !== 1 || result.suite !== 'shader-language-stage7-artifact-v2' || result.status !== 'passed') {
  failures.push('invalid result identity');
}
if (result.artifactVersion !== 2 || result.rendererOwnedGroupCount !== 1 || result.artifactOwnedGroupCount !== 1) {
  failures.push('multi-group ownership was not preserved');
}
if (result.compilationErrorCount !== 0) failures.push(`compilationErrorCount=${result.compilationErrorCount}`);
if (result.validationErrorCount !== 0) failures.push(`validationErrorCount=${result.validationErrorCount}`);
if (result.unclassifiedFailureCount !== 0) failures.push(`unclassifiedFailureCount=${result.unclassifiedFailureCount}`);
if (!Array.isArray(result.pixelDelta) || result.pixelDelta.some(value => value > 1)) {
  failures.push(`pixelDelta=${JSON.stringify(result.pixelDelta)}`);
}
if (result.cache?.shaderModules !== 1 || result.cache?.artifactLayouts !== 1 || result.cache?.pipelineLayouts !== 2) {
  failures.push(`layout-aware cache=${JSON.stringify(result.cache)}`);
}
if (failures.length > 0) throw new Error(`Shader language stage 7 WebGPU gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage7:webgpu] passed: pixel=${result.centerPixel.join(',')}, cache=${JSON.stringify(result.cache)}.`);
