import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(await readFile(resolve(root, 'shader-language/stage14-contract.json'), 'utf8'));
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/shader-language-stage14-fixture.html',
  timeoutMs: 60_000,
});
const failures = [];
if (result.schemaVersion !== 1 || result.suite !== 'shader-language-stage14-dual-backend' || result.status !== 'passed') failures.push('invalid result identity');
if (result.productRendererContract !== 'webgpu-only-unchanged') failures.push(`productRendererContract=${result.productRendererContract}`);
for (const [name, value] of [['canonicalHash', result.canonicalHash], ['wgslCompositionHash', result.wgslCompositionHash], ['glslBackendHash', result.glslBackendHash]]) {
  if (!/^[a-f0-9]{64}$/.test(value ?? '')) failures.push(`missing ${name}`);
}
if (result.canonicalHash !== contract.evidence?.canonicalHash) failures.push(`canonicalHash=${result.canonicalHash}, contract=${contract.evidence?.canonicalHash}`);
if (result.glslBackendHash !== contract.evidence?.glslBackendHash) failures.push(`glslBackendHash=${result.glslBackendHash}, contract=${contract.evidence?.glslBackendHash}`);
if (result.glslEntryCount !== 2 || result.glslUniformBlockCount !== 1 || result.glslCombinedSamplerCount !== 1) failures.push('invalid GLSL reflection counts');
if (result.webgpu?.available !== true || result.webgpu?.compilationErrorCount !== 0 || result.webgpu?.validationErrorCount !== 0) failures.push(`invalid WebGPU result ${JSON.stringify(result.webgpu)}`);
if (result.webgl2?.available !== true || result.webgl2?.compileErrorCount !== 0 || result.webgl2?.linkErrorCount !== 0) failures.push(`invalid WebGL2 result ${JSON.stringify(result.webgl2)}`);
for (const name of ['crossBackendDelta', 'webgpuExpectedDelta', 'webgl2ExpectedDelta']) {
  if (!Array.isArray(result[name]) || result[name].length !== 4 || result[name].some(value => value > 1)) failures.push(`${name}=${JSON.stringify(result[name])}`);
}
if (result.unclassifiedFailureCount !== 0) failures.push(`unclassifiedFailureCount=${result.unclassifiedFailureCount}`);
if (failures.length) throw new Error(`Shader language stage 14 dual-backend gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage14:dual-backend] passed: canonical=${result.canonicalHash.slice(0, 12)}, glsl=${result.glslBackendHash.slice(0, 12)}, pixel=${result.webgpu.centerPixel.join(',')}, delta=${result.crossBackendDelta.join(',')}.`);
