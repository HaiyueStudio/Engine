import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  candidateProfileRoot,
  PERFORMANCE_CANDIDATE_FILES,
  validateCandidateProfileFromDisk,
} from './performance-candidate-policy.mjs';
import { loadPerformanceBudgetConfig } from './webgpu-performance-budget.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadPerformanceBudgetConfig(root);
const requestedProfile = argumentValue('--profile') || process.env.WEBGPU_DEVICE_PROFILE;
if (!requestedProfile || !config.profiles[requestedProfile]) {
  throw new Error('--profile must name a registered performance profile.');
}
const report = validateCandidateProfileFromDisk(root, config, requestedProfile);
const output = resolve(
  root,
  candidateProfileRoot(config, requestedProfile),
  PERFORMANCE_CANDIDATE_FILES.report,
);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

if (report.gate.status !== 'passed') {
  console.error(`[performance-candidate] ${requestedProfile} is blocked:`);
  for (const violation of report.gate.violations) console.error(`- ${violation}`);
  console.error(`[performance-candidate] Wrote ${relative(root, output)}.`);
  process.exit(1);
}
console.log(
  `[performance-candidate] ${requestedProfile} full candidate passed; `
  + `formal baselines unchanged; report=${relative(root, output)}.`,
);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}
