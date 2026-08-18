import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/shader-language-stage10-fixture.html',
  timeoutMs: 90_000,
});
const failures = [];
if (result.schemaVersion !== 1 || result.suite !== 'shader-language-stage10-production-deformation' || result.status !== 'passed') failures.push('invalid result identity');
if (result.artifactVersion !== 2 || result.compilerVersion !== 'shader-language-stage10' || result.abiVersion !== 1) failures.push('invalid artifact/ABI identity');
if (result.passCount !== 9) failures.push(`passCount=${result.passCount}`);
if (result.compilationErrorCount !== 0) failures.push(`compilationErrorCount=${result.compilationErrorCount}`);
if (result.validationErrorCount !== 0) failures.push(`validationErrorCount=${result.validationErrorCount}`);
if (result.unclassifiedFailureCount !== 0) failures.push(`unclassifiedFailureCount=${result.unclassifiedFailureCount}`);
if (!Array.isArray(result.outlinePixel) || result.outlinePixel.some((value, index) => Math.abs(value - [255, 255, 255, 255][index]) > 1)) failures.push(`outlinePixel=${JSON.stringify(result.outlinePixel)}`);
if (!Array.isArray(result.motionPixel) || Math.abs(result.motionPixel[0] - 0.25) > 0.03 || Math.abs(result.motionPixel[1]) > 0.03) failures.push(`motionPixel=${JSON.stringify(result.motionPixel)}`);
if (result.cache?.shaderModules !== 9 || result.cache?.rendererLayouts !== 30 || result.cache?.pipelineLayouts !== 9) failures.push(`cache=${JSON.stringify(result.cache)}`);
if (failures.length > 0) throw new Error(`Shader language stage 10 WebGPU gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage10:webgpu] passed: passes=${result.passCount}, outline=${result.outlinePixel.join(',')}, motion=${result.motionPixel.join(',')}, module=${result.deformationModuleHash.slice(0, 12)}.`);
