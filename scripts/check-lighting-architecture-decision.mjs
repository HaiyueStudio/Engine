import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateLightingArchitectureDecision } from './lighting-architecture-decision-policy.mjs';

const root = new URL('../', import.meta.url);
const policy = readJson(new URL('config/lighting-architecture-policy.json', root));
const result = evaluateLightingArchitectureDecision(policy, {
  lightingScaling: readOptional(policy.forwardPlus.scalingEvidencePath ?? 'artifacts/webgpu/lighting-scaling.json'),
  forwardPlusEvidence: readOptional(policy.forwardPlus.evidencePath),
  csmEvidence: readOptional(policy.csm.evidencePath),
});
console.log(
  `[lighting-architecture] Forward+: ${result.forwardPlus.status}; product=${result.forwardPlus.productStatus} `
  + `(${[...result.forwardPlus.reasons, ...result.forwardPlus.productReasons].join(', ') || 'evidence complete'})`,
);
console.log(`[lighting-architecture] CSM: ${result.csm.status} (${result.csm.reasons.join(', ') || 'evidence complete'})`);
if (result.violations.length > 0) {
  for (const violation of result.violations) console.error(`[lighting-architecture] ${violation}`);
  process.exit(1);
}

function readOptional(path) {
  const absolute = resolve(fileURLToPath(root), path);
  return existsSync(absolute) ? JSON.parse(readFileSync(absolute, 'utf8')) : null;
}

function readJson(url) {
  return JSON.parse(readFileSync(url, 'utf8'));
}
