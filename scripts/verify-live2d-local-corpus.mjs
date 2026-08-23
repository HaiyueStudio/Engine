import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(import.meta.dirname, '..');
const repository = readRepositoryEvidence(root);
const { models, output, core } = parseArguments(process.argv.slice(2));
if (models.length === 0) throw new Error('Pass at least one licensed runtime directory with --model <directory>.');
const coreFile = core ? resolve(core) : null;
if (coreFile && (!existsSync(coreFile) || !statSync(coreFile).isFile())) throw new Error(`Cubism Core path is not a file: ${coreFile}`);
if (coreFile && !/^live2dcubismcore(?:\.min)?\.js$/iu.test(basename(coreFile))) {
  throw new Error(`Cubism Core file must use the official SDK filename live2dcubismcore.js or live2dcubismcore.min.js: ${coreFile}`);
}
const corePrefix = '/__licensed_cubism_core';
const coreUrl = coreFile ? `${corePrefix}/${encodeURIComponent(basename(coreFile))}` : null;

const samples = [];
for (let index = 0; index < models.length; index++) {
  const modelInput = models[index];
  const directory = resolve(modelInput.directory);
  if (!statSync(directory).isDirectory()) throw new Error(`Model path is not a directory: ${directory}`);
  const files = listFiles(directory);
  if (!files.some(path => path.toLowerCase().endsWith('.model3.json'))) throw new Error(`Model directory has no .model3.json: ${directory}`);
  const prefix = `/__licensed_live2d_${index}`;
  const result = await runChromeWebGpuFixture({
    root,
    fixture: 'examples/live2d-hya-compare/index.html',
    query: {
      // Reuse the comparison page's deterministic parity-evidence mode: both
      // renderers pause and seek to one second before the result is published.
      fixture: 'mask-parity',
      localEvidence: 1,
      recoverySmoke: 1,
      localModelMount: prefix,
      localModelFiles: files.join('|'),
      ...(coreUrl ? { coreUrl } : {}),
    },
    mounts: [
      { prefix, directory },
      ...(coreFile ? [{ prefix: corePrefix, directory: dirname(coreFile) }] : []),
    ],
    crossOriginIsolation: false,
    timeoutMs: 180_000,
    visualCapture: {
      viewportWidth: 1440,
      viewportHeight: 900,
      sampleWidth: 32,
      sampleHeight: 20,
      compareSelectors: ['#hya-canvas', '#reference-canvas'],
      compareInsetTop: 52,
    },
  });
  if (result.reference !== 'official-cubism-core') throw new Error(`Model ${directory} did not reach the official Core evaluator.`);
  assert.deepEqual(result.comparisonConfiguration?.canvas, [719, 746], `Model ${directory} comparison canvas drifted.`);
  assert.equal(result.comparisonBackground, '#050817', `Model ${directory} comparison background drifted.`);
  assert.deepEqual({
    viewportMode: result.comparisonConfiguration?.viewportMode,
    fitPolicy: result.comparisonConfiguration?.fitPolicy,
    fitFill: result.comparisonConfiguration?.fitFill,
    userZoom: result.comparisonConfiguration?.userZoom,
    pan: result.comparisonConfiguration?.pan,
    synchronizedViews: result.comparisonConfiguration?.synchronizedViews,
    targetFormat: result.comparisonConfiguration?.targetFormat,
    textureColorSpaceConversion: result.comparisonConfiguration?.textureColorSpaceConversion,
    alphaMode: result.comparisonConfiguration?.alphaMode,
    antialias: result.comparisonConfiguration?.antialias,
  }, {
    viewportMode: 'fit', fitPolicy: 'bounds-centered-auto-zoom', fitFill: 0.82,
    userZoom: 1, pan: [0, 0], synchronizedViews: true, targetFormat: 'rgba8unorm',
    textureColorSpaceConversion: 'none', alphaMode: 'premultiplied', antialias: false,
  }, `Model ${directory} comparison configuration drifted.`);
  const surfaceReadback = result.visualCapture?.regionParity;
  assert.ok(surfaceReadback, `Model ${directory} did not produce paired Chrome surface readback.`);
  const paritySummary = JSON.stringify(surfaceReadback);
  const requiresCompositionParity = result.featureCoverage.maskReferenceCount > 0
    || result.featureCoverage.additiveDrawableCount > 0
    || result.featureCoverage.multiplicativeDrawableCount > 0
    || result.featureCoverage.cullingDrawableCount > 0;
  if (requiresCompositionParity) {
    // Real models contain much longer antialiased silhouettes than the compact
    // synthetic fixture. Keep a bounded outlier ceiling while mean/ratio remain
    // the primary parity signals for composition or atlas regressions.
    assert.ok(surfaceReadback.maxChannelError <= 224, `Model ${directory} max-channel error regressed: ${paritySummary}.`);
    assert.ok(surfaceReadback.meanAbsoluteError <= 1, `Model ${directory} mean surface error regressed: ${paritySummary}.`);
    assert.ok(surfaceReadback.mismatchRatio <= 0.025, `Model ${directory} mismatch ratio regressed: ${paritySummary}.`);
  }
  samples.push({
    id: modelInput.id ?? basename(directory),
    sourcePolicy: 'caller-supplied-local-only',
    runtimeDirectoryHash: directoryHash(directory, files),
    fileCount: files.length,
    sourceBytes: files.reduce((sum, path) => sum + statSync(resolve(directory, path)).size, 0),
    sourceEntry: files.find(path => path.toLowerCase().endsWith('.model3.json')),
    sourceFiles: files.map(path => {
      const bytes = readFileSync(resolve(directory, path));
      return {
        path,
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
    coreVersion: result.coreVersion,
    evidenceRecipe: {
      profile: 'clip-baked-reference-times',
      motionId: result.selectedActionId,
      motionFile: result.selectedMotionFile,
      bakedFrameTimes: result.bakedFrameTimes,
      referenceTimes: [result.sampledAt],
    },
    conversionDiagnostics: result.conversionDiagnostics,
    featureCoverage: result.featureCoverage,
    observedBlendModes: ['normal',
      ...(result.featureCoverage.additiveDrawableCount > 0 ? ['additive'] : []),
      ...(result.featureCoverage.multiplicativeDrawableCount > 0 ? ['multiplicative'] : []),
    ],
    drawables: result.hya.visualCount,
    bakedFrameCount: result.bakedFrameCount,
    maskTargets: result.hya.maskTargetCount,
    sampledAt: result.sampledAt,
    recoverySmoke: result.recoverySmoke,
    comparisonConfiguration: result.comparisonConfiguration,
    surfaceReadback: summarizeSurfaceReadback(surfaceReadback),
    browser: {
      product: result.browserEvidence.product,
      userAgent: result.browserEvidence.userAgent,
      platform: result.browserEvidence.platform,
      angleBackend: result.browserEvidence.angleBackend,
      nativeBackend: result.browserEvidence.nativeBackend,
      gpuAdapter: result.gpuAdapter,
    },
    browserDiagnostics: result.browserDiagnostics,
    requestedProjectFiles: result.httpProvenance.files
      .filter(file => !file.sourcePath.startsWith(prefix.slice(1)) && !file.sourcePath.startsWith(corePrefix.slice(1)))
      .map(file => file.sourcePath),
  });
}

const report = {
  schemaVersion: 1,
  kind: 'haiyue-live2d-local-corpus-candidate',
  revision: repository.revision,
  dirty: repository.dirty,
  formalEvidence: false,
  core: coreFile ? {
    sourcePolicy: 'caller-supplied-local-official-sdk-only',
    fileName: basename(coreFile),
    byteLength: statSync(coreFile).size,
    sha256: createHash('sha256').update(readFileSync(coreFile)).digest('hex'),
    transport: 'same-origin-test-mount',
  } : {
    sourcePolicy: 'official-cdn',
    url: 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
    transport: 'network',
  },
  sampleCount: samples.length,
  samples,
  totals: samples.reduce((totals, sample) => ({
    maskReferenceCount: totals.maskReferenceCount + sample.featureCoverage.maskReferenceCount,
    invertedMaskDrawableCount: totals.invertedMaskDrawableCount + sample.featureCoverage.invertedMaskDrawableCount,
    additiveDrawableCount: totals.additiveDrawableCount + sample.featureCoverage.additiveDrawableCount,
    multiplicativeDrawableCount: totals.multiplicativeDrawableCount + sample.featureCoverage.multiplicativeDrawableCount,
    cullingDrawableCount: totals.cullingDrawableCount + sample.featureCoverage.cullingDrawableCount,
  }), { maskReferenceCount: 0, invertedMaskDrawableCount: 0, additiveDrawableCount: 0, multiplicativeDrawableCount: 0, cullingDrawableCount: 0 }),
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (output) writeFileSync(resolve(output), json);
process.stdout.write(json);

function readRepositoryEvidence(repositoryRoot) {
  const revision = String(process.env.GITHUB_SHA ?? process.env.BUILD_SOURCEVERSION
    ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim());
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error(`Engine revision must be a full Git SHA-1: ${revision}`);
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryRoot, encoding: 'utf8' });
  return Object.freeze({ revision, dirty: status.trim().length > 0 });
}

function parseArguments(args) {
  const parsed = { models: [], output: null, core: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--model') parsed.models.push(parseModelInput(requireValue(args, ++index, '--model')));
    else if (argument === '--out') parsed.output = requireValue(args, ++index, '--out');
    else if (argument === '--core') parsed.core = requireValue(args, ++index, '--core');
    else throw new Error(`Unknown argument ${argument}.`);
  }
  return parsed;
}

function parseModelInput(value) {
  const separator = value.indexOf('=');
  if (separator < 1) return { id: null, directory: value };
  const id = value.slice(0, separator);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) throw new Error(`Model id must use lowercase letters, digits, and hyphens: ${id}`);
  return { id, directory: value.slice(separator + 1) };
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

function listFiles(directory) {
  const result = [];
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.push(relative(directory, path).split(sep).join('/'));
    }
  };
  visit(directory);
  return result.sort((left, right) => left.localeCompare(right));
}

function directoryHash(directory, files) {
  const hash = createHash('sha256');
  for (const path of files) {
    const bytes = readFileSync(resolve(directory, path));
    hash.update(path).update('\0').update(String(bytes.byteLength)).update('\0').update(bytes);
  }
  return `sha256-${hash.digest('hex')}`;
}

function summarizeSurfaceReadback(value) {
  return {
    width: value.width,
    height: value.height,
    maxChannelError: value.maxChannelError,
    meanAbsoluteError: value.meanAbsoluteError,
    mismatchPixelCount: value.mismatchPixelCount,
    mismatchRatio: value.mismatchRatio,
    onePixelSpatialTolerance: value.onePixelSpatialTolerance ? {
      maxChannelError: value.onePixelSpatialTolerance.maxChannelError,
      meanAbsoluteError: value.onePixelSpatialTolerance.meanAbsoluteError,
      mismatchPixelCount: value.onePixelSpatialTolerance.mismatchPixelCount,
      mismatchRatio: value.onePixelSpatialTolerance.mismatchRatio,
    } : null,
    stableInterior: value.stableInterior ? {
      pixelCount: value.stableInterior.pixelCount,
      coverageRatio: value.stableInterior.coverageRatio,
      maxChannelError: value.stableInterior.maxChannelError,
      meanAbsoluteError: value.stableInterior.meanAbsoluteError,
      mismatchPixelCount: value.stableInterior.mismatchPixelCount,
      mismatchRatio: value.stableInterior.mismatchRatio,
    } : null,
  };
}
