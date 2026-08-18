import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EngineErrorCode,
  Geometry2D,
  Geometry3D,
  csgIntersect,
  csgSubtract,
  csgUnion,
  createBox3D,
  createCircle2D,
  createCone3D,
  createCylinder3D,
  createIcosahedron3D,
  createPolygon2D,
  createRoundedBox3D,
  createSphere3D,
  createSVG2DMeshes,
} from '../dist/experimental.js';

const isGeometryParameterError = error => error?.code === EngineErrorCode.GeometryInvalidParameter;

test('Geometry3D validates finite positions at construction and bounding-box refresh', () => {
  assert.throws(
    () => new Geometry3D({ positions: new Float32Array([0, Number.NaN, 0]) }),
    isGeometryParameterError,
  );

  const geometry = new Geometry3D({
    positions: new Float32Array([
      -1, 2, 3,
       4, 0, 8,
    ]),
  });
  assert.equal('uvs' in geometry, false);
  assert.equal('uvs1' in geometry, false);
  const bounds = geometry.getBoundingBox();
  assert.deepEqual(Array.from(bounds.min), [-1, 0, 3]);
  assert.deepEqual(Array.from(bounds.max), [4, 2, 8]);

  geometry.positions.set([-2, 3, 4, 5, -1, 9]);
  geometry.markDirty();
  const refreshedBounds = geometry.getBoundingBox();
  assert.equal(refreshedBounds, bounds);
  assert.equal(refreshedBounds.min, bounds.min);
  assert.equal(refreshedBounds.max, bounds.max);
  assert.deepEqual(Array.from(refreshedBounds.min), [-2, -1, 4]);
  assert.deepEqual(Array.from(refreshedBounds.max), [5, 3, 9]);

  geometry.positions[1] = Number.POSITIVE_INFINITY;
  geometry.markDirty();
  assert.throws(() => geometry.getBoundingBox(), isGeometryParameterError);

  geometry.positions = new Float32Array([0, 1]);
  geometry.markDirty();
  assert.throws(() => geometry.getBoundingBox(), isGeometryParameterError);
});

test('Geometry2D rejects non-finite updates before replacing data or advancing version', () => {
  const geometry = new Geometry2D(new Float32Array([0, 0, 1, 1]));
  const positions = geometry.positions;
  const version = geometry.version;

  assert.throws(
    () => geometry.setPositions(new Float32Array([0, 0, Number.NaN, 1])),
    isGeometryParameterError,
  );
  assert.equal(geometry.positions, positions);
  assert.equal(geometry.version, version);
});

test('Icosahedron detail rejects non-finite and explosive subdivision requests', () => {
  assert.throws(() => createIcosahedron3D({ detail: Number.POSITIVE_INFINITY }), isGeometryParameterError);
  assert.throws(() => createIcosahedron3D({ detail: 9 }), isGeometryParameterError);

  const geometry = createIcosahedron3D({ radius: 2, detail: 1 });
  assert.equal(geometry.vertexCount, 42);
  assert.equal(geometry.indexCount, 240);
  assert.equal(Array.from(geometry.positions).every(Number.isFinite), true);
});

test('Rounded box validates generation inputs before allocating subdivision grids', () => {
  assert.throws(
    () => createRoundedBox3D({ segments: Number.POSITIVE_INFINITY }),
    isGeometryParameterError,
  );
  assert.throws(() => createRoundedBox3D({ width: Number.NaN }), isGeometryParameterError);
  assert.throws(() => createRoundedBox3D({ segments: 257 }), isGeometryParameterError);

  const geometry = createRoundedBox3D({ width: 2, height: 3, depth: 4, radius: 0.25, segments: 3 });
  assert.ok(geometry.vertexCount > 24);
  assert.ok(geometry.indexCount > 36);
});

test('Cylinder triangle winding agrees with its outward vertex normals', () => {
  const geometry = createCylinder3D({
    radiusTop: 0.7,
    radiusBottom: 1,
    height: 2,
    radialSegments: 12,
    heightSegments: 2,
  });

  assertTriangleWindingMatchesNormals(geometry);
});

test('Cone side and bottom-cap winding agree with their outward vertex normals', () => {
  const geometry = createCone3D({
    radius: 1.05,
    height: 2.5,
    radialSegments: 36,
  });

  assertTriangleWindingMatchesNormals(geometry);
});

test('2D shape segment contracts floor fractions and promote large indices to Uint32', () => {
  const fractional = createCircle2D({ radius: 1, segments: 3.9 });
  assert.equal(fractional.vertexCount, 4);
  assert.equal(fractional.indexCount, 9);

  const large = createCircle2D({ radius: 1, segments: 65535 });
  assert.equal(large.vertexCount, 65536);
  assert.equal(large.indices instanceof Uint32Array, true);

  assert.throws(
    () => createCircle2D({ radius: 1, segments: Number.POSITIVE_INFINITY }),
    isGeometryParameterError,
  );
  assert.throws(
    () => createPolygon2D({ radius: 1, sides: Number.POSITIVE_INFINITY }),
    isGeometryParameterError,
  );
});

test('SVG geometry rejects unbounded subdivision and incomplete path commands', () => {
  withFakeDom(() => {
    assert.throws(
      () => createSVG2DMeshes('<svg viewBox="0 0 10 10"><path d="M0 0L10 0L10 10Z"/></svg>', {
        curveSegments: Number.POSITIVE_INFINITY,
      }),
      isGeometryParameterError,
    );
    assert.throws(
      () => createSVG2DMeshes('<svg viewBox="0 0 10 10"><path d="M 0"/></svg>'),
      isGeometryParameterError,
    );
    assert.throws(
      () => createSVG2DMeshes('<svg viewBox="0 0 10 10"><path d="M0 0L"/></svg>'),
      isGeometryParameterError,
    );
    assert.throws(
      () => createSVG2DMeshes('<svg viewBox="0 0 10 10"><path d="M0 0L10 0L10 10Z"/></svg>', {
        height: Number.NaN,
      }),
      isGeometryParameterError,
    );
  });
});

test('SVG geometry keeps finite output and promotes large batches to Uint32 indices', () => {
  withFakeDom(() => {
    const triangle = createSVG2DMeshes(
      '<svg viewBox="0 0 10 10"><path d="M0 0L10 0L10 10Z" fill="#ff0000"/></svg>',
    );
    assert.equal(triangle.length, 1);
    assert.equal(Array.from(triangle[0].geometry.positions).every(Number.isFinite), true);

    const points = Array.from({ length: 16385 }, (_, index) => `${index},${index % 2}`).join(' ');
    const large = createSVG2DMeshes(
      `<svg viewBox="0 0 16385 2"><polyline points="${points}" fill="none" stroke="#000"/></svg>`,
    );
    assert.equal(large.length, 1);
    assert.equal(large[0].geometry.vertexCount > 65535, true);
    assert.equal(large[0].geometry.indices instanceof Uint32Array, true);
  });
});

test('CSG boolean operations preserve finite indexed triangle output', () => {
  const box = createBox3D({ width: 2, height: 2, depth: 2 });
  const sphere = createSphere3D({ radius: 1.2, widthSegments: 12, heightSegments: 8 });
  for (const operation of [csgUnion, csgSubtract, csgIntersect]) {
    const result = operation(box, sphere);
    assert.equal(result.positions.length > 0, true);
    assert.equal(result.indices.length % 3, 0);
    assert.equal(Array.from(result.positions).every(Number.isFinite), true);
    assert.equal(Array.from(result.normals).every(Number.isFinite), true);
    assert.equal(Array.from(result.getTextureCoordinates(0)).every(Number.isFinite), true);
    assert.equal(Math.max(...result.indices) < result.vertexCount, true);
  }
});

test('CSG represents disjoint intersection as empty geometry with zero bounds', () => {
  const box = createBox3D({ width: 2, height: 2, depth: 2 });
  const farBox = translateGeometryForTest(box, [10, 0, 0]);
  const result = csgIntersect(box, farBox);
  assert.equal(result.vertexCount, 0);
  assert.equal(result.indexCount, 0);
  const bounds = result.getBoundingBox();
  assert.deepEqual(Array.from(bounds.min), [0, 0, 0]);
  assert.deepEqual(Array.from(bounds.max), [0, 0, 0]);
});

test('CSG revalidates mutable triangle-list inputs at the operation boundary', () => {
  const valid = createBox3D();
  const invalidTopology = createBox3D();
  invalidTopology.topology = 'line-list';
  assert.throws(() => csgUnion(valid, invalidTopology), isGeometryParameterError);

  const invalidPositions = createBox3D();
  invalidPositions.positions = new Float32Array([0, 0, 0, 1, 0, 0]);
  assert.throws(() => csgSubtract(invalidPositions, valid), isGeometryParameterError);

  const invalidNormals = createBox3D();
  invalidNormals.normals = new Float32Array([0, 1, 0]);
  assert.throws(() => csgIntersect(valid, invalidNormals), isGeometryParameterError);
});

function translateGeometryForTest(geometry, [x, y, z]) {
  const positions = Float32Array.from(geometry.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += x;
    positions[i + 1] += y;
    positions[i + 2] += z;
  }
  return new Geometry3D({
    positions,
    normals: geometry.normals ? Float32Array.from(geometry.normals) : undefined,
    textureCoordinates: [...geometry.textureCoordinates].map(([set, data]) => ({ set, data: Float32Array.from(data) })),
    textureCoordinateLayout: geometry.textureCoordinateLayout,
    indices: geometry.indices ? new Uint32Array(geometry.indices) : undefined,
  });
}

function assertTriangleWindingMatchesNormals(geometry) {
  const { positions, normals, indices } = geometry;
  assert.ok(normals);
  assert.ok(indices);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const ia = indices[offset] * 3;
    const ib = indices[offset + 1] * 3;
    const ic = indices[offset + 2] * 3;
    const abx = positions[ib] - positions[ia];
    const aby = positions[ib + 1] - positions[ia + 1];
    const abz = positions[ib + 2] - positions[ia + 2];
    const acx = positions[ic] - positions[ia];
    const acy = positions[ic + 1] - positions[ia + 1];
    const acz = positions[ic + 2] - positions[ia + 2];
    const faceX = aby * acz - abz * acy;
    const faceY = abz * acx - abx * acz;
    const faceZ = abx * acy - aby * acx;
    const normalX = normals[ia] + normals[ib] + normals[ic];
    const normalY = normals[ia + 1] + normals[ib + 1] + normals[ic + 1];
    const normalZ = normals[ia + 2] + normals[ib + 2] + normals[ic + 2];
    assert.ok(
      faceX * normalX + faceY * normalY + faceZ * normalZ > 0,
      `triangle ${offset / 3} winding opposes its vertex normals`,
    );
  }
}

function withFakeDom(run) {
  const previous = globalThis.DOMParser;
  globalThis.DOMParser = FakeDOMParser;
  try {
    return run();
  } finally {
    if (previous === undefined) delete globalThis.DOMParser;
    else globalThis.DOMParser = previous;
  }
}

class FakeDOMParser {
  parseFromString(source) {
    const rootMatch = source.match(/<svg\b([^>]*)>([\s\S]*)<\/svg>/i);
    if (!rootMatch) return { documentElement: new FakeElement('parsererror') };
    const root = new FakeElement('svg', parseAttributes(rootMatch[1]));
    const body = rootMatch[2];
    for (const match of body.matchAll(/<(path|rect|circle|ellipse|polygon|polyline|line)\b([^>]*)\/?\s*>/gi)) {
      root.children.push(new FakeElement(match[1], parseAttributes(match[2])));
    }
    return { documentElement: root };
  }
}

class FakeElement {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName;
    this.attributes = attributes;
    this.children = [];
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
}

function parseAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) attributes[match[1]] = match[3];
  return attributes;
}
