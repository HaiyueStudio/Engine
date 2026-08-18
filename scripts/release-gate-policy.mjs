const FULL_CORRECTNESS_CHECKS = Object.freeze([
  Object.freeze(['run', 'check:fast']),
  Object.freeze(['run', 'check:slow', '--', '--content-tier=full']),
  Object.freeze(['run', 'verify:webgpu-readback:long']),
]);

const ARTIFACT_CHECKS = Object.freeze([
  Object.freeze(['run', 'render-product:check']),
  Object.freeze(['run', 'api:check']),
  Object.freeze(['run', 'build:engine']),
  Object.freeze(['run', 'build:extensions']),
  Object.freeze(['run', 'build:editor']),
]);

export function resolveReleaseGateMode(argv) {
  const requested = new Set();
  if (argv.includes('--artifact')) requested.add('artifact');
  if (argv.includes('--local')) requested.add('local');
  if (argv.includes('--global') || argv.includes('--full')) requested.add('global');
  if (requested.size > 1) {
    throw new Error('Choose exactly one release gate mode: --artifact, --local, or --global.');
  }
  return requested.values().next().value ?? 'global';
}

export function createReleaseGateChecks(mode) {
  if (!['artifact', 'local', 'global'].includes(mode)) {
    throw new RangeError(`Unknown release gate mode "${mode}".`);
  }
  const checks = (mode === 'artifact' ? ARTIFACT_CHECKS : FULL_CORRECTNESS_CHECKS)
    .map(args => [...args]);
  checks.push([
    'exec:node',
    'scripts/inspect-release-artifacts.mjs',
    ...(mode === 'artifact' ? [] : ['--release']),
  ]);
  if (mode === 'local' || mode === 'global') checks.push(['run', 'performance:compare:formal']);
  return checks;
}

export function releaseGateSuccessLabel(mode) {
  if (mode === 'artifact') return 'Artifact';
  if (mode === 'local') return 'Local-device candidate';
  return 'Global release candidate';
}
