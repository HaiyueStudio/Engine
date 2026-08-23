import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineErrorCode } from '../dist/core.js';
import { createPathExtrusion3D } from '../dist/geometry.js';

const rectangle = [
  [-2, 0.5],
  [2, 0.5],
  [2, -0.5],
  [-2, -0.5],
];

test('path extrusion creates indexed faces, normals, UVs, and expected bounds', () => {
  const geometry = createPathExtrusion3D({
    path: [
      { position: [0, 0, 0] },
      { position: [0, 0, 5] },
      { position: [2, 1, 10] },
    ],
    shape: rectangle,
    uvScale: [0.1, 0.25],
  });
  assert.equal(geometry.vertexCount, 24);
  assert.equal(geometry.indexCount, 48);
  assert.equal(geometry.normals.length, geometry.positions.length);
  assert.equal(geometry.getTextureCoordinates(0).length, geometry.vertexCount * 2);
  assert.ok(geometry.indices instanceof Uint16Array);
  const bounds = geometry.getBoundingBox();
  assert.ok(bounds.min[0] <= -2);
  assert.ok(bounds.max[0] >= 3.7);
  assert.ok(bounds.max[1] > 1.4);
  assert.ok(bounds.max[2] >= 10);
  assertTriangleWindingMatchesNormals(geometry);
});

test('closed path extrusion keeps a continuous geometry seam and accepts banked rings', () => {
  const geometry = createPathExtrusion3D({
    path: [
      { position: [-5, 0, -5], roll: 0 },
      { position: [5, 2, -5], roll: 0.25 },
      { position: [5, 0, 5], roll: 0 },
      { position: [-5, -2, 5], roll: -0.25 },
    ],
    shape: rectangle,
    closedPath: true,
  });
  assert.equal(geometry.vertexCount, 40);
  assert.equal(geometry.indexCount, 96);
  assertTriangleWindingMatchesNormals(geometry);
  const uvs = geometry.getTextureCoordinates(0);
  assert.ok(Math.max(...uvs) > 30);
});

test('open two-point shapes create ribbons without side faces', () => {
  const geometry = createPathExtrusion3D({
    path: [{ position: [0, 0, 0] }, { position: [0, 0, 8] }],
    shape: [[-1, 0], [1, 0]],
    closedShape: false,
  });
  assert.equal(geometry.vertexCount, 4);
  assert.equal(geometry.indexCount, 6);
});

test('path extrusion rejects non-finite, overlapping, and repeated closed points', () => {
  const invalid = error => error?.code === EngineErrorCode.GeometryInvalidParameter;
  assert.throws(() => createPathExtrusion3D({ path: [], shape: rectangle }), invalid);
  assert.throws(() => createPathExtrusion3D({
    path: [{ position: [0, 0, 0] }, { position: [0, Number.NaN, 2] }],
    shape: rectangle,
  }), invalid);
  assert.throws(() => createPathExtrusion3D({
    path: [{ position: [0, 0, 0] }, { position: [0, 0, 0] }],
    shape: rectangle,
  }), invalid);
  assert.throws(() => createPathExtrusion3D({
    path: [{ position: [0, 0, 0] }, { position: [2, 0, 0] }, { position: [0, 0, 0] }],
    shape: rectangle,
    closedPath: true,
  }), invalid);
});

function assertTriangleWindingMatchesNormals(geometry) {
  const { positions, normals, indices } = geometry;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const ia = indices[offset] * 3;
    const ib = indices[offset + 1] * 3;
    const ic = indices[offset + 2] * 3;
    const ab = [positions[ib] - positions[ia], positions[ib + 1] - positions[ia + 1], positions[ib + 2] - positions[ia + 2]];
    const ac = [positions[ic] - positions[ia], positions[ic + 1] - positions[ia + 1], positions[ic + 2] - positions[ia + 2]];
    const face = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const normal = [normals[ia] + normals[ib] + normals[ic], normals[ia + 1] + normals[ib + 1] + normals[ic + 1], normals[ia + 2] + normals[ib + 2] + normals[ic + 2]];
    assert.ok(face[0] * normal[0] + face[1] * normal[1] + face[2] * normal[2] > 0, `triangle ${offset / 3} winding opposes its normals`);
  }
}
