import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/shader-language-stage11-fixture.html',
  timeoutMs: 90_000,
});
const failures = [];
if (result.schemaVersion !== 1 || result.suite !== 'shader-language-stage11-material-lighting' || result.status !== 'passed') failures.push('invalid result identity');
if (result.artifactVersion !== 2 || result.compilerVersion !== 'shader-language-stage11' || result.abiVersion !== 1) failures.push('invalid artifact/ABI identity');
if (result.passCount !== 6) failures.push(`passCount=${result.passCount}`);
if (result.compilationErrorCount !== 0) failures.push(`compilationErrorCount=${result.compilationErrorCount}`);
if (result.validationErrorCount !== 0) failures.push(`validationErrorCount=${result.validationErrorCount}`);
if (result.unclassifiedFailureCount !== 0) failures.push(`unclassifiedFailureCount=${result.unclassifiedFailureCount}`);
assertPixel(result.litPixel, [186, 0, 0, 255], 1, 'litPixel', failures);
assertPixel(result.lowAmbientPixel, [44, 44, 44, 255], 1, 'lowAmbientPixel', failures);
assertPixel(result.fogPixel, [0, 0, 255, 255], 1, 'fogPixel', failures);
if (result.cache?.shaderModules !== 6 || result.cache?.rendererLayouts !== 24 || result.cache?.pipelineLayouts !== 6) failures.push(`cache=${JSON.stringify(result.cache)}`);
if (!/^[a-f0-9]{64}$/.test(result.lightingModuleHash ?? '')) failures.push(`lightingModuleHash=${result.lightingModuleHash}`);
if (!/^[a-f0-9]{64}$/.test(result.deformationModuleHash ?? '')) failures.push(`deformationModuleHash=${result.deformationModuleHash}`);
if (failures.length > 0) throw new Error(`Shader language stage 11 WebGPU gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage11:webgpu] passed: passes=${result.passCount}, lit=${result.litPixel.join(',')}, lowAmbient=${result.lowAmbientPixel.join(',')}, fog=${result.fogPixel.join(',')}, module=${result.lightingModuleHash.slice(0, 12)}.`);

function assertPixel(actual, expected, tolerance, label, failures) {
  if (!Array.isArray(actual) || actual.some((value, index) => Math.abs(value - expected[index]) > tolerance)) {
    failures.push(`${label}=${JSON.stringify(actual)}`);
  }
}
