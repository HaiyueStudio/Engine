import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRayG10ReviewManifest } from './ray-g10-review-contract.mjs';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const options = parseOptions(process.argv.slice(2));
const manifestPath = resolve(engineRoot, options.manifest);
const reviewDirectory = dirname(manifestPath);
const receiptPath = resolve(reviewDirectory, 'approval.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const captureFiles = new Map(manifest.captures.map(capture => [
  capture.file,
  readFileSync(resolve(reviewDirectory, capture.file)),
]));
const pendingValidation = validateRayG10ReviewManifest(manifest, { captureFiles });
if (pendingValidation.status !== 'passed') fail('Review candidate is invalid', pendingValidation.violations);
if (manifest.humanReview?.status !== 'pending') throw new Error('Review candidate must be pending before approval is applied.');

const captureSetSha256 = hashCaptureSet(manifest.captures);
let receipt;
if (options.reuse) {
  if (!existsSync(receiptPath)) throw new Error(`Approval receipt is missing: ${receiptPath}`);
  receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (receipt.captureSetSha256 !== captureSetSha256) {
    throw new Error(`Capture set changed since human review: expected ${receipt.captureSetSha256}, received ${captureSetSha256}.`);
  }
} else {
  if (!options.reviewer) throw new Error('--reviewer=<identity> is required for a new approval.');
  if (existsSync(receiptPath)) throw new Error('Approval receipt already exists; use --reuse only when the capture set is unchanged.');
  receipt = {
    format: 'haiyue-ray-tracing-g10-human-review-approval@1',
    captureSetSha256,
    reviewer: options.reviewer,
    reviewedAt: new Date().toISOString(),
    source: 'explicit project-owner confirmation in the Codex task',
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

manifest.humanReviewStatus = 'approved';
manifest.humanReview = {
  status: 'approved',
  reviewer: receipt.reviewer,
  reviewedAt: receipt.reviewedAt,
  checks: manifest.requiredHumanReview.map(id => ({
    id,
    status: 'approved',
    notes: 'Approved against the exact capture set recorded by approval.json.',
  })),
};
manifest.validation = validateRayG10ReviewManifest(manifest, { captureFiles });
if (manifest.validation.status !== 'passed') fail('Approved review manifest is invalid', manifest.validation.violations);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `[ray-g10-review] approval applied to ${relative(engineRoot, manifestPath)}; captureSetSha256=${captureSetSha256}.`,
);

function parseOptions(args) {
  const parsed = {
    manifest: 'artifacts/ray-tracing-g10-review/manifest.json',
    reviewer: null,
    reuse: false,
  };
  for (const argument of args) {
    if (argument === '--reuse') parsed.reuse = true;
    else if (argument.startsWith('--reviewer=')) parsed.reviewer = argument.slice('--reviewer='.length).trim();
    else if (argument.startsWith('--manifest=')) parsed.manifest = argument.slice('--manifest='.length);
    else throw new Error(`Unknown G10 review approval option ${argument}.`);
  }
  if (parsed.reuse && parsed.reviewer) throw new Error('--reuse and --reviewer cannot be combined.');
  return parsed;
}

function hashCaptureSet(captures) {
  const identity = captures
    .map(capture => ({ id: capture.id, file: capture.file, sha256: capture.sha256 }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function fail(label, violations) {
  throw new Error(`${label}:\n- ${violations.join('\n- ')}`);
}
