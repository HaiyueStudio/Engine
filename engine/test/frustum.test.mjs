import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EngineErrorCode,
  Frustum,
  Geometry3D,
  computeBoundingSphere,
  transformBoundingSphere,
} from '../dist/experimental.js';

const IDENTITY = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

test('bounding spheres validate triplets and preserve conservative non-uniform scale', () => {
  const sphere = computeBoundingSphere(new Float32Array([
    0, 0, 0,
    2, 0, 0,
    0, 2, 0,
  ]));
  assert.deepEqual(sphere.center, [2 / 3, 2 / 3, 0]);
  assert.ok(Math.abs(sphere.radius - Math.sqrt(20) / 3) < 1e-6);

  const transformed = transformBoundingSphere(sphere, new Float32Array([
    2, 0, 0, 0,
    0, 3, 0, 0,
    0, 0, 4, 0,
    10, 20, 30, 1,
  ]));
  assert.deepEqual(transformed.center, [10 + 4 / 3, 22, 30]);
  assert.ok(Math.abs(transformed.radius - sphere.radius * 4) < 1e-6);

  for (const positions of [new Float32Array(), new Float32Array([0, 1])]) {
    assert.throws(
      () => computeBoundingSphere(positions),
      error => error.code === EngineErrorCode.GeometryInvalidParameter,
    );
  }
  assert.throws(
    () => transformBoundingSphere(sphere, new Float32Array(15)),
    error => error.code === EngineErrorCode.GeometryInvalidParameter,
  );
});

test('Frustum extracts WebGPU depth planes and classifies points and spheres', () => {
  const frustum = new Frustum().setFromViewProjection(IDENTITY);
  assert.equal(frustum.containsPoint([0, 0, 0]), true);
  assert.equal(frustum.containsPoint([0, 0, 1]), true);
  assert.equal(frustum.containsPoint([0, 0, -0.01]), false);
  assert.equal(frustum.containsPoint([1.01, 0, 0.5]), false);
  assert.equal(frustum.containsSphere({ center: [1.2, 0, 0.5], radius: 0.25 }), true);
  assert.equal(frustum.containsSphere({ center: [1.2, 0, 0.5], radius: 0.1 }), false);

  const planes = frustum.copyPlanesTo(new Float32Array(24));
  assert.deepEqual(Array.from(planes.slice(0, 4)), [1, 0, 0, 1]);
  assert.deepEqual(Array.from(planes.slice(16, 20)), [0, 0, 1, 0]);
});

test('Frustum rejects short matrices and degenerate explicit planes', () => {
  assert.throws(
    () => new Frustum().setFromViewProjection(new Float32Array(15)),
    error => error.code === EngineErrorCode.GeometryInvalidParameter,
  );
  assert.throws(
    () => new Frustum().setFromViewProjection(new Float32Array(16)),
    error => error.code === EngineErrorCode.GeometryInvalidParameter && /plane 0/.test(error.message),
  );
  const planes = new Float32Array(24);
  planes.set([1, 0, 0, 1], 0);
  assert.throws(
    () => new Frustum().setFromPlanes(planes),
    error => error.code === EngineErrorCode.GeometryInvalidParameter && /plane 1/.test(error.message),
  );
});

test('Frustum geometry tests preserve any/all semantics for indexed and direct triangles', () => {
  const positions = new Float32Array([
    -0.25, -0.25, 0.5,
     0.25, -0.25, 0.5,
     0.00,  0.25, 0.5,
     2.00,  2.00, 0.5,
     2.50,  2.00, 0.5,
     2.00,  2.50, 0.5,
  ]);
  const frustum = new Frustum().setFromViewProjection(IDENTITY);
  const direct = new Geometry3D({ positions });
  const indexed = new Geometry3D({ positions, indices: new Uint16Array([0, 1, 2, 3, 4, 5]) });

  for (const geometry of [direct, indexed]) {
    assert.equal(frustum.intersectsGeometry(geometry, IDENTITY, 'any'), true);
    assert.equal(frustum.intersectsGeometry(geometry, IDENTITY, 'all'), false);
    assert.throws(
      () => frustum.intersectsGeometry(geometry, new Float32Array(12)),
      error => error.code === EngineErrorCode.GeometryInvalidParameter,
    );
  }
});
