import test from 'node:test';
import assert from 'node:assert/strict';

import { getEngineDiagnosticsSnapshot } from '../dist/diagnostics.js';
import {
  FrameDiagnostics,
  GPUResourceTracker,
  registerEngineDiagnostics,
} from '../dist/experimental.js';

test('stable diagnostics returns a frozen disabled snapshot for unregistered engines', () => {
  const snapshot = getEngineDiagnosticsSnapshot({});
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.frame.enabled, false);
  assert.deepEqual(snapshot.gpuResources.totals, { resources: 0, estimatedBytes: 0 });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.frame.cpuMs), true);
  assert.equal(Object.isFrozen(snapshot.gpuResources.byType), true);
});

test('stable diagnostics exposes aggregates without mutable tracker internals', () => {
  let now = 10;
  const frameDiagnostics = new FrameDiagnostics({ enabled: true, now: () => now });
  const resourceTracker = new GPUResourceTracker({ debug: true, frameDiagnostics });
  const engine = {};
  registerEngineDiagnostics(engine, { frameDiagnostics, resourceTracker });
  frameDiagnostics.beginFrame(7);
  now = 12.5;
  frameDiagnostics.addDuration('update', 2.5);
  frameDiagnostics.increment('draws', 3);

  const snapshot = getEngineDiagnosticsSnapshot(engine);
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.frame.frame, 7);
  assert.equal(snapshot.frame.cpuMs.update, 2.5);
  assert.equal(snapshot.frame.counters.draws, 3);
  assert.deepEqual(Object.keys(snapshot.gpuResources).sort(), [
    'byType',
    'cacheCount',
    'enabled',
    'frame',
    'ownerCount',
    'releasedOwnerResiduals',
    'totals',
  ]);
  assert.equal('resources' in snapshot.gpuResources, false);
  assert.equal('owners' in snapshot.gpuResources, false);
  assert.equal('caches' in snapshot.gpuResources, false);
  assert.equal('reset' in snapshot.gpuResources, false);
});
