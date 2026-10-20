/** Pure validation shared by browser evidence and policy tests; it does not admit performance claims. */
export function validateInspectorCapture(snapshot) {
  const errors = [];
  if (snapshot?.schemaVersion !== 1 || snapshot?.scope !== 'selected-system-command-context') errors.push('unsupported capture contract');
  if (snapshot?.status !== 'submitted' || snapshot?.error !== null) errors.push('capture did not submit successfully');
  if (snapshot?.truncated !== false) errors.push('capture was truncated');
  for (const key of ['gpuReadbacks', 'extraPasses', 'retainedGpuBytes']) if (snapshot?.overhead?.[key] !== 0) errors.push(`observer changed ${key}`);
  for (const key of ['renderPasses', 'computePasses', 'drawCalls', 'dispatchCalls', 'bundleExecutions', 'copies', 'resolves', 'submissions']) {
    const value = snapshot?.work?.[key]; if (!Number.isSafeInteger(value) || value < 0) errors.push(`invalid encoded ${key}`);
  }
  if (snapshot?.work?.submissions !== 1) errors.push('expected one observed submission');
  for (const allocation of snapshot?.allocations ?? []) {
    if (allocation.intervalScope !== 'allocation-local') errors.push('ambiguous lifetime scope');
    for (const m of allocation.mappings) if (m.lastUse < m.firstUse || !m.descriptor || !m.decision) errors.push('incomplete physical mapping');
  }
  for (const pool of snapshot?.pools ?? []) if (pool.counters.pendingPeakBytes < pool.counters.pendingBytes) errors.push('invalid pending high water');
  return errors;
}

/** Separate leases may reuse a pool texture after release; their local intervals are not a global axis. */
export function findSequentialPoolReuses(snapshot, owner) {
  const slots = new Map();
  for (const a of snapshot.allocations.filter(a => a.owner === owner)) for (const m of a.mappings) {
    const key = `${a.pool}:${m.physicalId}`;
    const batches = slots.get(key) ?? new Set(); batches.add(a.id); slots.set(key, batches);
  }
  return [...slots].filter(([, batches]) => batches.size > 1).map(([physical, batches]) => ({ physical, batches: [...batches] }));
}
