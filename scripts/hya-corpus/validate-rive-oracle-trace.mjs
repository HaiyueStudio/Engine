import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRiveOracleTrace } from './rive-oracle-trace-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const formal = process.argv.includes('--formal');
const traceArgument = process.argv.find(value => value.startsWith('--trace='));
if (!traceArgument) throw new Error('Usage: node scripts/hya-corpus/validate-rive-oracle-trace.mjs --trace=<artifact.json> [--formal]');
const tracePath = resolve(root, traceArgument.slice('--trace='.length));
const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
const manifestBytes = readFileSync(resolve(root, 'animation-spec/corpus/rive/rive-g11-corpus-manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const workloadPlan = JSON.parse(readFileSync(safePath(manifest.workloadPlan.path), 'utf8'));
const artifactBytesByPath = new Map();
for (const path of artifactPaths(trace)) artifactBytesByPath.set(path, readFileSync(safePath(path)));
for (const capture of [trace?.official, trace?.hya]) {
  const pixels = capture?.channels?.pixels;
  if (!pixels?.path) continue;
  const artifact = JSON.parse(artifactBytesByPath.get(pixels.path).toString('utf8'));
  for (const sample of artifact?.samples ?? []) {
    const path = sample?.value?.rgba?.path;
    if (path && !artifactBytesByPath.has(path)) artifactBytesByPath.set(path, readFileSync(safePath(path)));
  }
}
const validation = validateRiveOracleTrace(trace, {
  formal,
  expectedRevision: formal
    ? execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    : null,
  expectedManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  workloadPlan,
  artifactBytesByPath,
});
if (validation.status !== 'passed') {
  throw new Error(`Rive oracle trace validation failed (${validation.mode}):\n- ${validation.violations.join('\n- ')}`);
}
console.log(`[rive-oracle] ${validation.mode} passed for ${relative(root, tracePath)}.`);

function artifactPaths(value) {
  const output = new Set();
  if (value?.scenarioArtifact?.path) output.add(value.scenarioArtifact.path);
  for (const capture of [value?.official, value?.hya]) {
    for (const item of Object.values(capture?.channels ?? {})) if (item?.path) output.add(item.path);
  }
  for (const comparison of Object.values(value?.comparison?.channels ?? {})) if (comparison?.artifact?.path) output.add(comparison.artifact.path);
  return output;
}

function safePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.includes('\\') || relativePath.startsWith('/') || /^[A-Za-z]:/u.test(relativePath)) throw new Error(`Artifact path must be relative POSIX: ${String(relativePath)}`);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Artifact path escapes repository root: ${relativePath}`);
  return path;
}
