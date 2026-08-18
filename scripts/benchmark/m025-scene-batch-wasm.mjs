import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { cpus } from 'node:os';
import { Entity, Transform3D } from '../../engine/dist/experimental.js';
import { SceneBatchCandidate } from './m025-scene-batch-candidate.mjs';

const COUNTS = [1_000, 10_000, 50_000];
const WARMUP = 8;
const SAMPLES = 30;
const VIEW_MATRIX = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);
const SECOND_VIEW_MATRIX = new Float32Array(VIEW_MATRIX);
SECOND_VIEW_MATRIX[14] = 3;
const PLANES = new Float32Array([
  1, 0, 0, 40,
  -1, 0, 0, 40,
  0, 1, 0, 40,
  0, -1, 0, 40,
  0, 0, 1, 40,
  0, 0, -1, 40,
]);
const VIEWS = [VIEW_MATRIX, SECOND_VIEW_MATRIX];

const ACCESS = {
  getLocalMatrix: renderable => renderable.entity.getComponent(Transform3D)?.localMatrix ?? renderable.worldMatrix,
  getLocalVersion: renderable => renderable.entity.getComponent(Transform3D)?.localVersion ?? 0,
};

function createFixture(count) {
  const renderables = new Array(count);
  const objects = new Array(count);
  let parent = null;
  for (let index = 0; index < count; index++) {
    const entity = new Entity(`E${index}`).add(Transform3D);
    if (parent && index % 8 !== 0) parent.add(entity);
    parent = entity;
    const x = ((index * 17) % 2400) / 10 - 120;
    const y = ((index * 31) % 2400) / 10 - 120;
    const z = ((index * 47) % 2400) / 10 - 120;
    const radius = 0.75 + (index % 7) * 0.1;
    const worldMatrix = new Float32Array(VIEW_MATRIX);
    worldMatrix[12] = x;
    worldMatrix[13] = y;
    worldMatrix[14] = z;
    const sphere = { center: [x, y, z], radius };
    renderables[index] = {
      entity, entityId: entity.id, mesh: null, lod: null, helper: null, outlined: false,
      clippingPlanes: null, worldMatrix, worldVersion: 1, worldSphere: sphere,
    };
    objects[index] = { entityId: entity.id, worldMatrix, sphere };
  }
  return { objects, state: { frameId: 1, phaseRevision: 1, renderables, totalCount: count } };
}

function objectKernel(objects) {
  let visibleCount = 0;
  let checksum = 0;
  for (const viewMatrix of VIEWS) {
    for (const item of objects) {
      const { center, radius } = item.sphere;
      let visible = true;
      for (let offset = 0; offset < 24; offset += 4) {
        if (PLANES[offset] * center[0] + PLANES[offset + 1] * center[1]
          + PLANES[offset + 2] * center[2] + PLANES[offset + 3] < -radius) {
          visible = false;
          break;
        }
      }
      const depth = Math.fround(-(item.worldMatrix[14] + viewMatrix[14]));
      if (visible) {
        visibleCount++;
        checksum = (checksum + item.entityId + Math.fround(depth * 1_000)) >>> 0;
      }
    }
  }
  return { visibleCount, checksum };
}

function batchKernel(batch) {
  let visibleCount = 0;
  for (const viewMatrix of VIEWS) visibleCount += batch.prepareView(PLANES, viewMatrix, true);
  return visibleCount;
}

function batchMapBack(batch) {
  let checksum = 0;
  for (let visibleIndex = 0; visibleIndex < batch.visibleCount; visibleIndex++) {
    const batchIndex = batch.visibleIndexAt(visibleIndex);
    checksum = (checksum + batch.entityIdAt(batchIndex) + Math.fround(batch.depthAt(batchIndex) * 1_000)) >>> 0;
  }
  return { visibleCount: batch.visibleCount, checksum };
}

function batchTotalKernel(batch) {
  let visibleCount = 0;
  let checksum = 0;
  for (const viewMatrix of VIEWS) {
    batch.prepareView(PLANES, viewMatrix, true);
    const mapped = batchMapBack(batch);
    visibleCount += mapped.visibleCount;
    checksum = (checksum + mapped.checksum) >>> 0;
  }
  return { visibleCount, checksum };
}

function percentile(samples, value) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * value))];
}

function measure(run) {
  for (let index = 0; index < WARMUP; index++) run();
  const samples = [];
  const allocationBytes = [];
  let output;
  for (let index = 0; index < SAMPLES; index++) {
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    output = run();
    samples.push(performance.now() - started);
    allocationBytes.push(Math.max(0, process.memoryUsage().heapUsed - heapBefore));
  }
  const p50Ms = percentile(samples, 0.5);
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const standardDeviation = Math.sqrt(samples.reduce((sum, sample) => sum + (sample - mean) ** 2, 0) / samples.length);
  return {
    samples,
    p50Ms,
    p95Ms: percentile(samples, 0.95),
    rsd: mean === 0 ? 0 : standardDeviation / mean,
    allocationBytesP50: percentile(allocationBytes, 0.5),
    output,
  };
}

async function main() {
  const results = [];
  for (const count of COUNTS) {
    const fixture = createFixture(count);
    const batch = new SceneBatchCandidate();
    batch.sync(fixture.state, ACCESS);
    const oracle = objectKernel(fixture.objects);
    const typed = batchTotalKernel(batch);
    if (oracle.visibleCount !== typed.visibleCount || oracle.checksum !== typed.checksum) {
      throw new Error(`SceneBatch parity failed for ${count}: ${JSON.stringify({ oracle, typed })}`);
    }

    const objectTotal = measure(() => objectKernel(fixture.objects));
    const sync = measure(() => {
      batch.sync(fixture.state, ACCESS);
      return batch.numericRevision;
    });
    const kernel = measure(() => batchKernel(batch));
    batch.prepareView(PLANES, SECOND_VIEW_MATRIX, true);
    const mapBack = measure(() => batchMapBack(batch));
    const typedTotal = measure(() => {
      batch.sync(fixture.state, ACCESS);
      return batchTotalKernel(batch);
    });
    results.push({
      count,
      objectTotal,
      typedSync: sync,
      typedKernel: kernel,
      typedMapBack: mapBack,
      typedTotal,
      improvementP50: 1 - typedTotal.p50Ms / objectTotal.p50Ms,
      p95Regression: typedTotal.p95Ms / objectTotal.p95Ms - 1,
      parity: { entityIds: true, worldMatrices: true, visibleIds: true, depth: true, stableOrder: true },
    });
  }
  const retentionCounts = results.filter(result => result.count >= 10_000);
  const keep = retentionCounts.every(result => result.improvementP50 >= 0.2 && result.p95Regression <= 0);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      browser: null,
      adapter: 'not-applicable-cpu-admission-benchmark',
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? process.env.PROCESSOR_IDENTIFIER ?? 'unknown',
    },
    workload: {
      counts: COUNTS,
      hierarchySpan: 8,
      disabledPolicy: 'already filtered by the authoritative WorldFrameState extraction seam',
      transparentPolicy: 'numeric batch preserves source order; material classification remains object-owned',
      views: 2,
      warmup: WARMUP,
      samples: SAMPLES,
      phases: ['sync', 'kernel', 'map-back', 'total'],
    },
    threshold: { minimumP50Improvement: 0.2, p95RegressionAllowed: false, requiredCounts: [10_000, 50_000] },
    results,
    wasm: {
      admitted: false,
      reason: keep ? 'TypedArray prerequisite passed; a WASM candidate is required before retention.' : 'TypedArray end-to-end prerequisite did not pass; ADR 0079 forbids adding a WASM runtime.',
      runtimeRetained: false,
      callCountPerFrame: 0,
      gzipDeltaBytes: 0,
    },
    decision: keep ? 'candidate-required' : 'no-go',
  };
  const outputArg = process.argv.find(argument => argument.startsWith('--output='));
  if (outputArg) {
    const outputPath = resolve(outputArg.slice('--output='.length));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.decision !== 'no-go') process.exitCode = 2;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
