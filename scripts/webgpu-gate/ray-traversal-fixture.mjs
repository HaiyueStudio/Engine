const progressNode = document.querySelector('#progress');
const resultNode = document.querySelector('#result');

try {
  const result = await run();
  publish('passed', result);
} catch (error) {
  publish('failed', { error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
}

async function run() {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable.');
  const build = new URLSearchParams(location.search).get('build');
  if (!build?.startsWith('/scripts/webgpu-gate/.ray-gpu-build-')) throw new Error('Missing validated ray GPU build path.');
  const [{ RayTraversalRuntime }, acceleration, reference] = await Promise.all([
    import(`${build}/ray-tracing/traversal/index.js`),
    import(`${build}/ray-tracing/acceleration/index.js`),
    import(`${build}/ray-tracing/reference/index.js`),
  ]);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No native WebGPU adapter was returned.');
  const requiredFeatures = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
  const device = await adapter.requestDevice({ requiredFeatures });
  const uncaptured = [];
  device.addEventListener('uncapturederror', event => uncaptured.push(event.error?.message ?? String(event.error)));

  let fixedCases = 0;
  let edgeCases = 0;
  let randomizedCases = 0;
  let anyHitCases = 0;
  let dispatchCount = 0;
  let overflowClassified = false;
  let deterministicReplay = false;
  let residuals = 0;
  let totalNodeTests = 0;
  let totalPrimitiveTests = 0;
  let gpuTimeSamples = 0;
  let maxPeakBytes = 0;
  let maxLiveResources = 0;

  for (const entry of reference.RAY_REFERENCE_CORPUS) {
    const owned = await createRuntime(device, entry.scene, acceleration, RayTraversalRuntime, `fixed:${entry.id}`);
    const gpu = await owned.runtime.execute([entry.ray]);
    assert(gpu.status === 'ok', `${entry.id} GPU status: ${formatDiagnostics(gpu.diagnostics)}`);
    compareHit(reference.traceRayBruteForce(entry.scene, entry.ray).hit, gpu.hits[0], entry.id);
    collect(gpu); fixedCases++;
    owned.runtime.destroy(); residuals += owned.runtime.liveResourceCount;
  }

  const edgeScene = makeEdgeScene();
  const edgeRays = [
    { origin: [9.5, 1, 2], direction: [0, 0, -1], tMin: 0, tMax: 10 },
    { origin: [9.5, 1, -2], direction: [0, 0, 1], tMin: 0, tMax: 10 },
    { origin: [100001, 1, 100], direction: [0, 0, -1], tMin: 0, tMax: 200 },
    { origin: [-100, -100, 1], direction: [0, 0, -1], tMin: 0, tMax: 10 },
  ];
  const edgeOwned = await createRuntime(device, edgeScene, acceleration, RayTraversalRuntime, 'edge');
  const edgeGpu = await edgeOwned.runtime.execute(edgeRays, { maxRaysPerDispatch: 2 });
  assert(edgeGpu.status === 'ok' && edgeGpu.dispatchCount === 2, `edge multi-dispatch failed: ${formatDiagnostics(edgeGpu.diagnostics)}`);
  edgeRays.forEach((ray, index) => compareHit(reference.traceRayBruteForce(edgeScene, ray).hit, edgeGpu.hits[index], `edge:${index}`));
  collect(edgeGpu); edgeCases += edgeRays.length;
  edgeOwned.runtime.destroy(); residuals += edgeOwned.runtime.liveResourceCount;

  const randomScene = makeRandomScene(160);
  const randomRays = makeRandomRays(256);
  const randomOwned = await createRuntime(device, randomScene, acceleration, RayTraversalRuntime, 'random');
  const randomGpu = await randomOwned.runtime.execute(randomRays, { maxRaysPerDispatch: 17 });
  assert(randomGpu.status === 'ok', `randomized traversal failed: ${formatDiagnostics(randomGpu.diagnostics)}`);
  assert(randomGpu.dispatchCount === Math.ceil(randomRays.length / 17), 'multi-dispatch count drifted.');
  randomRays.forEach((ray, index) => compareHit(reference.traceRayBruteForce(randomScene, ray).hit, randomGpu.hits[index], `random:${index}`));
  collect(randomGpu); randomizedCases += randomRays.length;

  const replayGpu = await randomOwned.runtime.execute(randomRays, { maxRaysPerDispatch: 31 });
  deterministicReplay = replayGpu.status === 'ok'
    && JSON.stringify(replayGpu.hits) === JSON.stringify(randomGpu.hits)
    && JSON.stringify(replayGpu.counters) === JSON.stringify(randomGpu.counters);
  assert(deterministicReplay, `deterministic replay drifted: ${formatDiagnostics(replayGpu.diagnostics)}`);
  collect(replayGpu);

  const anyGpu = await randomOwned.runtime.execute(randomRays, { mode: 'any-hit', maxRaysPerDispatch: 19 });
  assert(anyGpu.status === 'ok', `any-hit traversal failed: ${formatDiagnostics(anyGpu.diagnostics)}`);
  randomRays.forEach((ray, index) => {
    const cpuHasHit = reference.traceRayBruteForce(randomScene, ray).hit !== null;
    assert((anyGpu.hits[index] !== null) === cpuHasHit, `any-hit mismatch at ${index}.`);
  });
  collect(anyGpu); anyHitCases += randomRays.length;

  const overflow = await randomOwned.runtime.execute([randomRays[0]], { stackLimit: 1 });
  overflowClassified = overflow.status === 'failed'
    && overflow.counters.stackOverflows === 1
    && overflow.diagnostics.some(entry => entry.code === 'RAY_GPU_STACK_OVERFLOW');
  assert(overflowClassified, `overflow was not classified: ${formatDiagnostics(overflow.diagnostics)}`);

  const artifactHash = randomOwned.runtime.artifactHash;
  const accelerationFingerprint = randomOwned.runtime.accelerationFingerprint;
  device.destroy();
  const lost = await device.lost;
  const afterLoss = await randomOwned.runtime.execute([randomRays[0]]);
  const deviceLossClassified = afterLoss.status === 'failed' && afterLoss.diagnostics.some(entry => entry.code === 'RAY_GPU_DEVICE_LOST');
  assert(deviceLossClassified, `device loss was not classified: ${formatDiagnostics(afterLoss.diagnostics)}`);
  randomOwned.runtime.destroy(); residuals += randomOwned.runtime.liveResourceCount;
  assert(uncaptured.length === 0, `Uncaptured WebGPU errors: ${uncaptured.join('; ')}`);
  assert(residuals === 0, `Ray traversal owner residuals: ${residuals}`);

  const info = adapter.info ?? {};
  return {
    schemaVersion: 1,
    suite: 'ray-traversal-gpu-parity',
    status: 'passed',
    artifactVersion: 2,
    artifactHash,
    accelerationFingerprint,
    fixedCases,
    edgeCases,
    randomizedCases,
    anyHitCases,
    mismatchCount: 0,
    dispatchCount,
    overflowClassified,
    deterministicReplay,
    deviceLossClassified,
    gpuTimeSamples,
    maxPeakBytes,
    maxLiveResources,
    totalNodeTests,
    totalPrimitiveTests,
    validationErrorCount: 0,
    uncapturedErrorCount: uncaptured.length,
    residualCount: residuals,
    unclassifiedFailureCount: 0,
    deviceLossReason: lost.reason,
    adapter: { vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '', description: info.description ?? '' },
  };

  function collect(value) {
    dispatchCount += value.dispatchCount;
    totalNodeTests += value.counters.tlasNodeTests + value.counters.blasNodeTests;
    totalPrimitiveTests += value.counters.primitiveTests;
    if (value.gpuTimeNs !== null) gpuTimeSamples++;
    maxPeakBytes = Math.max(maxPeakBytes, value.memory.peakBytes);
    maxLiveResources = Math.max(maxLiveResources, value.memory.liveResourceCount);
  }
}

async function createRuntime(device, scene, acceleration, Runtime, label) {
  const builder = new acceleration.RayAccelerationBuilder();
  const update = builder.update(snapshotFromScene(scene, label));
  assert(update.snapshot, `${label} acceleration failed: ${JSON.stringify(update.diagnostics)}`);
  const created = await Runtime.create(device, update.snapshot.packed);
  assert(created.runtime, `${label} runtime creation failed: ${formatDiagnostics(created.diagnostics)}`);
  builder.destroy();
  return { runtime: created.runtime };
}

function snapshotFromScene(scene, label) {
  const provenance = scene.instances.map((entry, index) => Object.freeze({
    instanceId: entry.instanceId, entityId: entry.entityId, meshComponentId: index + 1,
    hierarchyVersion: 0, transformLocalVersion: 0,
    material: Object.freeze({ materialId: `material:${entry.instanceId}`, revision: 1, type: 'basic' }),
  }));
  return Object.freeze({
    schemaVersion: 1,
    sourceRevision: Object.freeze({ worldId: 1, structureVersion: scene.instances.length + scene.analyticPrimitives.length, componentChangeRevision: 1 }),
    revision: `gpu:${label}`, fingerprint: `gpu:${label}`,
    geometries: scene.geometries, instances: scene.instances, analyticPrimitives: scene.analyticPrimitives,
    provenance: Object.freeze(provenance), diagnostics: Object.freeze([]),
  });
}

function makeEdgeScene() {
  const triangle = Object.freeze({ kind: 'triangle-mesh', geometryId: 'edge:triangle', revision: 1,
    positions: Object.freeze([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), normals: null, indices: null, primitiveCount: 2 });
  const large = Object.freeze({ kind: 'triangle-mesh', geometryId: 'edge:large', revision: 1,
    positions: Object.freeze([100000, 0, 0, 100008, 0, 0, 100000, 8, 0]), normals: null, indices: null, primitiveCount: 1 });
  return Object.freeze({ geometries: Object.freeze([triangle, large]), instances: Object.freeze([
    Object.freeze({ instanceId: 'edge:negative', entityId: 'entity:negative', geometryId: triangle.geometryId, geometryRevision: 1,
      transform: Object.freeze([-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0.5, 0, 10, 0, 0, 1]) }),
    Object.freeze({ instanceId: 'edge:large', entityId: 'entity:large', geometryId: large.geometryId, geometryRevision: 1,
      transform: Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }),
  ]), analyticPrimitives: Object.freeze([]) });
}

function makeRandomScene(count) {
  const positions = [];
  for (let index = 0; index < count; index++) {
    const x = index % 16; const y = Math.floor(index / 16);
    positions.push(x, y, 0, x + 0.8, y, 0, x, y + 0.8, 0);
  }
  const geometry = Object.freeze({ kind: 'triangle-mesh', geometryId: 'random:grid', revision: 1, positions: Object.freeze(positions), normals: null, indices: null, primitiveCount: count });
  const identity = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return Object.freeze({ geometries: Object.freeze([geometry]), instances: Object.freeze([
    Object.freeze({ instanceId: 'random:grid', entityId: 'entity:grid', geometryId: geometry.geometryId, geometryRevision: 1, transform: identity }),
  ]), analyticPrimitives: Object.freeze([
    Object.freeze({ kind: 'sphere', identity: Object.freeze({ instanceId: 'random:sphere', entityId: 'entity:sphere', geometryId: 'random:sphere', geometryRevision: 1, primitiveIndex: 0 }), center: Object.freeze([0, 0, 0]), radius: 1,
      transform: Object.freeze([1.5, 0, 0, 0, 0, 0.75, 0, 0, 0, 0, 2, 0, 18, 3, 0, 1]) }),
  ]) });
}

function makeRandomRays(count) {
  let state = 0x5eed1234;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
  return Object.freeze(Array.from({ length: count }, () => Object.freeze({
    origin: Object.freeze([random() * 22 - 2, random() * 14 - 2, 4 + random() * 6]),
    direction: Object.freeze([(random() - 0.5) * 0.05, (random() - 0.5) * 0.05, -1]), tMin: 0, tMax: 30,
  })));
}

function compareHit(cpu, gpu, label) {
  if (cpu === null || gpu === null) { assert(cpu === null && gpu === null, `${label}: hit/miss mismatch.`); return; }
  assert(cpu.primitiveKind === gpu.primitiveKind, `${label}: primitive kind mismatch.`);
  assert(gpu.instanceIdentity === `${cpu.identity.instanceId}|${cpu.identity.entityId}|${cpu.identity.geometryId}@${cpu.identity.geometryRevision}`, `${label}: instance identity mismatch.`);
  assert(gpu.geometryIdentity === `${cpu.identity.geometryId}@${cpu.identity.geometryRevision}`, `${label}: geometry identity mismatch.`);
  assert(cpu.identity.primitiveIndex === gpu.primitiveIndex, `${label}: primitive identity mismatch.`);
  close(cpu.t, gpu.t, label, 't');
  closeVec(cpu.position, gpu.position, label, 'position');
  closeVec(cpu.geometricNormal, gpu.geometricNormal, label, 'geometricNormal');
  closeVec(cpu.shadingNormal, gpu.shadingNormal, label, 'shadingNormal');
  closeVec(cpu.facingNormal, gpu.facingNormal, label, 'facingNormal');
  assert(cpu.frontFace === gpu.frontFace, `${label}: frontFace mismatch.`);
  if (cpu.barycentric === null || gpu.barycentric === null) assert(cpu.barycentric === null && gpu.barycentric === null, `${label}: barycentric null mismatch.`);
  else closeVec(cpu.barycentric, gpu.barycentric, label, 'barycentric');
}
function closeVec(a, b, label, field) { for (let index = 0; index < 3; index++) close(a[index], b[index], label, `${field}.${index}`); }
function close(a, b, label, field) { const tolerance = 3e-4 * Math.max(1, Math.abs(a), Math.abs(b)); assert(Math.abs(a - b) <= tolerance, `${label}: ${field} expected ${a}, received ${b}, tolerance ${tolerance}.`); }
function assert(value, message) { if (!value) throw new Error(message); }
function formatDiagnostics(value) { return JSON.stringify(value.map(entry => ({ code: entry.code, message: entry.message }))); }
function publish(status, value) { progressNode.textContent = status; resultNode.dataset.status = status; resultNode.textContent = JSON.stringify(value); }
