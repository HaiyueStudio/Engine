const METRICS = Object.freeze([
  ['heapDeltaBytes', 'maxHeapDeltaBytes'],
  ['arrayBufferDeltaBytes', 'maxArrayBufferDeltaBytes'],
  ['rssDeltaBytes', 'maxRssDeltaBytes'],
  ['cleanupHeapResidualBytes', 'maxCleanupHeapResidualBytes'],
  ['cleanupArrayBufferResidualBytes', 'maxCleanupArrayBufferResidualBytes'],
]);

export function validateEditorMemoryBudgetConfig(config) {
  if (!config || config.schemaVersion !== 1 || !isRecord(config.scenarios)) {
    throw new Error('Editor memory budget config must use schemaVersion 1 and define scenarios.');
  }
  for (const [id, scenario] of Object.entries(config.scenarios)) {
    if (!isRecord(scenario.parameters) || !isRecord(scenario.expected) || !isRecord(scenario.limits)) {
      throw new Error(`Editor memory scenario ${id} must define parameters, expected, and limits.`);
    }
    for (const [, limitName] of METRICS) {
      const limit = scenario.limits[limitName];
      if (!Number.isFinite(limit) || limit < 0) {
        throw new Error(`Editor memory scenario ${id} has invalid ${limitName}.`);
      }
    }
  }
  return config;
}

export function evaluateEditorMemoryArtifact(config, artifact) {
  validateEditorMemoryBudgetConfig(config);
  const violations = [];
  if (!artifact || artifact.schemaVersion !== 1 || !Array.isArray(artifact.scenarios)) {
    return { violations: ['Editor memory artifact must use schemaVersion 1 and contain scenarios.'] };
  }
  const actualById = new Map(artifact.scenarios.map(scenario => [scenario.id, scenario]));
  for (const [id, policy] of Object.entries(config.scenarios)) {
    const actual = actualById.get(id);
    if (!actual) {
      violations.push(`Missing editor memory scenario ${id}.`);
      continue;
    }
    for (const [name, expected] of Object.entries(policy.parameters)) {
      if (actual.parameters?.[name] !== expected) {
        violations.push(`${id}.${name} expected ${expected}, received ${actual.parameters?.[name]}.`);
      }
    }
    for (const [name, expected] of Object.entries(policy.expected)) {
      if (actual.observed?.[name] !== expected) {
        violations.push(`${id}.${name} expected ${expected}, received ${actual.observed?.[name]}.`);
      }
    }
    for (const [metric, limitName] of METRICS) {
      const value = actual.metrics?.[metric];
      const limit = policy.limits[limitName];
      if (!Number.isFinite(value)) violations.push(`${id}.${metric} is missing.`);
      else if (value > limit) violations.push(`${id}.${metric} ${value} exceeds ${limitName} ${limit}.`);
    }
  }
  for (const id of actualById.keys()) {
    if (!config.scenarios[id]) violations.push(`Unexpected editor memory scenario ${id}.`);
  }
  return { violations };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
