import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateEditorMemoryArtifact,
  validateEditorMemoryBudgetConfig,
} from './editor-memory-budget-policy.mjs';

const config = {
  schemaVersion: 1,
  scenarios: {
    fixture: {
      parameters: { count: 2 },
      expected: { retained: 1 },
      limits: {
        maxHeapDeltaBytes: 10,
        maxArrayBufferDeltaBytes: 10,
        maxRssDeltaBytes: 10,
        maxCleanupHeapResidualBytes: 10,
        maxCleanupArrayBufferResidualBytes: 10,
      },
    },
  },
};

test('editor memory policy accepts matching bounded evidence', () => {
  validateEditorMemoryBudgetConfig(config);
  assert.deepEqual(evaluateEditorMemoryArtifact(config, {
    schemaVersion: 1,
    scenarios: [{
      id: 'fixture',
      parameters: { count: 2 },
      observed: { retained: 1 },
      metrics: {
        heapDeltaBytes: 9,
        arrayBufferDeltaBytes: 0,
        rssDeltaBytes: 8,
        cleanupHeapResidualBytes: 1,
        cleanupArrayBufferResidualBytes: 0,
      },
    }],
  }).violations, []);
});

test('editor memory policy rejects scenario drift, retention errors, and budget overflow', () => {
  const result = evaluateEditorMemoryArtifact(config, {
    schemaVersion: 1,
    scenarios: [{
      id: 'fixture',
      parameters: { count: 3 },
      observed: { retained: 2 },
      metrics: {
        heapDeltaBytes: 11,
        arrayBufferDeltaBytes: 0,
        rssDeltaBytes: 0,
        cleanupHeapResidualBytes: 0,
        cleanupArrayBufferResidualBytes: 0,
      },
    }],
  });
  assert.equal(result.violations.length, 3);
  assert.match(result.violations.join('\n'), /fixture\.count/);
  assert.match(result.violations.join('\n'), /fixture\.retained/);
  assert.match(result.violations.join('\n'), /maxHeapDeltaBytes/);
});
