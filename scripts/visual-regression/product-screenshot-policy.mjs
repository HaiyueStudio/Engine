export const PRODUCT_SCREENSHOT_CASES = Object.freeze([
  screenshotCase('character-animation', 'examples/gltf-animation3d-crossfade/index.html', { regression: 1 }),
  screenshotCase('ambient-occlusion', 'examples/ambient-occlusion/index.html', { regression: 1, algorithm: 'gtao' }),
  screenshotCase('multiple-directional-shadows', 'examples/shadow-map/index.html', { regression: 1 }),
  screenshotCase('spine-animation', 'examples/spine-viewer/index.html', { regression: 1 }),
  screenshotCase('complete-game-match-3', 'games/match-3/index.html', { regression: 1 }),
]);

export const DEFAULT_SCREENSHOT_BUDGET = Object.freeze({
  maxMeanAbsoluteError: 14,
  maxChangedChannelRatio: 0.18,
  changedChannelThreshold: 34,
  maxMeanRgbDelta: 24,
  maxDarkRatioDelta: 0.15,
});

export function compareVisualFingerprint(current, baseline, budget = baseline.budget ?? DEFAULT_SCREENSHOT_BUDGET) {
  if (current.sampleWidth !== baseline.capture.sampleWidth || current.sampleHeight !== baseline.capture.sampleHeight) {
    throw new Error(`Screenshot sample dimensions changed for ${baseline.id}.`);
  }
  if (current.signature.length !== baseline.capture.signature.length || current.signature.length === 0) {
    throw new Error(`Screenshot signature length changed for ${baseline.id}.`);
  }
  let absoluteError = 0;
  let changedChannels = 0;
  for (let index = 0; index < current.signature.length; index++) {
    const delta = Math.abs(current.signature[index] - baseline.capture.signature[index]);
    absoluteError += delta;
    if (delta > budget.changedChannelThreshold) changedChannels++;
  }
  const meanAbsoluteError = absoluteError / current.signature.length;
  const changedChannelRatio = changedChannels / current.signature.length;
  const meanRgbDelta = Math.max(...current.meanRgb.map((value, index) => Math.abs(value - baseline.capture.meanRgb[index])));
  const darkRatioDelta = Math.abs(current.darkRatio - baseline.capture.darkRatio);
  const metrics = { meanAbsoluteError, changedChannelRatio, meanRgbDelta, darkRatioDelta };
  const failures = [];
  if (meanAbsoluteError > budget.maxMeanAbsoluteError) failures.push(`MAE ${meanAbsoluteError.toFixed(3)} > ${budget.maxMeanAbsoluteError}`);
  if (changedChannelRatio > budget.maxChangedChannelRatio) failures.push(`changed ratio ${changedChannelRatio.toFixed(4)} > ${budget.maxChangedChannelRatio}`);
  if (meanRgbDelta > budget.maxMeanRgbDelta) failures.push(`mean RGB delta ${meanRgbDelta.toFixed(3)} > ${budget.maxMeanRgbDelta}`);
  if (darkRatioDelta > budget.maxDarkRatioDelta) failures.push(`dark ratio delta ${darkRatioDelta.toFixed(4)} > ${budget.maxDarkRatioDelta}`);
  return { status: failures.length === 0 ? 'passed' : 'failed', metrics, failures };
}

function screenshotCase(id, fixture, query) {
  return Object.freeze({
    id,
    fixture,
    query: Object.freeze(query),
    baseline: `review/baselines/product-screenshots/${id}.json`,
    baselineImage: `review/baselines/product-screenshots/${id}.png`,
    artifactImage: `artifacts/render-regression/${id}.png`,
    artifactReport: `artifacts/render-regression/${id}.json`,
  });
}
