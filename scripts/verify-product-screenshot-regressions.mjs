import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import {
  compareVisualFingerprint,
  DEFAULT_SCREENSHOT_BUDGET,
  PRODUCT_SCREENSHOT_CASES,
} from './visual-regression/product-screenshot-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const update = process.env.UPDATE_PRODUCT_SCREENSHOT_BASELINES === '1';

for (const definition of PRODUCT_SCREENSHOT_CASES) {
  console.log(`[product-screenshot] ${definition.id}`);
  const result = await runChromeWebGpuFixture({
    root,
    fixture: definition.fixture,
    query: definition.query,
    timeoutMs: 90_000,
    visualCapture: { viewportWidth: 960, viewportHeight: 540, sampleWidth: 24, sampleHeight: 14 },
  });
  const capture = result.visualCapture;
  delete result.visualCapture;
  const png = Buffer.from(capture.pngBase64, 'base64');
  delete capture.pngBase64;
  writeArtifact(definition.artifactImage, png);

  if (update) {
    const baseline = {
      schemaVersion: 1,
      id: definition.id,
      fixture: definition.fixture,
      viewport: { width: 960, height: 540, deviceScaleFactor: 1 },
      budget: DEFAULT_SCREENSHOT_BUDGET,
      capture,
      provenance: result,
    };
    writeArtifact(definition.baselineImage, png);
    writeArtifact(definition.baseline, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`[product-screenshot] updated ${definition.baseline}.`);
    continue;
  }

  if (!existsSync(resolve(root, definition.baseline)) || !existsSync(resolve(root, definition.baselineImage))) {
    throw new Error(`Missing reviewed screenshot baseline for ${definition.id}. Run with UPDATE_PRODUCT_SCREENSHOT_BASELINES=1 and review the PNG.`);
  }
  const baseline = JSON.parse(readFileSync(resolve(root, definition.baseline), 'utf8'));
  const comparison = compareVisualFingerprint(capture, baseline);
  writeArtifact(definition.artifactReport, `${JSON.stringify({
    schemaVersion: 1,
    id: definition.id,
    status: comparison.status,
    fixture: definition.fixture,
    comparison,
    capture,
    result,
  }, null, 2)}\n`);
  if (comparison.status !== 'passed') {
    throw new Error(`Screenshot regression for ${definition.id}: ${comparison.failures.join('; ')}. See ${definition.artifactImage}.`);
  }
  console.log(
    `[product-screenshot] ${definition.id} passed: MAE=${comparison.metrics.meanAbsoluteError.toFixed(3)}, `
    + `changed=${(comparison.metrics.changedChannelRatio * 100).toFixed(2)}%.`,
  );
}

function writeArtifact(path, contents) {
  const absolute = resolve(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}
