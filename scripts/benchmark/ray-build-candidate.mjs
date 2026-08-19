import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = resolve(import.meta.dirname, '../..');
const gamesRoot = resolve(root, '../Games');
const productScenePath = resolve(gamesRoot, 'games/pad-simulator/scenes/billiards-3d-import.scene.json');
const compiledRoot = mkdtempSync(join(tmpdir(), 'haiyue-ray-build-benchmark-'));
try {
  execFileSync(process.execPath, [
    resolve(root, 'node_modules/typescript/bin/tsc'),
    '--target', 'ESNext', '--module', 'ESNext', '--moduleResolution', 'bundler',
    '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck',
    '--rootDir', resolve(root, 'extensions/src'), '--outDir', compiledRoot,
    resolve(root, 'extensions/src/ray-tracing/acceleration/index.ts'),
  ], { cwd: root, stdio: 'pipe' });
  const { RayAccelerationBuilder, RAY_ACCELERATION_ABI_FINGERPRINT } = await import(
    pathToFileURL(join(compiledRoot, 'ray-tracing/acceleration/index.js'))
  );
  const gamesRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gamesRoot, encoding: 'utf8' }).trim();
  const gamesDirty = execFileSync('git', ['status', '--porcelain'], { cwd: gamesRoot, encoding: 'utf8' }).trim().length > 0;
  const cases = [
    { id: 'synthetic-1k-triangles', sourceKind: 'synthetic-scale', snapshot: syntheticSnapshot(1_000) },
    { id: 'synthetic-10k-triangles', sourceKind: 'synthetic-scale', snapshot: syntheticSnapshot(10_000) },
    {
      id: 'games-billiards-3d-import',
      sourceKind: 'real-product-scene',
      snapshot: productSnapshot(productScenePath),
      provenance: {
        repository: 'Games',
        revision: gamesRevision,
        dirty: gamesDirty,
        sourcePath: 'games/pad-simulator/scenes/billiards-3d-import.scene.json',
      },
    },
  ];
  const results = cases.map(entry => benchmarkCase(RayAccelerationBuilder, entry));
  const report = {
    format: 'haiyue-ray-build-candidate@1',
    evidenceClass: 'candidate-node-cpu-only',
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    abiFingerprint: RAY_ACCELERATION_ABI_FINGERPRINT,
    limitations: [
      'Node CPU timing does not satisfy Worker scheduling, GPU upload, native WebGPU traversal, or device memory budgets.',
      'Formal evidence must replay the same source fingerprint in the required browser/device runner.',
    ],
    cases: results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  rmSync(compiledRoot, { recursive: true, force: true });
}

function benchmarkCase(Builder, entry) {
  for (let warmup = 0; warmup < 2; warmup++) new Builder().update(entry.snapshot);
  const buildSamples = [];
  let finalUpdate = null;
  for (let sample = 0; sample < 7; sample++) {
    const builder = new Builder();
    const start = performance.now();
    finalUpdate = builder.update(entry.snapshot);
    buildSamples.push(performance.now() - start);
    builder.destroy();
  }
  const refitBuilder = new Builder();
  refitBuilder.update(entry.snapshot);
  const moved = moveSnapshot(entry.snapshot, 0.125);
  const refitSamples = [];
  for (let sample = 0; sample < 7; sample++) {
    const next = moveSnapshot(sample % 2 === 0 ? moved : entry.snapshot, sample * 0.001);
    const start = performance.now();
    const update = refitBuilder.update(next);
    refitSamples.push(performance.now() - start);
    if (update.kind !== 'transform-refit' && update.kind !== 'unchanged') {
      throw new Error(`${entry.id}: expected transform-refit, received ${update.kind}`);
    }
  }
  if (!finalUpdate?.snapshot) throw new Error(`${entry.id}: build failed`);
  const acceleration = finalUpdate.snapshot;
  return {
    id: entry.id,
    sourceKind: entry.sourceKind,
    provenance: entry.provenance ?? null,
    sourceFingerprint: entry.snapshot.fingerprint,
    geometryCount: entry.snapshot.geometries.length,
    triangleCount: entry.snapshot.geometries.reduce((sum, geometry) => sum + geometry.primitiveCount, 0),
    instanceCount: entry.snapshot.instances.length,
    buildMilliseconds: summarize(buildSamples),
    refitMilliseconds: summarize(refitSamples),
    blasNodeCount: [...acceleration.blases.values()].reduce((sum, blas) => sum + blas.nodes.length, 0),
    tlasNodeCount: acceleration.tlas.nodes.length,
    packedBytes: acceleration.packed.memory.totalBytes,
    peakBytes: refitBuilder.statistics.peakBytes,
    diagnosticCodes: [...new Set(finalUpdate.diagnostics.map(item => item.code))],
  };
}

function syntheticSnapshot(triangleCount) {
  const positions = [];
  for (let primitive = 0; primitive < triangleCount; primitive++) {
    const x = primitive % 128;
    const y = Math.floor(primitive / 128);
    positions.push(x, y, 0, x + 0.8, y, 0, x, y + 0.8, 0);
  }
  const geometry = freezeGeometry('benchmark:grid', 1, positions, null);
  const instances = [freezeInstance('benchmark:grid:instance', 'benchmark:grid:entity', geometry.geometryId, 1, identity())];
  return freezeSnapshot(`synthetic:${triangleCount}`, [geometry], instances, []);
}

function productSnapshot(path) {
  const bytes = readFileSync(path);
  const source = JSON.parse(bytes.toString('utf8'));
  const geometryById = new Map();
  const geometries = source.resources.geometries.map(entry => {
    const geometry = freezeGeometry(`billiards-3d:geometry:${entry.id}`, 1, entry.positions, entry.indices ?? null);
    geometryById.set(entry.id, geometry);
    return geometry;
  });
  const instances = [];
  for (let entityIndex = 0; entityIndex < source.entities.length; entityIndex++) {
    const entity = source.entities[entityIndex];
    if (entity.disabled) continue;
    const mesh = entity.components.find(component => component.type === 'Mesh3D');
    if (!mesh) continue;
    const geometry = geometryById.get(mesh.geometryId);
    if (!geometry) continue;
    const cartesian = entity.components.find(component => component.type === 'CartesianTransform3D');
    const matrix = cartesian ? composeTrs(cartesian.position, cartesian.rotation, cartesian.scale) : identity();
    instances.push(freezeInstance(
      `billiards-3d:instance:${entityIndex}`,
      `billiards-3d:entity:${entityIndex}`,
      geometry.geometryId,
      geometry.revision,
      matrix,
    ));
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return freezeSnapshot(`games:billiards-3d-import:sha256:${sha256}`, geometries, instances, []);
}

function moveSnapshot(source, offset) {
  const instances = source.instances.map((entry, index) => {
    const matrix = [...entry.transform];
    matrix[12] += offset * (index + 1);
    return freezeInstance(entry.instanceId, entry.entityId, entry.geometryId, entry.geometryRevision, matrix);
  });
  return freezeSnapshot(`${source.fingerprint}:move:${offset}`, source.geometries, instances, source.analyticPrimitives);
}

function freezeGeometry(id, revision, positions, indices) {
  return Object.freeze({
    kind: 'triangle-mesh', geometryId: id, revision,
    positions: Object.freeze([...positions]), normals: null,
    indices: indices ? Object.freeze([...indices]) : null,
    primitiveCount: indices ? indices.length / 3 : positions.length / 9,
  });
}

function freezeInstance(instanceId, entityId, geometryId, geometryRevision, transform) {
  return Object.freeze({
    instanceId, entityId, geometryId, geometryRevision, transform: Object.freeze([...transform]),
  });
}

function freezeSnapshot(fingerprint, geometries, instances, analyticPrimitives) {
  const provenance = instances.map((entry, index) => Object.freeze({
    instanceId: entry.instanceId, entityId: entry.entityId, meshComponentId: index,
    hierarchyVersion: 0, transformLocalVersion: 0,
    material: Object.freeze({ materialId: `benchmark:material:${index}`, revision: 0, type: 'benchmark' }),
  }));
  return Object.freeze({
    schemaVersion: 1,
    sourceRevision: Object.freeze({ worldId: 0, structureVersion: instances.length, componentChangeRevision: 0 }),
    revision: fingerprint, fingerprint,
    geometries: Object.freeze([...geometries]), instances: Object.freeze([...instances]),
    analyticPrimitives: Object.freeze([...analyticPrimitives]), provenance: Object.freeze(provenance), diagnostics: Object.freeze([]),
  });
}

function composeTrs(position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) {
  const [sx, sy, sz] = scale;
  const [rx, ry, rz] = rotation;
  const cx = Math.cos(rx), sxr = Math.sin(rx);
  const cy = Math.cos(ry), syr = Math.sin(ry);
  const cz = Math.cos(rz), szr = Math.sin(rz);
  return Object.freeze([
    (cy * cz) * sx, (sxr * syr * cz + cx * szr) * sx, (-cx * syr * cz + sxr * szr) * sx, 0,
    (-cy * szr) * sy, (-sxr * syr * szr + cx * cz) * sy, (cx * syr * szr + sxr * cz) * sy, 0,
    syr * sz, (-sxr * cy) * sz, (cx * cy) * sz, 0,
    position[0], position[1], position[2], 1,
  ]);
}

function identity() { return Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    median: round(sorted[Math.floor(sorted.length / 2)]),
    p95: round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
  };
}

function round(value) { return Math.round(value * 1000) / 1000; }
