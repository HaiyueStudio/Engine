import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../..');
const shell = resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const windows = { skip: process.platform !== 'win32' };
const run = args => spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
async function artifactTemp(prefix) {
  const directory = resolve(root, 'artifacts/engine-0.2.1/g09');
  await mkdir(directory, { recursive: true }); return mkdtemp(resolve(directory, prefix));
}
test('native Windows PowerShell parses launchers and reports the effective token without starting work', windows, () => {
  const result = run(['-File', resolve(root, 'scripts/start-framegraph-calibration.ps1'), '-CheckPermissions']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  assert.equal(typeof state.administrator, 'boolean');
  assert.equal(state.method, 'WindowsPrincipal.IsInRole(Administrator)');
  assert.match(state.powershellVersion, /^5\./);
  for (const option of ['-Smoke', '-CheckBuild']) {
    const r = run(['-File', resolve(root, 'scripts/start-framegraph-calibration.ps1'), '-CheckPermissions', option]);
    assert.equal(r.status, 1); assert.match(r.stderr, /cannot combine/);
  }
});
test('a stale build fails before a dispatch or sampler can be created', windows, async () => {
  const base = await artifactTemp('v5-stale-entry-test-');
  await mkdir(resolve(base, 'scripts/webgpu-gate'), { recursive: true });
  const script = await readFile(resolve(root, 'scripts/start-framegraph-calibration.ps1'));
  await writeFile(resolve(base, 'scripts/start-framegraph-calibration.ps1'), script);
  for (const file of ['framegraph-build-preflight.ps1', 'framegraph-background-policy.ps1', 'framegraph-desktop-preflight.ps1', 'framegraph-sampling-lease.ps1']) {
    await copyFile(resolve(root, 'scripts/webgpu-gate', file), resolve(base, 'scripts/webgpu-gate', file));
  }
  await writeFile(resolve(base, 'scripts/webgpu-gate/framegraph-launch-permissions.ps1'), 'function Get-G09LaunchPermissionState { @{administrator=$true} }');
  await writeFile(resolve(base, 'scripts/webgpu-gate/check-framegraph-build.mjs'), 'console.log(JSON.stringify({ready:false,error:"G09_BUILD_STALE: injected"})); process.exitCode=1;');
  const r = run(['-File', resolve(base, 'scripts/start-framegraph-calibration.ps1'), '-Smoke', '-NoNotify']);
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /G09_BUILD_STALE/);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(resolve(base, 'artifacts')), false);
});
test('shared lease rejects a duplicate and can be reacquired after disposal', windows, async () => {
  const base = await artifactTemp('v5-lease-test-');
  const fixture = resolve(base, 'lease.ps1');
  const quote = s => s.replaceAll("'", "''");
  await writeFile(fixture, `
$ErrorActionPreference='Stop'
. '${quote(resolve(root, 'scripts/webgpu-gate/framegraph-sampling-lease.ps1'))}'
$lease=Enter-G09MainPassLease '${quote(base)}' '${quote(base)}'
try{try{$duplicate=Enter-G09MainPassLease '${quote(base)}' '${quote(base)}';$duplicate.Dispose();throw 'Duplicate accepted'}catch{if($_.Exception.Message -ne 'G09_ALREADY_RUNNING'){throw}}}finally{$lease.Dispose()}
$next=Enter-G09MainPassLease '${quote(base)}' '${quote(base)}';$next.Dispose();Write-Output 'lease-passed'
`);
  const r = run(['-File', fixture]); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /lease-passed/);
});

test('GPU diagnostic plan keeps the v5 workload and cannot launch baseline work', windows, () => {
  const result = run(['-File', resolve(root, 'scripts/start-framegraph-calibration.ps1'), '-GpuStateDiagnostic', '-Plan']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const plan = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  assert.deepEqual(plan.plan.map(j => j.variant), ['A0', 'B4', 'B4', 'A0', 'A0', 'B4']);
  assert.equal(plan.protocol.cpuWarmup + plan.protocol.cpuSamples, 24000);
  assert.equal(plan.protocol.gpuWarmup + plan.protocol.gpuSamples, 10200);
  assert.equal(plan.config.regressionRatio, .05); assert.equal(plan.createsBaseline, false);
  for (const flag of ['-CheckPermissions', '-CheckBuild', '-PreflightOnly']) {
    const rejected = run(['-File', resolve(root, 'scripts/start-framegraph-calibration.ps1'), '-GpuStateDiagnostic', flag]);
    assert.equal(rejected.status, 1); assert.match(rejected.stderr, /only combines/);
  }
});
