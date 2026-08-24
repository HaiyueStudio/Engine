import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRiveCorpusManifest } from '../hya-corpus/rive-corpus-contract.mjs';
import { validateRiveG11Candidate } from './rive-g11-candidate-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const formal = process.argv.includes('--formal');
const artifactArgument = process.argv.find(value => value.startsWith('--artifact='));
const artifactPath = resolve(
  root,
  artifactArgument?.slice('--artifact='.length) ?? 'review/candidates/rive-g11-candidate.json',
);
const candidate = JSON.parse(readFileSync(artifactPath, 'utf8'));
const manifestPath = resolve(root, 'animation-spec/corpus/rive/rive-g11-corpus-manifest.json');
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const census = JSON.parse(readFileSync(resolve(root, manifest.census.path), 'utf8'));
const corpusValidation = validateRiveCorpusManifest(manifest, census, { formal, root });
const traces = new Map();
for (const reference of candidate.traceArtifacts ?? []) {
  const path = resolve(root, reference.path);
  traces.set(reference.path, JSON.parse(readFileSync(path, 'utf8')));
}
const validation = validateRiveG11Candidate(candidate, {
  formal,
  expectedEngineRevision: formal
    ? execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    : null,
  expectedManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  manifest,
  tracesByPath: traces,
});
if (corpusValidation.status !== 'passed' || validation.status !== 'passed') {
  const violations = [
    ...corpusValidation.violations.map(value => `corpus: ${value}`),
    ...validation.violations.map(value => `candidate: ${value}`),
  ];
  throw new Error(`Rive G11 candidate validation failed (${validation.mode}):\n- ${violations.join('\n- ')}`);
}
console.log(`[rive-g11] ${validation.mode} contract passed for ${relative(root, artifactPath)}; evidence status=${candidate.status}.`);
