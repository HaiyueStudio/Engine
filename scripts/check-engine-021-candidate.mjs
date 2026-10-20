import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sha256, deferredRuntimeFingerprint } from './webgpu-gate/deferred-fixture-policy.mjs';
import { validateEngine021CandidateLock, validateEngine021FreshQualification } from './engine-021-candidate-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const mode = process.argv[2];
if (process.argv.length !== 3 || !['--plan', '--require-evidence'].includes(mode)) throw Error('Use --plan or --require-evidence');
const read = path => readFile(resolve(root, path), 'utf8');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const scopeBytes = await read('review/engine-0.2.1/release-candidate.json'), config = JSON.parse(scopeBytes);
const lock = JSON.parse(await read('artifacts/engine-0.2.1/candidate-lock.json'));
const current = { revision: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--porcelain']),
  candidateManifestSha256: sha256(scopeBytes), runtime: await deferredRuntimeFingerprint(root) };
validateEngine021CandidateLock(config, lock, current);
if (mode === '--require-evidence') {
  let manifest;
  try { manifest = JSON.parse(await read('artifacts/engine-0.2.1/qualification.json')); }
  catch (error) {
    if (error.code === 'ENOENT') throw Error('[EVIDENCE_REQUIRED] Capture seven fresh complete reports for this Toast candidate; the old 55feff1 bundle remains historical.');
    throw error;
  }
  validateEngine021FreshQualification(manifest, current.revision, lock.captureRevision ?? lock.revision);
}
console.log(JSON.stringify({ status: 'passed', scope: 'candidate lock and fresh report bindings only; full raw evidence and release gates remain required',
  version: '0.2.1', revision: current.revision, includesToast: true,
  freshReportsRequired: config.qualification.requiredKinds, published: false }, null, 2));
