import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  G07_REQUIRED_MODELS,
  validateG07Candidate,
  validateG07Manifest,
} from './deformable2d-g07-candidate-contract.mjs';

const root = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(await readFile(resolve(root, 'animation-spec/corpus/deformable2d/fidelity-performance-corpus-manifest.json'), 'utf8'));

test('G07 manifest freezes the licensed three-model population and full workload', () => {
  validateG07Manifest(manifest);
  assert.deepEqual(manifest.samples.map(sample => sample.id), G07_REQUIRED_MODELS);
});

test('G07 candidate accepts complete no-go evidence and rejects missing metrics', () => {
  const candidate = fixtureCandidate();
  validateG07Candidate(candidate, manifest);
  const incomplete = structuredClone(candidate);
  delete incomplete.samples[0].runtime.peakProcessMemoryBytes;
  assert.throws(() => validateG07Candidate(incomplete, manifest));
});

function fixtureCandidate() {
  const runtime = {
    status: 'passed', network: { totalBytes: 6_000_000 }, parseMs: 1, warmFirstFrameMs: 5,
    steady: { cpuUpdateRenderP50Ms: 0.4, cpuUpdateRenderP95Ms: 0.8, uploadBytes: 1024, gpuFrameP50Ms: null, gpuQueueCompletionP50Ms: 0.2, gpuQueueCompletionP95Ms: 0.3, gpuQueueCompletionSamples: 8 },
    gpuMemory: { estimatedBytes: 2048, peakEstimatedBytes: 4096 }, peakProcessMemoryBytes: 10_000_000,
    cubismRuntimeInBrowser: false, forbiddenRequestCount: 0,
    lifecycle: { releasedOwnerResiduals: 0, resourcesAfterDestroy: 0 }, diagnostics: [{ severity: 'warning', code: 'W_G07_GPU_TIMESTAMP_UNAVAILABLE', path: '$.runtime.steady.gpuFrameP50Ms' }], errors: [],
  };
  return {
    schemaVersion: 1, kind: 'haiyue-deformable2d-g07-fidelity-performance-candidate', goal: 'M05-G07',
    formalEvidence: false, revision: 'a'.repeat(40), dirty: false,
    manifest: { id: manifest.id, sha256: 'b'.repeat(64) },
    methodology: { workload: 'full', compression: 'gzip-9-per-file', cachePolicy: manifest.methodology.cachePolicy },
    samples: manifest.samples.map(sample => ({
      id: sample.id,
      source: { runtimeDirectoryHash: sample.source.runtimeDirectoryHash, fileCount: sample.source.fileCount, rawBytes: sample.source.sourceBytes, gzipBytes: 1000 },
      featureCoverage: { drawableCount: 1 }, diagnostics: sample.id === 'rice-glassfield-pro' ? [{ severity: 'warning', code: 'W_G07_UNUSED_INVERTED_MASK_FLAG_NORMALIZED', path: '$.frames[*].drawables[*].invertedMask' }] : [],
      conversion: { converterMs: 1, bakedFrameCount: 3, evaluationCount: 5 },
      structuralFidelity: { denseFrameCount: 3, maxError: 0.005, renderOrderMismatchCount: 0 },
      pixelFidelity: { surfaceReadback: { meanAbsoluteError: 0.1, mismatchRatio: 0.001 }, acceptedReadback: { meanAbsoluteError: 0.05, mismatchRatio: 0.0005 } },
      package: { rawBytes: 1000, gzipBytes: 800 }, runtime: { ...structuredClone(runtime), browser: { nativeBackend: true } },
    })),
    neutralRuntime: { id: manifest.neutralRuntimeFixture.id, playbackPassed: true, cubismRuntimeInBrowser: false, forbiddenRequestCount: 0, artifactForbiddenTokenCount: 0, lifecycleResiduals: 0 },
    verdict: { status: 'no-go', blockers: [{ sampleId: 'niziiro-mao', code: 'E_CUBISM_RECIPE_CAPABILITY_MISSING', path: '$.recipe.expression' }] },
    summary: { sampleCount: 3, pixelFidelitySampleCount: 3, structuralFidelitySampleCount: 3, runtimePlaybackSampleCount: 3, sourceRawBytes: 10, sourceGzipBytes: 9, hyaPackageRawBytes: 8, hyaPackageGzipBytes: 7 },
    unclassifiedFailureCount: 0,
  };
}
