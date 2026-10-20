import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runChromeWebGpuFixture } from './chrome-runner.mjs';
import { sha256 } from './deferred-fixture-policy.mjs';
import { parseOutputProbeOptions, validateOutputProbeEvidence } from './multiview-output-probe-policy.mjs';

const options = parseOutputProbeOptions(process.argv.slice(2));
const root = fileURLToPath(new URL('../../', import.meta.url));
const shaderPath = 'engine/src/shaders/generated/postprocess-output.generated.wgsl';
const paths = [shaderPath, 'scripts/webgpu-gate/multiview-output-probe.html',
  'scripts/webgpu-gate/multiview-output-probe.mjs', 'scripts/webgpu-gate/run-multiview-output-probe.mjs',
  'scripts/webgpu-gate/chrome-runner.mjs', 'scripts/webgpu-gate/deferred-fixture-policy.mjs',
  'scripts/webgpu-gate/multiview-output-probe-policy.mjs'];
const fingerprint = async () => Promise.all(paths.map(async path => ({ path, sha256: sha256(await readFile(resolve(root, path))) })));
const inputs = await fingerprint();
const result = await runChromeWebGpuFixture({ root, fixture: 'scripts/webgpu-gate/multiview-output-probe.html',
  query: { powerPreference: options.preference, shaderSha256: inputs[0].sha256, variant: options.variant, frames: options.frames },
  acceptedStatuses: ['passed', 'failed'], timeoutMs: 240000 });
if (JSON.stringify(inputs) !== JSON.stringify(await fingerprint())) throw new Error('Probe source changed during capture.');
if (result.status === 'passed') {
  try { validateOutputProbeEvidence(result, options, inputs[0].sha256); }
  catch (error) { result.status = 'failed'; result.error = error.message; }
}
const directory = resolve(root, 'artifacts/engine-0.2.1/g02');
await mkdir(directory, { recursive: true });
const path = resolve(directory, `output-probe-${options.preference}-${options.variant}.json`);
const generatedAt = new Date().toISOString();
const evidence = JSON.stringify({ schemaVersion: 1, tier: 'diagnostic-output-isolation',
  generatedAt, inputs,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  result }, null, 2) + '\n';
{
  const archivePath = resolve(directory, `output-probe-${options.preference}-${options.variant}-${result.status}-${generatedAt.replaceAll(':', '-')}.json`);
  await writeFile(archivePath, evidence, { flag: 'wx' });
}
await writeFile(path, evidence);
console.log(JSON.stringify({ path, status: result.status, cases: result.cases, failure: result.failure, error: result.error }));
if (result.status !== 'passed') process.exitCode = 1;
