import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCapabilityAdmissionPolicy } from './capability-admission-policy.mjs';
import { evaluateLightingArchitectureDecision } from './lighting-architecture-decision-policy.mjs';

const root = new URL('../', import.meta.url);
const lightingPolicy = readJson('config/lighting-architecture-policy.json');
const capabilityPolicy = readJson('config/capability-admission-policy.json');
const lighting = evaluateLightingArchitectureDecision(lightingPolicy, {
  lightingScaling: readOptional(lightingPolicy.forwardPlus.scalingEvidencePath
    ?? 'artifacts/webgpu/lighting-scaling.json'),
  forwardPlusEvidence: readOptional(lightingPolicy.forwardPlus.evidencePath),
  csmEvidence: readOptional(lightingPolicy.csm.evidencePath),
});
const capabilities = evaluateCapabilityAdmissionPolicy(capabilityPolicy, {
  webgl2Fallback: readOptional(capabilityPolicy.webgl2Fallback.evidencePath),
  layeredNavMesh: readOptional(capabilityPolicy.layeredNavMesh.evidencePath),
  clippingExtensions: Object.fromEntries(Object.entries(capabilityPolicy.clippingExtensions)
    .map(([feature, policy]) => [feature, readOptional(policy.evidencePath)])),
});

log('Forward+/Clustered', lighting.forwardPlus.status, lighting.forwardPlus.reasons);
log('CSM', lighting.csm.status, lighting.csm.reasons);
log('WebGL2 fallback', capabilities.webgl2Fallback.status, capabilities.webgl2Fallback.reasons);
log('Layered NavMesh', capabilities.layeredNavMesh.status, capabilities.layeredNavMesh.reasons);
for (const [feature, result] of Object.entries(capabilities.clippingExtensions)) {
  log(`Clipping ${feature}`, result.status, result.reasons);
}

const violations = [...lighting.violations, ...capabilities.violations];
if (violations.length > 0) {
  for (const violation of violations) console.error(`[capability-admission] ${violation}`);
  process.exit(1);
}

function log(label, status, reasons) {
  console.log(`[capability-admission] ${label}: ${status} (${reasons.join(', ') || 'evidence complete'})`);
}

function readOptional(path) {
  const absolute = resolve(fileURLToPath(root), path);
  return existsSync(absolute) ? JSON.parse(readFileSync(absolute, 'utf8')) : null;
}

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, root), 'utf8'));
}
