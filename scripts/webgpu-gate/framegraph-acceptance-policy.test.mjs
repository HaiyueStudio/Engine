import test from 'node:test';
import assert from 'node:assert/strict';
import { G09_ACCEPTANCE_CASES, G09_ACCEPTANCE_CONTRACT, createG09AcceptancePlan, compareG09Pixels, validateG09PreflightCoverage } from './framegraph-acceptance-cases.mjs';
import { auditG09Preflight, validateG09ServedInputs } from './framegraph-acceptance-policy.mjs';
const qualification = { targets: ['chrome-windows', 'edge-windows'].map(browserId => ({ browserId, powerPreference: 'high-performance' })) };
const image = (values = [1, .5, .25, 1]) => ({ encoding: 'float32-le-base64', components: values.length, bytes: Buffer.from(Float32Array.from(values).buffer).toString('base64') });
const pixels = (values, key = 'view:0') => [{ key, hdr: image(values), ldr: image(values) }];
const one = { id: 'one', dimensions: [[1, 1]] };
function report() {
  const plan = createG09AcceptancePlan(qualification);
  return { schemaVersion: 1, contractId: G09_ACCEPTANCE_CONTRACT, status: 'passed', tier: 'full',
    performanceQualified: false, g09Complete: false, qualification, plan,
    entries: plan.map(job => ({ job, status: 'passed', raw: { file: 'raw.json', sha256: 'a'.repeat(64) } })),
    pairs: plan.filter(j => j.variant === 'B4' && G09_ACCEPTANCE_CASES.find(c => c.id === j.caseId).pairedPixels)
      .map(job => ({ caseId: job.caseId, browserId: job.browserId, views: [{}] })) };
}
test('registry distinguishes effects-off F0 and covers high-overlap 256 in both algorithms and motion states', () => {
  assert.equal(new Set(G09_ACCEPTANCE_CASES.map(c => c.id)).size, G09_ACCEPTANCE_CASES.length);
  assert.deepEqual([...new Set(G09_ACCEPTANCE_CASES.map(c => c.group))].sort(), Array.from({ length: 9 }, (_, i) => `F${i}`));
  assert.equal(G09_ACCEPTANCE_CASES.filter(c => c.group === 'F1').length, 16);
  assert.equal(G09_ACCEPTANCE_CASES.filter(c => c.group === 'F1' && c.parameters.count === 256 && c.parameters.overlap).length, 4);
  assert.equal(G09_ACCEPTANCE_CASES.filter(c => c.group === 'F0').every(c => c.parameters.effects === 'off'), true);
  assert.equal(G09_ACCEPTANCE_CASES.filter(c => c.fixture === 'deferred-g05-instance').length, 16);
});
test('each native browser has paired old/new production cases; no fake A0 graph internals', () => {
  const plan = createG09AcceptancePlan(qualification);
  for (const browserId of ['chrome-windows', 'edge-windows']) {
    const jobs = plan.filter(j => j.browserId === browserId);
    assert.equal(jobs.filter(j => j.variant === 'A0').length, G09_ACCEPTANCE_CASES.filter(c => !['F6', 'F7'].includes(c.group)).length);
    assert.equal(jobs.filter(j => j.variant === 'B4').length, G09_ACCEPTANCE_CASES.length);
  }
  assert.throws(() => createG09AcceptancePlan(qualification, 'formal'));
});
test('missing, failed, reordered jobs, wrong raw hashes and missing pairs fail closed', () => {
  assert.equal(validateG09PreflightCoverage(report()).g09Complete, false);
  for (const mutate of [r => r.entries.pop(), r => { r.entries[0].status = 'failed'; },
    r => r.entries.reverse(), r => { r.entries[0].raw.sha256 = ''; }, r => r.pairs.pop(), r => r.pairs.reverse()]) {
    const value = report(); mutate(value); assert.throws(() => validateG09PreflightCoverage(value));
  }
});
test('correctness reports cannot promote themselves to full G09 or performance qualification', () => {
  for (const key of ['g09Complete', 'performanceQualified']) {
    const value = report(); value[key] = true; assert.throws(() => validateG09PreflightCoverage(value));
  }
});
test('pixel oracle accepts exact images and rejects black, missing, truncated and changed views', () => {
  assert.equal(compareG09Pixels(pixels(), pixels(), one)[0].failures, 0);
  assert.throws(() => compareG09Pixels(pixels([0, 0, 0, 1]), pixels([0, 0, 0, 1]), one), /Empty/);
  assert.throws(() => compareG09Pixels(pixels(), [], one));
  assert.throws(() => compareG09Pixels(pixels(), pixels(undefined, 'wrong'), one));
  const bad = pixels(); bad[0].hdr.bytes = bad[0].hdr.bytes.slice(1);
  assert.throws(() => compareG09Pixels(pixels(), bad, one), /Truncated/);
});
test('HDR and LDR limits retain slow/failing pixel tails, no tolerant summary substitution', () => {
  const wrongHdr = pixels(); wrongHdr[0].hdr = image([1.003, .5, .25, 1]);
  assert.throws(() => compareG09Pixels(pixels(), wrongHdr, one), /mismatch/);
  const wrongLdr = pixels(); wrongLdr[0].ldr = image([1, .505, .25, 1]);
  assert.throws(() => compareG09Pixels(pixels(), wrongLdr, one), /mismatch/);
  const nan = pixels(); nan[0].ldr = image([NaN, .5, .25, 1]);
  assert.throws(() => compareG09Pixels(pixels(), nan, one), /Nonfinite/);
});
test('mixed view dimensions cannot be replaced by the largest view or lose a view', () => {
  const spec = { id: 'mixed', dimensions: [[1, 1], [2, 1]] };
  const mixed = [...pixels(), { key: 'view:1', hdr: image([1, 1, 1, 1, 1, 1, 1, 1]), ldr: image([1, 1, 1, 1, 1, 1, 1, 1]) }];
  assert.equal(compareG09Pixels(mixed, mixed, spec).length, 2);
  assert.throws(() => compareG09Pixels(mixed, [...pixels(), ...pixels(undefined, 'view:1')], spec), /dimensions/);
});
test('independent audit actually loads raw evidence even if every summary claims passed', async () => {
  let read = false;
  await assert.rejects(auditG09Preflight(report(), async () => { read = true; throw Error('raw bytes changed'); }), /raw bytes changed/);
  assert.equal(read, true);
});
test('a partial viewport keeps a smaller HDR image and the entire display target', () => {
  const spec = { id: 'viewport', dimensions: [[2, 1]], hdrDimensions: [[1, 1]] };
  const values = [{ key: 'view:0', hdr: image(), ldr: image([1, 1, 1, 1, 0, 0, 0, 0]) }];
  assert.equal(compareG09Pixels(values, values, spec)[0].hdrWidth, 1);
  assert.throws(() => compareG09Pixels(values, pixels(), spec), /dimensions/);
});
test('mostly black images cannot qualify by matching each other', () => {
  const values = Array.from({ length: 400 }, (_, i) => i < 36 || i % 4 === 3 ? 1 : 0);
  assert.throws(() => compareG09Pixels(pixels(values), pixels(values), { id: 'room', dimensions: [[10, 10]] }), /insufficient/);
});
test('HTTP provenance cannot substitute the current runtime for A0 or omit the served entry', () => {
  const report = { baseline: { outputs: [{ file: 'fixture.js', sha256: 'a'.repeat(64) }] },
    build: { outputs: [{ file: 'fixture.js', sha256: 'b'.repeat(64) }] }, harness: [{ path: 'scripts/fixture.mjs', sha256: 'c'.repeat(64) }] };
  const raw = { httpProvenance: { transport: 'http', files: [{ sourcePath: 'artifacts/engine-0.2.1/g03/fixture.js', sha256: 'a'.repeat(64) }] } };
  validateG09ServedInputs(raw, { variant: 'A0' }, report);
  assert.throws(() => validateG09ServedInputs(raw, { variant: 'B4' }, report), /runtime differs/);
  raw.httpProvenance.files = [{ sourcePath: 'scripts/fixture.mjs', sha256: 'c'.repeat(64) }];
  assert.throws(() => validateG09ServedInputs(raw, { variant: 'A0' }, report), /entry was not served/);
  raw.httpProvenance.files[0].sha256 = 'a'.repeat(64);
  assert.throws(() => validateG09ServedInputs(raw, { variant: 'A0' }, report), /harness/);
});
test('only the two registered package auxiliary fixtures may consume bound dist bytes', () => {
  const report = { build: { outputs: [{ file: 'fixture.js', sha256: 'a'.repeat(64) }] },
    harness: [{ path: 'scripts/fixture.mjs', sha256: 'c'.repeat(64) }],
    auxiliaryDist: { files: [{ path: 'engine/dist/experimental.js', sha256: 'b'.repeat(64) }] } };
  const raw = { httpProvenance: { transport: 'http', files: [{ sourcePath: 'engine/dist/experimental.js', sha256: 'b'.repeat(64) }] } };
  validateG09ServedInputs(raw, { variant: 'B4', caseId: 'f7-auxiliary-semantics' }, report);
  assert.throws(() => validateG09ServedInputs(raw, { variant: 'B4', caseId: 'f0-forward-1-effects-off' }, report), /package runtime/);
  raw.httpProvenance.files[0].sha256 = 'a'.repeat(64);
  assert.throws(() => validateG09ServedInputs(raw, { variant: 'B4', caseId: 'f7-auxiliary-semantics' }, report), /package runtime/);
});
