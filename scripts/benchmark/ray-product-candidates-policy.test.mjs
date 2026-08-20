import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const verifierUrl = new URL('./verify-ray-product-candidates.mjs', import.meta.url);

test('ray product candidates retain split-repository identity and profile cleanup evidence', async () => {
  const source = await readFile(verifierUrl, 'utf8');

  assert.match(source, /requireStudioRepository\('Games'\)\.root/u);
  assert.match(source, /browserDiagnostics:\s*Object\.freeze/u);
  assert.match(source, /profileCleanup\?\.status !== 'passed'/u);
  assert.match(source, /artifacts\/ray-tracing\/g09-product-candidates\.json/u);
  assert.match(source, /const engineDirty = git\(engineRoot/u);
  assert.match(source, /const gamesDirty = git\(gamesRoot/u);
  assert.match(source, /validateRayProductCandidateArtifact\(report/u);
  assert.match(source, /requireCrossBrowserDeterminism\(browserReports\)/u);
  assert.match(source, /baseline\.sourceSha256 !== candidate\.sourceSha256/u);
  assert.match(source, /baseline\.candidateSha256 !== candidate\.candidateSha256/u);
  assert.doesNotMatch(source, /resolve\(engineRoot, '\.\.\/Games'\)/u);
});
