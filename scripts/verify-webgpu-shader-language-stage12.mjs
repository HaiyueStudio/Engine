import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/shader-language-stage12-fixture.html',
  timeoutMs: 90_000,
});
const failures = [];
if (result.schemaVersion !== 1 || result.suite !== 'shader-language-stage12-specialized-rendering' || result.status !== 'passed') failures.push('invalid result identity');
if (result.artifactVersion !== 2 || result.compilerVersion !== 'shader-language-stage12' || result.abiVersion !== 1) failures.push('invalid artifact/ABI identity');
if (result.passCount !== 7 || result.renderPassCount !== 6 || result.computePassCount !== 1) {
  failures.push(`pass counts=${result.passCount}/${result.renderPassCount}/${result.computePassCount}`);
}
if (result.compilationErrorCount !== 0) failures.push(`compilationErrorCount=${result.compilationErrorCount}`);
if (result.validationErrorCount !== 0) failures.push(`validationErrorCount=${result.validationErrorCount}`);
if (result.unclassifiedFailureCount !== 0) failures.push(`unclassifiedFailureCount=${result.unclassifiedFailureCount}`);
assertPixel(result.mipmapPixel, [51, 102, 204, 255], 1, 'mipmapPixel', failures);
assertPixel(result.convolutionPixel, [25, 50, 75, 255], 1, 'convolutionPixel', failures);
if (result.cache?.shaderModules !== 7 || result.cache?.bindGroupLayouts !== 12 || result.cache?.pipelineLayouts !== 7) {
  failures.push(`cache=${JSON.stringify(result.cache)}`);
}
if (!/^[a-f0-9]{64}$/.test(result.specializedModuleHash ?? '')) failures.push(`specializedModuleHash=${result.specializedModuleHash}`);
if (failures.length > 0) throw new Error(`Shader language stage 12 WebGPU gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage12:webgpu] passed: passes=${result.passCount}, mipmap=${result.mipmapPixel.join(',')}, convolution=${result.convolutionPixel.join(',')}, module=${result.specializedModuleHash.slice(0, 12)}.`);

function assertPixel(actual, expected, tolerance, label, failures) {
  if (!Array.isArray(actual) || actual.some((value, index) => Math.abs(value - expected[index]) > tolerance)) {
    failures.push(`${label}=${JSON.stringify(actual)}`);
  }
}
