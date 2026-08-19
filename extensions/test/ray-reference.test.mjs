import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAY_REFERENCE_CORPUS,
  compareRayHit,
  formatRayHitMismatch,
  replayRayReferenceCorpus,
  traceRayBruteForce,
} from '../src/ray-tracing/reference/index.ts';

const identity = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function geometry({
  id = 'geometry:test',
  revision = 1,
  positions = [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals = null,
  indices = null,
} = {}) {
  return Object.freeze({
    kind: 'triangle-mesh',
    geometryId: id,
    revision,
    positions: Object.freeze([...positions]),
    normals: normals ? Object.freeze([...normals]) : null,
    indices: indices ? Object.freeze([...indices]) : null,
    primitiveCount: indices ? indices.length / 3 : positions.length / 9,
  });
}

function instance({
  id = 'instance:test',
  entityId = 'entity:test',
  geometryId = 'geometry:test',
  geometryRevision = 1,
  transform = identity,
} = {}) {
  return Object.freeze({ instanceId: id, entityId, geometryId, geometryRevision, transform });
}

function scene(geometries, instances, analyticPrimitives = []) {
  return Object.freeze({
    geometries: Object.freeze(geometries),
    instances: Object.freeze(instances),
    analyticPrimitives: Object.freeze(analyticPrimitives),
  });
}

test('fixed ray reference corpus independently replays exact expected hits', () => {
  assert.ok(RAY_REFERENCE_CORPUS.length >= 3);
  const replay = replayRayReferenceCorpus();
  assert.equal(replay.passed, true, replay.cases.map(entry => entry.message).join('\n'));
  assert.ok(replay.cases.every(entry => Object.isFrozen(entry.result)));
});

test('indexed winding defines back face and barycentric order exactly', () => {
  const indexed = geometry({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 2, 1],
  });
  const result = traceRayBruteForce(scene([indexed], [instance()]), {
    origin: [0.25, 0.25, 1], direction: [0, 0, -4], tMin: 0, tMax: 2,
  });
  assert.equal(result.hit?.frontFace, false);
  assert.deepEqual(result.hit?.barycentric, [0.5, 0.25, 0.25]);
  assert.deepEqual(result.hit?.geometricNormal, [0, 0, -1]);
  assert.deepEqual(result.hit?.facingNormal, [0, 0, 1]);
  assert.equal(result.hit?.t, 1, 'direction is normalized so t is world distance');
});

test('negative non-uniform scale preserves winding, inverse-transpose normal, and identity', () => {
  const transform = Object.freeze([
    -2, 0, 0, 0,
    0, 3, 0, 0,
    0, 0, 0.5, 0,
    0, 0, 0, 1,
  ]);
  const mesh = geometry({ normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] });
  const result = traceRayBruteForce(scene([mesh], [instance({ transform })]), {
    origin: [-0.5, 0.75, 1], direction: [0, 0, -1],
  });
  assert.equal(result.hit?.t, 1);
  assert.equal(result.hit?.frontFace, false);
  assert.deepEqual(result.hit?.geometricNormal, [0, 0, -1]);
  assert.deepEqual(result.hit?.shadingNormal, [0, 0, -1]);
  assert.deepEqual(result.hit?.facingNormal, [0, 0, 1]);
  assert.deepEqual(result.hit?.identity, {
    instanceId: 'instance:test', entityId: 'entity:test', geometryId: 'geometry:test',
    geometryRevision: 1, primitiveIndex: 0,
  });
});

test('inverse-transpose normals follow a sheared triangle plane', () => {
  const shear = Object.freeze([
    1, 0, 0, 0,
    1, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  const mesh = geometry({
    positions: [0, 0, 0, 0, 1, 0, 0, 0, 1],
    normals: [1, 0, 0, 1, 0, 0, 1, 0, 0],
  });
  const invSqrt2 = 1 / Math.sqrt(2);
  const result = traceRayBruteForce(scene([mesh], [instance({ transform: shear })]), {
    origin: [0.25 + invSqrt2, 0.25 - invSqrt2, 0.25],
    direction: [-invSqrt2, invSqrt2, 0],
  });
  assert.ok(result.hit);
  assert.ok(Math.abs(result.hit.t - 1) < 1e-12);
  assert.ok(Math.abs(result.hit.geometricNormal[0] - invSqrt2) < 1e-12);
  assert.ok(Math.abs(result.hit.geometricNormal[1] + invSqrt2) < 1e-12);
  assert.deepEqual(result.hit.shadingNormal, result.hit.geometricNormal);
});

test('large-coordinate triangles and inclusive t range remain deterministic', () => {
  const large = geometry({
    positions: [1e9, 1e9, 0, 1e9 + 100, 1e9, 0, 1e9, 1e9 + 100, 0],
  });
  const hit = traceRayBruteForce(scene([large], [instance()]), {
    origin: [1e9 + 25, 1e9 + 25, 10], direction: [0, 0, -1], tMin: 10, tMax: 10,
  });
  assert.equal(hit.hit?.t, 10);
  assert.deepEqual(hit.hit?.barycentric, [0.5, 0.25, 0.25]);
  const miss = traceRayBruteForce(scene([large], [instance()]), {
    origin: [1e9 + 25, 1e9 + 25, 10], direction: [0, 0, -1], tMin: 0, tMax: 9.9,
  });
  assert.equal(miss.hit, null);
});

test('degenerate, missing, singular, and invalid ray inputs produce structured diagnostics', () => {
  const degenerate = geometry({ positions: [0, 0, 0, 1, 1, 1, 2, 2, 2] });
  const degenerateResult = traceRayBruteForce(scene([degenerate], [instance()]), {
    origin: [0, 0, 1], direction: [0, 0, -1],
  });
  assert.equal(degenerateResult.hit, null);
  assert.ok(degenerateResult.diagnostics.some(entry => entry.code === 'RAY_TRIANGLE_DEGENERATE'));

  const missingResult = traceRayBruteForce(scene([], [instance()]), {
    origin: [0, 0, 1], direction: [0, 0, -1],
  });
  assert.ok(missingResult.diagnostics.some(entry => entry.code === 'RAY_INSTANCE_GEOMETRY_MISSING'));

  const singular = Object.freeze(new Array(16).fill(0));
  const singularResult = traceRayBruteForce(scene([geometry()], [instance({ transform: singular })]), {
    origin: [0, 0, 1], direction: [0, 0, -1],
  });
  assert.ok(singularResult.diagnostics.some(entry => entry.code === 'RAY_TRANSFORM_SINGULAR'));

  const invalidRay = traceRayBruteForce(scene([], []), {
    origin: [0, 0, 0], direction: [0, 0, 0], tMin: 2, tMax: 1,
  });
  assert.equal(invalidRay.ray, null);
  assert.ok(invalidRay.diagnostics.some(entry => entry.code === 'RAY_DIRECTION_ZERO'));
});

test('analytic sphere supports inside rays and non-uniform transforms', () => {
  const sphere = Object.freeze({
    kind: 'sphere',
    identity: Object.freeze({
      instanceId: 'instance:sphere', entityId: 'entity:sphere', geometryId: 'analytic:sphere',
      geometryRevision: 4, primitiveIndex: 0,
    }),
    center: Object.freeze([0, 0, 0]),
    radius: 1,
    transform: Object.freeze([
      2, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0.5, 0,
      0, 0, 0, 1,
    ]),
  });
  const outside = traceRayBruteForce(scene([], [], [sphere]), {
    origin: [3, 0, 0], direction: [-1, 0, 0],
  });
  assert.equal(outside.hit?.t, 1);
  assert.equal(outside.hit?.frontFace, true);
  const inside = traceRayBruteForce(scene([], [], [sphere]), {
    origin: [0, 0, 0], direction: [0, 0, 1],
  });
  assert.equal(inside.hit?.t, 0.5);
  assert.equal(inside.hit?.frontFace, false);
});

test('tie-break is independent of scene order and mismatch diagnostics are human-readable', () => {
  const mesh = geometry();
  const a = instance({ id: 'instance:a', entityId: 'entity:9' });
  const z = instance({ id: 'instance:z', entityId: 'entity:1' });
  const ray = { origin: [0.2, 0.2, 1], direction: [0, 0, -1] };
  const forward = traceRayBruteForce(scene([mesh], [z, a]), ray);
  const reverse = traceRayBruteForce(scene([mesh], [a, z]), ray);
  assert.equal(forward.hit?.identity.instanceId, 'instance:a');
  assert.deepEqual(forward.hit, reverse.hit);

  const mismatches = compareRayHit({ t: 2, frontFace: false }, forward.hit, 1e-12);
  const message = formatRayHitMismatch('readable-case', mismatches);
  assert.match(message, /readable-case:/);
  assert.match(message, /t: expected 2/);
  assert.match(message, /frontFace: expected false/);
});

test('deterministic property corpus hits generated triangle interiors', () => {
  let state = 0x9e3779b9;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let caseIndex = 0; caseIndex < 128; caseIndex++) {
    const x = (random() - 0.5) * 200;
    const y = (random() - 0.5) * 200;
    const z = (random() - 0.5) * 200;
    const width = 0.1 + random() * 20;
    const height = 0.1 + random() * 20;
    const u = random() * 0.45;
    const v = random() * (0.9 - u);
    const mesh = geometry({ positions: [x, y, z, x + width, y, z, x, y + height, z] });
    const result = traceRayBruteForce(scene([mesh], [instance()]), {
      origin: [x + width * u, y + height * v, z + 5], direction: [0, 0, -3], tMin: 0, tMax: 5,
    });
    assert.ok(result.hit, `generated case ${caseIndex} should hit`);
    assert.ok(Math.abs(result.hit.t - 5) < 1e-9, `generated case ${caseIndex} t`);
    assert.ok(Math.abs(result.hit.barycentric[0] - (1 - u - v)) < 1e-9, `generated case ${caseIndex} barycentric`);
  }
});
