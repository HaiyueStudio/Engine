import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFrameGraphQualification, validateFrameGraphAdapter, validateFrameGraphBrowser, validateFrameGraphAdapterConsistency } from './framegraph-qualification-policy.mjs';
import { createFrameGraphRegressionPlan, validateFrameGraphRegressionResult } from './framegraph-regression-policy.mjs';
const matrix = JSON.parse(readFileSync(new URL('../../config/release-matrix.json', import.meta.url)));
const windows = createFrameGraphQualification(matrix, 'win32'), macos = createFrameGraphQualification(matrix, 'darwin');
const nvidia = { vendor: 'nvidia', architecture: 'pascal', isFallbackAdapter: false };
const raw = { browserEvidence: { nativeBackend: true, angleBackend: 'd3d11', platform: 'Win32', product: 'HeadlessChrome/153', userAgent: 'Chrome/153' } };
test('one complete path, no low-power hint impersonating a second device', () => {
  assert.deepEqual(windows.targets.map(t => t.browserId), ['chrome-windows', 'edge-windows']);
  assert.equal(createFrameGraphRegressionPlan('full', windows).length, 16);
  assert.equal(createFrameGraphRegressionPlan('full', macos).length, 8);
  assert.ok(windows.targets.every(t => t.powerPreference === 'high-performance'));
  assert.throws(() => createFrameGraphQualification(matrix, 'linux'));
});
test('required hardware excludes legacy Intel, fallback, unidentified and unsupported devices', () => {
  validateFrameGraphAdapter(nvidia, windows);
  validateFrameGraphAdapter({ vendor: 'apple', architecture: 'apple-m', isFallbackAdapter: false }, macos);
  for (const adapter of [{ ...nvidia, isFallbackAdapter: true }, { ...nvidia, isFallbackAdapter: undefined },
    { vendor: 'intel', architecture: 'gen-9', isFallbackAdapter: false },
    { ...nvidia, description: 'SwiftShader' }, { vendor: 'amd', architecture: 'rdna-2', isFallbackAdapter: false }])
    assert.throws(() => validateFrameGraphAdapter(adapter, windows));
  validateFrameGraphAdapter({ vendor: 'amd', architecture: 'rdna-2', description: 'AMD Radeon RX 6800', isFallbackAdapter: false }, windows);
  assert.throws(() => validateFrameGraphAdapter({ vendor: 'intel', architecture: 'gen-9', isFallbackAdapter: false }, macos));
});
test('Chrome cannot fill Edge; native backend and OS remain mandatory', () => {
  validateFrameGraphBrowser(raw, windows.targets[0], windows);
  assert.throws(() => validateFrameGraphBrowser(raw, windows.targets[1], windows));
  const edge = { browserEvidence: { ...raw.browserEvidence, product: 'Edg/154', userAgent: 'Chrome/154 Edg/154' } };
  validateFrameGraphBrowser(edge, windows.targets[1], windows);
  assert.throws(() => validateFrameGraphBrowser(edge, windows.targets[0], windows));
  for (const patch of [{ nativeBackend: false }, { platform: 'MacIntel' }, { angleBackend: 'swiftshader' }])
    assert.throws(() => validateFrameGraphBrowser({ browserEvidence: { ...raw.browserEvidence, ...patch } }, windows.targets[0], windows));
});
test('hardware change and weakened fixture evidence still fail', () => {
  validateFrameGraphAdapterConsistency([nvidia, nvidia]);
  assert.throws(() => validateFrameGraphAdapterConsistency([nvidia, { ...nvidia, architecture: 'turing' }]));
  const job = { ...windows.targets[0], name: 'auxiliary-semantics' };
  const result = { ...raw, schemaVersion: 1, status: 'passed', adapter: nvidia, validationErrors: [], cases: Array(17).fill({}), ownerResidual: 0 };
  validateFrameGraphRegressionResult(result, job, 'full', windows);
  for (const patch of [{ cases: [] }, { ownerResidual: 1 }, { validationErrors: ['error'] }, { status: 'failed' }])
    assert.throws(() => validateFrameGraphRegressionResult({ ...result, ...patch }, job, 'full', windows));
});
