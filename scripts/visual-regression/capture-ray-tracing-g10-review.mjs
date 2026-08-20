import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireStudioRepository } from '../studio-repository-layout.mjs';
import { runChromeWebGpuFixture } from '../webgpu-gate/chrome-runner.mjs';
import {
  createPendingHumanReview,
  validateRayG10ReviewManifest,
} from './ray-g10-review-contract.mjs';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactsRoot = resolve(engineRoot, 'artifacts');
const options = parseOptions(process.argv.slice(2));
const outputDirectory = resolve(options.output ?? resolve(artifactsRoot, 'ray-tracing-g10-review'));
const browser = browserConfiguration(options.browser);

assertInside(outputDirectory, artifactsRoot, 'review output');
mkdirSync(outputDirectory, { recursive: true });
process.env.CHROME_PATH = browser.executable;
process.env.WEBGPU_ANGLE_BACKEND = 'd3d11';

const repositories = ['Engine', 'Editor', 'Games', 'UI', 'milestones'].map(name => repositoryState(name));
const dirtyRepositories = repositories.filter(repository => repository.dirty);
if (options.requireClean && dirtyRepositories.length > 0) {
  throw new Error(`Formal G10 review requires clean repositories: ${dirtyRepositories.map(value => value.name).join(', ')}.`);
}

const captures = [];
const captureFiles = new Map();
for (const view of ['raw', 'denoised', 'variance', 'history-age', 'feature']) {
  const result = await runChromeWebGpuFixture({
    root: engineRoot,
    fixture: 'examples/ray-tracing/index.html',
    query: { evidence: 1, review: 1, resolution: '128x72', quality: 'medium', view },
    timeoutMs: 120_000,
    visualCapture: { viewportWidth: 960, viewportHeight: 650, sampleWidth: 32, sampleHeight: 22 },
  });
  requireExampleResult(view, result);
  captures.push(writeCapture(`example-material-${view}`, result));
}

const gamesRoot = requireStudioRepository('Games').root;
const game = await runChromeWebGpuFixture({
  root: gamesRoot,
  fixture: 'games/gravity-maze/index.html',
  query: { rayTracing: 1, seed: 731291 },
  timeoutMs: 120_000,
  visualCapture: { viewportWidth: 1280, viewportHeight: 800, sampleWidth: 32, sampleHeight: 20 },
});
requireGameResult(game);
captures.push(writeCapture('gravity-maze-ray-tracing', game));

const humanReview = createPendingHumanReview();
const report = {
  format: 'haiyue-ray-tracing-g10-human-review-candidate@1',
  evidenceClass: dirtyRepositories.length === 0 ? 'clean-revision-candidate' : 'dirty-worktree-candidate',
  generatedAt: new Date().toISOString(),
  browser: browser.name,
  backend: 'd3d11',
  nodeVersion: process.version,
  repositories,
  captures,
  requiredHumanReview: Object.freeze([
    'raw-versus-denoised-detail-and-edge-preservation',
    'light-leaks-and-fireflies',
    'temporal-ghosting-and-history-age',
    'variance-and-convergence-quality',
    'large-product-scene-composition',
  ]),
  humanReviewStatus: humanReview.status,
  humanReview,
  limitations: Object.freeze([
    'This generator never promotes pixel baselines.',
    'A clean-revision candidate still requires an explicit human review decision.',
    'Formal G10 acceptance additionally requires the full fast/slow, package, device, lifecycle, and performance gates.',
  ]),
};
const validation = validateRayG10ReviewManifest(report, { captureFiles });
if (validation.status !== 'passed') {
  throw new Error(`G10 review manifest is invalid:\n- ${validation.violations.join('\n- ')}`);
}
report.validation = validation;
writeFileSync(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`[ray-g10-review] wrote ${captures.length} captures to ${relative(engineRoot, outputDirectory)} (${report.evidenceClass}).`);

function parseOptions(args) {
  const parsed = { output: null, browser: 'chrome', requireClean: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--require-clean') parsed.requireClean = true;
    else if (argument === '--edge') parsed.browser = 'edge';
    else if (argument === '--output') parsed.output = args[++index] ?? null;
    else if (argument?.startsWith('--output=')) parsed.output = argument.slice('--output='.length);
    else throw new Error(`Unknown G10 review option ${argument}.`);
  }
  if (parsed.output === '') throw new Error('--output requires a directory under Engine/artifacts.');
  return parsed;
}

function browserConfiguration(name) {
  const configurations = {
    chrome: { name: 'chrome', executable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    edge: { name: 'edge', executable: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  };
  const configuration = configurations[name];
  if (!configuration || !existsSync(configuration.executable)) throw new Error(`${name} browser is unavailable.`);
  return configuration;
}

function repositoryState(name) {
  const root = requireStudioRepository(name).root;
  const revision = git(root, ['rev-parse', 'HEAD']);
  const status = git(root, ['status', '--porcelain=v1']);
  return Object.freeze({ name, revision, dirty: status.length > 0, changedPathCount: status ? status.split(/\r?\n/u).length : 0 });
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function requireExampleResult(view, result) {
  if (result.status !== 'passed' || result.unclassifiedFailureCount !== 0 || result.cases?.length !== 2) {
    throw new Error(`Ray example ${view} capture failed: ${JSON.stringify(withoutPng(result))}`);
  }
  if (!result.reviewCapture?.pngBase64 || result.reviewCapture.view !== view) throw new Error(`Ray example ${view} review pixels are missing.`);
}

function requireGameResult(result) {
  if (result.status !== 'passed' || result.suite !== 'gravity-maze-ray-tracing-candidate' || result.unclassifiedFailureCount !== 0) {
    throw new Error(`Gravity Maze capture failed: ${JSON.stringify(withoutPng(result))}`);
  }
  if (!result.visualCapture?.pngBase64 || result.visualCapture.darkRatio >= 1) throw new Error('Gravity Maze capture is empty.');
}

function writeCapture(id, result) {
  const source = result.reviewCapture ?? result.visualCapture;
  const png = Buffer.from(source.pngBase64, 'base64');
  const fileName = `${id}.png`;
  writeFileSync(resolve(outputDirectory, fileName), png);
  captureFiles.set(fileName, png);
  const visual = { ...source };
  delete visual.pngBase64;
  return Object.freeze({
    id,
    file: fileName,
    bytes: png.byteLength,
    sha256: createHash('sha256').update(png).digest('hex'),
    visual,
    browserEvidence: result.browserEvidence,
    browserDiagnostics: result.browserDiagnostics,
    httpProvenance: result.httpProvenance,
    candidateHashes: result.cases?.map(value => value.candidateSha256) ?? [result.candidateSha256],
  });
}

function withoutPng(result) {
  if (!result?.visualCapture) return result;
  return { ...result, visualCapture: { ...result.visualCapture, pngBase64: '<omitted>' } };
}

function assertInside(path, parent, label) {
  if (path === parent || !path.startsWith(`${parent}${sep}`)) throw new Error(`${label} must be inside ${parent}.`);
}
