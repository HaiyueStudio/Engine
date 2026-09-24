import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectReleaseQualification, validateLightingReleaseEvidence } from './release-platform-policy.mjs';
const matrix = JSON.parse(readFileSync(new URL('../config/release-matrix.json', import.meta.url)));
const identity = { runnerProfile: 'release-macos-native', qualificationPath: 'macos', revision: 'a'.repeat(40), dirty: false, platform: 'darwin',
  hostname: 'physical-mac', operatingSystem: 'macOS 26.6.2', osVersion: '26.6.2', driver: 'AMD Metal', localConsole: true };
const result = { browserEvidence: { nativeBackend: true, angleBackend: 'metal', product: 'HeadlessChrome/151' },
  adapter: { vendor: 'amd', description: 'AMD Radeon Pro 5300M' },
  configuration: { authoredLocalLightCount: 128, dynamicRatio: 1, viewCount: 4, overlap: 'high', resolution: { id: '720p' } },
  timing: { rawSamples: Array(8).fill(1) } };
test('macOS and Windows are complete alternative qualification paths', () => {
  assert.deepEqual(selectReleaseQualification(matrix, 'macos').browserIds, ['chrome-macos']);
  assert.deepEqual(selectReleaseQualification(matrix, 'windows').browserIds, ['chrome-windows', 'edge-windows']);
  assert.throws(() => selectReleaseQualification(matrix, 'linux'));
  assert.deepEqual(validateLightingReleaseEvidence(result, matrix, identity), []);
  assert.deepEqual(validateLightingReleaseEvidence({ ...result, adapter: { vendor: 'apple' } }, matrix, identity), []);
  assert.deepEqual(validateLightingReleaseEvidence({ ...result, adapter: { vendor: 'intel' } }, matrix, identity), []);
});
test('formal evidence rejects dirty, remote, old and mismatched hosts', () => {
  for (const patch of [{ runnerProfile: 'local-unregistered' }, { dirty: true }, { localConsole: false }, { revision: null }, { platform: 'win32' },
    { osVersion: '13.6' }, { osVersion: 'unknown' }, { driver: '' }]) {
    assert.ok(validateLightingReleaseEvidence(result, matrix, { ...identity, ...patch }).length, JSON.stringify(patch));
  }
});
test('software, fallback and smaller workload cannot become formal evidence', () => {
  for (const adapter of [{ vendor: 'google', description: 'SwiftShader' }, { vendor: 'amd', isFallbackAdapter: true }, {}]) {
    assert.ok(validateLightingReleaseEvidence({ ...result, adapter }, matrix, identity).length);
  }
  assert.ok(validateLightingReleaseEvidence({ ...result, configuration: { ...result.configuration, authoredLocalLightCount: 8 } }, matrix, identity).length);
  assert.ok(validateLightingReleaseEvidence({ ...result, browserEvidence: { ...result.browserEvidence, nativeBackend: false } }, matrix, identity).length);
});

test('Windows release qualification preserves discrete hardware requirements', () => {
  const windows = { ...identity, qualificationPath: 'windows', runnerProfile: 'release-windows-native', platform: 'win32', osVersion: '10.0.19045', operatingSystem: 'Windows 10', driver: 'AMD Radeon RX 6800' };
  const evidence = { ...result, browserEvidence: { ...result.browserEvidence, angleBackend: 'd3d11' }, adapter: { vendor: 'amd', architecture: 'rdna-2' } };
  assert.deepEqual(validateLightingReleaseEvidence(evidence, matrix, windows), []);
  assert.ok(validateLightingReleaseEvidence(evidence, matrix, { ...windows, driver: 'AMD integrated' }).length);
  assert.deepEqual(validateLightingReleaseEvidence({ ...evidence, adapter: { vendor: 'nvidia' } }, matrix, windows), []);
});
