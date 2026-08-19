import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Mesh3D, Transform3D } from '@haiyue/engine/components';
import { Entity, World } from '@haiyue/engine/ecs';
import { Geometry3D } from '@haiyue/engine/geometry';
import { BasicMaterial } from '@haiyue/engine/material';
import { extractRayTracingScene } from '../src/ray-tracing/scene/index.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const compiledRoot = mkdtempSync(join(tmpdir(), 'haiyue-ray-acceleration-'));
process.on('exit', () => rmSync(compiledRoot, { recursive: true, force: true }));
execFileSync(process.execPath, [
  resolve(repositoryRoot, 'node_modules/typescript/bin/tsc'),
  '--target', 'ESNext', '--module', 'ESNext', '--moduleResolution', 'bundler',
  '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck',
  '--rootDir', resolve(repositoryRoot, 'extensions/src'),
  '--outDir', compiledRoot,
  resolve(repositoryRoot, 'extensions/src/ray-tracing/acceleration/index.ts'),
], { cwd: repositoryRoot, stdio: 'pipe' });

const acceleration = await import(pathToFileURL(join(compiledRoot, 'ray-tracing/acceleration/index.js')));
const reference = await import(pathToFileURL(join(compiledRoot, 'ray-tracing/reference/index.js')));
const {
  RAY_ACCELERATION_ABI_FINGERPRINT, RAY_ACCELERATION_ABI_V1, RAY_ACCELERATION_POLICY,
  RayAccelerationBuilder, buildBlas, packAcceleration, queryRayAccelerationCandidates,
  validateAccelerationStructure, validatePackedAcceleration,
} = acceleration;
const { RAY_REFERENCE_CORPUS, traceRayBruteForce } = reference;

const identityMatrix = Object.freeze([
  1, 0, 0, 0, 0, 1, 0, 0,
  0, 0, 1, 0, 0, 0, 0, 1,
]);

function triangleGeometry({
  id = 'geometry:test', revision = 1,
  positions = [0, 0, 0, 1, 0, 0, 0, 1, 0], indices = null, normals = null,
} = {}) {
  return Object.freeze({
    kind: 'triangle-mesh', geometryId: id, revision,
    positions: Object.freeze([...positions]), normals: normals ? Object.freeze([...normals]) : null,
    indices: indices ? Object.freeze([...indices]) : null,
    primitiveCount: indices ? indices.length / 3 : positions.length / 9,
  });
}

function instance({
  id = 'instance:test', entityId = 'entity:test', geometryId = 'geometry:test',
  geometryRevision = 1, transform = identityMatrix,
} = {}) {
  return Object.freeze({
    instanceId: id, entityId, geometryId, geometryRevision, transform: Object.freeze([...transform]),
  });
}

function snapshot({
  geometries = [triangleGeometry()], instances = [instance()], analyticPrimitives = [],
  materialRevision = 0, fingerprint = null,
} = {}) {
  const provenance = instances.map((entry, index) => Object.freeze({
    instanceId: entry.instanceId, entityId: entry.entityId, meshComponentId: index + 1,
    hierarchyVersion: 0, transformLocalVersion: 0,
    material: Object.freeze({ materialId: `material:${index}`, revision: materialRevision, type: 'basic' }),
  }));
  const derivedFingerprint = fingerprint ?? JSON.stringify({
    geometries: geometries.map(entry => [entry.geometryId, entry.revision, entry.positions]),
    instances: instances.map(entry => [entry.instanceId, entry.geometryId, entry.geometryRevision, entry.transform]),
    analyticPrimitives, materialRevision,
  });
  return Object.freeze({
    schemaVersion: 1,
    sourceRevision: Object.freeze({ worldId: 1, structureVersion: instances.length, componentChangeRevision: materialRevision }),
    revision: `test:${derivedFingerprint}`, fingerprint: `test:${derivedFingerprint}`,
    geometries: Object.freeze([...geometries]), instances: Object.freeze([...instances]),
    analyticPrimitives: Object.freeze([...analyticPrimitives]), provenance: Object.freeze(provenance),
    diagnostics: Object.freeze([]),
  });
}

function makeGridGeometry(count, revision = 1) {
  const positions = [];
  for (let primitive = 0; primitive < count; primitive++) {
    const x = primitive % 100;
    const y = Math.floor(primitive / 100);
    positions.push(x, y, 0, x + 0.8, y, 0, x, y + 0.8, 0);
  }
  return triangleGeometry({ id: 'geometry:grid', revision, positions });
}

function translate(x, y, z) {
  return Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

test('BLAS build is deterministic, balanced, immutable, and contains every primitive', () => {
  const geometry = makeGridGeometry(257);
  const first = buildBlas(geometry);
  const second = buildBlas(geometry);
  assert.ok(first.blas);
  assert.ok(second.blas);
  assert.equal(first.blas.fingerprint, second.blas.fingerprint);
  assert.deepEqual(first.blas.nodes, second.blas.nodes);
  assert.equal(new Set(first.blas.primitiveIndices).size, 257);
  assert.equal(first.blas.statistics.primitiveCount, 257);
  assert.ok(first.blas.statistics.maxDepth < 16);
  assert.ok(first.blas.nodes.every(node => node.indexCount <= RAY_ACCELERATION_POLICY.blasLeafCapacity));
  assert.ok(Object.isFrozen(first.blas.nodes));
  const builder = new RayAccelerationBuilder();
  const update = builder.update(snapshot({ geometries: [geometry], instances: [instance({ geometryId: geometry.geometryId })] }));
  assert.ok(update.snapshot);
  assert.deepEqual(validateAccelerationStructure(update.snapshot), []);
});

test('indexed geometry preserves identity and degenerate triangles remain explicit', () => {
  const geometry = triangleGeometry({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 2, 0], indices: [0, 1, 2, 0, 3, 3],
  });
  const result = buildBlas(geometry);
  assert.ok(result.blas);
  assert.deepEqual(result.blas.primitives.map(entry => entry.primitiveIndex), [0, 1]);
  assert.ok(result.diagnostics.some(entry => entry.code === 'RAY_BLAS_TRIANGLE_DEGENERATE'));
  assert.equal(result.blas.statistics.primitiveCount, 2);
});

test('malformed geometry and reused revisions return classified diagnostics', () => {
  const malformed = Object.freeze({
    kind: 'triangle-mesh', geometryId: 'geometry:bad', revision: 1,
    positions: Object.freeze([0, 0, Number.NaN]), normals: null, indices: null, primitiveCount: 1,
  });
  const invalid = buildBlas(malformed);
  assert.equal(invalid.blas, null);
  assert.ok(invalid.diagnostics.some(entry => entry.code === 'RAY_BLAS_POSITIONS_INVALID'));
  assert.ok(invalid.diagnostics.some(entry => entry.code === 'RAY_BLAS_PRIMITIVE_COUNT_INVALID'));
  const builder = new RayAccelerationBuilder();
  assert.ok(builder.update(snapshot()).snapshot);
  const reused = triangleGeometry({ positions: [0, 0, 0, 2, 0, 0, 0, 2, 0] });
  const update = builder.update(snapshot({ geometries: [reused], fingerprint: 'test:reused-revision' }));
  assert.equal(update.kind, 'topology-rebuild');
  assert.ok(update.diagnostics.some(entry => entry.code === 'RAY_BLAS_REVISION_REUSED'));

  const duplicateBuilder = new RayAccelerationBuilder();
  const duplicate = duplicateBuilder.update(snapshot({ geometries: [reused, reused] }));
  assert.equal(duplicate.snapshot, null);
  assert.ok(duplicate.diagnostics.some(entry => entry.code === 'RAY_BLAS_IDENTITY_DUPLICATE'));

  const missingMaterialSource = Object.freeze({ ...snapshot(), provenance: Object.freeze([]) });
  const missingMaterial = new RayAccelerationBuilder().update(missingMaterialSource);
  assert.equal(missingMaterial.snapshot, null);
  assert.ok(missingMaterial.diagnostics.some(entry => entry.code === 'RAY_TLAS_MATERIAL_PROVENANCE_MISSING'));
});

test('packed ABI is frozen and outward float32 bounds never shrink', () => {
  const large = triangleGeometry({
    id: 'geometry:large', positions: [100000000.1, -3.2, 0, 100000003.7, -3.2, 0, 100000000.1, 4.9, 0],
  });
  const builder = new RayAccelerationBuilder();
  const packedTransformSource = Object.freeze([
    1.23456789, 0, 0, 0,
    0, 0.987654321, 0, 0,
    0, 0, 1, 0,
    0.123456789, -0.333333333, 0, 1,
  ]);
  const update = builder.update(snapshot({
    geometries: [large],
    instances: [instance({ geometryId: large.geometryId, transform: packedTransformSource })],
  }));
  assert.ok(update.snapshot);
  const packed = update.snapshot.packed;
  assert.equal(packed.abiFingerprint, RAY_ACCELERATION_ABI_FINGERPRINT);
  assert.equal(RAY_ACCELERATION_ABI_FINGERPRINT, 'fnv1a64:9fd4d41c38d10fa2');
  assert.equal(RAY_ACCELERATION_ABI_V1.endianness, 'little');
  assert.equal(RAY_ACCELERATION_ABI_V1.buffers.blasNodes.stride, 32);
  assert.equal(RAY_ACCELERATION_ABI_V1.buffers.primitives.stride, 64);
  assert.equal(RAY_ACCELERATION_ABI_V1.buffers.instances.stride, 144);
  assert.equal(RAY_ACCELERATION_ABI_V1.traversalStackLimit, 64);
  assert.ok(update.snapshot.tlas.statistics.maxDepth + 1
    + update.snapshot.blases.values().next().value.statistics.maxDepth + 1 <= 64);
  assert.ok(Object.isFrozen(RAY_ACCELERATION_ABI_V1));
  assert.deepEqual(validatePackedAcceleration(packed), []);
  const node = update.snapshot.blases.values().next().value.nodes[0];
  const view = new DataView(packed.buffers.blasNodes.data);
  assert.ok(view.getFloat32(0, true) <= node.bounds.min[0]);
  assert.ok(view.getFloat32(16, true) >= node.bounds.max[0]);
  const instanceView = new DataView(packed.buffers.instances.data);
  const primitiveView = new DataView(packed.buffers.primitives.data);
  const tlasView = new DataView(packed.buffers.tlasNodes.data);
  const packedTransform = Array.from({ length: 16 }, (_, index) => instanceView.getFloat32(index * 4, true));
  const rootMin = [0, 1, 2].map(axis => tlasView.getFloat32(axis * 4, true));
  const rootMax = [0, 1, 2].map(axis => tlasView.getFloat32(16 + axis * 4, true));
  for (let vertex = 0; vertex < 3; vertex++) {
    const point = [0, 1, 2].map(axis => primitiveView.getFloat32((vertex * 3 + axis) * 4, true));
    const world = [0, 1, 2].map(row => packedTransform[row] * point[0]
      + packedTransform[4 + row] * point[1]
      + packedTransform[8 + row] * point[2]
      + packedTransform[12 + row]);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(rootMin[axis] <= world[axis] && rootMax[axis] >= world[axis],
        `packed TLAS root must contain packed vertex ${vertex} axis ${axis}`);
    }
  }
  assert.equal(packed.memory.totalBytes,
    Object.values(packed.buffers).reduce((sum, buffer) => sum + buffer.data.byteLength, 0));
});

test('pack overflow is rejected before allocation', () => {
  const builder = new RayAccelerationBuilder();
  const update = builder.update(snapshot({ geometries: [makeGridGeometry(32)], instances: [instance({ geometryId: 'geometry:grid' })] }));
  assert.ok(update.snapshot);
  const packed = packAcceleration(update.snapshot.blases, update.snapshot.tlas, 64);
  assert.equal(packed.packed, null);
  assert.ok(packed.diagnostics.some(entry => entry.code === 'RAY_PACK_MEMORY_OVERFLOW'));
});

test('finite CPU values outside float32 range fail before producing packed data', () => {
  const hugeTransform = Object.freeze([
    1e100, 0, 0, 0, 0, 1e100, 0, 0,
    0, 0, 1e100, 0, 0, 0, 0, 1,
  ]);
  const builder = new RayAccelerationBuilder();
  const update = builder.update(snapshot({ instances: [instance({ transform: hugeTransform })] }));
  assert.equal(update.snapshot, null);
  assert.ok(update.diagnostics.some(entry => entry.code === 'RAY_PACK_FLOAT32_OVERFLOW'));
});

test('packed validator rejects corrupted indirection and fingerprint bytes', () => {
  const builder = new RayAccelerationBuilder();
  const update = builder.update(snapshot());
  assert.ok(update.snapshot);
  const packed = update.snapshot.packed;
  new DataView(packed.buffers.instances.data).setUint32(128, 0xffff_fffe, true);
  const diagnostics = validatePackedAcceleration(packed);
  assert.ok(diagnostics.some(entry => entry.code === 'RAY_PACK_INSTANCE_INVALID'));
  assert.ok(diagnostics.some(entry => entry.code === 'RAY_PACK_FINGERPRINT_MISMATCH'));
});

test('TLAS policy distinguishes unchanged, material, refit, membership, and topology changes', () => {
  const builder = new RayAccelerationBuilder();
  const base = snapshot();
  const initial = builder.update(base);
  assert.equal(initial.kind, 'initial-build');
  assert.ok(initial.dirtyRanges.length > 0);
  const unchanged = builder.update(base);
  assert.equal(unchanged.kind, 'unchanged');
  assert.deepEqual(unchanged.dirtyRanges, []);
  assert.ok(builder.statistics.cacheHitCount >= 1);

  const material = builder.update(snapshot({ materialRevision: 1, fingerprint: 'test:material' }));
  assert.equal(material.kind, 'material-update');
  assert.ok(material.dirtyRanges.every(range => ['instances', 'materials'].includes(range.buffer)));

  const movedInstance = instance({ transform: translate(5, 0, 0) });
  const topologyBefore = material.snapshot.tlas.nodes.map(node => [node.leftChild, node.rightChild, node.firstIndex, node.indexCount]);
  const moved = builder.update(snapshot({ instances: [movedInstance], materialRevision: 1, fingerprint: 'test:moved' }));
  assert.equal(moved.kind, 'transform-refit');
  assert.deepEqual(moved.snapshot.tlas.nodes.map(node => [node.leftChild, node.rightChild, node.firstIndex, node.indexCount]), topologyBefore);
  assert.ok(moved.dirtyRanges.every(range => ['tlasNodes', 'instances'].includes(range.buffer)));

  const added = builder.update(snapshot({
    instances: [movedInstance, instance({ id: 'instance:second', entityId: 'entity:second', transform: translate(-3, 0, 0) })],
    materialRevision: 1, fingerprint: 'test:added',
  }));
  assert.equal(added.kind, 'membership-rebuild');

  const revisedGeometry = triangleGeometry({ revision: 2, positions: [0, 0, 0, 2, 0, 0, 0, 2, 0] });
  const topology = builder.update(snapshot({
    geometries: [revisedGeometry],
    instances: [
      instance({ geometryRevision: 2, transform: translate(5, 0, 0) }),
      instance({ id: 'instance:second', entityId: 'entity:second', geometryRevision: 2, transform: translate(-3, 0, 0) }),
    ],
    materialRevision: 1, fingerprint: 'test:topology',
  }));
  assert.equal(topology.kind, 'topology-rebuild');
  assert.ok(topology.dirtyRanges.some(range => range.buffer === 'blasNodes'));
});

test('real Engine facts replay transform, topology, and removal through the correct policy', () => {
  const world = new World('ray-acceleration-integration');
  const entity = new Entity('triangle');
  const transform = new Transform3D();
  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  entity.add(transform);
  entity.add(new Mesh3D(geometry, new BasicMaterial()));
  world.addEntity(entity);
  const builder = new RayAccelerationBuilder();
  assert.equal(builder.update(extractRayTracingScene(world).snapshot).kind, 'initial-build');

  transform.setTranslation(4, 0, 0);
  const refit = builder.update(extractRayTracingScene(world).snapshot);
  assert.equal(refit.kind, 'transform-refit');

  geometry.positions[3] = 2;
  geometry.markDirty();
  const rebuild = builder.update(extractRayTracingScene(world).snapshot);
  assert.equal(rebuild.kind, 'topology-rebuild');

  world.removeEntity(entity);
  const removal = builder.update(extractRayTracingScene(world).snapshot);
  assert.equal(removal.kind, 'membership-rebuild');
  assert.equal(removal.snapshot.tlas.instances.length, 0);
  assert.ok(removal.dirtyRanges.some(range => (
    range.buffer === 'blasNodes' && range.mode === 'replace' && range.targetByteLength === 0
  )), 'last geometry removal explicitly releases stale packed BLAS storage');
  builder.destroy();
  world.destroy();
});

test('TLAS removal and replacement leave no stale identity', () => {
  const builder = new RayAccelerationBuilder();
  const first = instance({ id: 'instance:first', entityId: 'entity:first' });
  const second = instance({ id: 'instance:second', entityId: 'entity:second', transform: translate(2, 0, 0) });
  builder.update(snapshot({ instances: [first, second], fingerprint: 'membership:two' }));
  const removed = builder.update(snapshot({ instances: [second], fingerprint: 'membership:one' }));
  assert.equal(removed.kind, 'membership-rebuild');
  assert.ok(removed.dirtyRanges.every(range => !['blasNodes', 'blasTable', 'primitives'].includes(range.buffer)),
    'membership-only rebuild does not re-upload unchanged BLAS data');
  assert.deepEqual(removed.snapshot.tlas.instances.map(entry => entry.instanceId), ['instance:second']);
  assert.ok(removed.snapshot.packed.instanceIdentities.every(entry => !entry.includes('instance:first')));
  const replacement = instance({ id: 'instance:replacement', entityId: 'entity:first' });
  const replaced = builder.update(snapshot({ instances: [second, replacement], fingerprint: 'membership:replacement' }));
  assert.equal(replaced.kind, 'membership-rebuild');
  assert.ok(replaced.snapshot.tlas.instances.some(entry => entry.instanceId === 'instance:replacement'));
});

test('candidate traversal contains every oracle hit across fixed corpus', () => {
  for (const entry of RAY_REFERENCE_CORPUS) {
    const source = snapshot({
      geometries: entry.scene.geometries, instances: entry.scene.instances,
      analyticPrimitives: entry.scene.analyticPrimitives, fingerprint: `corpus:${entry.id}`,
    });
    const builder = new RayAccelerationBuilder();
    const update = builder.update(source);
    assert.ok(update.snapshot, entry.id);
    assert.deepEqual(validateAccelerationStructure(update.snapshot), [], entry.id);
    const oracle = traceRayBruteForce(entry.scene, entry.ray);
    const query = queryRayAccelerationCandidates(update.snapshot, entry.ray);
    assert.equal(query.aborted, false, entry.id);
    assert.deepEqual(query.diagnostics, [], entry.id);
    if (oracle.hit) {
      assert.ok(query.candidates.some(candidate => (
        candidate.instanceId === oracle.hit.identity.instanceId
        && candidate.geometryId === oracle.hit.identity.geometryId
        && candidate.geometryRevision === oracle.hit.identity.geometryRevision
        && candidate.primitiveIndex === oracle.hit.identity.primitiveIndex
      )), `${entry.id}: candidates must contain oracle hit`);
    }
  }
});

test('deterministic randomized rays never lose the brute-force oracle primitive', () => {
  const geometry = makeGridGeometry(600);
  const source = snapshot({ geometries: [geometry], instances: [instance({ geometryId: geometry.geometryId })] });
  const builder = new RayAccelerationBuilder();
  const update = builder.update(source);
  assert.ok(update.snapshot);
  let state = 0x12345678;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let index = 0; index < 256; index++) {
    const ray = { origin: [random() * 100, random() * 6, 10], direction: [0, 0, -1] };
    const oracle = traceRayBruteForce(source, ray);
    const query = queryRayAccelerationCandidates(update.snapshot, ray);
    assert.equal(query.aborted, false);
    if (oracle.hit) {
      assert.ok(query.candidates.some(candidate => candidate.primitiveIndex === oracle.hit.identity.primitiveIndex),
        `random ray ${index} lost primitive ${oracle.hit.identity.primitiveIndex}`);
    }
  }
});

test('rebuild serialization is deterministic and teardown is idempotent with zero residual', () => {
  const builder = new RayAccelerationBuilder();
  const source = snapshot({ geometries: [makeGridGeometry(64)], instances: [instance({ geometryId: 'geometry:grid' })] });
  const first = builder.update(source);
  assert.ok(first.snapshot);
  const fingerprint = first.snapshot.packed.fingerprint;
  const rebuilt = builder.rebuild(source);
  assert.ok(rebuilt.snapshot);
  assert.equal(rebuilt.snapshot.packed.fingerprint, fingerprint);
  assert.ok(builder.statistics.currentBytes > 0);
  assert.ok(builder.statistics.peakBytes >= builder.statistics.currentBytes);
  const moved = builder.update(snapshot({
    geometries: source.geometries,
    instances: [instance({ geometryId: 'geometry:grid', transform: translate(1, 0, 0) })],
    fingerprint: 'lifecycle:moved',
  }));
  assert.equal(moved.kind, 'transform-refit');
  assert.ok(builder.statistics.peakBytes >= builder.statistics.currentBytes * 2,
    'peak accounts for old and replacement packed data coexisting during refit');
  builder.destroy();
  builder.destroy();
  assert.equal(builder.statistics.currentBytes, 0);
  assert.equal(builder.statistics.liveBlasCount, 0);
  assert.equal(builder.statistics.destroyed, true);
  const late = builder.update(source);
  assert.equal(late.snapshot, null);
  assert.ok(late.diagnostics.some(entry => entry.code === 'RAY_ACCEL_OWNER_DESTROYED'));
});
