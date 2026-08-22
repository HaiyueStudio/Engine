import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from '../../scripts/webgpu-gate/chrome-runner.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const build = mkdtempSync(join(tmpdir(), 'haiyue-rig-webgpu-'));
if (!build.startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error(`Unsafe rig build directory ${build}`);
try {
  execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--target', 'ESNext', '--module', 'ESNext', '--moduleResolution', 'bundler', '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck', '--types', '@webgpu/types', '--rootDir', resolve(root, 'extensions/src'), '--outDir', build, resolve(root, 'extensions/src/deformable-animation/parameterized/index.ts')], { cwd: root, stdio: 'pipe' });
  const result = await runChromeWebGpuFixture({ root, fixture: 'extensions/test/rig-webgpu-parity-fixture.html', query: { build: '/rig-build' }, mounts: [{ prefix: '/rig-build', directory: build }], timeoutMs: 90_000, acceptedStatuses: ['passed'] });
  if (result.vertexCases !== 12 || result.pixelCases !== 2 || !result.strictValidation) throw new Error(`Invalid rig WebGPU result: ${JSON.stringify(result)}`);
  console.log(`[parameterized-rig:webgpu] ${result.vertexCases} vertex and ${result.pixelCases} raster cases passed on ${result.browserEvidence.product} via ${result.browserEvidence.angleBackend}.`);
} finally { rmSync(build, { recursive: true, force: true }); }
