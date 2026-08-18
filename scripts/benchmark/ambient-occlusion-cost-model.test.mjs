import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AO_COST_QUALITIES,
  createAoCostCase,
  createAoCostMatrix,
} from './ambient-occlusion-cost-model.mjs';

test('AO cost matrix covers 720p, 1080p, and 4K across every quality and scratch format', () => {
  const matrix = createAoCostMatrix();
  assert.equal(matrix.length, 18);
  assert.deepEqual(new Set(matrix.map(item => item.resolution.id)), new Set(['720p', '1080p', '4k']));
  assert.deepEqual(new Set(matrix.map(item => item.quality.id)), new Set(['low', 'medium', 'high']));
  assert.deepEqual(new Set(matrix.map(item => item.scratchFormat.id)), new Set(['r8unorm', 'r16float']));
});

test('half-resolution r8 reports the raw 32x and whole scratch 16x reductions separately', () => {
  const r8 = createAoCostCase({ resolution: '1080p', quality: 'medium', scratchFormat: 'r8unorm' });
  const r16 = createAoCostCase({ resolution: '1080p', quality: 'medium', scratchFormat: 'r16float' });
  assert.equal(r8.scratch.rawTextureReduction, 32);
  assert.equal(r8.scratch.totalScratchReduction, 16);
  assert.equal(r16.scratch.rawTextureReduction, 16);
  assert.equal(r16.scratch.totalScratchReduction, 8);
  assert.equal(r16.scratch.totalBytes, r8.scratch.totalBytes * 2);
  assert.equal(r8.scratchFormat.crossDeviceRisk, 'lower');
});

test('estimated read/write bandwidth is phase-specific and quality only scales the AO sampling phase', () => {
  const cases = AO_COST_QUALITIES.map(quality => createAoCostCase({
    resolution: '720p',
    quality,
    scratchFormat: 'r8unorm',
  }));
  assert.deepEqual(cases.map(item => item.aoProbeCount), [18, 36, 70]);
  assert.ok(cases[0].estimatedBandwidth.occlusion.readBytes < cases[1].estimatedBandwidth.occlusion.readBytes);
  assert.ok(cases[1].estimatedBandwidth.occlusion.readBytes < cases[2].estimatedBandwidth.occlusion.readBytes);
  assert.equal(cases[0].estimatedBandwidth.denoise.totalBytes, cases[2].estimatedBandwidth.denoise.totalBytes);
  assert.equal(cases[0].estimatedBandwidth.upscale.totalBytes, cases[2].estimatedBandwidth.upscale.totalBytes);
  for (const item of cases) {
    for (const phase of ['occlusion', 'denoise', 'upscale']) {
      assert.ok(item.estimatedBandwidth[phase].readBytes > 0);
      assert.ok(item.estimatedBandwidth[phase].writeBytes > 0);
    }
    assert.equal(
      item.estimatedBandwidth.totalBytes,
      item.estimatedBandwidth.totalReadBytes + item.estimatedBandwidth.totalWriteBytes,
    );
  }
});
