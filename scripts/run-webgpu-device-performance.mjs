import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = mkdtempSync(resolve(tmpdir(), 'haiyue-device-performance-'));
const fixtureArgs = process.argv.includes('--smoke') ? [] : ['--long'];

try {
  for (const path of [
    'engine/dist',
    'scripts/benchmark',
    'scripts/webgpu-gate',
    'node_modules/wgpu-matrix/dist/3.x/wgpu-matrix.module.js',
  ]) {
    const target = resolve(snapshot, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(root, path), target, { recursive: true, errorOnExist: true });
  }
  const env = {
    ...process.env,
    WEBGPU_BENCHMARK_ROOT: snapshot,
    WEBGPU_ENFORCE_DEVICE_PERFORMANCE_BUDGETS: '1',
  };
  for (const [script, args] of [
    ['scripts/verify-webgpu-real-renderer-benchmark.mjs', fixtureArgs],
    ['scripts/verify-webgpu-planar-reflection.mjs', fixtureArgs],
    ['scripts/verify-ambient-occlusion-gpu-cost.mjs', process.argv.includes('--smoke') ? ['--smoke'] : []],
  ]) {
    const result = spawnSync(process.execPath, [resolve(root, script), ...args], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(snapshot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
