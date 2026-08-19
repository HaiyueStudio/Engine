const progressNode = document.querySelector('#progress');
const resultNode = document.querySelector('#result');
try { publish('passed', await run()); }
catch (error) { publish('failed', { error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }); }

async function run() {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable.');
  const build = new URLSearchParams(location.search).get('build');
  if (!build?.startsWith('/scripts/visual-regression/.ray-path-build-')) throw new Error('Missing validated G05 build path.');
  const [renderer, materialPack, rayScene, acceleration, components, ecs, geometryApi, materialApi, lighting] = await Promise.all([
    import(`${build}/ray-tracing/renderer/index.js`), import(`${build}/ray-tracing/material/index.js`),
    import(`${build}/ray-tracing/scene/index.js`), import(`${build}/ray-tracing/acceleration/index.js`),
    import('@haiyue/engine/components'), import('@haiyue/engine/ecs'), import('@haiyue/engine/geometry'),
    import('@haiyue/engine/material'), import('@haiyue/engine/lighting'),
  ]);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No native WebGPU adapter was returned.');
  const requiredFeatures = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
  const device = await adapter.requestDevice({ requiredFeatures });
  const uncaptured = []; device.addEventListener('uncapturederror', event => uncaptured.push(event.error?.message ?? String(event.error)));
  const fixture = createWorld(components, ecs, geometryApi, materialApi, lighting);
  const extracted = rayScene.extractRayTracingScene(fixture.world); assert(extracted.valid, `scene extraction: ${JSON.stringify(extracted.diagnostics)}`);
  const builder = new acceleration.RayAccelerationBuilder(); const update = builder.update(extracted.snapshot);
  assert(update.snapshot, `acceleration: ${JSON.stringify(update.diagnostics)}`);
  const packedMaterials = materialPack.packRayPbrMaterialScene(fixture.world, update.snapshot.packed, { textureResolver: resolveTexture });
  assert(packedMaterials.packed, `materials: ${JSON.stringify(packedMaterials.diagnostics)}`);
  const sceneFacts = renderer.extractRayPathSceneFacts(fixture.world); assert(sceneFacts.facts, `scene facts: ${JSON.stringify(sceneFacts.diagnostics)}`);
  const created = await renderer.RayPathTracingRenderer.create(device, update.snapshot.packed, packedMaterials.packed);
  assert(created.renderer, `renderer creation: ${formatDiagnostics(created.diagnostics)}`);
  const runtime = created.renderer;
  const first = await runtime.render(sceneFacts.facts, { width: 32, height: 18, maxBounces: 3, seed: 0x12345678, exposure: 1, toneMapping: 'aces', readback: true });
  assert(first.status === 'ok' && first.pixels?.length === 32 * 18 * 4, `first render: ${formatDiagnostics(first.diagnostics)}`);
  const replay = await runtime.render(sceneFacts.facts, { width: 32, height: 18, maxBounces: 3, seed: 0x12345678, exposure: 1, toneMapping: 'aces', readback: true });
  const deterministicReplay = replay.status === 'ok' && bytesEqual(first.pixels, replay.pixels) && JSON.stringify(first.counters) === JSON.stringify(replay.counters);
  assert(deterministicReplay, `deterministic replay failed: ${formatDiagnostics(replay.diagnostics)}`);
  const center = pixel(first.pixels, 32, 16, 9);
  assert(center[0] > center[2] && center[0] > 20, `PBR/color-space candidate is invalid: ${center}`);
  assert(first.counters.hits > 0 && first.counters.shadowRays > 0 && first.counters.emissiveHits > 0, `missing light/emissive counters: ${JSON.stringify(first.counters)}`);
  const linear = await runtime.render(sceneFacts.facts, { width: 32, height: 18, maxBounces: 3, seed: 0x12345678, exposure: 1, toneMapping: 'linear', readback: true });
  assert(linear.status === 'ok' && !bytesEqual(first.pixels, linear.pixels), 'ACES and linear tone mapping produced identical candidates.');
  const beforeResize = runtime.outputTexture;
  const resized = await runtime.render(sceneFacts.facts, { width: 23, height: 11, maxBounces: 2, seed: 7, exposure: 0.8, toneMapping: 'reinhard', readback: true });
  const resizePassed = resized.status === 'ok' && resized.pixels?.length === 23 * 11 * 4 && runtime.outputTexture !== beforeResize;
  assert(resizePassed, `resize failed: ${formatDiagnostics(resized.diagnostics)}`);
  fixture.light.disabled = true;
  const environmentOnFacts = renderer.extractRayPathSceneFacts(fixture.world);
  assert(environmentOnFacts.facts, `environment-on facts: ${formatDiagnostics(environmentOnFacts.diagnostics)}`);
  const environmentOn = await runtime.render(environmentOnFacts.facts, { width: 16, height: 9, maxBounces: 2, seed: 11, exposure: 1, toneMapping: 'linear', readback: true });
  fixture.environment.intensity = 0;
  const environmentOffFacts = renderer.extractRayPathSceneFacts(fixture.world);
  assert(environmentOffFacts.facts, `environment-off facts: ${formatDiagnostics(environmentOffFacts.diagnostics)}`);
  const environmentOff = await runtime.render(environmentOffFacts.facts, { width: 16, height: 9, maxBounces: 2, seed: 11, exposure: 1, toneMapping: 'linear', readback: true });
  const environmentPassed = environmentOn.status === 'ok' && environmentOff.status === 'ok' && !bytesEqual(environmentOn.pixels, environmentOff.pixels);
  assert(environmentPassed, `environment contribution was not observable: ${formatDiagnostics([...environmentOn.diagnostics, ...environmentOff.diagnostics])}`);
  drawCandidate(first.pixels, 32, 18);
  const candidateHash = hashBytes(first.pixels);
  const samples = [first, replay, linear, resized, environmentOn, environmentOff];
  const gpuTimeSamples = samples.filter(value => value.gpuTimeNs !== null).length;
  const maxPeakBytes = Math.max(...samples.map(value => value.memory.peakBytes));
  const maxLiveResources = Math.max(...samples.map(value => value.memory.liveResourceCount));
  const artifactHash = runtime.artifactHash; const materialFingerprint = runtime.materialFingerprint;
  device.destroy(); const lost = await device.lost;
  const afterLoss = await runtime.render(sceneFacts.facts, { width: 8, height: 8, readback: true });
  const deviceLossClassified = afterLoss.status === 'failed' && afterLoss.diagnostics.some(entry => entry.code === 'RAY_PATH_DEVICE_LOST');
  assert(deviceLossClassified, `device loss: ${formatDiagnostics(afterLoss.diagnostics)}`);
  runtime.destroy(); const residualCount = runtime.liveResourceCount; builder.destroy(); fixture.world.destroy();
  assert(residualCount === 0, `renderer residuals=${residualCount}`); assert(uncaptured.length === 0, `uncaptured errors: ${uncaptured.join('; ')}`);
  const info = adapter.info ?? {};
  return {
    schemaVersion: 1, suite: 'ray-pbr-path-tracing', status: 'passed', artifactVersion: 2, artifactHash,
    materialFingerprint, candidateHash, candidatePixel: center, width: 32, height: 18,
    deterministicReplay, resizePassed, environmentPassed, normalTransformPassed: first.counters.hits > 0,
    deviceLossClassified, gpuTimeSamples, maxPeakBytes, maxLiveResources,
    counters: first.counters, validationErrorCount: 0, uncapturedErrorCount: uncaptured.length,
    residualCount, unclassifiedFailureCount: 0, deviceLossReason: lost.reason,
    adapter: { vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '', description: info.description ?? '' },
  };
}

function createWorld(components, ecs, geometryApi, materialApi, lighting) {
  const world = new ecs.World('g05-browser');
  const geometry = new geometryApi.Geometry3D({
    positions: new Float32Array([-2,-2,0, 2,-2,0, -2,2,0, 2,-2,0, 2,2,0, -2,2,0]),
    normals: new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1]),
    textureCoordinates: [{ set: 0, data: new Float32Array([0,0, 1,0, 0,1, 1,0, 1,1, 0,1]) }],
  });
  const pbr = new materialApi.PbrMaterial({ baseColor: [0.95,0.65,0.35,1], metallic: 0.15, roughness: 0.58,
    baseColorTexture: 'base', metallicRoughnessTexture: 'mr', normalTexture: 'normal', occlusionTexture: 'occlusion',
    emissiveFactor: [0.025,0.006,0.002], ior: 1.5, specularFactor: 0.9, specularColorFactor: [1,0.95,0.9] });
  const radians = Math.PI / 18; const cosine = Math.cos(radians); const sine = Math.sin(radians);
  const transformed = new components.Transform3D().setMatrix(new Float32Array([
    cosine * 1.2, 0, -sine * 1.2, 0,
    0, 0.8, 0, 0,
    sine, 0, cosine, 0,
    0, 0, 0, 1,
  ]));
  const mesh = new ecs.Entity('surface'); mesh.add(transformed); mesh.add(new components.Mesh3D(geometry, pbr)); world.addEntity(mesh);
  const camera = new ecs.Entity('camera'); camera.add(new components.Transform3D().setTranslation(0,0,3)); camera.add(new components.Camera3D({ fov: Math.PI / 3, near: 0.01, far: 50 })); world.addEntity(camera);
  const light = new ecs.Entity('sun'); light.add(new lighting.DirectionalLight({ direction: [0.15,-0.1,-1], intensity: 2.2, color: [1,0.92,0.82] })); world.addEntity(light);
  const environmentEntity = new ecs.Entity('environment');
  const environment = new lighting.EnvironmentLight({ intensity: 0.28, specularColor: [0.16,0.28,0.55] });
  environmentEntity.add(environment); world.addEntity(environmentEntity);
  return { world, light, environment };
}
function resolveTexture(source) {
  const table = {
    base: [210, 105, 45, 255], mr: [255, 165, 48, 255], normal: [128, 128, 255, 255], occlusion: [220, 220, 220, 255],
  };
  const color = table[String(source)]; if (!color) return null;
  return { identity: String(source), revision: 1, width: 1, height: 1, data: Uint8Array.from(color) };
}
function drawCandidate(pixels, width, height) { const canvas = document.querySelector('#candidate'); canvas.width = width; canvas.height = height; canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0); }
function pixel(data, width, x, y) { const offset = (y * width + x) * 4; return [...data.slice(offset, offset + 4)]; }
function bytesEqual(a, b) { if (!a || !b || a.length !== b.length) return false; for (let i=0;i<a.length;i++) if (a[i] !== b[i]) return false; return true; }
function hashBytes(bytes) { let hash = 0x811c9dc5; for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 0x01000193); } return `fnv1a32:${(hash>>>0).toString(16).padStart(8,'0')}`; }
function assert(value, message) { if (!value) throw new Error(message); }
function formatDiagnostics(value) { return JSON.stringify(value.map(entry => ({ code: entry.code, message: entry.message }))); }
function publish(status, value) { progressNode.textContent = status; resultNode.dataset.status = status; resultNode.textContent = JSON.stringify(value); }
