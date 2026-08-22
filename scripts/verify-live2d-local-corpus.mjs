import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(import.meta.dirname, '..');
const { models, output } = parseArguments(process.argv.slice(2));
if (models.length === 0) throw new Error('Pass at least one licensed runtime directory with --model <directory>.');

const samples = [];
for (let index = 0; index < models.length; index++) {
  const directory = resolve(models[index]);
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
      localModelMount: prefix,
      localModelFiles: files.join('|'),
    },
    mounts: [{ prefix, directory }],
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
  const surfaceReadback = result.visualCapture?.regionParity;
  assert.ok(surfaceReadback, `Model ${directory} did not produce paired Chrome surface readback.`);
  const paritySummary = JSON.stringify(surfaceReadback);
  if (result.featureCoverage.maskReferenceCount > 0) {
    // Real models contain much longer antialiased silhouettes than the compact
    // synthetic fixture. Keep a bounded outlier ceiling while mean/ratio remain
    // the primary parity signals for composition or atlas regressions.
    assert.ok(surfaceReadback.maxChannelError <= 224, `Model ${directory} max-channel error regressed: ${paritySummary}.`);
    assert.ok(surfaceReadback.meanAbsoluteError <= 1, `Model ${directory} mean surface error regressed: ${paritySummary}.`);
    assert.ok(surfaceReadback.mismatchRatio <= 0.025, `Model ${directory} mismatch ratio regressed: ${paritySummary}.`);
  }
  samples.push({
    id: directory.split(/[\\/]/u).slice(-2, -1)[0] ?? `model-${index + 1}`,
    sourcePolicy: 'caller-supplied-local-only',
    runtimeDirectoryHash: directoryHash(directory, files),
    fileCount: files.length,
    sourceBytes: files.reduce((sum, path) => sum + statSync(resolve(directory, path)).size, 0),
    featureCoverage: result.featureCoverage,
    drawables: result.hya.visualCount,
    maskTargets: result.hya.maskTargetCount,
    sampledAt: result.sampledAt,
    surfaceReadback,
    browser: {
      product: result.browserEvidence.product,
      userAgent: result.browserEvidence.userAgent,
      platform: result.browserEvidence.platform,
      angleBackend: result.browserEvidence.angleBackend,
      nativeBackend: result.browserEvidence.nativeBackend,
    },
    browserDiagnostics: result.browserDiagnostics,
    requestedProjectFiles: result.httpProvenance.files
      .filter(file => !file.sourcePath.startsWith(prefix.slice(1)))
      .map(file => file.sourcePath),
  });
}

const report = {
  schemaVersion: 1,
  kind: 'haiyue-live2d-local-corpus-candidate',
  revision: process.env.GITHUB_SHA ?? process.env.BUILD_SOURCEVERSION ?? 'working-tree',
  dirty: true,
  formalEvidence: false,
  sampleCount: samples.length,
  samples,
  totals: samples.reduce((totals, sample) => ({
    maskReferenceCount: totals.maskReferenceCount + sample.featureCoverage.maskReferenceCount,
    invertedMaskDrawableCount: totals.invertedMaskDrawableCount + sample.featureCoverage.invertedMaskDrawableCount,
    additiveDrawableCount: totals.additiveDrawableCount + sample.featureCoverage.additiveDrawableCount,
    multiplicativeDrawableCount: totals.multiplicativeDrawableCount + sample.featureCoverage.multiplicativeDrawableCount,
  }), { maskReferenceCount: 0, invertedMaskDrawableCount: 0, additiveDrawableCount: 0, multiplicativeDrawableCount: 0 }),
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (output) writeFileSync(resolve(output), json);
process.stdout.write(json);

function parseArguments(args) {
  const parsed = { models: [], output: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--model') parsed.models.push(requireValue(args, ++index, '--model'));
    else if (argument === '--out') parsed.output = requireValue(args, ++index, '--out');
    else throw new Error(`Unknown argument ${argument}.`);
  }
  return parsed;
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
