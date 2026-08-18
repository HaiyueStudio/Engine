export const GLTF_CORPUS_SCHEMA_VERSION = 2;
export const GLTF_CORPUS_SUITE = 'haiyue-production-gltf-first-visible-corpus';
const LARGE_KTX2_UPLOAD_CALL_MAX = 64;
const LARGE_CPU_STAGING_BYTES_MAX = Math.floor(51.8 * 1024 * 1024);

const PHASES = [
  'fetchMs',
  'workerParseMs',
  'dracoDecodeMs',
  'instantiateMs',
  'imageDecodeTranscodeMs',
  'gpuUploadMs',
  'pipelineWarmupMs',
  'visibleSubmitMs',
  'firstVisibleFrameMs',
];

export function validateGltfCorpusResult(result, manifest) {
  const errors = [];
  const fail = message => errors.push(message);
  if (!result || typeof result !== 'object') return ['result must be an object'];
  if (result.schemaVersion !== GLTF_CORPUS_SCHEMA_VERSION) fail(`schemaVersion must be ${GLTF_CORPUS_SCHEMA_VERSION}`);
  if (result.suite !== GLTF_CORPUS_SUITE) fail(`suite must be ${GLTF_CORPUS_SUITE}`);
  if (result.configuration?.mode !== 'optimized') fail('validated corpus result must use optimized mode');
  if (result.configuration?.gltfWorker !== 'production-inline') {
    fail('glTF corpus did not use the production inline asset worker');
  }
  if (result.configuration?.ktx2Worker !== true) fail('glTF corpus did not use the KTX2 worker');
  if (result.configuration?.ktx2WorkerPoolSize !== 4) {
    fail('glTF corpus did not use the bounded four-worker KTX2 pool');
  }
  if (!result.environment?.adapter || !Object.values(result.environment.adapter).some(Boolean)) fail('adapter identity is missing');
  validateAnimation3DResult(result.animation3D, fail);
  if (!Array.isArray(result.tiers) || result.tiers.length !== 3) return [...errors, 'exactly three corpus tiers are required'];

  for (const expected of manifest.tiers) {
    const tier = result.tiers.find(entry => entry.id === expected.id);
    if (!tier) {
      fail(`tier ${expected.id} is missing`);
      continue;
    }
    if (tier.asset.entry !== expected.entry) fail(`${expected.id} entry does not match the pinned manifest`);
    for (const [name, value] of Object.entries(expected.expected)) {
      if (tier.asset[name] !== value) fail(`${expected.id} asset.${name} must be ${value}, received ${tier.asset[name]}`);
    }
    for (const phase of PHASES) {
      const value = tier.timings?.[phase];
      if (!Number.isFinite(value) || value < 0) fail(`${expected.id} timings.${phase} must be finite and non-negative`);
    }
    if (!(tier.timings.firstVisibleFrameMs > 0)) fail(`${expected.id} first-visible time must be positive`);
    if (!(tier.timings.workerParseMs > 0)) fail(`${expected.id} did not execute measured worker parsing`);
    if (tier.timings.firstVisibleFrameMs > expected.gate.firstVisibleFrameMaxMs) {
      fail(`${expected.id} first-visible ${tier.timings.firstVisibleFrameMs}ms exceeds ${expected.gate.firstVisibleFrameMaxMs}ms`);
    }
    if (!(tier.resources?.assetTransferBytes > 0)) fail(`${expected.id} assetTransferBytes must be positive`);
    if (!(tier.resources?.sourceBytes > 0)) fail(`${expected.id} sourceBytes must be positive`);
    if (!(tier.resources?.decodedGeometryBytes > 0)) fail(`${expected.id} decodedGeometryBytes must be positive`);
    if (!(tier.resources?.workerTransferBytes > 0)) fail(`${expected.id} did not transfer worker geometry`);
    if (!(tier.resources?.workerTransferBufferCount > 0)) fail(`${expected.id} did not transfer worker buffers`);
    if (!(tier.resources?.peakCpuStagingBytes >= tier.resources.decodedGeometryBytes)) {
      fail(`${expected.id} peakCpuStagingBytes must cover decoded geometry`);
    }
    if (!(tier.resources?.peakGpuEstimatedBytes > 0)) fail(`${expected.id} peakGpuEstimatedBytes must be positive`);
    if (!(tier.resources?.gpuUploadCalls > 0)) fail(`${expected.id} gpuUploadCalls must be positive`);
    if (!(tier.resources?.gpuUploadBytes > 0)) fail(`${expected.id} gpuUploadBytes must be positive`);
    if (tier.resources?.pendingUploadTasksAfterVisible !== 0) fail(`${expected.id} left upload tasks after first visible`);
    if (tier.resources?.postVisibleAssetUploadBytes !== 0) fail(`${expected.id} deferred asset uploads past first visible`);
    if (tier.render?.passCount !== 2) fail(`${expected.id} must use one warmup and one visible pass`);
    if (tier.render?.visiblePixel !== true) fail(`${expected.id} rendered output remained at the clear value`);
    if (tier.lifecycle?.duplicateLoad !== true) fail(`${expected.id} duplicate load did not complete`);
    if (!(tier.lifecycle?.recordCacheHits > 0)) fail(`${expected.id} did not prove an AssetManager record cache hit`);
    if (tier.lifecycle?.sceneDestroyResidualRecords !== 0) fail(`${expected.id} retained AssetManager records after scene destroy`);
  }

  const medium = result.tiers.find(tier => tier.id === 'medium');
  if (!(medium?.timings?.dracoDecodeMs > 0)) fail('medium tier did not execute a measured Draco decode');
  const large = result.tiers.find(tier => tier.id === 'large');
  const largeBudget = manifest.tiers.find(tier => tier.id === 'large')?.gate.uploadFrameBudgetBytes;
  if (!(large?.resources?.assetUploadCalls > 1)) fail('large tier did not exercise split AssetUploadScheduler uploads');
  if (large?.resources?.assetUploadCalls > LARGE_KTX2_UPLOAD_CALL_MAX) {
    fail(`large asset upload calls ${large.resources.assetUploadCalls} exceeds ${LARGE_KTX2_UPLOAD_CALL_MAX}`);
  }
  if (large?.resources?.peakCpuStagingBytes > LARGE_CPU_STAGING_BYTES_MAX) {
    fail(`large CPU staging ${large.resources.peakCpuStagingBytes} exceeds ${LARGE_CPU_STAGING_BYTES_MAX}`);
  }
  if (large?.resources?.maxFrameAssetUploadBytes > largeBudget) {
    fail(`large max frame upload ${large.resources.maxFrameAssetUploadBytes} exceeds ${largeBudget}`);
  }
  if (large?.lifecycle?.recoveryFailures !== 0) fail('large tier device recovery reported failures');
  if (!(large?.lifecycle?.recoveredTextureRecords > 0)) fail('large tier did not recover compressed texture records');

  if (result.lifecycle?.cancelledLoadRejected !== true) fail('in-flight cancellation did not reject');
  if (result.lifecycle?.cancelledLoadWasInFlight !== true) fail('cancellation only covered a pre-aborted request');
  if (result.resources?.liveGpuResourcesAfterDestroy !== 0) fail('liveGpuResourcesAfterDestroy must be 0');
  if (result.resources?.liveGpuBytesAfterDestroy !== 0) fail('liveGpuBytesAfterDestroy must be 0');
  if (result.resources?.releasedOwnerResiduals !== 0) fail('releasedOwnerResiduals must be 0');
  if (!Array.isArray(result.validation?.errors) || result.validation.errors.length > 0) {
    fail(`WebGPU validation errors: ${(result.validation?.errors ?? []).join('; ')}`);
  }
  if (!Array.isArray(result.validation?.uncapturedErrors) || result.validation.uncapturedErrors.length > 0) {
    fail(`uncaptured WebGPU errors: ${(result.validation?.uncapturedErrors ?? []).join('; ')}`);
  }
  if (result.validation?.deviceLost !== false) fail('GPU device was lost during the corpus gate');
  return errors;
}

function validateAnimation3DResult(animation, fail) {
  if (!animation || typeof animation !== 'object') {
    fail('Animation3D browser evidence is missing');
    return;
  }
  if (animation.fixture !== '/extensions/test/fixtures/gltf/animation-characterization.gltf') {
    fail('Animation3D evidence did not use the pinned characterization fixture');
  }
  if (!sameStrings(animation.clipIds, ['Idle', 'Run'])) {
    fail('Animation3D evidence must cross-fade Idle to Run');
  }
  if (!sameStrings(animation.interpolation, ['cubic-spline', 'linear', 'step'])) {
    fail('Animation3D evidence must preserve STEP, LINEAR, and CUBICSPLINE');
  }
  if (animation.gpuMorph !== true) fail('Animation3D cross-fade did not use GPU morph');
  if (animation.skinning !== true) fail('Animation3D cross-fade did not use skinning');
  if (animation.positionsRemainBase !== true) {
    fail('Animation3D GPU morph cross-fade modified CPU base positions');
  }

  const phases = Array.isArray(animation.phases) ? animation.phases : [];
  if (phases.length !== 3) {
    fail('Animation3D evidence requires start, mid, and end phases');
  } else {
    const expectations = [
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
        jointTranslation: [0, 0, 0, 1],
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
        jointTranslation: [0, 0.5, 0, 1],
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
        jointTranslation: [0, 2, 0, 1],
      },
    ];
    for (let index = 0; index < expectations.length; index++) {
      const phase = phases[index];
      const expected = expectations[index];
      if (phase?.name !== expected.name) fail(`Animation3D phase ${index} must be ${expected.name}`);
      if (!closeNumber(phase?.mixerTime, expected.mixerTime)) {
        fail(`Animation3D ${expected.name} mixer time is incorrect`);
      }
      if (!closeArray(phase?.rootLocalMatrix, expected.rootLocalMatrix)) {
        fail(`Animation3D ${expected.name} root TRS pose is incorrect`);
      }
      if (!closeArray(phase?.morphWeights, expected.morphWeights)) {
        fail(`Animation3D ${expected.name} morph pose is incorrect`);
      }
      if (!closeArray(phase?.skinJointTipMatrix?.slice?.(12, 16), expected.jointTranslation)) {
        fail(`Animation3D ${expected.name} joint pose is incorrect`);
      }
      if (phase?.visiblePixel !== true) {
        fail(`Animation3D ${expected.name} WebGPU frame remained at the clear value`);
      }
    }
  }

  if (animation.lifecycle?.runtimeState !== 'destroyed') {
    fail('Animation3D runtime survived model disposal');
  }
  for (const field of ['actionCount', 'bindingCount', 'targetCount']) {
    if (animation.lifecycle?.[field] !== 0) {
      fail(`Animation3D lifecycle ${field} must be 0`);
    }
  }
}

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function closeArray(actual, expected, epsilon = 1e-4) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => closeNumber(value, expected[index], epsilon));
}

function closeNumber(actual, expected, epsilon = 1e-4) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon;
}
