import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from '../../scripts/webgpu-gate/chrome-runner.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url))), build = mkdtempSync(join(tmpdir(), 'haiyue-layout-webgpu-'));
if (!build.startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error(`Unsafe layout build directory ${build}`);
try {
  execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--target', 'ESNext', '--module', 'ESNext', '--moduleResolution', 'bundler', '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck', '--types', '@webgpu/types', '--rootDir', resolve(root, 'extensions/src'), '--outDir', build, resolve(root, 'extensions/src/animation/layout/parameterized/index.ts')], { cwd: root, stdio: 'pipe' });
  const result = await runChromeWebGpuFixture({ root, fixture: 'extensions/test/layout-webgpu-parity-fixture.html', query: { build: '/layout-build' }, mounts: [{ prefix: '/layout-build', directory: build }], timeoutMs: 90_000, acceptedStatuses: ['passed'] });
  if (result.pixelCases !== 2 || !result.strictValidation || result.recoveredGeneration !== 7) throw new Error(`Invalid layout WebGPU result: ${JSON.stringify(result)}`);
  console.log(`[responsive-layout:webgpu] ${result.pixelCases} raster cases passed on ${result.browserEvidence.product} via ${result.browserEvidence.angleBackend}.`);
} finally { rmSync(build, { recursive: true, force: true }); }
