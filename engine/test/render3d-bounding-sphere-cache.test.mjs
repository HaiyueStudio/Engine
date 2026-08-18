import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Entity,
  Geometry3D,
  Render3DSystem,
  World,
} from '../dist/experimental.js';
import { MaterialRendererRegistry } from '../dist/material.js';

const IDENTITY = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function createRender3DSystem() {
  const engine = {
    device: { features: new Set() },
    width: 640,
    height: 360,
    reverseZ: false,
    msaaSamples: 1,
  };
  return new Render3DSystem(engine, new Entity('Camera'), {
    materialRenderers: new MaterialRendererRegistry(),
    registerDefaultMaterialRenderers: false,
    renderProfile: 'batched',
  });
}

function createGeometry(offset = 0) {
  return new Geometry3D({
    positions: new Float32Array([
      offset, 0, 0,
      offset + 2, 0, 0,
      offset, 2, 0,
    ]),
  });
}

test('Render3DSystem recomputes cached bounds when geometry version changes', () => {
  const render3D = createRender3DSystem();
  const geometry = createGeometry();

  render3D._beginLiveCacheFrame();
  const initialSphere = render3D._getWorldBoundingSphere(geometry, IDENTITY);
  geometry.positions.set([
    100, 0, 0,
    102, 0, 0,
    100, 2, 0,
  ]);
  geometry.markDirty();

  render3D._beginLiveCacheFrame();
  const updatedSphere = render3D._getWorldBoundingSphere(geometry, IDENTITY);
  assert.deepEqual(initialSphere.center, [2 / 3, 2 / 3, 0]);
  assert.deepEqual(updatedSphere.center, [100 + 2 / 3, 2 / 3, 0]);
  assert.equal(render3D._boundsCache.size, 1);
});

test('Render3DSystem sweeps stale bounds while retaining geometry used in the current frame', () => {
  const render3D = createRender3DSystem();
  const world = new World('Render3DBoundsCacheLifecycle');
  const persistentGeometry = createGeometry();
  const staleGeometry = createGeometry(10);

  render3D._beginLiveCacheFrame();
  render3D._getWorldBoundingSphere(persistentGeometry, IDENTITY);
  render3D._getWorldBoundingSphere(staleGeometry, IDENTITY);
  render3D._sweepLiveCacheMarkers(world);

  // Match the production sweep cadence while continuously churning geometry.
  for (let frame = 1; frame < 120; frame++) {
    render3D._beginLiveCacheFrame();
    render3D._getWorldBoundingSphere(persistentGeometry, IDENTITY);
    render3D._getWorldBoundingSphere(createGeometry(frame * 100), IDENTITY);
    render3D._sweepLiveCacheMarkers(world);
  }

  assert.equal(render3D._boundsCache.has(staleGeometry.id), false);
  assert.equal(render3D._boundsCache.has(persistentGeometry.id), true);
  assert.equal(render3D._boundsCache.size, 2);
});

test('GPU morph and skinning default to fail-open dynamic bounds', () => {
  const render3D = createRender3DSystem();
  const gpuMorph = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    morphTargets: [{ positions: new Float32Array([100, 0, 0, 100, 0, 0, 100, 0, 0]) }],
  });
  const skinned = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    skinning: {
      joints: new Float32Array(12),
      weights: new Float32Array(12),
      jointMatrices: IDENTITY,
    },
  });

  render3D._beginLiveCacheFrame();
  assert.equal(gpuMorph.boundsMode, 'dynamic');
  assert.equal(skinned.boundsMode, 'dynamic');
  assert.equal(render3D._getWorldBoundingSphere(gpuMorph, IDENTITY), null);
  assert.equal(render3D._getWorldBoundingSphere(skinned, IDENTITY), null);
  assert.equal(render3D._boundsCache.size, 0);
});

test('empty geometry skips static bound construction and cache retention', () => {
  const render3D = createRender3DSystem();
  const geometry = new Geometry3D({ positions: new Float32Array(0) });

  render3D._beginLiveCacheFrame();
  assert.equal(render3D._getWorldBoundingSphere(geometry, IDENTITY), null);
  assert.equal(render3D._boundsCache.has(geometry.id), false);
});

test('dynamic/manual geometry uses caller-provided conservative local bounds', () => {
  const render3D = createRender3DSystem();
  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    boundsMode: 'manual',
    localBounds: { center: [25, 2, -4], radius: 12 },
  });

  render3D._beginLiveCacheFrame();
  assert.deepEqual(render3D._getWorldBoundingSphere(geometry, IDENTITY), {
    center: [25, 2, -4],
    radius: 12,
  });
  assert.equal(render3D._boundsCache.size, 0);
  assert.throws(
    () => new Geometry3D({ positions: geometry.positions, boundsMode: 'manual' }),
    /manual boundsMode requires localBounds/,
  );
});

test('CPU morph remains versioned static geometry while switching to GPU morph disables culling', () => {
  const render3D = createRender3DSystem();
  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    morphTargets: [{ positions: new Float32Array(9) }],
    morphUseGpu: false,
  });
  assert.equal(geometry.boundsMode, 'static');
  render3D._beginLiveCacheFrame();
  assert.ok(render3D._getWorldBoundingSphere(geometry, IDENTITY));
  geometry.setMorphUseGpu(true);
  assert.equal(geometry.boundsMode, 'dynamic');
  assert.equal(render3D._getWorldBoundingSphere(geometry, IDENTITY), null);
});
