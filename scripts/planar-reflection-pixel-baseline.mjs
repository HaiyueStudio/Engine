const defaultPolicy = Object.freeze({
  hash: 'diagnostic-only',
  nonBlackPixelsRelativeTolerance: 0.02,
  averageLuminanceTolerance: 1,
  sampleChannelTolerance: 2,
});

export function createPlanarReflectionPixelBaseline(result) {
  const cases = {};
  for (const [id, item] of Object.entries(result.pixelCases ?? {})) {
    cases[id] = {
      width: item.width,
      height: item.height,
      hash: item.hash,
      nonBlackPixels: item.nonBlackPixels,
      averageLuminance: item.averageLuminance,
      samples: item.samples,
      mirrorStats: item.mirrorStats,
    };
  }
  return {
    schemaVersion: 2,
    fixture: 'render3d.planar-reflection',
    policy: { ...defaultPolicy },
    cases,
  };
}

export function comparePlanarReflectionPixelBaseline(result, baseline) {
  if (baseline.schemaVersion !== 2 || baseline.fixture !== 'render3d.planar-reflection') {
    return { status: 'failed', violations: ['pixel baseline schema/fixture is invalid'], hashMismatches: [] };
  }
  const policy = { ...defaultPolicy, ...baseline.policy };
  const currentCases = result.pixelCases ?? {};
  const violations = [];
  const hashMismatches = [];
  const currentIds = Object.keys(currentCases).sort();
  const baselineIds = Object.keys(baseline.cases ?? {}).sort();
  if (JSON.stringify(currentIds) !== JSON.stringify(baselineIds)) {
    violations.push(`case set ${currentIds.join(',')} != ${baselineIds.join(',')}`);
  }
  for (const id of baselineIds) {
    const expected = baseline.cases[id];
    const current = currentCases[id];
    if (!current) continue;
    if (current.width !== expected.width || current.height !== expected.height) {
      violations.push(`${id}: dimensions ${current.width}x${current.height} != ${expected.width}x${expected.height}`);
    }
    const pixelTolerance = Math.max(1, Math.round(expected.nonBlackPixels * policy.nonBlackPixelsRelativeTolerance));
    if (Math.abs(current.nonBlackPixels - expected.nonBlackPixels) > pixelTolerance) {
      violations.push(`${id}: nonBlackPixels ${current.nonBlackPixels} outside ${expected.nonBlackPixels}±${pixelTolerance}`);
    }
    if (Math.abs(current.averageLuminance - expected.averageLuminance) > policy.averageLuminanceTolerance) {
      violations.push(`${id}: averageLuminance ${current.averageLuminance} outside ${expected.averageLuminance}±${policy.averageLuminanceTolerance}`);
    }
    compareSamples(id, current.samples, expected.samples, policy.sampleChannelTolerance, violations);
    if (JSON.stringify(current.mirrorStats) !== JSON.stringify(expected.mirrorStats)) {
      violations.push(`${id}: mirror planner/culling statistics changed`);
    }
    if (current.hash !== expected.hash) {
      hashMismatches.push({ id, expected: expected.hash, actual: current.hash });
    }
  }
  return {
    status: violations.length === 0 ? 'passed' : 'failed',
    policy,
    violations,
    hashMismatches,
  };
}

function compareSamples(id, current = {}, expected = {}, tolerance, violations) {
  const currentNames = Object.keys(current).sort();
  const expectedNames = Object.keys(expected).sort();
  if (JSON.stringify(currentNames) !== JSON.stringify(expectedNames)) {
    violations.push(`${id}: sample point set changed`);
    return;
  }
  for (const name of expectedNames) {
    const actualChannels = current[name] ?? [];
    const expectedChannels = expected[name] ?? [];
    if (actualChannels.length !== expectedChannels.length) {
      violations.push(`${id}.${name}: sample channel count changed`);
      continue;
    }
    for (let index = 0; index < expectedChannels.length; index++) {
      if (Math.abs(actualChannels[index] - expectedChannels[index]) > tolerance) {
        violations.push(`${id}.${name}[${index}]: ${actualChannels[index]} outside ${expectedChannels[index]}±${tolerance}`);
      }
    }
  }
}
