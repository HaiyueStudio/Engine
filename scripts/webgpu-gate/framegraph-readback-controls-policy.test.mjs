import test from 'node:test';
import assert from 'node:assert/strict';
import { controlWords, controlRgba, decodeBgraRows, assessReadbackControls, classifyAtomicReadback } from './framegraph-readback-controls-policy.mjs';
import { parseFrameGraphBlackFrameOptions } from './framegraph-black-frame-policy.mjs';
const controls = () => ({ buffer: controlWords(), textureCompute: controlRgba().map(v => v / 255),
  textureCopy: controlRgba().map(v => v / 255), witness: [4660, 5, 64, 64, 22136, 5, 64, 64] });
const capture = () => ({ computed: Array(16384).fill(.5), copied: Array(16384).fill(.5), copySource: true,
  atomicReadback: { schemaVersion: 1, submissions: 1, frameId: 5, access: 'native',
    resourcesRetainedUntilAllMapsSettled: true, mapErrors: [], controls: controls() } });
test('same-submission mode keeps full cohort and rejects combined experimental substitutions', () => {
  assert.deepEqual(parseFrameGraphBlackFrameOptions(['--readback=atomic']), { coverage: 'production', readback: 'atomic' });
  for (const args of [['--readback=unknown'], ['--readback=atomic', '--integrated'], ['--readback=atomic', '--coverage=arithmetic-chain']])
    assert.throws(() => parseFrameGraphBlackFrameOptions(args));
});
test('known-answer controls reject zeros, untouched sentinels, one-word errors and stale frame IDs', () => {
  assert.equal(assessReadbackControls(controls(), 5).status, 'passed');
  for (const key of ['buffer', 'textureCompute', 'textureCopy', 'witness']) {
    for (const replacement of [0, 0xffffffff]) {
      const c = controls(); c[key].fill(replacement);
      assert.equal(assessReadbackControls(c, 5).status, 'failed');
    }
    const c = controls(); c[key][c[key].length - 1] += 1;
    assert.equal(assessReadbackControls(c, 5).checks[key].status, 'failed');
  }
  assert.equal(assessReadbackControls(controls(), 6).checks.witness.status, 'failed');
});
test('identically corrupted texture paths cannot pass the independent known pattern oracle', () => {
  const c = controls(); c.textureCopy.reverse(); c.textureCompute = [...c.textureCopy];
  assert.equal(assessReadbackControls(c, 5).status, 'failed');
});
test('BGRA decoding skips padding and preserves row and channel order', () => {
  const bytes = new Uint8Array(512).fill(0xa5);
  bytes.set([3, 2, 1, 255, 6, 5, 4, 128]); bytes.set([9, 8, 7, 64, 12, 11, 10, 0], 256);
  assert.deepEqual(decodeBgraRows(bytes, 2, 2, 256), [1, 2, 3, 255, 4, 5, 6, 128, 7, 8, 9, 64, 10, 11, 12, 0].map(v => v / 255));
  assert.throws(() => decodeBgraRows(bytes.subarray(4), 2, 2, 256));
  assert.throws(() => decodeBgraRows(bytes, 65, 2, 256));
});
test('unreliable captures never pass by choosing a plausible image path', () => {
  const r = capture(); assert.equal(classifyAtomicReadback(r).status, 'passed');
  r.copied[500] = 0; assert.equal(classifyAtomicReadback(r).classification, 'capture-unreliable');
  r.copied = [...r.computed]; r.atomicReadback.controls.buffer[255] = 0;
  assert.equal(classifyAtomicReadback(r).classification, 'capture-unreliable');
});
test('consistent black images leave content judgement to the existing image gate', () => {
  const r = capture(); r.computed.fill(0); r.copied.fill(0);
  assert.equal(classifyAtomicReadback(r).classification, 'capture-consistent');
});
test('missing contract, truncated/nonfinite images and outstanding mappings cannot qualify', () => {
  for (const mutate of [r => r.computed.pop(), r => { r.computed[0] = NaN; },
    r => { r.atomicReadback.submissions = 2; }, r => { r.atomicReadback.resourcesRetainedUntilAllMapsSettled = false; }]) {
    const r = capture(); mutate(r); assert.throws(() => classifyAtomicReadback(r));
  }
  const r = capture(); r.atomicReadback.controls.textureCopy.pop();
  assert.equal(classifyAtomicReadback(r).status, 'failed');
});
test('device loss remains an explicit mapping failure even when every image is unavailable', () => {
  const r = capture(); r.computed = null; r.copied = null;
  r.atomicReadback.mapErrors = [{ key: 'computed', error: 'AbortError: GPU device is lost' }];
  const assessment = classifyAtomicReadback(r);
  assert.equal(assessment.status, 'failed'); assert.equal(assessment.classification, 'capture-unreliable');
  assert.equal(assessment.failureStage, 'mapping'); assert.deepEqual(assessment.mapErrors, r.atomicReadback.mapErrors);
  assert.equal(assessment.controls, null); assert.equal(assessment.pair, null);
});
test('observed device loss rejects even plausible pixels and successful map promises', () => {
  const r = capture(); r.deviceLoss = { reason: 'unknown', message: 'GPU stopped', phase: 'readback' };
  const assessment = classifyAtomicReadback(r);
  assert.equal(assessment.status, 'failed'); assert.equal(assessment.failureStage, 'device-lost');
  assert.deepEqual(assessment.deviceLoss, r.deviceLoss);
});
