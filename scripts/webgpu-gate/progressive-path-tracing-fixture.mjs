const progressNode = document.querySelector('#progress'); const resultNode = document.querySelector('#result');
try { publish('passed', await run()); } catch (error) { publish('failed', { error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }); }

async function run() {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable.');
  const build = new URLSearchParams(location.search).get('build'); if (!build?.startsWith('/scripts/webgpu-gate/.progressive-path-tracing-build-')) throw new Error('Missing validated G06 build path.');
  const [sampling, denoise, renderer, materialPack, rayScene, acceleration, components, ecs, geometryApi, materialApi, lighting] = await Promise.all([
    import(`${build}/ray-tracing/sampling/index.js`), import(`${build}/ray-tracing/denoise/index.js`), import(`${build}/ray-tracing/renderer/index.js`),
    import(`${build}/ray-tracing/material/index.js`), import(`${build}/ray-tracing/scene/index.js`), import(`${build}/ray-tracing/acceleration/index.js`),
    import('@haiyue/engine/components'), import('@haiyue/engine/ecs'), import('@haiyue/engine/geometry'), import('@haiyue/engine/material'), import('@haiyue/engine/lighting'),
  ]);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); assert(adapter, 'No native WebGPU adapter.');
  const requestDevice = () => adapter.requestDevice({ requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] });
  let device = await requestDevice(); const uncaptured = []; device.addEventListener('uncapturederror', event => uncaptured.push(event.error?.message ?? String(event.error)));
  const fixture = createWorld(components, ecs, geometryApi, materialApi, lighting); const builder = new acceleration.RayAccelerationBuilder();
  let active = await buildBase(device, fixture.world, builder, { renderer, materialPack, rayScene, acceleration, sampling });
  let denoisedCreated = await denoise.RaySpatialTemporalDenoiser.create(device); assert(denoisedCreated.denoiser, formatDiagnostics(denoisedCreated.diagnostics));
  let activeDenoiser = denoisedCreated.denoiser;
  let progressiveCreated = await sampling.RayProgressiveRenderer.create(device, active.base, activeDenoiser); assert(progressiveCreated.renderer, formatDiagnostics(progressiveCreated.diagnostics));
  let progressive = progressiveCreated.renderer; const oldBases = []; const oldDenoisers = [];
  const common = { width: 32, height: 18, baseSeed: 0x13579bdf, maxBounces: 3, exposure: 1, toneMapping: 'aces' };
  let first = null; let eighth = null; let rawFinal = null; let timingSamples = 0; let maxPeakBytes = 0; let maxLiveResources = 0;
  for (let index = 1; index <= 32; index++) {
    const readback = index === 1 || index === 8 || index === 32;
    const result = await progressive.render(active.frame, { ...common, view: 'raw', readback }); assert(result.status === 'ok', `raw sample ${index}: ${formatDiagnostics(result.diagnostics)}`);
    if (index === 1) first = result; if (index === 8) eighth = result; if (index === 32) rawFinal = result;
    timingSamples += result.timing.kind === 'timestamp-query' ? 1 : 0; maxPeakBytes = Math.max(maxPeakBytes, result.memory.peakBytes); maxLiveResources = Math.max(maxLiveResources, result.memory.liveResourceCount);
  }
  assert(first.statistics.lastReset?.reasons.includes('initial') && rawFinal.statistics.sampleCount === 32, 'initial/sample-count contract failed.');
  const earlyError = meanAbsoluteError(first.pixels, rawFinal.pixels); const lateError = meanAbsoluteError(eighth.pixels, rawFinal.pixels);
  const rawConvergencePassed = lateError <= earlyError && rawFinal.statistics.varianceMax > 0; assert(rawConvergencePassed, `raw convergence ${earlyError}/${lateError}/${rawFinal.statistics.varianceMax}`);

  progressive.reset(); let replayFinal = null;
  for (let index = 1; index <= 32; index++) replayFinal = await progressive.render(active.frame, { ...common, view: 'raw', readback: index === 32 });
  const deterministicReplay = replayFinal.status === 'ok' && bytesEqual(rawFinal.pixels, replayFinal.pixels) && replayFinal.statistics.lastReset?.reasons.includes('explicit');
  assert(deterministicReplay, `fixed-seed replay failed: ${formatDiagnostics(replayFinal.diagnostics)}`);
  const denoisedResult = await progressive.render(active.frame, { ...common, view: 'denoised', readback: true }); assert(denoisedResult.status === 'ok', formatDiagnostics(denoisedResult.diagnostics));
  const rawContrast = maxNeighborContrast(replayFinal.pixels, 32, 18); const denoisedContrast = maxNeighborContrast(denoisedResult.pixels, 32, 18);
  const edgePreservationPassed = denoisedContrast >= rawContrast * 0.6 && totalVariation(denoisedResult.pixels, 32, 18) <= totalVariation(replayFinal.pixels, 32, 18) * 1.15;
  assert(edgePreservationPassed, `edge preservation ${rawContrast}/${denoisedContrast}`); drawCandidate(denoisedResult.pixels, 32, 18);
  const rawCandidateHash = hashBytes(rawFinal.pixels); const denoisedCandidateHash = hashBytes(denoisedResult.pixels); assert(rawCandidateHash !== denoisedCandidateHash, 'raw and denoised candidates are unexpectedly identical.');
  for (const view of ['variance', 'history-age', 'feature']) { const debug = await progressive.render(active.frame, { ...common, view, readback: true }); assert(debug.status === 'ok' && nonBlack(debug.pixels), `${view} debug view is empty.`); }

  const beforeResize = progressive.outputTexture; const resized = await progressive.render(active.frame, { ...common, width: 23, height: 11, view: 'denoised', readback: true });
  assert(resized.status === 'ok' && resized.pixels?.length === 23 * 11 * 4 && progressive.outputTexture !== beforeResize && resized.statistics.sampleCount === 1 && resized.statistics.lastReset?.reasons.includes('viewport'), `resize reset: ${formatDiagnostics(resized.diagnostics)}`);
  fixture.cameraTransform.setTranslation(0.18, 0, 4);
  active = { ...active, frame: frameFrom(active.snapshot, active.materials, renderer.extractRayPathSceneFacts(fixture.world), sampling) };
  const cameraReset = await progressive.render(active.frame, { ...common, width: 23, height: 11, view: 'denoised', readback: true });
  assert(cameraReset.status === 'ok' && cameraReset.statistics.lastReset?.reasons.includes('camera'), 'camera reset missing.');
  progressive.reset(); const cameraFresh = await progressive.render(active.frame, { ...common, width: 23, height: 11, view: 'denoised', readback: true });
  const ghostingPassed = cameraFresh.status === 'ok' && bytesEqual(cameraReset.pixels, cameraFresh.pixels); assert(ghostingPassed, 'camera reset retained ghost history.');
  fixture.light.intensity = 1.15; active = { ...active, frame: frameFrom(active.snapshot, active.materials, renderer.extractRayPathSceneFacts(fixture.world), sampling) };
  const lightReset = await progressive.render(active.frame, { ...common, width: 23, height: 11, view: 'denoised' }); assert(lightReset.statistics.lastReset?.reasons.includes('light'), 'light reset missing.');
  const qualityReset = await progressive.render(active.frame, { ...common, width: 23, height: 11, maxBounces: 2, qualityRevision: 'quality:low', view: 'denoised' }); assert(qualityReset.statistics.lastReset?.reasons.includes('quality'), 'quality reset missing.');
  const samplingReset = await progressive.render(active.frame, { ...common, width: 23, height: 11, baseSeed: 99, maxBounces: 2, qualityRevision: 'quality:low', view: 'denoised' }); assert(samplingReset.statistics.lastReset?.reasons.includes('sampling'), 'sampling reset missing.');
  oldDenoisers.push(activeDenoiser); progressive.setDenoiser(null);
  const denoiseDisabled = await progressive.render(active.frame, { ...common, width: 23, height: 11, baseSeed: 99, maxBounces: 2, qualityRevision: 'quality:low', view: 'raw' });
  const moduleUnloadPassed = denoiseDisabled.status === 'ok' && denoiseDisabled.statistics.lastReset?.reasons.includes('denoise') && denoiseDisabled.memory.denoiseScratchBytes === 0 && denoiseDisabled.memory.liveResourceCount === 7;
  assert(moduleUnloadPassed, `denoiser disable/unload failed: ${formatDiagnostics(denoiseDisabled.diagnostics)}`); oldDenoisers.splice(0).forEach(value => value.destroy());
  const replacementDenoiser = await denoise.RaySpatialTemporalDenoiser.create(device, { temporalFeedback: 0.12 }); assert(replacementDenoiser.denoiser, formatDiagnostics(replacementDenoiser.diagnostics));
  activeDenoiser = replacementDenoiser.denoiser; progressive.setDenoiser(activeDenoiser);
  const denoiseReset = await progressive.render(active.frame, { ...common, width: 23, height: 11, baseSeed: 99, maxBounces: 2, qualityRevision: 'quality:low', view: 'denoised' }); assert(denoiseReset.statistics.lastReset?.reasons.includes('denoise'), 'denoise reset missing.'); oldDenoisers.splice(0).forEach(value => value.destroy());

  fixture.surfaceTransform.setMatrix(new Float32Array([1,0,0,0, 0,0.96,0.18,0, 0,-0.18,0.96,0, 0,0,0,1]));
  let refreshed = await buildBase(device, fixture.world, builder, { renderer, materialPack, rayScene, acceleration, sampling }); assert(refreshed.kind === 'transform-refit', `transform update=${refreshed.kind}`);
  oldBases.push(active.base); progressive.replaceBaseRenderer(refreshed.base); active = refreshed;
  const transformReset = await progressive.render(active.frame, { ...common, width: 23, height: 11, baseSeed: 99, maxBounces: 2, qualityRevision: 'quality:low', view: 'denoised' }); assert(transformReset.statistics.lastReset?.reasons.includes('transform') && transformReset.statistics.lastReset.reasons.includes('renderer'), 'transform/renderer reset missing.'); oldBases.splice(0).forEach(value => value.destroy());
  fixture.material.roughness = 0.42; refreshed = await buildBase(device, fixture.world, builder, { renderer, materialPack, rayScene, acceleration, sampling }); assert(refreshed.kind === 'material-update', `material update=${refreshed.kind}`);
  oldBases.push(active.base); progressive.replaceBaseRenderer(refreshed.base); active = refreshed;
  const materialReset = await progressive.render(active.frame, { ...common, width: 23, height: 11, baseSeed: 99, maxBounces: 2, qualityRevision: 'quality:low', view: 'denoised' }); assert(materialReset.statistics.lastReset?.reasons.includes('material'), 'material reset missing.'); oldBases.splice(0).forEach(value => value.destroy());

  const pending = progressive.render(active.frame, { ...common, width: 23, height: 11, baseSeed: 99, maxBounces: 2, qualityRevision: 'quality:low', view: 'denoised' }); progressive.reset();
  const stale = await pending; assert(stale.status === 'failed' && stale.diagnostics.some(entry => entry.code === 'RAY_PROGRESSIVE_STALE_SAMPLE'), `rapid mutation stale=${formatDiagnostics(stale.diagnostics)}`);
  const afterRapid = await progressive.render(active.frame, { ...common, width: 23, height: 11, baseSeed: 99, maxBounces: 2, qualityRevision: 'quality:low', view: 'denoised' }); assert(afterRapid.status === 'ok' && afterRapid.statistics.sampleCount === 1 && afterRapid.statistics.lastReset?.reasons.includes('explicit'), 'rapid reset did not restart exactly once.');
  let longRunFinal = afterRapid;
  for (let sample = 2; sample <= 128; sample++) {
    longRunFinal = await progressive.render(active.frame, { ...common, width: 23, height: 11, baseSeed: 99, maxBounces: 2, qualityRevision: 'quality:low', view: 'denoised' });
    assert(longRunFinal.status === 'ok', `long-run sample ${sample}: ${formatDiagnostics(longRunFinal.diagnostics)}`);
  }
  const longRunSamples = longRunFinal.statistics.sampleCount; assert(longRunSamples === 128 && longRunFinal.memory.liveResourceCount === 10, `long-run history/resources=${longRunSamples}/${longRunFinal.memory.liveResourceCount}`);
  maxPeakBytes = Math.max(maxPeakBytes, longRunFinal.memory.peakBytes); maxLiveResources = Math.max(maxLiveResources, longRunFinal.memory.liveResourceCount);
  const firstArtifact = progressive.artifactHash; const firstDenoiseArtifact = activeDenoiser.artifactHash;
  device.destroy(); await device.lost; const lost = await progressive.render(active.frame, { ...common, width: 8, height: 8, view: 'denoised' });
  const deviceLossClassified = lost.status === 'failed' && lost.diagnostics.some(entry => entry.code === 'RAY_PROGRESSIVE_DEVICE_LOST' || entry.code === 'RAY_PATH_DEVICE_LOST'); assert(deviceLossClassified, formatDiagnostics(lost.diagnostics));
  progressive.destroy(); activeDenoiser.destroy(); active.base.destroy(); assert(progressive.liveResourceCount === 0 && activeDenoiser.liveResourceCount === 0 && active.base.liveResourceCount === 0, 'old device residuals.');

  const recoveredAdapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); assert(recoveredAdapter, 'No recovery WebGPU adapter.');
  device = await recoveredAdapter.requestDevice({ requiredFeatures: recoveredAdapter.features.has('timestamp-query') ? ['timestamp-query'] : [] }); device.addEventListener('uncapturederror', event => uncaptured.push(event.error?.message ?? String(event.error)));
  active = await buildBase(device, fixture.world, builder, { renderer, materialPack, rayScene, acceleration, sampling }); denoisedCreated = await denoise.RaySpatialTemporalDenoiser.create(device); assert(denoisedCreated.denoiser, formatDiagnostics(denoisedCreated.diagnostics)); activeDenoiser = denoisedCreated.denoiser;
  progressiveCreated = await sampling.RayProgressiveRenderer.create(device, active.base, activeDenoiser); assert(progressiveCreated.renderer, formatDiagnostics(progressiveCreated.diagnostics)); progressive = progressiveCreated.renderer;
  const recovered = await progressive.render(active.frame, { ...common, width: 8, height: 8, view: 'denoised', readback: true });
  const deviceRecoveryPassed = recovered.status === 'ok' && recovered.statistics.sampleCount === 1 && recovered.statistics.lastReset?.reasons.includes('initial'); assert(deviceRecoveryPassed, formatDiagnostics(recovered.diagnostics));
  const candidateHash = denoisedCandidateHash; const resetCount = afterRapid.statistics.resetCount; const residualBeforeDestroy = progressive.liveResourceCount + activeDenoiser.liveResourceCount + active.base.liveResourceCount;
  progressive.destroy(); activeDenoiser.destroy(); active.base.destroy(); builder.destroy(); fixture.world.destroy();
  const residualCount = progressive.liveResourceCount + activeDenoiser.liveResourceCount + active.base.liveResourceCount + builder.statistics.currentBytes;
  assert(residualCount === 0 && uncaptured.length === 0, `residual=${residualCount}, uncaptured=${uncaptured.join('; ')}`);
  const info = adapter.info ?? {};
  return { schemaVersion: 1, suite: 'ray-progressive-sampling-denoise', status: 'passed', progressiveArtifactHash: firstArtifact, denoiseArtifactHash: firstDenoiseArtifact,
    candidateHash, rawCandidateHash, denoisedCandidateHash, deterministicReplay, rawConvergencePassed, edgePreservationPassed, ghostingPassed, moduleUnloadPassed, deviceLossClassified, deviceRecoveryPassed,
    earlyError, lateError, rawContrast, denoisedContrast, resetCount, sampleCount: rawFinal.statistics.sampleCount, longRunSamples, timingSamples, maxPeakBytes, maxLiveResources,
    residualBeforeDestroy, residualCount, validationErrorCount: 0, uncapturedErrorCount: uncaptured.length, unclassifiedFailureCount: 0,
    adapter: { vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '', description: info.description ?? '' } };
}

async function buildBase(device, world, builder, api) {
  const extracted = api.rayScene.extractRayTracingScene(world); assert(extracted.valid, JSON.stringify(extracted.diagnostics));
  const update = builder.update(extracted.snapshot); assert(update.snapshot, JSON.stringify(update.diagnostics));
  const packed = api.materialPack.packRayPbrMaterialScene(world, update.snapshot.packed, { textureResolver: resolveTexture }); assert(packed.packed, JSON.stringify(packed.diagnostics));
  const facts = api.renderer.extractRayPathSceneFacts(world); const frame = frameFrom(update.snapshot, packed.packed, facts, api.sampling);
  const created = await api.renderer.RayPathTracingRenderer.create(device, update.snapshot.packed, packed.packed); assert(created.renderer, formatDiagnostics(created.diagnostics));
  return { base: created.renderer, snapshot: update.snapshot, materials: packed.packed, frame, kind: update.kind };
}
function frameFrom(snapshot, materials, facts, sampling) { assert(facts.facts, formatDiagnostics(facts.diagnostics)); return Object.freeze({ facts: facts.facts, revision: sampling.createRayProgressiveFrameRevision(snapshot, materials, facts.facts) }); }
function createWorld(components, ecs, geometryApi, materialApi, lighting) {
  const world = new ecs.World('g06-browser'); const plane = new geometryApi.Geometry3D({ positions: new Float32Array([-3,-3,0, 3,-3,0, -3,3,0, 3,-3,0, 3,3,0, -3,3,0]), normals: new Float32Array(Array.from({length:6},()=>[0,0,1]).flat()), textureCoordinates: [{ set: 0, data: new Float32Array([0,0,1,0,0,1,1,0,1,1,0,1]) }] });
  const material = new materialApi.PbrMaterial({ baseColor: [0.72,0.3,0.12,1], metallic: 0.05, roughness: 0.72, baseColorTexture: 'base', metallicRoughnessTexture: 'mr', normalTexture: 'normal', emissiveFactor: [0.006,0.002,0.001] });
  const surface = new ecs.Entity('surface'); const surfaceTransform = new components.Transform3D(); surface.add(surfaceTransform); surface.add(new components.Mesh3D(plane, material)); world.addEntity(surface);
  const sideMaterial = new materialApi.PbrMaterial({ baseColor: [0.08,0.42,0.18,1], metallic: 0, roughness: 0.8 }); const side = new ecs.Entity('side'); side.add(new components.Transform3D().setMatrix(new Float32Array([0,0,-1,0, 0,1,0,0, 1,0,0,0, -1.9,0,1.3,1]))); side.add(new components.Mesh3D(plane, sideMaterial)); world.addEntity(side);
  const camera = new ecs.Entity('camera'); const cameraTransform = new components.Transform3D().setTranslation(0,0,4); camera.add(cameraTransform); camera.add(new components.Camera3D({ fov: Math.PI/3, near: 0.01, far: 50 })); world.addEntity(camera);
  const lightEntity = new ecs.Entity('sun'); const light = new lighting.DirectionalLight({ direction: [0.25,-0.2,-1], intensity: 1.8, color: [1,0.9,0.78] }); lightEntity.add(light); world.addEntity(lightEntity);
  const environmentEntity = new ecs.Entity('environment'); environmentEntity.add(new lighting.EnvironmentLight({ intensity: 0.22, specularColor: [0.12,0.2,0.42] })); world.addEntity(environmentEntity);
  return { world, material, surfaceTransform, cameraTransform, light };
}
function resolveTexture(source) { const value = { base:[205,92,35,255], mr:[255,190,40,255], normal:[128,128,255,255] }[String(source)]; return value ? { identity:String(source), revision:1, width:1, height:1, data:Uint8Array.from(value) } : null; }
function drawCandidate(pixels,width,height){const canvas=document.querySelector('#candidate');canvas.width=width;canvas.height=height;canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels),width,height),0,0);}
function bytesEqual(a,b){if(!a||!b||a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
function meanAbsoluteError(a,b){let sum=0;for(let i=0;i<a.length;i+=4)for(let c=0;c<3;c++)sum+=Math.abs(a[i+c]-b[i+c]);return sum/(a.length/4*3);}
function luma(data,index){return(data[index]*0.2126+data[index+1]*0.7152+data[index+2]*0.0722)/255;}
function maxNeighborContrast(data,w,h){let max=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4,v=luma(data,i);if(x+1<w)max=Math.max(max,Math.abs(v-luma(data,i+4)));if(y+1<h)max=Math.max(max,Math.abs(v-luma(data,i+w*4)));}return max;}
function totalVariation(data,w,h){let sum=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4,v=luma(data,i);if(x+1<w)sum+=Math.abs(v-luma(data,i+4));if(y+1<h)sum+=Math.abs(v-luma(data,i+w*4));}return sum;}
function nonBlack(data){return data&&data.some((value,index)=>index%4!==3&&value>0);}
function hashBytes(bytes){let hash=0x811c9dc5;for(const byte of bytes){hash^=byte;hash=Math.imul(hash,0x01000193);}return`fnv1a32:${(hash>>>0).toString(16).padStart(8,'0')}`;}
function assert(value,message){if(!value)throw new Error(message);} function formatDiagnostics(value){return JSON.stringify(value.map(entry=>({code:entry.code,message:entry.message})));}
function publish(status,value){progressNode.textContent=status;resultNode.dataset.status=status;resultNode.textContent=JSON.stringify(value);}
