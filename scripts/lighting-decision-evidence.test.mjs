import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadLightingDecisionEvidence } from './lighting-decision-evidence.mjs';
import { validateLightingReleaseEvidence } from './release-platform-policy.mjs';
import { passingForwardResult } from './webgpu-gate/lighting-scaling-test-fixture.mjs';

test('architecture checks work with diagnostic-only evidence without promoting it', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'lighting-decision-'));
  const directory = resolve(root, 'artifacts/webgpu');
  mkdirSync(directory, { recursive: true });
  const diagnostic = resolve(directory, 'lighting-scaling-diagnostic.json');
  const formal = resolve(directory, 'lighting-scaling.json');
  const value = passingForwardResult();
  try {
    assert.throws(() => loadLightingDecisionEvidence(root), /missing/);
    writeFileSync(diagnostic, JSON.stringify(value));
    assert.deepEqual(loadLightingDecisionEvidence(root), value);
    const matrix = JSON.parse(readFileSync(new URL('../config/release-matrix.json', import.meta.url)));
    assert.ok(validateLightingReleaseEvidence(value, matrix, value.releaseEvidence).length);
    writeFileSync(formal, JSON.stringify(value));
    rmSync(diagnostic);
    assert.deepEqual(loadLightingDecisionEvidence(root), value);
    writeFileSync(diagnostic, '{}');
    assert.throws(() => loadLightingDecisionEvidence(root), /Invalid lighting/);
    assert.throws(() => loadLightingDecisionEvidence(root, 'missing.json'), /missing/);
    assert.deepEqual(loadLightingDecisionEvidence(root, 'artifacts/webgpu/lighting-scaling.json'), value);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
