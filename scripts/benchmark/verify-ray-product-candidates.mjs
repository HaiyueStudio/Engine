import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireStudioRepository } from '../studio-repository-layout.mjs';
import { runChromeWebGpuFixture } from '../webgpu-gate/chrome-runner.mjs';
import { validateRayProductCandidateArtifact } from './ray-product-candidate-contract.mjs';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gamesRoot = requireStudioRepository('Games').root;
const artifactPath = resolve(engineRoot, 'artifacts/ray-tracing/g09-product-candidates.json');
const engineRevision = git(engineRoot, ['rev-parse', 'HEAD']);
const gamesRevision = git(gamesRoot, ['rev-parse', 'HEAD']);
const engineDirty = git(engineRoot, ['status', '--porcelain']).length > 0;
const gamesDirty = git(gamesRoot, ['status', '--porcelain']).length > 0;
const browsers = [
  ['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  ['edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
].filter(([, path]) => existsSync(path));
if (browsers.length === 0) throw new Error('Ray product candidate validation requires Chrome or Edge.');

const bundleTopology = await validateGameBundleTopology();
const browserReports = [];
for (const [browser, executable] of browsers) {
  process.env.CHROME_PATH = executable;
  process.env.WEBGPU_ANGLE_BACKEND = 'd3d11';
  const examples = await runChromeWebGpuFixture({
    root: engineRoot,
    fixture: 'examples/ray-tracing/index.html',
    query: { evidence: 1, resolution: '96x54', quality: 'low', view: 'denoised' },
    timeoutMs: 90_000,
  });
  requireExamples(browser, examples);
  const game = await runChromeWebGpuFixture({
    root: gamesRoot,
    fixture: 'games/gravity-maze/index.html',
    query: { rayTracing: 1, seed: 731291 },
    timeoutMs: 120_000,
  });
  requireGame(browser, game);
  const candidates = [
    ...examples.cases.map(value => compactExample(value)),
    compactGame(game),
  ];
  browserReports.push(Object.freeze({
    browser,
    candidates: Object.freeze(candidates),
    browserEvidence: Object.freeze({ examples: examples.browserEvidence, game: game.browserEvidence }),
    browserDiagnostics: Object.freeze({ examples: examples.browserDiagnostics, game: game.browserDiagnostics }),
    httpProvenance: Object.freeze({ examples: examples.httpProvenance, game: game.httpProvenance }),
  }));
  console.log(`[ray-product:${browser}] passed ${candidates.map(value => value.fixedSceneId).join(', ')}.`);
}
requireCrossBrowserDeterminism(browserReports);

const report = {
  schemaVersion: 1,
  suite: 'm04-g09-ray-tracing-product-candidates',
  status: 'passed',
  evidence: {
    kind: engineDirty || gamesDirty ? 'diagnostic-candidate' : 'formal-candidate',
    generatedAt: new Date().toISOString(),
    engineRevision,
    engineDirty,
    gamesRevision,
    gamesDirty,
    nodeVersion: process.version,
  },
  sceneClasses: Object.freeze(['small-analytic', 'medium-material-light', 'large-real-product']),
  bundleTopology,
  browsers: browserReports,
  unclassifiedFailureCount: 0,
};
const validation = validateRayProductCandidateArtifact(report, {
  formal: report.evidence.kind === 'formal-candidate',
  expectedEngineRevision: engineRevision,
  expectedGamesRevision: gamesRevision,
});
if (validation.status !== 'passed') {
  throw new Error(`Ray product candidate artifact is invalid:\n- ${validation.violations.join('\n- ')}`);
}
report.validation = validation;
await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[ray-product] wrote ${relative(engineRoot, artifactPath)}.`);
console.log(JSON.stringify(report, null, 2));

function requireExamples(browser, result) {
  if (result.status !== 'passed' || result.unclassifiedFailureCount !== 0 || result.cases?.length !== 2) {
    throw new Error(`${browser} ray example candidates failed: ${JSON.stringify(result)}`);
  }
  requireBrowserLifecycle(`${browser}:examples`, result.browserDiagnostics);
  for (const value of result.cases) {
    requireHashesAndMemory(`${browser}:${value.sceneId}`, value);
    if (value.diagnostics.length !== 0) throw new Error(`${browser}:${value.sceneId} returned unexpected example diagnostics.`);
    if (value.sceneId === 'material' && (value.counters?.path?.hits < 1 || value.counters?.path?.invalidAccesses !== 0 || value.counters?.path?.stackOverflows !== 0)) {
      throw new Error(`${browser}:${value.sceneId} returned invalid path counters.`);
    }
  }
}

function requireGame(browser, result) {
  if (result.status !== 'passed' || result.suite !== 'gravity-maze-ray-tracing-candidate' || result.unclassifiedFailureCount !== 0) {
    throw new Error(`${browser} Gravity Maze candidate failed: ${JSON.stringify(result)}`);
  }
  requireBrowserLifecycle(`${browser}:gravity-maze`, result.browserDiagnostics);
  requireHashesAndMemory(`${browser}:gravity-maze`, {
    ...result,
    peakBytes: result.memory?.peakBytes,
    liveResourceCount: result.memory?.liveResourceCount,
  });
  for (const field of ['traversalNs', 'shadingAndPathTracingNs', 'denoiseNs', 'compositeNs']) {
    const value = result.stageTimings?.[field];
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`${browser} Gravity Maze has invalid ${field}.`);
  }
  const files = result.httpProvenance?.files?.map(value => value.sourcePath) ?? [];
  if (!files.includes('games/gravity-maze/dist/bundle.js') || !files.some(file => /games\/gravity-maze\/dist\/chunks\/rayTracingPreview-[^/]+\.js$/.test(file))) {
    throw new Error(`${browser} Gravity Maze did not load both default and opt-in ray bundles over HTTP.`);
  }
}

function requireBrowserLifecycle(label, diagnostics) {
  if (diagnostics?.unclassifiedFailureCount !== 0
    || diagnostics?.profileCleanup?.status !== 'passed'
    || !Number.isInteger(diagnostics.profileCleanup.attempts)
    || diagnostics.profileCleanup.attempts < 1) {
    throw new Error(`${label} returned invalid browser/profile lifecycle evidence: ${JSON.stringify(diagnostics)}.`);
  }
}

function requireCrossBrowserDeterminism(reports) {
  const reference = reports[0];
  if (!reference) throw new Error('Ray product candidate validation produced no browser report.');
  const expected = new Map(reference.candidates.map(candidate => [candidate.fixedSceneId, candidate]));
  for (const report of reports.slice(1)) {
    for (const candidate of report.candidates) {
      const baseline = expected.get(candidate.fixedSceneId);
      if (!baseline
        || baseline.sourceSha256 !== candidate.sourceSha256
        || baseline.candidateSha256 !== candidate.candidateSha256) {
        throw new Error(
          `${report.browser}:${candidate.fixedSceneId} is not deterministic across browsers: `
          + `${candidate.sourceSha256}/${candidate.candidateSha256}.`,
        );
      }
    }
  }
}

function requireHashesAndMemory(label, value) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value.sourceSha256)
    || !/^sha256:[0-9a-f]{64}$/.test(value.candidateSha256)
    || !Number.isFinite(value.peakBytes) || value.peakBytes < 1
    || !Number.isFinite(value.liveResourceCount) || value.liveResourceCount < 1
    || value.pixelSummary?.maximumChannel < 8
    || value.pixelSummary?.nonBlackPixelCount < 1) {
    throw new Error(`${label} returned invalid source/candidate hash or memory evidence.`);
  }
}

function compactExample(value) {
  return Object.freeze({
    sceneClass: value.sceneId === 'analytic' ? 'small-analytic' : 'medium-material-light',
    fixedSceneId: value.fixedSceneId,
    fixedCameraReplayId: value.fixedCameraReplayId,
    sourceSha256: value.sourceSha256,
    candidateSha256: value.candidateSha256,
    buildMs: value.buildMs,
    stageTimings: value.stageTimings,
    peakBytes: value.peakBytes,
    liveResourceCount: value.liveResourceCount,
    diagnosticCount: value.diagnostics.length,
    pixelSummary: value.pixelSummary,
  });
}

function compactGame(value) {
  return Object.freeze({
    sceneClass: value.sceneClass,
    fixedSceneId: value.fixedSceneId,
    fixedCameraReplayId: value.fixedCameraReplayId,
    sourceSha256: value.sourceSha256,
    candidateSha256: value.candidateSha256,
    buildRefit: value.buildRefit,
    stageTimings: value.stageTimings,
    peakBytes: value.memory.peakBytes,
    liveResourceCount: value.memory.liveResourceCount,
    diagnosticCount: value.diagnostics.length,
    pixelSummary: value.pixelSummary,
  });
}

async function validateGameBundleTopology() {
  const defaultPath = resolve(gamesRoot, 'games/gravity-maze/dist/bundle.js');
  const chunkDirectory = resolve(gamesRoot, 'games/gravity-maze/dist/chunks');
  const rayName = (await readdir(chunkDirectory)).find(name => /^rayTracingPreview-[^.]+\.js$/.test(name));
  if (!rayName) throw new Error('Gravity Maze build is missing its code-split ray tracing chunk.');
  const rayPath = resolve(chunkDirectory, rayName);
  const [defaultBytes, rayBytes, defaultStat, rayStat] = await Promise.all([
    readFile(defaultPath), readFile(rayPath), stat(defaultPath), stat(rayPath),
  ]);
  const defaultText = defaultBytes.toString('utf8');
  const rayText = rayBytes.toString('utf8');
  if (defaultText.includes('RayPathTracingRenderer') || defaultText.includes('RAY_PATH_TRACING_LAYOUT')) {
    throw new Error('Gravity Maze default bundle contains ray tracing runtime code.');
  }
  if (!/import\(["']\.\/chunks\/rayTracingPreview-[^"']+\.js["']\)/.test(defaultText) || !rayText.includes('RayPathTracingRenderer')) {
    throw new Error('Gravity Maze opt-in ray tracing bundle boundary is incomplete.');
  }
  return Object.freeze({
    defaultBundle: fileEvidence(defaultBytes, defaultStat.size),
    rayTracingBundle: fileEvidence(rayBytes, rayStat.size),
    defaultContainsRayTracingRuntime: false,
    optInReferenceOnly: true,
  });
}

function fileEvidence(bytes, size) {
  return Object.freeze({ bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') });
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
