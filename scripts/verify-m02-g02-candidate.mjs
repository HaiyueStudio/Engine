import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateG02CandidateReport,
  verifyG02CandidateArtifacts,
  verifyG02CandidateProvenance,
} from './visual-regression/g02-browser-regression-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(root, 'scripts/visual-regression/g02-candidate-status.json');
const matrix = JSON.parse(readFileSync(resolve(root, 'config/release-matrix.json'), 'utf8'));
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const requireAllDevices = process.argv.includes('--require-all-devices');
const skipArtifacts = process.argv.includes('--skip-artifacts');
const errors = [
  ...validateG02CandidateReport(report, matrix, { requireAllDevices }),
  ...verifyG02CandidateProvenance(root, report),
  ...(skipArtifacts ? [] : verifyG02CandidateArtifacts(root, report)),
];

if (errors.length > 0) {
  throw new Error(`G02 candidate verification failed:\n${errors.map(error => `- ${error}`).join('\n')}`);
}

const handoffs = report.browserMatrix.filter(browser => browser.status === 'device-handoff');
console.log(
  `[g02-candidate] ${report.representativeCases.length} representative cases, `
  + `${report.editorE2E.length} editor flows and ${report.verification.length} gates passed.`,
);
console.log('[g02-candidate] unclassified failures=0; GPU validation errors=0; owner residual=0.');
if (handoffs.length > 0) {
  console.log(
    `[g02-candidate] Device-owned handoff retained for ${handoffs.map(item => item.id).join(', ')} `
    + `to ${handoffs[0].owner}.`,
  );
}
