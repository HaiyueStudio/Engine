import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { defaultChromePath, defaultWebGpuAngleBackend, runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args], { cwd: root, encoding: 'utf8' }).trim();
const revision = git(['rev-parse', 'HEAD']), dirty = git(['status', '--porcelain']).length > 0;
const sourceFingerprint = createPerformanceSourceFingerprint(root, root);
const result = await runChromeWebGpuFixture({ root, fixture: 'scripts/webgpu-gate/view-light-selection-fixture.html', timeoutMs: 60_000 });
if (createPerformanceSourceFingerprint(root, root) !== sourceFingerprint) throw Error('View light selection inputs changed during verification.');
const output = resolve(root, 'artifacts/webgpu/view-light-selection-diagnostic.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify({ format: 'haiyue-view-light-selection-diagnostic@1', schemaVersion: 1,
  generatedAt: new Date().toISOString(), ...result, revision, dirty, sourceFingerprint, runner: {
  script: 'scripts/verify-webgpu-view-light-selection.mjs',
  platform: process.platform, chromePath: process.env.CHROME_PATH ?? defaultChromePath(), angleBackend: process.env.WEBGPU_ANGLE_BACKEND ?? defaultWebGpuAngleBackend(),
} }, null, 2)}\n`);
console.log(`[view-light-selection] passed: ${result.cases.length} cases. ${output}`);
