import assert from 'node:assert/strict';
import test from 'node:test';

import * as extensionsRoot from '@haiyue/extensions';
import {
  rayAcceleration,
  rayDenoise,
  rayHybrid,
  rayLifecycle,
  rayMaterial,
  rayPathTracing,
  rayReference,
  raySampling,
  rayScene,
  rayTraversal,
  rayWorker,
} from '@haiyue/extensions/ray-tracing';

test('focused ray-tracing export resolves every owner without entering the extensions root', () => {
  assert.equal('rayPathTracing' in extensionsRoot, false);
  assert.equal(typeof rayReference.traceRayBruteForce, 'function');
  assert.equal(typeof rayScene.extractRayTracingScene, 'function');
  assert.equal(typeof rayAcceleration.RayAccelerationBuilder, 'function');
  assert.equal(typeof rayTraversal.RayTraversalRuntime, 'function');
  assert.equal(typeof rayMaterial.packRayPbrMaterialScene, 'function');
  assert.equal(typeof rayPathTracing.RayPathTracingRenderer, 'function');
  assert.equal(typeof raySampling.RayProgressiveRenderer, 'function');
  assert.equal(typeof rayDenoise.RaySpatialTemporalDenoiser, 'function');
  assert.equal(typeof rayHybrid.RayHybridRenderer, 'function');
  assert.equal(typeof rayWorker.RayAccelerationWorkerClient, 'function');
  assert.equal(typeof rayLifecycle.RayDeviceRecoveryOwner, 'function');
});
