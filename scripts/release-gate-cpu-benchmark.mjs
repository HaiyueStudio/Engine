import { existsSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateReleaseBenchmarkArtifact } from './benchmark/cpu-benchmark-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArguments(process.argv.slice(2));
const artifactPath = resolve(root, options.artifact ?? process.env.CPU_BENCHMARK_ARTIFACT ?? 'artifacts/benchmarks/haiyue-benchmark-v3.json');
const runnerProfile = options.runnerProfile ?? process.env.CPU_BENCHMARK_RUNNER_PROFILE;

if (!runnerProfile) {
  fail(['CPU_BENCHMARK_RUNNER_PROFILE or --runner-profile is required for a release candidate.']);
}
if (!existsSync(artifactPath)) {
  fail([`CPU benchmark artifact is missing: ${relative(root, artifactPath)}`]);
}

const revision = git(['rev-parse', 'HEAD']);
const currentDirty = git(['status', '--porcelain']).trim().length > 0;
const report = JSON.parse(readFileSync(artifactPath, 'utf8'));
const validation = validateReleaseBenchmarkArtifact(report, {
  revision,
  runnerProfile,
  benchmarkProfile: options.profile ?? process.env.BENCHMARK_PROFILE ?? 'full',
  node: process.version,
  v8: process.versions.v8,
  platform: process.platform,
  arch: process.arch,
  cpu: cpus()[0]?.model ?? 'unknown',
});
if (currentDirty) validation.violations.push('Release candidate worktree is dirty.');
if (validation.violations.length > 0) validation.status = 'failed';
if (validation.status !== 'passed') fail(validation.violations);

console.log(
  `[release-gate] Revision-bound CPU benchmark passed for ${runnerProfile} `
  + `at ${revision.slice(0, 12)} (${relative(root, artifactPath)}).`,
);

function parseArguments(argv) {
  const parsed = { artifact: null, runnerProfile: null, profile: null };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--artifact') parsed.artifact = requiredValue(argv, ++index, argument);
    else if (argument === '--runner-profile') parsed.runnerProfile = requiredValue(argv, ++index, argument);
    else if (argument === '--profile') parsed.profile = requiredValue(argv, ++index, argument);
    else throw new Error(`Unknown CPU benchmark evidence argument "${argument}".`);
  }
  return parsed;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed.`);
  return result.stdout.trim();
}

function fail(violations) {
  for (const violation of violations) console.error(`[release-gate] CPU benchmark evidence: ${violation}`);
  process.exit(1);
}
