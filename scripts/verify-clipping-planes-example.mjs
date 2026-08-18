import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cases = {};
for (const name of ['off', 'three-planes', 'moved-plane']) {
  cases[name] = await runChromeWebGpuFixture({
    root,
    fixture: 'examples/clipping-planes/index.html',
    query: { regression: 1, clip: name },
    timeoutMs: 90_000,
    visualCapture: {
      viewportWidth: 960,
      viewportHeight: 640,
      sampleWidth: 96,
      sampleHeight: 64,
    },
  });
  assertCase(cases[name], name);
}

const offVsThreePlanes = compareFingerprints(cases.off.visualCapture, cases['three-planes'].visualCapture);
const threePlanesVsMovedPlane = compareFingerprints(
  cases['three-planes'].visualCapture,
  cases['moved-plane'].visualCapture,
);
assertPixelDifference(offVsThreePlanes, 'clipping disabled vs three planes');
assertPixelDifference(threePlanesVsMovedPlane, 'three planes vs moved plane');

console.log(JSON.stringify({
  schemaVersion: 1,
  suite: 'clipping-planes-example',
  status: 'passed',
  cases: Object.fromEntries(Object.entries(cases).map(([name, result]) => [name, {
    regressionCase: result.regressionCase,
    clippingPlaneCount: result.clippingPlaneCount,
    validationErrorCount: result.errors.length,
    meanRgb: result.visualCapture.meanRgb,
  }])),
  pixelDifferences: { offVsThreePlanes, threePlanesVsMovedPlane },
  passCoverage: ['forward', 'depth', 'shadow', 'motion-vector', 'outline', 'normal'],
}, null, 2));

function assertCase(result, expectedCase) {
  if (result.status !== 'passed' || result.errors.length !== 0) {
    throw new Error(`Clipping case ${expectedCase} reported validation errors: ${JSON.stringify(result.errors)}.`);
  }
  if (result.regressionCase !== expectedCase) {
    throw new Error(`Clipping case provenance mismatch: expected ${expectedCase}, received ${result.regressionCase}.`);
  }
  if (result.clippingPlaneCount !== 3 || result.clippingPlaneLimit !== 8) {
    throw new Error(`Clipping ABI changed: ${result.clippingPlaneCount}/${result.clippingPlaneLimit}.`);
  }
  if (result.entityScoped !== true || result.sharedGeometryAndMaterial !== true || result.capsGenerated !== false) {
    throw new Error(`Clipping entity semantics changed: ${JSON.stringify(result)}.`);
  }
  assertNonDegenerate(result.visualCapture, expectedCase);
}

function compareFingerprints(left, right) {
  if (left.sampleWidth !== right.sampleWidth || left.sampleHeight !== right.sampleHeight) {
    throw new Error('Clipping screenshots use different fingerprint dimensions.');
  }
  let absoluteDifference = 0;
  let changedPixels = 0;
  for (let offset = 0; offset < left.signature.length; offset += 3) {
    const difference = Math.abs(left.signature[offset] - right.signature[offset])
      + Math.abs(left.signature[offset + 1] - right.signature[offset + 1])
      + Math.abs(left.signature[offset + 2] - right.signature[offset + 2]);
    absoluteDifference += difference;
    if (difference >= 34) changedPixels++;
  }
  const pixelCount = left.sampleWidth * left.sampleHeight;
  return {
    changedPixelRatio: changedPixels / pixelCount,
    meanAbsoluteDifference: absoluteDifference / (pixelCount * 3),
  };
}

function assertPixelDifference(difference, label) {
  if (difference.changedPixelRatio < 0.005 || difference.meanAbsoluteDifference < 0.3) {
    throw new Error(`${label} produced no meaningful pixel difference: ${JSON.stringify(difference)}.`);
  }
}

function assertNonDegenerate(capture, label) {
  const channelRange = Math.max(...capture.meanRgb) - Math.min(...capture.meanRgb);
  if (capture.darkRatio > 0.98 || channelRange < 0.5) {
    throw new Error(`Clipping ${label} screenshot is degenerate: ${JSON.stringify({
      meanRgb: capture.meanRgb,
      darkRatio: capture.darkRatio,
      channelRange,
    })}.`);
  }
}
