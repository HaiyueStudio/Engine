import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireStudioRepository } from '../studio-repository-layout.mjs';
import { validateRayProductCandidateArtifact } from './ray-product-candidate-contract.mjs';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gamesRoot = requireStudioRepository('Games').root;
const formal = process.argv.includes('--formal');
const artifactArgument = process.argv.find(value => value.startsWith('--artifact='));
const artifactPath = resolve(
  engineRoot,
  artifactArgument?.slice('--artifact='.length) ?? 'artifacts/ray-tracing/g09-product-candidates.json',
);
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
const validation = validateRayProductCandidateArtifact(artifact, {
  formal,
  expectedEngineRevision: git(engineRoot, ['rev-parse', 'HEAD']),
  expectedGamesRevision: git(gamesRoot, ['rev-parse', 'HEAD']),
});
if (validation.status !== 'passed') {
  throw new Error(
    `Ray product candidate artifact validation failed (${validation.mode}):\n- `
    + validation.violations.join('\n- '),
  );
}
console.log(
  `[ray-product:artifact] ${validation.mode} passed for ${relative(engineRoot, artifactPath)}.`,
);

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
