import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  requireStudioRepository,
  resolveStudioRepositoryPath,
} from './studio-repository-layout.mjs';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gamesRoot = requireStudioRepository('Games').root;
const outputRoot = resolve(engineRoot, 'review/capabilities/ray-tracing');
const evidencePath = resolve(engineRoot, 'review/capabilities/ray-tracing-product-evidence.json');
const gamesRevision = git(gamesRoot, ['rev-parse', 'HEAD']);
const gamesDirty = git(gamesRoot, ['status', '--porcelain']);
if (gamesDirty) throw new Error(`Games must be clean before admission capture:\n${gamesDirty}`);

const referencePaths = {
  billiards: resolve(outputRoot, 'billiards-3d-reference-approved.png'),
  gravity: resolve(outputRoot, 'gravity-maze-reference-approved.png'),
};
for (const path of Object.values(referencePaths)) {
  if (!existsSync(path)) throw new Error(`Missing approved reference image: ${relative(engineRoot, path)}.`);
}

mkdirSync(outputRoot, { recursive: true });
const captures = {};
for (const definition of [
  { id: 'billiards-3d', viewport: { width: 1280, height: 720 } },
  { id: 'gravity-maze', viewport: { width: 1280, height: 720 } },
]) {
  const result = await runChromeWebGpuFixture({
    root: engineRoot,
    fixture: 'scripts/webgpu-gate/ray-tracing-admission-fixture.html',
    query: { game: definition.id },
    timeoutMs: 60_000,
    mounts: [{
      prefix: '/Games/games',
      directory: resolveStudioRepositoryPath('Games', 'games'),
    }],
    visualCapture: {
      viewportWidth: definition.viewport.width,
      viewportHeight: definition.viewport.height,
      sampleWidth: 32,
      sampleHeight: 18,
    },
  });
  const png = Buffer.from(result.visualCapture.pngBase64, 'base64');
  delete result.visualCapture.pngBase64;
  const imagePath = resolve(outputRoot, `${definition.id}-baseline.png`);
  writeFileSync(imagePath, png);
  captures[definition.id] = {
    result,
    imagePath,
    imageSha256: sha256(png),
    sceneSha256: fingerprintDirectory(resolve(gamesRoot, 'games', definition.id)),
  };
}

const gravity = captures['gravity-maze'];
const billiards = captures['billiards-3d'];
const evidence = {
  format: 'haiyue-ray-tracing-product-decision@1',
  productRequirementId: 'm04-first-portable-webgpu-ray-tracing-example',
  contentManifestSha256: prefixedSha256(readFileSync(resolve(gamesRoot, 'games/manifest.json'))),
  cases: [
    createCase('path-tracing', gravity, referencePaths.gravity, {
      sourceProduct: 'Games/gravity-maze',
      fixedSceneId: 'gravity-maze-level-1-seed-2188255966',
      fixedCameraReplayId: 'gravity-maze-level-1-camera-v1',
      deficitKind: 'multi-bounce-indirect-lighting',
    }),
    createCase('hybrid-shadow', gravity, referencePaths.gravity, {
      sourceProduct: 'Games/gravity-maze',
      fixedSceneId: 'gravity-maze-level-1-seed-2188255966',
      fixedCameraReplayId: 'gravity-maze-level-1-camera-v1',
      deficitKind: 'offscreen-occluder',
    }),
    createCase('hybrid-reflection', billiards, referencePaths.billiards, {
      sourceProduct: 'Games/billiards-3d',
      fixedSceneId: 'billiards-3d-initial-rack',
      fixedCameraReplayId: 'billiards-3d-initial-camera-v1',
      deficitKind: 'non-planar-dynamic-reflection',
    }),
    createCase('hybrid-ao', gravity, referencePaths.gravity, {
      sourceProduct: 'Games/gravity-maze',
      fixedSceneId: 'gravity-maze-level-1-seed-2188255966',
      fixedCameraReplayId: 'gravity-maze-level-1-camera-v1',
      deficitKind: 'depth-discontinuity-or-thin-geometry',
    }),
  ],
  captureRunner: {
    engineRevision: git(engineRoot, ['rev-parse', 'HEAD']),
    engineDirty: git(engineRoot, ['status', '--porcelain']).length > 0,
    gamesRevision,
    gamesDirty: false,
    fixture: 'scripts/webgpu-gate/ray-tracing-admission-fixture.html',
    contentMount: '/Games/games',
  },
  unclassifiedFailureCount: Object.values(captures)
    .reduce((sum, capture) => sum + capture.result.browserDiagnostics.unclassifiedFailureCount, 0),
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`[ray-tracing-admission] wrote ${relative(engineRoot, evidencePath)}.`);

function createCase(effectId, capture, referencePath, definition) {
  const browser = capture.result.browserEvidence;
  const adapter = capture.result.adapter;
  return {
    effectId,
    sourceProduct: definition.sourceProduct,
    sourceRevision: { commitSha: gamesRevision, dirty: false },
    fixedSceneId: definition.fixedSceneId,
    fixedCameraReplayId: definition.fixedCameraReplayId,
    sceneSha256: `sha256:${capture.sceneSha256}`,
    baselineImageSha256: `sha256:${capture.imageSha256}`,
    referenceImageSha256: prefixedSha256(readFileSync(referencePath)),
    referenceKind: 'product-art-direction-approved',
    baselineDeficit: { currentPathFailed: true, kind: definition.deficitKind },
    deviceClasses: ['windows-discrete'],
    capture: {
      browser: browser.product.split('/')[0] || 'Chrome',
      browserVersion: browser.product,
      backend: browser.angleBackend,
      adapterName: [adapter.vendor, adapter.architecture, adapter.device, adapter.description]
        .filter(Boolean).join(' ') || 'unknown hardware adapter',
      softwareAdapter: !browser.nativeBackend,
      userAgent: browser.userAgent,
      viewport: capture.result.visualCapture,
      baselinePath: relative(engineRoot, capture.imagePath).split(sep).join('/'),
      referencePath: relative(engineRoot, referencePath).split(sep).join('/'),
      httpProvenance: capture.result.httpProvenance,
      browserDiagnostics: capture.result.browserDiagnostics,
    },
  };
}

function fingerprintDirectory(root) {
  const hash = createHash('sha256');
  const files = listFiles(root).filter(path => !/bundle\.js(?:\.map)?$/u.test(path));
  for (const path of files) {
    const relativePath = relative(root, path).split(sep).join('/');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function listFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap(entry => {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) return listFiles(path);
      return statSync(path).isFile() ? [path] : [];
    })
    .sort();
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function prefixedSha256(contents) {
  return `sha256:${sha256(contents)}`;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
