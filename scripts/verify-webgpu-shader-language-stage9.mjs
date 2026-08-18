import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/shader-language-stage9-fixture.html',
  timeoutMs: 90_000,
});
const failures = [];
if (result.schemaVersion !== 1 || result.suite !== 'shader-language-stage9-builtin-render' || result.status !== 'passed') {
  failures.push('invalid result identity');
}
if (result.artifactVersion !== 2 || result.compilerVersion !== 'shader-language-stage9') {
  failures.push('production artifact identity was not preserved');
}
if (result.familyCount !== 3 || result.passCount !== 15) {
  failures.push(`unexpected family/pass count ${result.familyCount}/${result.passCount}`);
}
if (result.compilationErrorCount !== 0) failures.push(`compilationErrorCount=${result.compilationErrorCount}`);
if (result.validationErrorCount !== 0) failures.push(`validationErrorCount=${result.validationErrorCount}`);
if (result.unclassifiedFailureCount !== 0) failures.push(`unclassifiedFailureCount=${result.unclassifiedFailureCount}`);
if (!Array.isArray(result.pixelDelta) || result.pixelDelta.some(value => value > 1)) {
  failures.push(`pixelDelta=${JSON.stringify(result.pixelDelta)}`);
}
if (result.cache?.shaderModules !== 15 || result.cache?.rendererLayouts !== 38 || result.cache?.pipelineLayouts !== 15) {
  failures.push(`artifact runtime cache=${JSON.stringify(result.cache)}`);
}
if (failures.length > 0) throw new Error(`Shader language stage 9 WebGPU gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage9:webgpu] passed: families=${result.familyCount}, passes=${result.passCount}, pixel=${result.centerPixel.join(',')}, cache=${JSON.stringify(result.cache)}.`);
