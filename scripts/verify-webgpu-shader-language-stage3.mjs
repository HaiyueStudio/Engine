import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { validateShaderLanguageStage3VariantEvidence } from './webgpu-gate/shader-language-stage3-report.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage3Contract = JSON.parse(readFileSync(resolve(root, 'shader-language/stage3-contract.json'), 'utf8'));
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/shader-language-stage3-fixture.html',
  timeoutMs: 90_000,
});
const failures = [];
if (result.schemaVersion !== 1 || result.suite !== 'shader-language-stage3-pbr-pilot' || result.status !== 'passed') failures.push('invalid result identity');
if (!/^[a-f0-9]{64}$/.test(result.canonicalHash ?? '')) failures.push('missing canonical graph/IR hash');
if (!/^[a-f0-9]{64}$/.test(result.compositionHash ?? '')) failures.push('missing Composer hash');
if (result.compilationErrorCount !== 0) failures.push(`compilationErrorCount=${result.compilationErrorCount}`);
if (result.validationErrorCount !== 0) failures.push(`validationErrorCount=${result.validationErrorCount}`);
if (result.unclassifiedFailureCount !== 0) failures.push(`unclassifiedFailureCount=${result.unclassifiedFailureCount}`);
if (result.pixelDifference?.maximumChannelDelta > 2 || result.pixelDifference?.meanAbsoluteChannelDelta > 0.25) {
  failures.push(`pixelDifference=${JSON.stringify(result.pixelDifference)}`);
}
const expectedCenterPixel = [26, 27, 39, 230];
if (!samePixelWithin(result.generatedCenterPixel, expectedCenterPixel, 2)) failures.push(`generatedCenterPixel=${JSON.stringify(result.generatedCenterPixel)}`);
if (!samePixelWithin(result.referenceCenterPixel, expectedCenterPixel, 2)) failures.push(`referenceCenterPixel=${JSON.stringify(result.referenceCenterPixel)}`);
if (!(result.gzipRatio <= 1.15)) failures.push(`gzipRatio=${result.gzipRatio} (${result.generatedGzipBytes}/${result.referenceGzipBytes})`);
failures.push(...validateShaderLanguageStage3VariantEvidence(result, stage3Contract.pilot));
if (result.productionFirstFrameRegressionPercent > 5) failures.push(`productionFirstFrameRegressionPercent=${result.productionFirstFrameRegressionPercent}`);
if (result.materialUniformByteSize !== 16) failures.push(`materialUniformByteSize=${result.materialUniformByteSize}`);
if (result.varyingCount !== 5) failures.push(`varyingCount=${result.varyingCount}`);
if (failures.length > 0) throw new Error(`Shader language stage 3 WebGPU gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage3:webgpu] passed: canonical=${result.canonicalHash.slice(0, 12)}, pixel max/mean=${result.pixelDifference.maximumChannelDelta}/${result.pixelDifference.meanAbsoluteChannelDelta.toFixed(4)}, gzip=${result.generatedGzipBytes}/${result.referenceGzipBytes} (${result.gzipRatio.toFixed(3)}x), graph=${result.graphCompileMs.toFixed(2)}ms.`);

function samePixelWithin(actual, expected, tolerance) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
}
