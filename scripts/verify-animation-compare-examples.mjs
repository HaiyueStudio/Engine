import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(import.meta.dirname, '..');
const [lottieBundle, live2dBundle] = await Promise.all([
  readFile(resolve(root, 'examples/lottie-hya-compare/bundle.js'), 'utf8'),
  readFile(resolve(root, 'examples/live2d-hya-compare/bundle.js'), 'utf8'),
]);
assert.equal(lottieBundle.includes('_expression_function'), false, 'The official light player must exclude expression eval support.');
assert.equal(live2dBundle.includes('Live2D Proprietary Software License Agreement'), false, 'The optional comparison bundle must not vendor Cubism Core.');

const [lottie, live2d, live2dMask, live2dBlend, maskTextureReadback, blendTextureReadback] = await Promise.all([
  runChromeWebGpuFixture({ root, fixture: 'examples/lottie-hya-compare/index.html', timeoutMs: 60_000, visualCapture: { viewportWidth: 1200, viewportHeight: 760, sampleWidth: 24, sampleHeight: 15 } }),
  runChromeWebGpuFixture({ root, fixture: 'examples/live2d-hya-compare/index.html', query: { actionSmoke: 1 }, timeoutMs: 60_000, visualCapture: { viewportWidth: 1200, viewportHeight: 760, sampleWidth: 24, sampleHeight: 15 } }),
  runChromeWebGpuFixture({ root, fixture: 'examples/live2d-hya-compare/index.html', query: { fixture: 'mask-parity', maskActionSmoke: 1, loopSmoke: 1, resizeSmoke: 1, recoverySmoke: 1 }, timeoutMs: 60_000, visualCapture: { viewportWidth: 1200, viewportHeight: 760, sampleWidth: 24, sampleHeight: 15, compareSelectors: ['#hya-canvas', '#reference-canvas'], compareInsetTop: 52 } }),
  runChromeWebGpuFixture({ root, fixture: 'examples/live2d-hya-compare/index.html', query: { fixture: 'blend-parity', actionSmoke: 1, recoverySmoke: 1 }, timeoutMs: 60_000, visualCapture: { viewportWidth: 1201, viewportHeight: 760, sampleWidth: 24, sampleHeight: 15, compareSelectors: ['#hya-canvas', '#reference-canvas'], compareInsetTop: 52 } }),
  runChromeWebGpuFixture({ root, fixture: 'scripts/webgpu-gate/deformable-mask-composition-fixture.html', timeoutMs: 60_000 }),
  runChromeWebGpuFixture({ root, fixture: 'scripts/webgpu-gate/deformable-blend-composition-fixture.html', timeoutMs: 60_000 }),
]);
assert.equal(lottie.status, 'passed');
assert.equal(lottie.officialPlayer, 'lottie-web');
assert.equal(lottie.comparisonBackground, '#050817');
assert.ok(lottie.renderer.visualCount > 0);
assert.ok(lottie.bounds.width > 0 && lottie.bounds.height > 0);
assert.ok(lottie.bounds.width < 128 * 4 && lottie.bounds.height < 128 * 4, 'Lottie content bounds must stay near the 128x128 sample composition.');
assert.ok(lottie.autoZoom > 0.1, 'Automatic fitting must not collapse to its emergency minimum.');
assert.equal(lottie.browserDiagnostics.unclassifiedFailureCount, 0);
assert.equal(live2d.status, 'passed');
assert.equal(live2d.reference, 'captured-mesh-fixture');
assert.equal(live2d.comparisonBackground, lottie.comparisonBackground);
assert.ok(live2d.hya.visualCount > 0);
assert.equal(live2d.actionCount, 2);
assert.equal(live2d.selectedActionId, 'sample:second');
assert.equal(live2d.playerInstallCount, 1, 'Action switching must reuse the existing HYA player instance.');
assert.ok(live2d.bounds.width > 0 && live2d.bounds.height > 0);
assert.equal(live2d.browserDiagnostics.unclassifiedFailureCount, 0);
for (const file of live2d.httpProvenance.files) assert.ok(!/live2dcubismcore|\.moc3|\.model3\.json/iu.test(file.sourcePath), `Default fixture unexpectedly requested ${file.sourcePath}`);
assert.equal(live2dMask.status, 'passed');
assert.equal(live2dMask.fixtureId, 'mask-parity');
assert.equal(live2dMask.sampledAt, 1, 'Mask parity must sample the dynamic hidden-source pose.');
assert.equal(live2dMask.featureCoverage.maskReferenceCount, 5);
assert.equal(live2dMask.featureCoverage.invertedMaskDrawableCount, 1);
assert.equal(live2dMask.hya.maskTargetCount, 2, 'Single-source and shared multi-source consumers must allocate exactly two group targets.');
assert.equal(live2dMask.hya.droppedCompositeCount, 0);
assert.equal(live2dMask.maskActionSmoke, true);
assert.equal(live2dMask.loopSmoke, true);
assert.equal(live2dMask.playerInstallCount, 1, 'Mask action switching must retain one HYA player and mask owner.');
assert.equal(live2dMask.resizeSmoke, true);
assert.notEqual(live2dMask.preResizeMaskPixels, live2dMask.postResizeMaskPixels, 'Mask targets must be recreated at the resized viewport dimensions.');
assert.equal(live2dMask.recoverySmoke, true, 'Mask targets must rebuild after renderer device recovery.');
assert.equal(live2dMask.browserDiagnostics.unclassifiedFailureCount, 0);
const maskPixels = live2dMask.visualCapture.regionParity;
assert.ok(maskPixels, 'Mask parity must include Chrome surface-readback evidence.');
// Candidate thresholds bind the observed WebGPU/WebGL rasterizer edge variance;
// mean error is the primary signal while the max bound catches gross channel drift.
assert.ok(maskPixels.maxChannelError <= 180, `Mask surface max-channel error regressed to ${maskPixels.maxChannelError}.`);
assert.ok(maskPixels.meanAbsoluteError <= 1, `Mask surface mean error regressed to ${maskPixels.meanAbsoluteError}.`);
assert.ok(maskPixels.mismatchRatio <= 0.025, `Mask surface mismatch ratio regressed to ${maskPixels.mismatchRatio}.`);
for (const file of live2dMask.httpProvenance.files) assert.ok(!/live2dcubismcore|\.moc3|\.model3\.json/iu.test(file.sourcePath), `Mask fixture unexpectedly requested ${file.sourcePath}`);
assert.equal(live2dBlend.status, 'passed');
assert.equal(live2dBlend.fixtureId, 'blend-parity');
assert.equal(live2dBlend.featureCoverage.additiveDrawableCount, 1);
assert.equal(live2dBlend.featureCoverage.multiplicativeDrawableCount, 1);
assert.equal(live2dBlend.featureCoverage.maskReferenceCount, 2);
assert.equal(live2dBlend.hya.droppedCompositeCount, 0);
assert.equal(live2dBlend.selectedActionId, 'sample:second');
assert.equal(live2dBlend.playerInstallCount, 1, 'Blend action switching must retain one HYA player, model and texture set.');
assert.equal(live2dBlend.recoverySmoke, true, 'All three blend pipelines must rebuild after renderer device recovery.');
assert.equal(live2dBlend.browserDiagnostics.unclassifiedFailureCount, 0);
const blendPixels = live2dBlend.visualCapture.regionParity;
assert.ok(blendPixels, 'Blend parity must include Chrome WebGPU/WebGL surface-readback evidence.');
assert.ok(blendPixels.maxChannelError <= 64, `Blend surface max-channel error regressed to ${blendPixels.maxChannelError}.`);
assert.ok(blendPixels.meanAbsoluteError <= 0.5, `Blend surface mean error regressed to ${blendPixels.meanAbsoluteError}.`);
assert.ok(blendPixels.mismatchRatio <= 0.02, `Blend surface mismatch ratio regressed to ${blendPixels.mismatchRatio}.`);
for (const file of live2dBlend.httpProvenance.files) assert.ok(!/live2dcubismcore|\.moc3|\.model3\.json/iu.test(file.sourcePath), `Blend fixture unexpectedly requested ${file.sourcePath}`);
assert.equal(maskTextureReadback.status, 'passed');
assert.equal(maskTextureReadback.suite, 'deformable-mask-composition-texture-readback');
assert.equal(maskTextureReadback.caseCount, 8);
assert.equal(maskTextureReadback.strictValidation, true);
assert.ok(maskTextureReadback.cases.every(item => item.error <= 1));
assert.equal(maskTextureReadback.browserDiagnostics.unclassifiedFailureCount, 0);
assert.equal(blendTextureReadback.status, 'passed');
assert.equal(blendTextureReadback.suite, 'deformable-blend-composition-texture-readback');
assert.equal(blendTextureReadback.caseCount, 15);
assert.deepEqual(blendTextureReadback.modes, ['normal', 'additive', 'multiplicative']);
assert.equal(blendTextureReadback.strictValidation, true);
assert.deepEqual(blendTextureReadback.runtimeExternalImageUpload.actual, blendTextureReadback.runtimeExternalImageUpload.expected);
assert.ok(blendTextureReadback.cases.every(item => item.maximumError <= 2));
assert.equal(blendTextureReadback.browserDiagnostics.unclassifiedFailureCount, 0);
console.log(JSON.stringify({
  status: 'passed',
  lottie: { visualCount: lottie.renderer.visualCount, bounds: lottie.bounds, autoZoom: lottie.autoZoom, bundleBytes: Buffer.byteLength(lottieBundle) },
  live2d: { visualCount: live2d.hya.visualCount, bounds: live2d.bounds, autoZoom: live2d.autoZoom, bundleBytes: Buffer.byteLength(live2dBundle) },
  live2dMask: { visualCount: live2dMask.hya.visualCount, maskTargetCount: live2dMask.hya.maskTargetCount, featureCoverage: live2dMask.featureCoverage, sampledAt: live2dMask.sampledAt, maskActionSmoke: live2dMask.maskActionSmoke, loopSmoke: live2dMask.loopSmoke, resize: { before: live2dMask.preResizeMaskPixels, after: live2dMask.postResizeMaskPixels }, recoverySmoke: live2dMask.recoverySmoke, surfaceReadback: maskPixels },
  live2dBlend: { visualCount: live2dBlend.hya.visualCount, maskTargetCount: live2dBlend.hya.maskTargetCount, featureCoverage: live2dBlend.featureCoverage, sampledAt: live2dBlend.sampledAt, selectedActionId: live2dBlend.selectedActionId, playerInstallCount: live2dBlend.playerInstallCount, recoverySmoke: live2dBlend.recoverySmoke, surfaceReadback: blendPixels },
  maskTextureReadback: { caseCount: maskTextureReadback.caseCount, maximumError: Math.max(...maskTextureReadback.cases.map(item => item.error)), strictValidation: maskTextureReadback.strictValidation },
  blendTextureReadback: { caseCount: blendTextureReadback.caseCount, maximumError: Math.max(...blendTextureReadback.cases.map(item => item.maximumError)), strictValidation: blendTextureReadback.strictValidation },
  browser: lottie.browserEvidence.product,
}, null, 2));
