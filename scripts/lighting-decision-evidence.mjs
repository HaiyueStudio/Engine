import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateLightingScalingResult } from './webgpu-gate/lighting-scaling-contract.mjs';

// Architecture diagnostics can use either measurement. Release promotion must
// continue to use check-lighting-release-evidence, which only accepts formal data.
export function loadLightingDecisionEvidence(root, explicitPath) {
  const paths = explicitPath ? [explicitPath] : [
    'artifacts/webgpu/lighting-scaling-diagnostic.json',
    'artifacts/webgpu/lighting-scaling.json',
  ];
  const path = paths.map(path => resolve(root, path)).find(existsSync);
  if (!path) throw new Error('Lighting decision evidence is missing; run node scripts/release-ci-bootstrap.mjs.');
  const result = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateLightingScalingResult(result);
  if (errors.length) throw new Error(`Invalid lighting decision evidence at ${path}: ${errors.join('; ')}`);
  return result;
}
