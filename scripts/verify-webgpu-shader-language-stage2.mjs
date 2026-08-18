import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/shader-language-stage2-fixture.html',
  timeoutMs: 60_000,
});
const failures = [];
if (result.schemaVersion !== 1 || result.suite !== 'shader-language-stage2-webgpu' || result.status !== 'passed') {
  failures.push('invalid result identity');
}
if (!/^[a-f0-9]{64}$/.test(result.canonicalHash ?? '')) failures.push('missing canonical Typed IR hash');
if (!/^[a-f0-9]{64}$/.test(result.compositionHash ?? '')) failures.push('missing Composer IR hash');
if (result.compilationErrorCount !== 0) failures.push(`compilationErrorCount=${result.compilationErrorCount}`);
if (result.validationErrorCount !== 0) failures.push(`validationErrorCount=${result.validationErrorCount}`);
if (!Array.isArray(result.pixelDelta) || result.pixelDelta.length !== 4 || result.pixelDelta.some(value => value > 1)) {
  failures.push(`pixelDelta=${JSON.stringify(result.pixelDelta)}`);
}
if (failures.length > 0) throw new Error(`Shader language stage 2 WebGPU gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage2:webgpu] passed: canonical=${result.canonicalHash.slice(0, 12)}, composition=${result.compositionHash.slice(0, 12)}, pixel=${result.centerPixel.join(',')}.`);
