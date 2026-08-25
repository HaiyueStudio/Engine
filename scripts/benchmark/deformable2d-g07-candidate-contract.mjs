import assert from 'node:assert/strict';

export const G07_CANDIDATE_KIND = 'haiyue-deformable2d-g07-fidelity-performance-candidate';
export const G07_REQUIRED_MODELS = Object.freeze(['hatsune-miku-free', 'rice-glassfield-pro', 'niziiro-mao']);
export const G07_REQUIRED_METRICS = Object.freeze([
  'featureCoverage', 'diagnosticAttribution', 'pixelFidelity', 'structuralFidelity',
  'rawBytes', 'gzipBytes', 'totalNetworkBytes', 'parseMs', 'warmFirstFrameMs',
  'steadyUpdateRenderMs', 'uploadBytes', 'gpuMemoryBytes', 'peakProcessMemoryBytes',
  'lifecycleResiduals',
]);

export function validateG07Manifest(manifest) {
  assert.equal(manifest?.schemaVersion, 1, 'G07 manifest schemaVersion must be 1.');
  assert.equal(manifest?.kind, 'haiyue-deformable2d-fidelity-performance-corpus');
  assert.equal(manifest?.id, 'm05-g07-fidelity-performance-corpus');
  assert.deepEqual(manifest.populationPolicy?.requiredModelIds, G07_REQUIRED_MODELS);
  assert.equal(manifest.populationPolicy?.sampleCount, G07_REQUIRED_MODELS.length);
  assert.equal(manifest.populationPolicy?.licensedAssetsBundled, false);
  assert.equal(manifest.methodology?.workload, 'full');
  assert.equal(manifest.methodology?.compression, 'gzip-9-per-file');
  assert.equal(manifest.methodology?.converterCostReportedSeparately, true);
  assert.deepEqual(manifest.requiredMetrics, G07_REQUIRED_METRICS);
  assert.deepEqual(manifest.samples.map(sample => sample.id), G07_REQUIRED_MODELS);
  for (const sample of manifest.samples) {
    assert.equal(sample.sourcePolicy, 'caller-supplied-local-only');
    assert.equal(sample.distribution?.rawAssets, false);
    assert.match(sample.source?.runtimeDirectoryHash ?? '', /^sha256-[a-f\d]{64}$/u);
    assert.ok(sample.source?.fileCount > 0 && sample.source?.sourceBytes > 0);
    assert.ok(sample.requiredFiles?.length >= 4);
    for (const file of sample.requiredFiles) {
      assert.ok(!file.path.includes('\\') && !file.path.includes('..'));
      assert.ok(file.byteLength > 0);
      assert.match(file.sha256, /^[a-f\d]{64}$/u);
    }
  }
  const mao = manifest.samples.find(sample => sample.id === 'niziiro-mao');
  assert.ok(mao.recipe.expression && mao.recipe.physics && mao.recipe.pose, 'Mao must freeze the full expression/physics/pose recipe.');
  assert.deepEqual(
    ['motion', 'expression', 'physics', 'pose'].map(capability => manifest.oracle?.frameworkCapability?.[capability]),
    [true, true, true, true],
  );
  assert.match(manifest.oracle?.frameworkCapability?.testedTag ?? '', /^5-r\.\d+$/u);
  assert.equal(manifest.neutralRuntimeFixture?.required, true);
  return manifest;
}

export function validateG07Candidate(candidate, manifest, { requireClean = true } = {}) {
  validateG07Manifest(manifest);
  assert.equal(candidate?.schemaVersion, 1);
  assert.equal(candidate?.kind, G07_CANDIDATE_KIND);
  assert.equal(candidate?.goal, 'M05-G07');
  assert.equal(candidate?.formalEvidence, false, 'G07 must not overwrite G09 formal evidence.');
  assert.match(candidate?.revision ?? '', /^[a-f\d]{40}$/u);
  if (requireClean) assert.equal(candidate?.dirty, false, 'G07 completion candidate must come from a clean revision.');
  assert.equal(candidate?.manifest?.id, manifest.id);
  assert.match(candidate?.manifest?.sha256 ?? '', /^[a-f\d]{64}$/u);
  assert.equal(candidate?.methodology?.workload, 'full');
  assert.equal(candidate?.methodology?.compression, 'gzip-9-per-file');
  assert.equal(candidate?.methodology?.cachePolicy, manifest.methodology.cachePolicy);
  assert.deepEqual(candidate?.samples?.map(sample => sample.id), G07_REQUIRED_MODELS);
  assert.equal(candidate?.unclassifiedFailureCount, 0);

  for (const sample of candidate.samples) validateSample(sample, manifest.samples.find(item => item.id === sample.id));
  assert.ok(candidate.samples.find(sample => sample.id === 'rice-glassfield-pro').diagnostics.some(diagnostic => diagnostic.code === 'W_G07_UNUSED_INVERTED_MASK_FLAG_NORMALIZED' && diagnostic.path === '$.frames[*].drawables[*].invertedMask'));

  assert.equal(candidate.neutralRuntime?.id, manifest.neutralRuntimeFixture.id);
  assert.equal(candidate.neutralRuntime?.playbackPassed, true);
  assert.equal(candidate.neutralRuntime?.cubismRuntimeInBrowser, false);
  assert.equal(candidate.neutralRuntime?.forbiddenRequestCount, 0);
  assert.equal(candidate.neutralRuntime?.artifactForbiddenTokenCount, 0);
  assert.equal(candidate.neutralRuntime?.lifecycleResiduals, 0);

  assert.equal(candidate.verdict?.status, 'go', 'The official Framework evaluator must execute every frozen recipe capability.');
  assert.deepEqual(candidate.verdict?.blockers, []);
  assert.equal(candidate.summary?.sampleCount, 3);
  assert.equal(candidate.summary?.pixelFidelitySampleCount, 3);
  assert.equal(candidate.summary?.structuralFidelitySampleCount, 3);
  assert.equal(candidate.summary?.runtimePlaybackSampleCount, 3);
  assert.ok(candidate.summary?.sourceRawBytes > 0 && candidate.summary?.hyaPackageRawBytes > 0);
  assert.ok(candidate.summary?.sourceGzipBytes > 0 && candidate.summary?.hyaPackageGzipBytes > 0);
  return candidate;
}

function validateSample(sample, expected) {
  assert.ok(expected, `Unexpected G07 sample ${sample.id}.`);
  assert.equal(sample.source.runtimeDirectoryHash, expected.source.runtimeDirectoryHash);
  assert.equal(sample.source.fileCount, expected.source.fileCount);
  assert.equal(sample.source.rawBytes, expected.source.sourceBytes);
  assert.ok(sample.source.gzipBytes > 0);
  assert.ok(sample.featureCoverage && Number.isInteger(sample.featureCoverage.drawableCount));
  assert.ok(Array.isArray(sample.diagnostics));
  assert.ok(sample.conversion?.converterMs >= 0);
  assert.ok(sample.conversion?.bakedFrameCount >= 2);
  assert.ok(sample.conversion?.evaluationCount >= sample.conversion.bakedFrameCount);
  assert.ok(sample.structuralFidelity?.denseFrameCount >= 2);
  assert.ok(sample.structuralFidelity.maxError <= 0.011 + 1e-12);
  assert.equal(sample.structuralFidelity.renderOrderMismatchCount, 0);
  assert.ok(sample.pixelFidelity?.surfaceReadback?.meanAbsoluteError <= 1);
  assert.ok(sample.pixelFidelity?.acceptedReadback?.meanAbsoluteError <= 1);
  assert.ok(sample.pixelFidelity?.acceptedReadback?.mismatchRatio <= 0.025);
  assert.ok(sample.package.rawBytes > 0 && sample.package.gzipBytes > 0);
  assert.equal(sample.runtime.status, 'passed');
  assert.equal(sample.runtime.browser?.nativeBackend, true);
  assert.ok(sample.runtime.network.totalBytes >= sample.package.rawBytes);
  assert.ok(sample.runtime.parseMs >= 0);
  assert.ok(sample.runtime.warmFirstFrameMs >= 0);
  assert.ok(sample.runtime.steady.cpuUpdateRenderP50Ms >= 0);
  assert.ok(sample.runtime.steady.cpuUpdateRenderP95Ms >= sample.runtime.steady.cpuUpdateRenderP50Ms);
  assert.ok(sample.runtime.steady.uploadBytes >= 0);
  assert.ok(sample.runtime.steady.gpuQueueCompletionP50Ms >= 0);
  assert.ok(sample.runtime.steady.gpuQueueCompletionP95Ms >= sample.runtime.steady.gpuQueueCompletionP50Ms);
  assert.ok(sample.runtime.steady.gpuQueueCompletionSamples >= 8);
  if (sample.runtime.steady.gpuFrameP50Ms === null) assert.ok(sample.runtime.diagnostics?.some(diagnostic => diagnostic.code === 'W_G07_GPU_TIMESTAMP_UNAVAILABLE' && diagnostic.path === '$.runtime.steady.gpuFrameP50Ms'));
  assert.ok(sample.runtime.gpuMemory.estimatedBytes > 0);
  assert.ok(sample.runtime.gpuMemory.peakEstimatedBytes >= sample.runtime.gpuMemory.estimatedBytes);
  assert.ok(sample.runtime.peakProcessMemoryBytes > 0);
  assert.equal(sample.runtime.cubismRuntimeInBrowser, false);
  assert.equal(sample.runtime.forbiddenRequestCount, 0);
  assert.equal(sample.runtime.lifecycle.releasedOwnerResiduals, 0);
  assert.equal(sample.runtime.lifecycle.resourcesAfterDestroy, 0);
  assert.equal(sample.runtime.errors.length, 0);
}
