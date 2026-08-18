import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BasisTransform3D,
  CartesianTransform3D,
  SphericalTransform3D,
  Transform2D,
  Transform3D,
} from '../dist/experimental.js';

test('BasisTransform3D maps coordinates through basis columns and clones independently', () => {
  const transform = new BasisTransform3D({
    coordinates: [2, 3, 5],
    basisX: [1, 2, 0],
    basisY: [0, 1, 3],
    basisZ: [4, 0, 1],
  });

  assert.deepEqual(Array.from(transform.localMatrix.slice(0, 12)), [
    1, 2, 0, 0,
    0, 1, 3, 0,
    4, 0, 1, 0,
  ]);
  assert.deepEqual(Array.from(transform.mappedPosition), [22, 7, 14]);

  const clone = transform.clone();
  clone.setBasisX(9, 8, 7);
  assert.deepEqual(Array.from(transform.basisX), [1, 2, 0]);
  assert.deepEqual(Array.from(clone.basisX), [9, 8, 7]);
});

test('CartesianTransform3D preserves TRS and anchor matrix semantics', () => {
  const transform = new CartesianTransform3D({
    position: [10, 20, 30],
    scale: [2, 3, 4],
    anchor: [1, 1, 1],
  });

  assert.equal(transform.localMatrix[0], 2);
  assert.equal(transform.localMatrix[5], 3);
  assert.equal(transform.localMatrix[10], 4);
  assert.deepEqual(Array.from(transform.localMatrix.slice(12, 15)), [9, 19, 29]);
});

test('SphericalTransform3D keeps eye position and local matrix translation aligned', () => {
  const transform = new SphericalTransform3D({
    radius: 5,
    theta: Math.PI / 2,
    phi: Math.PI / 2,
    target: [1, 2, 3],
  });
  const eye = transform.eyePosition;

  assert.ok(Math.abs(eye[0] - 6) < 1e-5);
  assert.ok(Math.abs(eye[1] - 2) < 1e-5);
  assert.ok(Math.abs(eye[2] - 3) < 1e-5);
  assert.deepEqual(Array.from(eye), Array.from(transform.localMatrix.slice(12, 15)));

  const clone = transform.clone();
  clone.setTarget(10, 20, 30);
  assert.deepEqual(Array.from(transform.target), [1, 2, 3]);
});

test('Transform3D rejects incomplete matrix boundaries before copying or multiplying', () => {
  const transform = new Transform3D();

  assert.throws(
    () => { transform.localMatrix = new Float32Array(15); },
    error => error instanceof RangeError && /16 elements/.test(error.message),
  );
  assert.throws(
    () => transform.setMatrix(new Float32Array(15)),
    error => error instanceof RangeError && /16 elements/.test(error.message),
  );
  assert.throws(
    () => transform.updateWorldMatrix(new Float32Array(15), 1),
    error => error instanceof RangeError && /16 elements/.test(error.message),
  );

  transform.worldMatrix = new Float32Array(15);
  assert.throws(
    () => transform.updateWorldMatrix(undefined, 2),
    error => error instanceof RangeError && /16 elements/.test(error.message),
  );
});

test('Transform2D keeps root world versions stable and validates parent matrices', () => {
  const transform = new Transform2D({ x: 2, y: 3 });
  transform.updateWorldMatrix();
  const initialWorldVersion = transform.worldVersion;

  transform.updateWorldMatrix();
  assert.equal(transform.worldVersion, initialWorldVersion);

  transform.x = 4;
  transform.updateWorldMatrix();
  assert.equal(transform.worldVersion, initialWorldVersion + 1);
  assert.equal(transform.worldMatrix[12], 4);

  assert.throws(
    () => transform.updateWorldMatrix(new Float32Array(15), 1),
    error => error instanceof RangeError && /16 elements/.test(error.message),
  );
});
