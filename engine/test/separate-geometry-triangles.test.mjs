import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineErrorCode } from '../dist/core.js';
import { Geometry3D, separateGeometryTriangles } from '../dist/geometry.js';

const isGeometryParameterError = error => error?.code === EngineErrorCode.GeometryInvalidParameter;

test('separateGeometryTriangles expands every per-vertex stream in triangle order', () => {
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    1, 1, 0,
    0, 1, 0,
  ]);
  const normals = new Float32Array([
    0, 0, 1,
    0, 0, 2,
    0, 0, 3,
    0, 0, 4,
  ]);
  const uv2 = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const phase = new Float32Array([0, 10, 1, 11, 2, 12, 3, 13]);
  const instanceData = new Float32Array([5, 6]);
  const morphPositions = new Float32Array([
    0, 0, 0,
    0.1, 0, 0,
    0.2, 0, 0,
    0.3, 0, 0,
  ]);
  const morphNormals = Float32Array.from(normals, value => value * 0.1);
  const joints = new Float32Array([
    0, 1, 2, 3,
    4, 5, 6, 7,
    8, 9, 10, 11,
    12, 13, 14, 15,
  ]);
  const weights = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  const jointMatrices = identityMatrix();
  const source = new Geometry3D({
    positions,
    normals,
    textureCoordinates: [{ set: 2, data: uv2 }],
    textureCoordinateLayout: [2],
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
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
      data: instanceData,
      instanceCount: 2,
    }],
    instanceCount: 2,
    morphTargets: [{ positions: morphPositions, normals: morphNormals }],
    morphWeights: [0.4],
    skinning: { joints, weights, jointMatrices },
    boundsMode: 'manual',
    localBounds: { center: [0.5, 0.5, 0], radius: 1 },
  });

  const result = separateGeometryTriangles(source);
  const vertexOrder = [0, 1, 2, 0, 2, 3];

  assert.equal(result.indices, null);
  assert.equal(result.vertexCount, 6);
  assert.deepEqual(Array.from(result.positions), expandForTest(positions, 3, vertexOrder));
  assert.deepEqual(Array.from(result.normals), expandForTest(normals, 3, vertexOrder));
  assert.deepEqual(Array.from(result.getTextureCoordinates(2)), expandForTest(uv2, 2, vertexOrder));
  assert.deepEqual(Array.from(result.customAttributes.get('phase').data), expandForTest(phase, 2, vertexOrder));
  assert.deepEqual(Array.from(result.morphTargets[0].positions), expandForTest(morphPositions, 3, vertexOrder));
  assert.deepEqual(Array.from(result.morphTargets[0].normals), expandForTest(morphNormals, 3, vertexOrder));
  assert.deepEqual(Array.from(result.skinning.joints), expandForTest(joints, 4, vertexOrder));
  assert.deepEqual(Array.from(result.skinning.weights), expandForTest(weights, 4, vertexOrder));
  assert.deepEqual(Array.from(result.morphBasePositions), expandForTest(positions, 3, vertexOrder));
  assert.deepEqual(Array.from(result.morphBaseNormals), expandForTest(normals, 3, vertexOrder));

  assert.deepEqual(result.textureCoordinateLayout, [2]);
  assert.equal(result.textureCoordinateLayoutKey, '0=TEXCOORD_2');
  assert.equal(result.topology, 'triangle-list');
  assert.equal(result.cullMode, 'none');
  assert.equal(result.frontFace, 'cw');
  assert.equal(result.instanceCount, 2);
  assert.deepEqual(Array.from(result.instanceAttributes.get('instancePhase').data), [5, 6]);
  assert.deepEqual(Array.from(result.morphWeights), Array.from(source.morphWeights));
  assert.deepEqual(result.localBounds, { center: [0.5, 0.5, 0], radius: 1 });
});

test('separateGeometryTriangles returns independent arrays without mutating its source', () => {
  const source = new Geometry3D({
    positions: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]),
    normals: new Float32Array([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ]),
    customAttributes: [{
      name: 'delay',
      location: 7,
      format: 'float32',
      itemSize: 1,
      data: new Float32Array([0, 1, 2]),
    }],
  });

  const result = separateGeometryTriangles(source);
  assert.notEqual(result, source);
  assert.notEqual(result.positions, source.positions);
  assert.notEqual(result.normals, source.normals);
  assert.notEqual(result.customAttributes.get('delay').data, source.customAttributes.get('delay').data);

  result.positions[0] = 99;
  result.normals[0] = 88;
  result.customAttributes.get('delay').data[0] = 77;
  assert.equal(source.positions[0], 0);
  assert.equal(source.normals[0], 0);
  assert.equal(source.customAttributes.get('delay').data[0], 0);
});

test('separateGeometryTriangles supports empty geometry and preserves degenerate triangles', () => {
  const empty = separateGeometryTriangles(new Geometry3D({ positions: new Float32Array() }));
  assert.equal(empty.vertexCount, 0);
  assert.equal(empty.indices, null);

  const degenerate = separateGeometryTriangles(new Geometry3D({
    positions: new Float32Array([0, 0, 0]),
    indices: new Uint16Array([0, 0, 0]),
  }));
  assert.deepEqual(Array.from(degenerate.positions), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('separateGeometryTriangles rejects non-triangle and misaligned mutable geometry', () => {
  const line = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    topology: 'line-list',
  });
  assert.throws(() => separateGeometryTriangles(line), isGeometryParameterError);

  const incompleteNonIndexed = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
  });
  assert.throws(() => separateGeometryTriangles(incompleteNonIndexed), isGeometryParameterError);

  const incompleteIndexed = triangleGeometry();
  incompleteIndexed.indices = new Uint16Array([0, 1]);
  assert.throws(() => separateGeometryTriangles(incompleteIndexed), isGeometryParameterError);

  const outOfRange = triangleGeometry();
  outOfRange.indices = new Uint16Array([0, 1, 7]);
  assert.throws(() => separateGeometryTriangles(outOfRange), isGeometryParameterError);

  const badAttribute = triangleGeometry();
  badAttribute.customAttributes.set('bad', {
    name: 'bad',
    location: 7,
    format: 'float32',
    itemSize: 1,
    data: new Float32Array(2),
  });
  assert.throws(() => separateGeometryTriangles(badAttribute), isGeometryParameterError);
});

function triangleGeometry() {
  return new Geometry3D({
    positions: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]),
    indices: new Uint16Array([0, 1, 2]),
  });
}

function expandForTest(source, itemSize, vertexOrder) {
  return vertexOrder.flatMap(vertex => Array.from(source.slice(vertex * itemSize, vertex * itemSize + itemSize)));
}

function identityMatrix() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}
