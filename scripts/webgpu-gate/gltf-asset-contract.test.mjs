import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  GLTF_ASSET_BASELINE_SCHEMA_VERSION,
  GLTF_ASSET_BASELINE_SUITE,
  validateGltfAssetBaselineResult,
} from './gltf-asset-contract.mjs';

function validResult() {
  return {
    schemaVersion: GLTF_ASSET_BASELINE_SCHEMA_VERSION,
    suite: GLTF_ASSET_BASELINE_SUITE,
    environment: { adapter: { vendor: 'test' } },
    asset: { fixtureVersion: 1, primitiveCount: 1, textureCount: 2, animationCount: 1 },
    contract: {
      uvSemantics: [{
        capacity: 2,
        referencedSemantics: ['TEXCOORD_2', 'TEXCOORD_5'],
        mappings: [
          { semantic: 'TEXCOORD_2', set: 2, channel: 0 },
          { semantic: 'TEXCOORD_5', set: 5, channel: 1 },
        ],
      }],
      extensions: [{
        extension: 'KHR_materials_clearcoat',
        required: true,
        support: 'supported',
        disposition: 'supported',
      }],
      clearcoat: [{ factor: 0.9, roughnessFactor: 0.22, normalScale: 0.8 }],
    },
    timings: { fetchMs: 1, firstVisibleFrameMs: 20 },
    resources: {
      assetTransferBytes: 100,
      peakCpuStagingBytes: 200,
      peakGpuEstimatedBytes: 300,
      peakGpuBufferBytes: 100,
      peakGpuTextureBytes: 200,
      gpuUploadBytes: 150,
      liveGpuResourcesAfterDestroy: 0,
      liveGpuBytesAfterDestroy: 0,
      releasedOwnerResiduals: 0,
    },
    lifecycle: { cancelledLoadRejected: true, recoveryFailures: 0 },
    validation: { errors: [], uncapturedErrors: [], deviceLost: false, visiblePixel: true },
  };
}

test('real glTF asset baseline contract accepts a complete dynamic-UV lifecycle result', () => {
  assert.deepEqual(validateGltfAssetBaselineResult(validResult(), {
    budgets: { firstVisibleFrameMaxMs: 100, peakGpuEstimatedBytesMax: 1_000, peakCpuStagingBytesMax: 1_000 },
  }), []);
});

test('real glTF asset baseline contract rejects semantic drift and lifecycle residuals', () => {
  const result = validResult();
  result.contract.uvSemantics[0].mappings[0].channel = 1;
  result.resources.liveGpuResourcesAfterDestroy = 1;
  result.lifecycle.recoveryFailures = 1;
  const errors = validateGltfAssetBaselineResult(result);
  assert.ok(errors.some(error => error.includes('dynamic UV physical mapping')));
  assert.ok(errors.some(error => error.includes('liveGpuResourcesAfterDestroy')));
  assert.ok(errors.some(error => error.includes('device recovery')));
});

test('real glTF browser fixtures map every engine runtime subpath used by the extension bundle', async () => {
  for (const fixture of ['gltf-asset-fixture.html', 'shader-language-stage4-fixture.html']) {
    const html = await readFile(new URL(`./${fixture}`, import.meta.url), 'utf8');
    for (const subpath of ['assets', 'components', 'core', 'ecs', 'experimental', 'material']) {
      assert.match(
        html,
        new RegExp(`"@haiyue/engine/${subpath}"\\s*:\\s*"/engine/dist/${subpath}\\.js"`),
        fixture,
      );
    }
    assert.match(
      html,
      /"@haiyue\/engine\/experimental\/async"\s*:\s*"\/engine\/dist\/experimental\/async\.js"/,
      fixture,
    );
  }
});

test('real glTF browser fixture consumes domain APIs from their stable subpath', async () => {
  const source = await readFile(new URL('./gltf-asset-fixture.mjs', import.meta.url), 'utf8');
  assert.match(source, /import\s+\{\s*AssetManager\s*\}\s+from '\/engine\/dist\/assets\.js'/);
  assert.doesNotMatch(source, /AssetManager[\s\S]*from '\/engine\/dist\/index\.js'/);
});
