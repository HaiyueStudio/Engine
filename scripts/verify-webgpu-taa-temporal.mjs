import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { defaultChromePath, defaultWebGpuAngleBackend, runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args], { cwd: root, encoding: 'utf8' }).trim();
const revision = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain']).length > 0;
const sourceFingerprint = createPerformanceSourceFingerprint(root, root);
const result = await runChromeWebGpuFixture({ root, fixture: 'scripts/webgpu-gate/taa-temporal-fixture.html', timeoutMs: 90_000 });
if (createPerformanceSourceFingerprint(root, root) !== sourceFingerprint) throw Error('TAA inputs changed during verification; retry with stable inputs.');
const output = resolve(root, 'artifacts/webgpu/taa-temporal-diagnostic.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify({ ...result, sourceFingerprint, revision, dirty, runner: { platform: process.platform, chromePath: process.env.CHROME_PATH ?? defaultChromePath(), angleBackend: process.env.WEBGPU_ANGLE_BACKEND ?? defaultWebGpuAngleBackend() } }, null, 2)}\n`);
console.log(`[taa-temporal] passed: ${result.cases.length} cases, zero validation errors. ${output}`);
