import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createReleaseGateChecks,
  releaseGateSuccessLabel,
  resolveReleaseGateMode,
} from './release-gate-policy.mjs';
import { npmArgs, npmCommand } from './npm-process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = resolveReleaseGateMode(process.argv.slice(2));
const checks = createReleaseGateChecks(mode);
const childEnvironment = mode === 'artifact'
  ? process.env
  : { ...process.env, BENCHMARK_PROFILE: process.env.BENCHMARK_PROFILE ?? 'full' };

for (const args of checks) {
  const command = args[0] === 'exec:node' ? process.execPath : npmCommand();
  const commandArgs = args[0] === 'exec:node' ? args.slice(1) : npmArgs(args);
  console.log(`\n[release-gate] ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    env: childEnvironment,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`[release-gate] ${releaseGateSuccessLabel(mode)} gate passed.`);
