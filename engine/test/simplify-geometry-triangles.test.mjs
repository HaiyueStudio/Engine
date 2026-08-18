import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineErrorCode } from '../dist/core.js';
import {
  Geometry3D,
  createIcosahedron3D,
  simplifyGeometryTriangles,
} from '../dist/geometry.js';

const isGeometryParameterError = error => error?.code === EngineErrorCode.GeometryInvalidParameter;

test('simplifyGeometryTriangles reaches reviewed QEM targets on a closed indexed mesh', () => {
  const source = createIcosahedron3D({ radius: 2, detail: 2 });
  const half = simplifyGeometryTriangles(source, { targetRatio: 0.5 });
  const quarter = simplifyGeometryTriangles(source, { targetTriangleCount: 80 });

  assert.equal(source.indices.length / 3, 320);
  assert.equal(source.vertexCount, 162);
  assert.equal(half.indices.length / 3, 160);
  assert.equal(half.vertexCount, 82);
  assert.equal(quarter.indices.length / 3, 80);
  assert.equal(quarter.vertexCount, 42);
  assert.equal(half.indices instanceof Uint16Array, true);
  assert.equal(half.indices.every(index => index < half.vertexCount), true);
  assert.equal(hasDegenerateIndexFace(half.indices), false);
});

test('simplifyGeometryTriangles locks open boundaries unless explicitly disabled', () => {
  const source = new Geometry3D({
    positions: new Float32Array([
      -1, 0, -1,
       1, 0, -1,
       1, 0,  1,
      -1, 0,  1,
    ]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  });

  const locked = simplifyGeometryTriangles(source, { targetTriangleCount: 1 });
  const unlocked = simplifyGeometryTriangles(source, {
    targetTriangleCount: 1,
    preserveBoundary: false,
  });

  assert.equal(locked.indices.length / 3, 2);
  assert.equal(locked.vertexCount, 4);
  assert.equal(unlocked.indices.length / 3, 1);
  assert.equal(unlocked.vertexCount, 3);
});

test('simplifyGeometryTriangles interpolates every deformation stream and keeps its source independent', () => {
  const positions = octahedronPositions();
  const normals = Float32Array.from(positions);
  const uv2 = new Float32Array(Array.from({ length: 6 }, (_, index) => [index, index + 0.5]).flat());
  const phase = new Float32Array(Array.from({ length: 6 }, (_, index) => [index, index + 10]).flat());
  const morphPositions = Float32Array.from(positions, value => value * 0.1);
  const morphNormals = Float32Array.from(positions, value => value * 0.2);
  const joints = new Float32Array(Array.from({ length: 6 }, (_, index) => [index, 7, 0, 0]).flat());
  const weights = new Float32Array(Array.from({ length: 6 }, () => [1, 0, 0, 0]).flat());
  const source = new Geometry3D({
    positions,
    normals,
    textureCoordinates: [{ set: 2, data: uv2 }],
    textureCoordinateLayout: [2],
    indices: octahedronIndices(),
    topology: 'triangle-list',
    cullMode: 'none',
    frontFace: 'cw',
    customAttributes: [{
      name: 'phase',
      location: 7,
      format: 'float32x2',
      itemSize: 2,
      data: phase,
    }],
    instanceAttributes: [{
      name: 'instancePhase',
      location: 8,
      format: 'float32',
      itemSize: 1,
      data: new Float32Array([5, 6]),
      instanceCount: 2,
    }],
    instanceCount: 2,
    morphTargets: [{ positions: morphPositions, normals: morphNormals }],
    morphWeights: [0.4],
    skinning: { joints, weights, jointMatrices: identityMatrix() },
    boundsMode: 'manual',
    localBounds: { center: [0, 0, 0], radius: 2 },
  });
  source.morphBasePositions = Float32Array.from(source.positions, value => value + 2);
  source.morphBaseNormals = Float32Array.from(source.normals);

  const result = simplifyGeometryTriangles(source, { targetTriangleCount: 6 });
  const inverseSqrt2 = Math.SQRT1_2;

  assert.equal(result.indices.length / 3, 6);
  assert.equal(result.vertexCount, 5);
  assert.deepEqual(Array.from(result.positions.slice(0, 3)), [0.5, 0.5, 0]);
  assert.ok(Math.abs(result.normals[0] - inverseSqrt2) < 1e-6);
  assert.ok(Math.abs(result.normals[1] - inverseSqrt2) < 1e-6);
  assert.deepEqual(Array.from(result.getTextureCoordinates(2).slice(0, 2)), [1, 1.5]);
  assert.deepEqual(Array.from(result.customAttributes.get('phase').data.slice(0, 2)), [1, 11]);
  assertFloatArrayClose(result.morphTargets[0].positions.slice(0, 3), [0.05, 0.05, 0]);
  assertFloatArrayClose(result.morphTargets[0].normals.slice(0, 3), [0.1, 0.1, 0]);
  assert.deepEqual(Array.from(result.skinning.joints.slice(0, 4)), [0, 2, 0, 0]);
  assert.deepEqual(Array.from(result.skinning.weights.slice(0, 4)), [0.5, 0.5, 0, 0]);
  assert.deepEqual(Array.from(result.morphBasePositions.slice(0, 3)), [2.5, 2.5, 2]);
  assert.ok(Math.abs(result.morphBaseNormals[0] - inverseSqrt2) < 1e-6);
  assert.deepEqual(result.textureCoordinateLayout, [2]);
  assert.equal(result.topology, 'triangle-list');
  assert.equal(result.cullMode, 'none');
  assert.equal(result.frontFace, 'cw');
  assert.equal(result.instanceCount, 2);
  assert.deepEqual(Array.from(result.instanceAttributes.get('instancePhase').data), [5, 6]);
  assert.deepEqual(result.localBounds, { center: [0, 0, 0], radius: 2 });

  result.positions[0] = 99;
  result.getTextureCoordinates(2)[0] = 99;
  result.instanceAttributes.get('instancePhase').data[0] = 99;
  assert.deepEqual(Array.from(source.positions.slice(0, 3)), [0, 1, 0]);
  assert.equal(source.getTextureCoordinates(2)[0], 0);
  assert.equal(source.instanceAttributes.get('instancePhase').data[0], 5);
});

test('simplifyGeometryTriangles removes duplicate/degenerate faces and supports empty indexed geometry', () => {
  const source = new Geometry3D({
    positions: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]),
    indices: new Uint16Array([0, 1, 2, 2, 1, 0, 0, 0, 1]),
  });
  const cleaned = simplifyGeometryTriangles(source, { targetRatio: 1 });
  const empty = simplifyGeometryTriangles(new Geometry3D({
    positions: new Float32Array(),
    indices: new Uint16Array(),
  }));

  assert.deepEqual(Array.from(cleaned.indices), [0, 1, 2]);
  assert.equal(cleaned.vertexCount, 3);
  assert.equal(empty.vertexCount, 0);
  assert.equal(empty.indices.length, 0);
});

test('simplifyGeometryTriangles rejects ambiguous topology, targets, and mutable streams', () => {
  const line = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    indices: new Uint16Array(),
    topology: 'line-list',
  });
  assert.throws(() => simplifyGeometryTriangles(line), isGeometryParameterError);

  const nonIndexed = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  });
  assert.throws(() => simplifyGeometryTriangles(nonIndexed), isGeometryParameterError);
  assert.throws(
    () => simplifyGeometryTriangles(octahedron(), { targetRatio: 0.5, targetTriangleCount: 4 }),
    isGeometryParameterError,
  );
  assert.throws(() => simplifyGeometryTriangles(octahedron(), { targetRatio: 0 }), isGeometryParameterError);
  assert.throws(() => simplifyGeometryTriangles(octahedron(), { targetRatio: 1.1 }), isGeometryParameterError);
  assert.throws(() => simplifyGeometryTriangles(octahedron(), { targetTriangleCount: 0 }), isGeometryParameterError);

  const incomplete = octahedron();
  incomplete.indices = new Uint16Array([0, 1]);
  assert.throws(() => simplifyGeometryTriangles(incomplete), isGeometryParameterError);

  const outOfRange = octahedron();
  outOfRange.indices = new Uint16Array([0, 1, 99]);
  assert.throws(() => simplifyGeometryTriangles(outOfRange), isGeometryParameterError);

  const badAttribute = octahedron();
  badAttribute.customAttributes.set('bad', {
    name: 'bad',
    location: 7,
    format: 'float32',
    itemSize: 1,
    data: new Float32Array(2),
  });
  assert.throws(() => simplifyGeometryTriangles(badAttribute), isGeometryParameterError);
});

function octahedron() {
  return new Geometry3D({ positions: octahedronPositions(), indices: octahedronIndices() });
}

function octahedronPositions() {
  return new Float32Array([
     0,  1,  0,
     0, -1,  0,
     1,  0,  0,
     0,  0,  1,
    -1,  0,  0,
     0,  0, -1,
  ]);
}

function octahedronIndices() {
  return new Uint16Array([
    0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 2,
    1, 3, 2, 1, 4, 3, 1, 5, 4, 1, 2, 5,
  ]);
}

function identityMatrix() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

function hasDegenerateIndexFace(indices) {
  for (let offset = 0; offset < indices.length; offset += 3) {
    if (indices[offset] === indices[offset + 1]
      || indices[offset + 1] === indices[offset + 2]
      || indices[offset + 2] === indices[offset]) return true;
  }
  return false;
}

function assertFloatArrayClose(actual, expected, epsilon = 1e-6) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= epsilon);
  }
}
