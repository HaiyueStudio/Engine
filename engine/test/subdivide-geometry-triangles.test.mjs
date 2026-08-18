import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineErrorCode } from '../dist/core.js';
import { Geometry3D, subdivideGeometryTriangles } from '../dist/geometry.js';

const isGeometryParameterError = error => error?.code === EngineErrorCode.GeometryInvalidParameter;

test('subdivideGeometryTriangles shares indexed edge midpoints and preserves winding', () => {
  const source = new Geometry3D({
    positions: new Float32Array([
      0, 0, 0,
      2, 0, 0,
      2, 2, 0,
      0, 2, 0,
    ]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  });

  const result = subdivideGeometryTriangles(source);

  assert.equal(result.vertexCount, 9);
  assert.equal(result.indices.length / 3, 8);
  assert.deepEqual(Array.from(result.indices), [
    0, 4, 6, 1, 5, 4, 2, 6, 5, 4, 5, 6,
    0, 6, 8, 2, 7, 6, 3, 8, 7, 6, 7, 8,
  ]);
  assert.deepEqual(Array.from(result.positions.slice(12)), [
    1, 0, 0,
    2, 1, 0,
    1, 1, 0,
    1, 2, 0,
    0, 1, 0,
  ]);
  assert.deepEqual(Array.from(source.indices), [0, 1, 2, 0, 2, 3]);
  assert.equal(source.vertexCount, 4);
});

test('subdivideGeometryTriangles interpolates deformation and render-contract streams', () => {
  const source = new Geometry3D({
    positions: new Float32Array([
      0, 0, 0,
      2, 0, 0,
      0, 2, 0,
    ]),
    normals: new Float32Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]),
    textureCoordinates: [{ set: 2, data: new Float32Array([0, 0, 1, 0, 0, 1]) }],
    textureCoordinateLayout: [2],
    indices: new Uint16Array([0, 1, 2]),
    topology: 'triangle-list',
    cullMode: 'none',
    frontFace: 'cw',
    customAttributes: [{
      name: 'phase',
      location: 7,
      format: 'float32x2',
      itemSize: 2,
      data: new Float32Array([0, 2, 2, 4, 4, 6]),
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
    morphTargets: [{
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
      normals: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
    }],
    morphWeights: [0.4],
    skinning: {
      joints: new Float32Array([
        0, 7, 0, 0,
        1, 7, 0, 0,
        2, 7, 0, 0,
      ]),
      weights: new Float32Array([
        1, 0, 0, 0,
        1, 0, 0, 0,
        1, 0, 0, 0,
      ]),
      jointMatrices: identityMatrix(),
    },
    boundsMode: 'manual',
    localBounds: { center: [1, 1, 0], radius: 2 },
  });
  source.morphBasePositions = Float32Array.from(source.positions, value => value + 2);
  source.morphBaseNormals = Float32Array.from(source.normals);

  const result = subdivideGeometryTriangles(source);
  const inverseSqrt2 = Math.SQRT1_2;

  assert.deepEqual(Array.from(result.getTextureCoordinates(2).slice(6)), [0.5, 0, 0.5, 0.5, 0, 0.5]);
  assert.deepEqual(Array.from(result.customAttributes.get('phase').data.slice(6)), [1, 3, 3, 5, 2, 4]);
  assert.deepEqual(Array.from(result.morphTargets[0].positions.slice(9)), [1, 0, 0, 1, 1, 0, 0, 1, 0]);
  assert.deepEqual(Array.from(result.morphTargets[0].normals.slice(9)), [1, 0, 0, 1, 1, 0, 0, 1, 0]);
  assert.ok(Math.abs(result.normals[9] - inverseSqrt2) < 1e-6);
  assert.ok(Math.abs(result.normals[10] - inverseSqrt2) < 1e-6);
  assert.deepEqual(Array.from(result.skinning.joints.slice(12, 16)), [0, 1, 0, 0]);
  assert.deepEqual(Array.from(result.skinning.weights.slice(12, 16)), [0.5, 0.5, 0, 0]);
  assert.deepEqual(Array.from(result.morphBasePositions.slice(9, 12)), [3, 2, 2]);
  assert.ok(Math.abs(result.morphBaseNormals[9] - inverseSqrt2) < 1e-6);
  assert.deepEqual(result.textureCoordinateLayout, [2]);
  assert.equal(result.topology, 'triangle-list');
  assert.equal(result.cullMode, 'none');
  assert.equal(result.frontFace, 'cw');
  assert.equal(result.instanceCount, 2);
  assert.deepEqual(Array.from(result.instanceAttributes.get('instancePhase').data), [5, 6]);
  assert.deepEqual(result.localBounds, { center: [1, 1, 0], radius: 2 });

  result.positions[0] = 99;
  result.getTextureCoordinates(2)[0] = 99;
  result.instanceAttributes.get('instancePhase').data[0] = 99;
  assert.equal(source.positions[0], 0);
  assert.equal(source.getTextureCoordinates(2)[0], 0);
  assert.equal(source.instanceAttributes.get('instancePhase').data[0], 5);
});

test('subdivideGeometryTriangles keeps intentionally disconnected non-indexed faces disconnected', () => {
  const result = subdivideGeometryTriangles(new Geometry3D({
    positions: new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0,
      0, 0, 0, 1, 1, 0, 0, 1, 0,
    ]),
  }));

  assert.equal(result.vertexCount, 12);
  assert.equal(result.indices.length / 3, 8);
});

test('subdivideGeometryTriangles compounds triangle counts and supports an independent zero-pass copy', () => {
  const source = triangleGeometry();
  const refined = subdivideGeometryTriangles(source, { iterations: 2 });
  const copied = subdivideGeometryTriangles(source, { iterations: 0 });

  assert.equal(refined.indices.length / 3, 16);
  assert.equal(copied.vertexCount, 3);
  assert.deepEqual(Array.from(copied.indices), [0, 1, 2]);
  assert.notEqual(copied.positions, source.positions);
  assert.notEqual(copied.indices, source.indices);
});

test('subdivideGeometryTriangles rejects invalid topology, mutable streams, and explosive requests', () => {
  const line = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    topology: 'line-list',
  });
  assert.throws(() => subdivideGeometryTriangles(line), isGeometryParameterError);

  assert.throws(() => subdivideGeometryTriangles(triangleGeometry(), { iterations: -1 }), isGeometryParameterError);
  assert.throws(() => subdivideGeometryTriangles(triangleGeometry(), { iterations: 9 }), isGeometryParameterError);

  const incomplete = triangleGeometry();
  incomplete.indices = new Uint16Array([0, 1]);
  assert.throws(() => subdivideGeometryTriangles(incomplete), isGeometryParameterError);

  const outOfRange = triangleGeometry();
  outOfRange.indices = new Uint16Array([0, 1, 7]);
  assert.throws(() => subdivideGeometryTriangles(outOfRange), isGeometryParameterError);

  const badAttribute = triangleGeometry();
  badAttribute.customAttributes.set('bad', {
    name: 'bad',
    location: 7,
    format: 'float32',
    itemSize: 1,
    data: new Float32Array(2),
  });
  assert.throws(() => subdivideGeometryTriangles(badAttribute), isGeometryParameterError);

  const repeatedTriangles = triangleGeometry();
  repeatedTriangles.indices = new Uint16Array(Array.from({ length: 16 * 3 }, (_, index) => index % 3));
  assert.throws(
    () => subdivideGeometryTriangles(repeatedTriangles, { iterations: 8 }),
    isGeometryParameterError,
  );
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

function identityMatrix() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}
