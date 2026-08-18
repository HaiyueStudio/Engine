import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await runChromeWebGpuFixture({ root, fixture: 'scripts/webgpu-gate/shader-language-stage13-fixture.html', timeoutMs: 90_000 });
const failures = [];
if (result.schemaVersion !== 1 || result.suite !== 'shader-language-stage13-compute' || result.status !== 'passed') failures.push('invalid result identity');
if (result.artifactVersion !== 2 || result.compilerVersion !== 'shader-language-stage13' || result.abiVersion !== 1) failures.push('invalid artifact/ABI identity');
if (result.passCount !== 5 || result.executedPassCount !== 3 || result.computeIrHashCount !== 5) failures.push(`pass evidence=${result.passCount}/${result.executedPassCount}/${result.computeIrHashCount}`);
if (result.compilationErrorCount !== 0 || result.validationErrorCount !== 0 || result.unclassifiedFailureCount !== 0) failures.push('compute fixture reported classified or unclassified failures');
if (JSON.stringify(result.drawCommand) !== JSON.stringify({ indexed: [6,3,0,0,7], draw: [4,3,0,7] })) failures.push(`drawCommand=${JSON.stringify(result.drawCommand)}`);
if (JSON.stringify(result.bitonicSort) !== JSON.stringify({ keys: [1,2,3,4], indices: [1,3,2,0] })) failures.push(`bitonicSort=${JSON.stringify(result.bitonicSort)}`);
if (JSON.stringify(result.instancedCull) !== JSON.stringify([1,0])) failures.push(`instancedCull=${JSON.stringify(result.instancedCull)}`);
if (result.cache?.shaderModules !== 5 || result.cache?.bindGroupLayouts !== 5 || result.cache?.pipelineLayouts !== 5) failures.push(`cache=${JSON.stringify(result.cache)}`);
if (!/^[a-f0-9]{64}$/.test(result.computeModuleHash ?? '')) failures.push(`computeModuleHash=${result.computeModuleHash}`);
if (failures.length > 0) throw new Error(`Shader language stage 13 WebGPU gate failed:\n- ${failures.join('\n- ')}`);
console.log(`[shader-language:stage13:webgpu] passed: passes=${result.passCount}, executed=${result.executedPassCount}, draw/sort/cull side effects verified, module=${result.computeModuleHash.slice(0, 12)}.`);
