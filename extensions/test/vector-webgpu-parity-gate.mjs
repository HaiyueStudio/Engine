import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from '../../scripts/webgpu-gate/chrome-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const result = await runChromeWebGpuFixture({ root, fixture: 'extensions/test/vector-webgpu-parity-fixture.html', timeoutMs: 90_000, acceptedStatuses: ['passed'] });
if (result.caseCount !== 25 || result.strictValidation !== true) throw new Error(`Invalid vector WebGPU result: ${JSON.stringify(result)}`);
console.log(`[vector-visual:webgpu] ${result.caseCount} paint/composite/image pixel cases passed on ${result.browserEvidence.product} via ${result.browserEvidence.angleBackend}.`);
