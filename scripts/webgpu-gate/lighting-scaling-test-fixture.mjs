import { summarizeTimingSamples } from '../benchmark/timing-cohorts.mjs';
import { LIGHTING_SCALING_EVIDENCE_METRICS, LIGHTING_SCALING_RESULT_FORMAT, LIGHTING_SCALING_RESULT_SCHEMA_VERSION, LIGHTING_SCALING_TIMING_METRICS } from './lighting-scaling-contract.mjs';

function available(value) {
  return { status: 'available', value };
}

function unavailable(reason) {
  return { status: 'unavailable', reason };
}

export function passingForwardResult() {
  const timing = Object.fromEntries(
    LIGHTING_SCALING_TIMING_METRICS.map((name, index) => [
      name,
      available(summarizeTimingSamples([index + 1, index + 2, index + 3])),
    ]),
  );
  timing.gpuTimestamp = unavailable(
    'timestamp-query is not exposed by this adapter',
  );
  return {
    format: LIGHTING_SCALING_RESULT_FORMAT,
    schemaVersion: LIGHTING_SCALING_RESULT_SCHEMA_VERSION,
    suite: 'lighting.scaling.real-renderer',
    caseId: 'lighting.billiards-3d.6l.medium.25pct.4v.1080p',
    renderer: {
      name: 'PbrRenderer',
      lightingStrategy: 'forward',
    },
    configuration: {
      authoredAmbientLightCount: 1,
      authoredDirectionalLightCount: 1,
      authoredLocalLightCount: 6,
      authoredTotalLightCount: 8,
      viewCount: 4,
    },
    workload: {
      sourceSceneEntityCount: 43,
      runtimeWorldEntityCount: 53,
      sceneHttpRequestCount: 1,
      authoredLocalLightCount: 6,
      viewCount: 4,
    },
    metrics: {
      timing,
      evidence: {
        lightOverflow: available({
          authoredAmbientLightCount: 1,
          authoredDirectionalLightCount: 1,
          authoredLocalLightCount: 6,
          authoredTotalLightCount: 8,
          submittedAmbientLightCount: 1,
          submittedDirectionalLightCount: 1,
          submittedLocalLightCount: 6,
          submittedTotalLightCount: 8,
          overflowLocalLightCount: 0,
          overflowTotalLightCount: 0,
          rendererTotalLightCapacity: 8,
          rendererLocalLightCapacity: 6,
          renderingComplete: true,
          capability: 'complete-for-selected-input',
        }),
        perViewIsolation: available({
          viewCount: 4,
          isolated: true,
          violationCount: 0,
        }),
        clusteredTileDistribution: unavailable(
          'Forward renderer does not build clustered or tiled light lists',
        ),
        gpuResidentAllocation: available({
          residentBytes: 4_096,
          allocatedBytes: 8_192,
          allocationCount: 2,
          resourceCount: 2,
        }),
        sceneProvenance: available({
          sourceGame: 'billiards-3d',
          sceneRevision: 'lighting-scale-v1',
          fixtureId: 'lighting.billiards-3d.8l.medium.25pct.4v.1080p',
          cameraReplayId: 'billiards-3d-lighting-camera-v1',
          sourceFingerprint: 'sha256:fixture',
          sourceSceneEntityCount: 43,
          runtimeWorldEntityCount: 53,
          skippedComponentCount: 17,
          intentionallySkippedComponentCount: 6,
          intentionallySkippedComponentTypes: [
            'Camera2D',
            'Camera3D',
            'CanvasTextComponent',
            'KeyboardComponent',
            'ScriptComponent',
          ],
          unsupportedMaterialMeshCount: 11,
          unsupportedMaterialAffectedEntityCount: 11,
          unsupportedMaterialDiagnostics: [{
            code: 'BILLIARDS_REAL_RENDERER_UNSUPPORTED_MATERIAL',
            skippedMeshComponentCount: 11,
            affectedEntityCount: 11,
          }],
        }),
      },
    },
  };
}

