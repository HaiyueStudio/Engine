import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  GLTF_CORPUS_SCHEMA_VERSION,
  GLTF_CORPUS_SUITE,
  validateGltfCorpusResult,
} from './gltf-corpus-contract.mjs';

const manifest = JSON.parse(await readFile(new URL('./assets/gltf-corpus/manifest.json', import.meta.url), 'utf8'));

function validResult() {
  return {
    schemaVersion: GLTF_CORPUS_SCHEMA_VERSION,
    suite: GLTF_CORPUS_SUITE,
    configuration: {
      mode: 'optimized',
      gltfWorker: 'production-inline',
      ktx2Worker: true,
      ktx2WorkerPoolSize: 4,
    },
    environment: { adapter: { vendor: 'test' } },
    animation3D: {
      fixture: '/extensions/test/fixtures/gltf/animation-characterization.gltf',
      clipIds: ['Idle', 'Run'],
      interpolation: ['cubic-spline', 'linear', 'step'],
      gpuMorph: true,
      skinning: true,
      positionsRemainBase: true,
      phases: [
        {
          name: 'start',
          mixerTime: 0,
          rootLocalMatrix: [
            0, 1, 0, 0,
            -1, 0, 0, 0,
            0, 0, 1, 0,
            1, 2, 3, 1,
          ],
          morphWeights: [0.1, 0.2],
          skinJointTipMatrix: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
          ],
          visiblePixel: true,
        },
        {
          name: 'mid',
          mixerTime: 0.5,
          rootLocalMatrix: [
            0, 1.25, 0, 0,
            -1.5, 0, 0, 0,
            0, 0, 1.75, 0,
            1.5, 2.5, 3.5, 1,
          ],
          morphWeights: [0.3, 0.35],
          skinJointTipMatrix: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0.5, 0, 1,
          ],
          visiblePixel: true,
        },
        {
          name: 'end',
          mixerTime: 1,
          rootLocalMatrix: [
            -2, 0, 0, 0,
            0, -3, 0, 0,
            0, 0, 4, 0,
            3, 4, 5, 1,
          ],
          morphWeights: [0.75, 0.25],
          skinJointTipMatrix: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 2, 0, 1,
          ],
          visiblePixel: true,
        },
      ],
      lifecycle: {
        runtimeState: 'destroyed',
        actionCount: 0,
        bindingCount: 0,
        targetCount: 0,
      },
    },
    tiers: manifest.tiers.map(tier => ({
      id: tier.id,
      asset: { entry: tier.entry, ...tier.expected },
      timings: {
        fetchMs: 1,
        workerParseMs: 1,
        dracoDecodeMs: tier.id === 'medium' ? 1 : 0,
        instantiateMs: 1,
        imageDecodeTranscodeMs: tier.id === 'large' ? 1 : 0,
        gpuUploadMs: tier.id === 'large' ? 1 : 0,
        pipelineWarmupMs: 1,
        visibleSubmitMs: 1,
        firstVisibleFrameMs: 20,
      },
      resources: {
        assetTransferBytes: 100,
        sourceBytes: 100,
        decodedGeometryBytes: 100,
        workerTransferBytes: 100,
        workerTransferBufferCount: 1,
        peakCpuStagingBytes: 200,
        peakGpuEstimatedBytes: 300,
        gpuUploadCalls: 1,
        gpuUploadBytes: 100,
        assetUploadCalls: tier.id === 'large' ? 2 : 0,
        maxFrameAssetUploadBytes: tier.id === 'large' ? 512 : 0,
        pendingUploadTasksAfterVisible: 0,
        postVisibleAssetUploadBytes: 0,
      },
      render: { passCount: 2, visiblePixel: true },
      lifecycle: {
        duplicateLoad: true,
        recordCacheHits: 1,
        sceneDestroyResidualRecords: 0,
        recoveryFailures: tier.id === 'large' ? 0 : null,
        recoveredTextureRecords: tier.id === 'large' ? 1 : 0,
      },
    })),
    lifecycle: { cancelledLoadRejected: true, cancelledLoadWasInFlight: true },
    resources: {
      liveGpuResourcesAfterDestroy: 0,
      liveGpuBytesAfterDestroy: 0,
      releasedOwnerResiduals: 0,
    },
    validation: { errors: [], uncapturedErrors: [], deviceLost: false },
  };
}

test('production glTF corpus contract accepts three fully visible lifecycle tiers', () => {
  assert.deepEqual(validateGltfCorpusResult(validResult(), manifest), []);
});

test('production glTF corpus contract rejects deferred uploads and missing recovery', () => {
  const result = validResult();
  const large = result.tiers.find(tier => tier.id === 'large');
  large.resources.postVisibleAssetUploadBytes = 1;
  large.lifecycle.recoveryFailures = 1;
  result.resources.liveGpuResourcesAfterDestroy = 1;
  const errors = validateGltfCorpusResult(result, manifest);
  assert.ok(errors.some(error => error.includes('deferred asset uploads')));
  assert.ok(errors.some(error => error.includes('device recovery')));
  assert.ok(errors.some(error => error.includes('liveGpuResourcesAfterDestroy')));
});

test('production glTF corpus contract enforces KTX2 upload-call and CPU-staging ceilings', () => {
  const result = validResult();
  const large = result.tiers.find(tier => tier.id === 'large');
  large.resources.assetUploadCalls = 65;
  large.resources.peakCpuStagingBytes = 60 * 1024 * 1024;
  const errors = validateGltfCorpusResult(result, manifest);
  assert.ok(errors.some(error => error.includes('asset upload calls')));
  assert.ok(errors.some(error => error.includes('CPU staging')));
});

test('production glTF corpus contract rejects fake or incomplete worker evidence', () => {
  const result = validResult();
  result.configuration.gltfWorker = 'fixture-parser';
  const small = result.tiers.find(tier => tier.id === 'small');
  small.timings.workerParseMs = 0;
  small.resources.workerTransferBytes = 0;
  small.resources.workerTransferBufferCount = 0;
  const errors = validateGltfCorpusResult(result, manifest);
  assert.ok(errors.some(error => error.includes('production inline asset worker')));
  assert.ok(errors.some(error => error.includes('measured worker parsing')));
  assert.ok(errors.some(error => error.includes('transfer worker geometry')));
  assert.ok(errors.some(error => error.includes('transfer worker buffers')));
});

test('production glTF corpus contract rejects incomplete Animation3D character evidence', () => {
  const result = validResult();
  result.animation3D.interpolation = ['linear'];
  result.animation3D.phases[1].morphWeights = result.animation3D.phases[0].morphWeights;
  result.animation3D.phases[2].visiblePixel = false;
  result.animation3D.lifecycle.bindingCount = 1;
  const errors = validateGltfCorpusResult(result, manifest);
  assert.ok(errors.some(error => error.includes('STEP, LINEAR, and CUBICSPLINE')));
  assert.ok(errors.some(error => error.includes('mid morph pose')));
  assert.ok(errors.some(error => error.includes('end WebGPU frame')));
  assert.ok(errors.some(error => error.includes('bindingCount')));
});

test('production glTF fixture is wired to worker parse and worker KTX2 transcode paths', async () => {
  const source = await readFile(new URL('./gltf-corpus-fixture.mjs', import.meta.url), 'utf8');
  assert.match(source, /createInlineGltfAssetWorkerClient/);
  assert.match(source, /extensions\/dist\/gltf-worker-runtime\.js/);
  assert.match(source, /extensions\/dist\/gltf-animation3d\.js/);
  assert.match(source, /createGltfAnimation3DRuntime/);
  assert.match(source, /animation-characterization\.gltf/);
  assert.match(source, /run\.crossFadeFrom\(idle,\s*1\)/);
  assert.match(source, /gltfWorker:\s*useWorkers\s*\?\s*'production-inline'/);
  assert.doesNotMatch(source, /createCorpusParserWorkerClient/);
  assert.doesNotMatch(source, /new GltfAssetWorkerClient/);
  assert.match(source, /createInlineKtx2TextureWorkerClient/);
  assert.match(source, /maxWorkers:\s*4/);
  assert.match(source, /ktx2WorkerPoolSize:\s*useWorkers\s*\?\s*4\s*:\s*0/);
  assert.match(source, /basisEncoderScriptUrl/);
  assert.match(source, /dracoDecoderConfig/);
  assert.match(source, /engine\/dist\/experimental\/assets\.js/);
  assert.doesNotMatch(source, /Could not resolve the engine KTX2 asset chunk/);
});

test('glTF verifier records same-corpus reference and optimized phase evidence', async () => {
  const source = await readFile(new URL('../verify-webgpu-gltf-asset.mjs', import.meta.url), 'utf8');
  assert.match(source, /query:\s*\{\s*mode:\s*'reference'\s*\}/);
  assert.match(source, /query:\s*\{\s*mode:\s*'optimized'\s*\}/);
  assert.match(source, /comparison:\s*\{/);
  assert.match(source, /selectEvidence\(reference\)/);
  assert.match(source, /selectEvidence\(result\)/);
  assert.match(source, /defaultWebGpuAngleBackend\(\)/);
});
