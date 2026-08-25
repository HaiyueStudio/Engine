#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseAnimation } from '../../animation-spec/dist/index.js';
import { createDeformableMesh2DFormatRegistry, decodeDeformableMesh2DData } from '../../animation-spec/dist/deformable2d.js';
import { OfflineConversionError } from '../../animation-spec/dist/conversion.js';
import { CUBISM_CAPTURE_FRAME_OPERATIONS, runCubismClipBakedConversion } from '../../animation-spec/dist/live2d/clip-baked.js';
import { runChromeWebGpuFixture } from '../webgpu-gate/chrome-runner.mjs';
import { G07_CANDIDATE_KIND, validateG07Candidate, validateG07Manifest } from './deformable2d-g07-candidate-contract.mjs';

const root = resolve(import.meta.dirname, '../..');
const manifestPath = resolve(root, 'animation-spec/corpus/deformable2d/fidelity-performance-corpus-manifest.json');
const manifestBytes = readFileSync(manifestPath);
const manifest = validateG07Manifest(JSON.parse(manifestBytes));
const args = parseArguments(process.argv.slice(2));
const fidelityReport = JSON.parse(readFileSync(resolve(args.fidelityReport), 'utf8'));
const fidelityById = new Map(fidelityReport.samples.map(sample => [sample.id, sample]));
const repository = repositoryEvidence(root);
const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'haiyue-g07-'));

try {
  const coreBytes = args.core ? readFileSync(resolve(args.core)) : Buffer.from(await fetchRequired(manifest.oracle.coreUrl));
  assertCore(coreBytes);
  prepareCaptureFixture(temporaryRoot, coreBytes);
  const samples = [];
  for (const expected of manifest.samples) {
    const directory = resolve(args.models.get(expected.id) ?? missingModel(expected.id));
    console.log(`[deformable2d-g07] ${expected.id}: validating source and capturing official Core oracle...`);
    const sourceEvidence = validateSourceDirectory(directory, expected);
    const capture = await captureOfficialCore(temporaryRoot, directory, expected);
    const converted = await convertSample(directory, expected, capture, manifest.methodology.sampling);
    const pixel = fidelityById.get(expected.id);
    if (!pixel) throw new Error(`Fidelity report omitted ${expected.id}.`);
    const sampleRoot = resolve(temporaryRoot, `playback-${expected.id}`);
    writePlaybackPackage(sampleRoot, converted.result.artifacts);
    const runtimeRaw = await measureRuntime(sampleRoot);
    const packageMetrics = sizeMetrics(converted.result.artifacts.map(artifact => artifact.bytes));
    const runtime = normalizeRuntime(runtimeRaw, packageMetrics.rawBytes, manifest.neutralRuntimeFixture.forbiddenRuntimeTokens);
    samples.push({
      id: expected.id,
      title: expected.title,
      source: { runtimeDirectoryHash: sourceEvidence.runtimeDirectoryHash, fileCount: sourceEvidence.fileCount, rawBytes: sourceEvidence.rawBytes, gzipBytes: sourceEvidence.gzipBytes },
      recipe: expected.recipe,
      featureCoverage: inspectFeatureCoverage(capture),
      diagnostics: [...capture.g07Diagnostics, ...converted.result.report.diagnostics],
      conversion: {
        converterMs: converted.converterMs,
        bakedFrameCount: converted.result.times.length,
        evaluationCount: converted.evaluationCount,
        sampling: converted.result.report.sampling,
        nodeParse: measureNodeParse(converted.result.artifacts.find(artifact => artifact.path === 'model.hya').bytes),
      },
      structuralFidelity: validateDenseFidelity(capture, converted.result.artifacts, manifest.methodology.structuralTolerance),
      pixelFidelity: {
        reference: 'official-cubism-core-same-version',
        sampledAt: pixel.sampledAt,
        comparisonConfiguration: pixel.comparisonConfiguration,
        surfaceReadback: pixel.surfaceReadback,
        acceptedReadback: pixel.surfaceReadback.onePixelSpatialTolerance,
        spatialTolerancePixels: manifest.methodology.referenceConfiguration.silhouetteSpatialTolerancePixels,
      },
      package: packageMetrics,
      runtime,
    });
  }

  const fullRecipeBlockers = await verifyFullRecipeNoGo(args.models.get('niziiro-mao'), manifest.samples.find(sample => sample.id === 'niziiro-mao'), temporaryRoot);
  const neutralRuntime = await runNeutralFixture(temporaryRoot, manifest);
  const candidate = {
    schemaVersion: 1,
    kind: G07_CANDIDATE_KIND,
    goal: 'M05-G07',
    formalEvidence: false,
    revision: repository.revision,
    dirty: repository.dirty,
    manifest: { id: manifest.id, sha256: sha256(manifestBytes) },
    oracle: {
      coreVersion: manifest.oracle.coreVersion,
      coreByteLength: coreBytes.byteLength,
      coreSha256: sha256(coreBytes),
      captureFormat: manifest.oracle.captureFormat,
      evaluatorCapabilities: manifest.oracle.frameworkCapability,
    },
    environment: { node: process.version, platform: process.platform, arch: process.arch, browser: samples[0].runtime.browser },
    methodology: manifest.methodology,
    samples,
    neutralRuntime,
    verdict: {
      status: 'no-go',
      owner: 'M05-G09',
      reason: 'The pinned official Core evaluator proves Motion and drawable output, but the official Framework evaluation path for Expression + Physics + Pose is not integrated.',
      blockers: fullRecipeBlockers,
    },
    summary: summarize(samples),
    unclassifiedFailureCount: 0,
  };
  validateG07Candidate(candidate, manifest, { requireClean: false });
  writeFileSync(resolve(args.output), `${JSON.stringify(candidate, null, 2)}\n`);
  console.log(`[deformable2d-g07] wrote ${args.output}; verdict=${candidate.verdict.status}; dirty=${candidate.dirty}.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function parseArguments(values) {
  const parsed = { models: new Map(), core: null, fidelityReport: null, output: 'review/candidates/deformable2d-g07-candidate.json' };
  for (let index = 0; index < values.length; index++) {
    const argument = values[index];
    if (argument === '--model') { const [id, ...rest] = required(values, ++index, argument).split('='); parsed.models.set(id, rest.join('=')); }
    else if (argument === '--core') parsed.core = required(values, ++index, argument);
    else if (argument === '--fidelity-report') parsed.fidelityReport = required(values, ++index, argument);
    else if (argument === '--out') parsed.output = required(values, ++index, argument);
    else throw new Error(`Unknown argument ${argument}.`);
  }
  if (!parsed.fidelityReport) throw new Error('--fidelity-report is required.');
  return parsed;
}

function prepareCaptureFixture(directory, coreBytes) {
  cpSync(resolve(root, 'animation-spec/live2d/tools/capture-page.html'), resolve(directory, 'capture-page.html'));
  cpSync(resolve(root, 'animation-spec/live2d/tools/capture-page.mjs'), resolve(directory, 'capture-page.mjs'));
  writeFileSync(resolve(directory, 'live2dcubismcore.min.js'), coreBytes);
}

async function captureOfficialCore(workRoot, modelRoot, expected) {
  const result = await runChromeWebGpuFixture({
    root: workRoot,
    fixture: 'capture-page.html',
    query: {
      model: `/__model/${expected.source.entry}`,
      motion: `/__model/${expected.recipe.motionFile}`,
      fps: manifest.methodology.captureFrameRate,
    },
    mounts: [{ prefix: '/__model', directory: modelRoot }],
    timeoutMs: 180_000,
  });
  if (!result.capture) throw new Error(`${expected.id} official Core capture returned no payload.`);
  if (result.capture.source.coreVersion !== String(manifest.oracle.coreVersion)) throw new Error(`${expected.id} Core version drifted: ${result.capture.source.coreVersion}.`);
  let unusedInvertedFlagCount = 0;
  for (const frame of result.capture.frames) for (const drawable of frame.drawables) {
    if (drawable.invertedMask === true && drawable.masks.length === 0) {
      // Core can expose an inverted constant bit on a drawable that is not a
      // mask target. It has no composition semantics without mask sources.
      drawable.invertedMask = false;
      unusedInvertedFlagCount++;
    }
  }
  result.capture.g07Diagnostics = unusedInvertedFlagCount === 0 ? [] : [{
    severity: 'warning',
    code: 'W_G07_UNUSED_INVERTED_MASK_FLAG_NORMALIZED',
    path: '$.frames[*].drawables[*].invertedMask',
    message: `${unusedInvertedFlagCount} Core inverted bits without mask references were normalized to false before strict source-neutral conversion.`,
  }];
  return result.capture;
}

async function convertSample(directory, expected, capture, sampling) {
  const allFiles = listFiles(directory);
  const model3 = JSON.parse(readFileSync(resolve(directory, expected.source.entry), 'utf8'));
  const textures = model3.FileReferences.Textures.map((uri, index) => ({ id: `texture-${index}`, uri, integrity: `sha256-${sha256(readFileSync(resolve(directory, uri)))}` }));
  let evaluationCount = 0;
  const evaluator = {
    version: 'official-core-dense-linear-oracle@1',
    duration: capture.duration,
    keyTimes: capture.frames.map(frame => frame.time),
    capabilities: { motion: true, expression: false, physics: false, pose: false, drawableColors: capture.capabilities?.drawableColors === 'captured' },
    async evaluate(time) { evaluationCount++; return sampleCapture(capture, time); },
    close() {},
  };
  const source = {
    entry: expected.source.entry, name: expected.title, sourceVersion: expected.source.runtimeDirectoryHash,
    coreVersion: String(manifest.oracle.coreVersion), canvas: capture.canvas, frameRate: capture.frameRate,
    textures,
    dependencies: allFiles.filter(path => path !== expected.source.entry).map(uri => ({ uri, integrity: `sha256-${sha256(readFileSync(resolve(directory, uri)))}` })),
    evaluator,
  };
  const host = fileHost(directory);
  const started = performance.now();
  const result = await runCubismClipBakedConversion({
    source,
    sourceBytes: readFileSync(resolve(directory, expected.source.entry)),
    recipe: { id: `${expected.id}-motion`, clip: expected.recipe.motionId, motion: expected.recipe.motionFile, duration: capture.duration },
    host,
    sampling,
    mode: 'strict',
  });
  return { result, evaluator, source, host, evaluationCount, converterMs: performance.now() - started };
}

async function verifyFullRecipeNoGo(directoryInput, expected, workRoot) {
  const directory = resolve(directoryInput ?? missingModel('niziiro-mao'));
  const capture = await captureOfficialCore(workRoot, directory, expected);
  const converted = await createSourceOnly(directory, expected, capture);
  const blockers = [];
  for (const capability of ['expression', 'physics', 'pose']) {
    const requested = capability === 'expression' ? { expression: expected.recipe.expression } : { [capability]: true };
    try {
      await runCubismClipBakedConversion({
        source: converted.source, sourceBytes: readFileSync(resolve(directory, expected.source.entry)), host: converted.host,
        recipe: { id: `mao-${capability}-recipe`, clip: expected.recipe.motionId, motion: expected.recipe.motionFile, duration: capture.duration, ...requested },
        sampling: manifest.methodology.sampling, mode: 'strict',
      });
      throw new Error(`Mao ${capability} recipe unexpectedly passed without an official Framework evaluator.`);
    } catch (error) {
      if (!(error instanceof OfflineConversionError) || error.code !== 'E_CUBISM_RECIPE_CAPABILITY_MISSING' || error.path !== `$.recipe.${capability}`) throw error;
      blockers.push({
      sampleId: expected.id,
      capability,
      code: 'E_CUBISM_RECIPE_CAPABILITY_MISSING',
      path: `$.recipe.${capability}`,
      owner: 'official-framework-evaluator',
      message: `Pinned evaluator does not execute ${capability}; G09 must remain no-go until the official Framework path is integrated and rerun.`,
      });
    }
  }
  return blockers;
}

async function createSourceOnly(directory, expected, capture) {
  const allFiles = listFiles(directory);
  const model3 = JSON.parse(readFileSync(resolve(directory, expected.source.entry), 'utf8'));
  return {
    source: {
      entry: expected.source.entry, name: expected.title, sourceVersion: expected.source.runtimeDirectoryHash,
      coreVersion: String(manifest.oracle.coreVersion), canvas: capture.canvas, frameRate: capture.frameRate,
      textures: model3.FileReferences.Textures.map((uri, index) => ({ id: `texture-${index}`, uri, integrity: `sha256-${sha256(readFileSync(resolve(directory, uri)))}` })),
      dependencies: allFiles.filter(path => path !== expected.source.entry).map(uri => ({ uri, integrity: `sha256-${sha256(readFileSync(resolve(directory, uri)))}` })),
      evaluator: { version: 'official-core-motion-only@1', duration: capture.duration, keyTimes: capture.frames.map(frame => frame.time), capabilities: { motion: true, expression: false, physics: false, pose: false, drawableColors: true }, async evaluate(time) { return sampleCapture(capture, time); }, close() {} },
    },
    host: fileHost(directory),
  };
}

function sampleCapture(capture, time) {
  const frames = capture.frames;
  if (time <= frames[0].time) return frames[0];
  if (time >= frames.at(-1).time) return frames.at(-1);
  let right = 1;
  while (frames[right].time < time) right++;
  const left = right - 1;
  const progress = (time - frames[left].time) / (frames[right].time - frames[left].time);
  return CUBISM_CAPTURE_FRAME_OPERATIONS.interpolate(frames[left], frames[right], progress);
}

function validateDenseFidelity(capture, artifacts, tolerance) {
  const hydm = artifacts.find(artifact => artifact.path === 'model.hydm');
  const data = decodeDeformableMesh2DData(exactBuffer(hydm.bytes));
  const ordered = [...capture.frames[0].drawables].sort((a, b) => a.renderOrder - b.renderOrder || a.id.localeCompare(b.id));
  let maximum = 0;
  let renderOrderMismatchCount = 0;
  for (const frame of capture.frames) {
    const sampled = sampleHydm(data, frame.time);
    for (let drawableIndex = 0; drawableIndex < ordered.length; drawableIndex++) {
      const source = frame.drawables.find(drawable => drawable.id === ordered[drawableIndex].id);
      const target = sampled[drawableIndex];
      if (source.positions.length) for (let index = 0; index < source.positions.length; index += 2) {
        maximum = Math.max(maximum,
          Math.abs(source.positions[index] - (target.positions[index] - capture.canvas.width / 2) / capture.canvas.pixelsPerUnit),
          Math.abs(source.positions[index + 1] - (capture.canvas.height / 2 - target.positions[index + 1]) / capture.canvas.pixelsPerUnit));
      }
      maximum = Math.max(maximum, Math.abs(source.opacity - target.opacity));
      maximum = Math.max(maximum, colorError(source.multiplyColor, target.multiplyColor, [1, 1, 1, 1]));
      maximum = Math.max(maximum, colorError(source.screenColor, target.screenColor, [0, 0, 0, 0]));
      if (source.renderOrder !== target.renderOrder) renderOrderMismatchCount++;
    }
  }
  if (maximum > tolerance.maxPositionOpacityColorError || renderOrderMismatchCount !== tolerance.renderOrderMismatchCount) throw new Error(`Dense structural fidelity failed: max=${maximum}, orderMismatch=${renderOrderMismatchCount}.`);
  return { denseFrameCount: capture.frames.length, drawableCount: ordered.length, maxError: maximum, renderOrderMismatchCount, tolerance };
}

function sampleHydm(data, time) {
  let right = 1;
  while (right < data.times.length && data.times[right] < time) right++;
  right = Math.min(right, data.times.length - 1);
  const left = Math.max(0, right - 1);
  const range = data.times[right] - data.times[left];
  const p = range > 0 ? Math.max(0, Math.min(1, (time - data.times[left]) / range)) : 0;
  return data.drawables.map(drawable => {
    const stride = drawable.uvs.length;
    const positions = new Array(stride);
    for (let index = 0; index < stride; index++) positions[index] = mix(drawable.positions[left * stride + index], drawable.positions[right * stride + index], p);
    return {
      positions,
      opacity: mix(drawable.opacities[left], drawable.opacities[right], p),
      renderOrder: p < 0.5 ? drawable.renderOrders[left] : drawable.renderOrders[right],
      multiplyColor: colorAt(drawable.multiplyColors, left, right, p, [1, 1, 1, 1]),
      screenColor: colorAt(drawable.screenColors, left, right, p, [0, 0, 0, 0]),
    };
  });
}

function writePlaybackPackage(directory, artifacts) {
  mkdirSync(directory, { recursive: true });
  cpSync(resolve(root, 'scripts/benchmark/deformable2d-g07-playback-fixture.html'), resolve(directory, 'playback.html'));
  cpSync(resolve(root, 'scripts/benchmark/deformable2d-g07-playback-fixture.mjs'), resolve(directory, 'deformable2d-g07-playback-fixture.mjs'));
  for (const artifact of artifacts) { const path = resolve(directory, artifact.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, artifact.bytes); }
}

async function measureRuntime(directory) {
  return runChromeWebGpuFixture({
    root: directory,
    fixture: 'playback.html',
    mounts: [{ prefix: '/__repo', directory: root }],
    crossOriginIsolation: true,
    timeoutMs: 180_000,
    allocationSampling: { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true },
    visualCapture: { viewportWidth: 719, viewportHeight: 800, sampleWidth: 24, sampleHeight: 24 },
  });
}

function normalizeRuntime(result, packageRawBytes, forbiddenTokens) {
  const files = result.httpProvenance.files;
  const totalBytes = files.reduce((sum, file) => sum + file.byteLength * file.requestCount, 0);
  const forbidden = files.filter(file => forbiddenTokens.some(token => file.sourcePath.toLowerCase().includes(token.toLowerCase())));
  if (forbidden.length) throw new Error(`Neutral runtime requested Cubism files: ${forbidden.map(file => file.sourcePath).join(', ')}.`);
  if (result.httpProvenance.requestCount !== result.httpProvenance.files.reduce((sum, file) => sum + file.requestCount, 0)) throw new Error('HTTP provenance request accounting drifted.');
  return {
    status: result.status,
    network: { totalBytes, packageRawBytes, requestCount: result.httpProvenance.requestCount, uniqueFileCount: result.httpProvenance.uniqueFileCount, files },
    parseMs: result.parseMs,
    coldFirstFrameMs: result.coldFirstFrameMs,
    warmFirstFrameMs: result.warmFirstFrameMs,
    steady: result.steady,
    gpuMemory: result.gpuMemory,
    peakProcessMemoryBytes: result.peakProcessMemoryBytes,
    memorySamples: result.memorySamples,
    runtime: result.runtime,
    renderer: result.renderer,
    browser: result.browserEvidence,
    gpuAdapter: result.gpuAdapter,
    allocationSampling: result.allocationSampling,
    visualCapture: result.visualCapture ? {
      sampleWidth: result.visualCapture.sampleWidth,
      sampleHeight: result.visualCapture.sampleHeight,
      meanRgb: result.visualCapture.meanRgb,
      darkRatio: result.visualCapture.darkRatio,
      brightRatio: result.visualCapture.brightRatio,
    } : null,
    cubismRuntimeInBrowser: result.cubismRuntimeInBrowser,
    forbiddenRequestCount: forbidden.length,
    lifecycle: result.lifecycle,
    diagnostics: result.steady.gpuFrameP50Ms === null ? [{
      severity: 'warning',
      code: 'W_G07_GPU_TIMESTAMP_UNAVAILABLE',
      path: '$.runtime.steady.gpuFrameP50Ms',
      message: 'Engine timestamp-query output was unavailable; GPU queue-completion latency is recorded as the explicit fallback metric.',
    }] : [],
    errors: result.errors,
  };
}

async function runNeutralFixture(workRoot, corpus) {
  const directory = resolve(workRoot, 'neutral-fixture');
  mkdirSync(directory, { recursive: true });
  const png = readFileSync(resolve(root, 'examples/hya-live2d-corpus-dashboard/samples/mascot.png'));
  const capture = { format: 'live2d-cubism-drawable-capture', version: 1, name: 'G07 fake source adapter', canvas: { width: 64, height: 64, pixelsPerUnit: 1, coordinateSystem: 'model-y-up', uvOrigin: 'bottom-left' }, duration: 1, frameRate: 2, textures: [{ id: 'texture-0', uri: 'texture.png', integrity: `sha256-${sha256(png)}` }], frames: [0, 0.5, 1].map(time => ({ time, drawables: [{ id: 'fake-source-triangle', textureIndex: 0, renderOrder: 0, opacity: 1, blendMode: 'normal', culling: false, masks: [], positions: [-16, -16, 16, -16, 0, 16], uvs: [0, 0, 1, 0, 0.5, 1], indices: [0, 1, 2], multiplyColor: [1, 1, 1, 1], screenColor: [0, 0, 0, 0] }] })) };
  const assets = new Map([['model.model3.json', new TextEncoder().encode('{"Version":3}')], ['texture.png', png]]);
  const host = memoryHost(assets);
  const source = { entry: 'model.model3.json', name: 'G07 fake source adapter', sourceVersion: 'sha256-fake-source-adapter', coreVersion: 'fake-evaluator-no-core', canvas: capture.canvas, frameRate: 2, textures: capture.textures, dependencies: [{ uri: 'texture.png', integrity: `sha256-${sha256(png)}` }], evaluator: { version: 'minimal-fake-source@1', duration: 1, keyTimes: [0.5], capabilities: { motion: true, expression: true, physics: true, pose: true, drawableColors: true }, async evaluate(time) { return sampleCapture(capture, time); }, close() {} } };
  const converted = await runCubismClipBakedConversion({ source, sourceBytes: assets.get('model.model3.json'), host, recipe: { id: 'fake', clip: 'fake', motion: 'fake' }, sampling: corpus.methodology.sampling, mode: 'strict' });
  writePlaybackPackage(directory, converted.artifacts);
  const artifactsText = converted.artifacts.map(artifact => `${artifact.path}\n${new TextDecoder().decode(artifact.bytes)}`).join('\n');
  const artifactForbiddenTokenCount = corpus.neutralRuntimeFixture.forbiddenRuntimeTokens.filter(token => artifactsText.includes(token)).length;
  const result = normalizeRuntime(await measureRuntime(directory), converted.artifacts.reduce((sum, artifact) => sum + artifact.bytes.byteLength, 0), corpus.neutralRuntimeFixture.forbiddenRuntimeTokens);
  return { id: corpus.neutralRuntimeFixture.id, adapter: converted.report.adapter, playbackPassed: result.status === 'passed', cubismRuntimeInBrowser: false, forbiddenRequestCount: result.forbiddenRequestCount, artifactForbiddenTokenCount, lifecycleResiduals: result.lifecycle.releasedOwnerResiduals + result.lifecycle.resourcesAfterDestroy, runtime: result };
}

function validateSourceDirectory(directory, expected) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`${expected.id} directory is missing: ${directory}.`);
  const files = listFiles(directory);
  const facts = files.map(path => ({ path, bytes: readFileSync(resolve(directory, path)) }));
  for (const requiredFile of expected.requiredFiles) {
    const fact = facts.find(item => item.path === requiredFile.path);
    if (!fact || fact.bytes.byteLength !== requiredFile.byteLength || sha256(fact.bytes) !== requiredFile.sha256) throw new Error(`${expected.id} required file drifted: ${requiredFile.path}.`);
  }
  const hash = createHash('sha256');
  for (const fact of facts) hash.update(fact.path).update('\0').update(String(fact.bytes.byteLength)).update('\0').update(fact.bytes);
  const evidence = {
    runtimeDirectoryHash: `sha256-${hash.digest('hex')}`,
    fileCount: facts.length,
    rawBytes: facts.reduce((sum, fact) => sum + fact.bytes.byteLength, 0),
    gzipBytes: facts.reduce((sum, fact) => sum + gzipSync(fact.bytes, { level: 9 }).byteLength, 0),
  };
  if (evidence.runtimeDirectoryHash !== expected.source.runtimeDirectoryHash || evidence.fileCount !== expected.source.fileCount || evidence.rawBytes !== expected.source.sourceBytes) throw new Error(`${expected.id} runtime directory population drifted: ${JSON.stringify(evidence)}.`);
  return evidence;
}

function fileHost(directory) {
  return { async readAsset(uri) { return readFileSync(resolveSafe(directory, uri)); }, async sha256(bytes) { return sha256(bytes); }, beginTransaction() { let done = false; return { stage() {}, commit() { if (done) throw new Error('transaction already ended'); done = true; }, rollback() { done = true; } }; } };
}
function memoryHost(assets) { return { async readAsset(uri) { const bytes = assets.get(uri); if (!bytes) throw new Error(`Missing memory asset ${uri}.`); return bytes; }, async sha256(bytes) { return sha256(bytes); }, beginTransaction() { return { stage() {}, commit() {}, rollback() {} }; } }; }

function inspectFeatureCoverage(capture) {
  const first = capture.frames[0].drawables;
  return {
    drawableCount: first.length,
    textureCount: capture.textures.length,
    maskReferenceCount: first.reduce((sum, drawable) => sum + (drawable.masks?.length ?? 0), 0),
    invertedMaskDrawableCount: first.filter(drawable => drawable.invertedMask).length,
    additiveDrawableCount: first.filter(drawable => drawable.blendMode === 'additive').length,
    multiplicativeDrawableCount: first.filter(drawable => drawable.blendMode === 'multiplicative').length,
    cullingDrawableCount: first.filter(drawable => drawable.culling).length,
    dynamicRenderOrderDrawableCount: first.filter((drawable, index) => capture.frames.some(frame => frame.drawables[index].renderOrder !== drawable.renderOrder)).length,
    nonNeutralMultiplyDrawableFrameCount: capture.frames.reduce((sum, frame) => sum + frame.drawables.filter(drawable => !neutral(drawable.multiplyColor, 1)).length, 0),
    nonNeutralScreenDrawableFrameCount: capture.frames.reduce((sum, frame) => sum + frame.drawables.filter(drawable => !neutral(drawable.screenColor, 0)).length, 0),
  };
}

function measureNodeParse(bytes, iterations = 30) {
  const values = [];
  for (let index = 0; index < iterations + 3; index++) { const started = performance.now(); parseAnimation(exactBuffer(bytes), { extensions: createDeformableMesh2DFormatRegistry() }); if (index >= 3) values.push(performance.now() - started); }
  return { iterations, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) };
}
function sizeMetrics(buffers) { return { rawBytes: buffers.reduce((sum, bytes) => sum + bytes.byteLength, 0), gzipBytes: buffers.reduce((sum, bytes) => sum + gzipSync(bytes, { level: 9 }).byteLength, 0), fileCount: buffers.length }; }
function summarize(samples) { return { sampleCount: samples.length, pixelFidelitySampleCount: samples.filter(sample => sample.pixelFidelity).length, structuralFidelitySampleCount: samples.filter(sample => sample.structuralFidelity).length, runtimePlaybackSampleCount: samples.filter(sample => sample.runtime.status === 'passed').length, sourceRawBytes: sum(samples, sample => sample.source.rawBytes), sourceGzipBytes: sum(samples, sample => sample.source.gzipBytes), hyaPackageRawBytes: sum(samples, sample => sample.package.rawBytes), hyaPackageGzipBytes: sum(samples, sample => sample.package.gzipBytes), totalNetworkBytes: sum(samples, sample => sample.runtime.network.totalBytes), peakProcessMemoryBytes: Math.max(...samples.map(sample => sample.runtime.peakProcessMemoryBytes)), peakGpuMemoryBytes: Math.max(...samples.map(sample => sample.runtime.gpuMemory.peakEstimatedBytes)) }; }

function repositoryEvidence(directory) { const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim(); const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: directory, encoding: 'utf8' }).trim().length > 0; return { revision, dirty }; }
function assertCore(bytes) { if (bytes.byteLength !== manifest.oracle.coreByteLength || sha256(bytes) !== manifest.oracle.coreSha256) throw new Error('Official Cubism Core bytes do not match the frozen oracle.'); }
async function fetchRequired(url) { const response = await fetch(url, { cache: 'no-store' }); if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`); return response.arrayBuffer(); }
function listFiles(directory) { const files = []; const visit = current => { for (const entry of readdirSync(current, { withFileTypes: true })) { const path = resolve(current, entry.name); if (entry.isDirectory()) visit(path); else if (entry.isFile()) files.push(relative(directory, path).split(sep).join('/')); } }; visit(directory); return files.sort((left, right) => left.localeCompare(right)); }
function resolveSafe(rootPath, uri) { const target = resolve(rootPath, uri); if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`)) throw new Error(`Asset escapes source root: ${uri}.`); return target; }
function exactBuffer(bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
function colorAt(track, left, right, p, fallback) { return [0, 1, 2, 3].map(channel => track ? mix(track[left * 4 + channel], track[right * 4 + channel], p) : fallback[channel]); }
function colorError(source, target, fallback) { return Math.max(...[0, 1, 2, 3].map(index => Math.abs((source?.[index] ?? fallback[index]) - target[index]))); }
function neutral(color, expected) { return !color || color.slice(0, 3).every(value => value === expected); }
function mix(left, right, progress) { return left + (right - left) * progress; }
function sum(values, select) { return values.reduce((total, value) => total + select(value), 0); }
function percentile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]; }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function required(values, index, flag) { const value = values[index]; if (!value) throw new Error(`${flag} requires a value.`); return value; }
function missingModel(id) { throw new Error(`Missing --model ${id}=<licensed-runtime-directory>.`); }
