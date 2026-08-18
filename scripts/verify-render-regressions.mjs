import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const typecheckTimeoutMs = environmentDuration('RENDER_TYPECHECK_TIMEOUT_MS', 300_000);
const engineBuildTimeoutMs = environmentDuration('RENDER_ENGINE_BUILD_TIMEOUT_MS', 180_000);
const exampleBuildTimeoutMs = environmentDuration('RENDER_EXAMPLE_BUILD_TIMEOUT_MS', 120_000);

const manifest = JSON.parse(readFileSync(new URL('../examples/manifest.json', import.meta.url), 'utf8'));
const renderTargets = manifest.entries.filter(entry =>
  entry.screenshot?.required
  || entry.capabilities.includes('render-pipeline')
  || entry.capabilities.includes('gui')
  || entry.capabilities.includes('2d'),
);
const commands = [
  { cmd: 'npm run typecheck', timeout: typecheckTimeoutMs },
  { cmd: 'npm run build:engine', timeout: engineBuildTimeoutMs },
  {
    cmd: 'npm run build -w ./examples',
    env: { EXAMPLE_SHELL_ONLY: '1' },
    timeout: exampleBuildTimeoutMs,
  },
  ...renderTargets.map(entry => ({
    cmd: 'npm run build -w ./examples',
    env: { EXAMPLE_FILTER: entry.id, EXAMPLE_SKIP_SOURCE_VIEWER: '1' },
    timeout: exampleBuildTimeoutMs,
  })),
];

for (const { cmd, env = {}, timeout } of commands) {
  const filter = env.EXAMPLE_FILTER ? ` EXAMPLE_FILTER=${env.EXAMPLE_FILTER}` : '';
  console.log(`\n> ${cmd}${filter}`);
  const result = spawnSync(cmd, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: 'pipe',
    shell: true,
    timeout,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function environmentDuration(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}
