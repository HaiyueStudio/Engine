import { createHash } from 'node:crypto';

export const RIVE_ORACLE_CAPTURE_KIND = 'haiyue-rive-normalized-channel-capture';
export const RIVE_ORACLE_COMPARISON_KIND = 'haiyue-rive-channel-comparison';
export const RIVE_ORACLE_CHANNEL_VERSION = 1;
export const RIVE_ORACLE_PIXEL_ALGORITHM = 'global-rgba-ssim@1';

const HASH = /^[a-f0-9]{64}$/u;
const PIXEL_THRESHOLDS = Object.freeze({ maxChannelDelta: 2 / 255, changedPixelRatio: 0.001, minimumSsim: 0.9995 });

export function validateRiveOracleChannelEvidence({
  channel,
  officialReference,
  hyaReference,
  comparisonReference,
  artifactBytesByPath,
  scenario,
  scenarioSha256,
  assetId,
  rivSha256,
  formal = false,
}) {
  const violations = [];
  const official = parseJsonReference(officialReference, 'official capture');
  const hya = parseJsonReference(hyaReference, 'HYA capture');
  const comparison = parseJsonReference(comparisonReference, 'comparison');
  if (!official || !hya || !comparison) return result(null);
  validateCapture(official, '@rive-app/webgl2@2.40.0', 'official');
  validateCapture(hya, 'haiyue-exact-hya', 'HYA');
  const expected = compareCaptures(official, hya, {
    channel, assetId, scenarioSha256, officialSha256: officialReference.sha256, hyaSha256: hyaReference.sha256,
  });
  validateComparison(comparison, expected);
  return result(expected);

  function parseJsonReference(reference, label) {
    const supplied = artifactBytesByPath?.get(reference?.path);
    if (!supplied) {
      if (formal) violations.push(`${label} bytes are unavailable`);
      return null;
    }
    try { return JSON.parse(asBytes(supplied).toString('utf8')); }
    catch (error) { violations.push(`${label} is not valid JSON: ${boundedMessage(error)}`); return null; }
  }

  function validateCapture(capture, runtime, label) {
    exactKeys(capture, ['schemaVersion', 'kind', 'channel', 'runtime', 'assetId', 'rivSha256', 'scenarioSha256', 'normalization', 'replayCount', 'samples'], `${label} capture`);
    equal(capture.schemaVersion, RIVE_ORACLE_CHANNEL_VERSION, `${label} capture schemaVersion`);
    equal(capture.kind, RIVE_ORACLE_CAPTURE_KIND, `${label} capture kind`);
    equal(capture.channel, channel, `${label} capture channel`);
    equal(capture.runtime, runtime, `${label} capture runtime`);
    equal(capture.assetId, assetId, `${label} capture asset`);
    equal(capture.rivSha256, rivSha256, `${label} capture RIV hash`);
    equal(capture.scenarioSha256, scenarioSha256, `${label} capture scenario hash`);
    equal(capture.normalization, `haiyue-rive-${channel}@1`, `${label} capture normalization`);
    equal(capture.replayCount, scenario?.replayCount, `${label} capture replay count`);
    const samples = Array.isArray(capture.samples) ? capture.samples : [];
    if (!Array.isArray(capture.samples)) violations.push(`${label} capture samples must be an array`);
    const expectedCount = Number(scenario?.replayCount ?? 0) * Number(scenario?.clockStepsMicros?.length ?? 0);
    equal(samples.length, expectedCount, `${label} capture sample count`);
    let sampleIndex = 0;
    for (let replayIndex = 0; replayIndex < Number(scenario?.replayCount ?? 0); replayIndex++) {
      for (const atMicros of scenario?.clockStepsMicros ?? []) {
        const sample = samples[sampleIndex++];
        if (!sample) continue;
        exactKeys(sample, ['replayIndex', 'atMicros', 'actionIds', 'value'], `${label} sample ${sampleIndex - 1}`);
        equal(sample.replayIndex, replayIndex, `${label} sample ${sampleIndex - 1} replay`);
        equal(sample.atMicros, atMicros, `${label} sample ${sampleIndex - 1} clock`);
        const expectedActions = (scenario?.actions ?? []).filter(action => action.atMicros === atMicros).map(action => action.id);
        if (stableJson(sample.actionIds) !== stableJson(expectedActions)) violations.push(`${label} sample ${sampleIndex - 1} action identities differ from the scenario`);
        if (channel === 'pixels') validatePixelValue(sample.value, `${label} sample ${sampleIndex - 1}`);
        else if (!isBoundedJson(sample.value)) violations.push(`${label} sample ${sampleIndex - 1} value is not bounded JSON`);
      }
    }
  }

  function validatePixelValue(value, label) {
    exactKeys(value, ['width', 'height', 'dpr', 'rgba'], `${label} pixel value`);
    positiveInteger(value?.width, `${label} pixel width`); positiveInteger(value?.height, `${label} pixel height`);
    if (!Number.isFinite(value?.dpr) || value.dpr <= 0) violations.push(`${label} pixel DPR must be positive`);
    const reference = value?.rgba;
    exactKeys(reference, ['path', 'sha256', 'byteLength', 'mediaType'], `${label} RGBA artifact`);
    requiredString(reference?.path, `${label} RGBA path`); match(reference?.sha256, HASH, `${label} RGBA hash`);
    equal(reference?.mediaType, 'application/octet-stream', `${label} RGBA media type`);
    const expectedLength = Number(value?.width ?? 0) * Number(value?.height ?? 0) * 4;
    equal(reference?.byteLength, expectedLength, `${label} RGBA byte length`);
    const supplied = artifactBytesByPath?.get(reference?.path);
    if (!supplied) { if (formal) violations.push(`${label} RGBA bytes are unavailable`); return; }
    const bytes = asBytes(supplied);
    equal(bytes.byteLength, reference?.byteLength, `${label} RGBA supplied byte length`);
    equal(createHash('sha256').update(bytes).digest('hex'), reference?.sha256, `${label} RGBA content hash`);
  }

  function compareCaptures(officialCapture, hyaCapture, identity) {
    const samples = [];
    let differenceCount = 0;
    let maxChannelDelta = 0;
    let changedPixelRatio = 0;
    let ssim = 1;
    const count = Math.min(officialCapture.samples?.length ?? 0, hyaCapture.samples?.length ?? 0);
    for (let index = 0; index < count; index++) {
      const left = officialCapture.samples[index]; const right = hyaCapture.samples[index];
      if (channel === 'pixels') {
        const metrics = comparePixelSamples(left?.value, right?.value);
        const passed = metrics.maxChannelDelta <= PIXEL_THRESHOLDS.maxChannelDelta
          && metrics.changedPixelRatio <= PIXEL_THRESHOLDS.changedPixelRatio && metrics.ssim >= PIXEL_THRESHOLDS.minimumSsim;
        if (!passed) differenceCount++;
        maxChannelDelta = Math.max(maxChannelDelta, metrics.maxChannelDelta);
        changedPixelRatio = Math.max(changedPixelRatio, metrics.changedPixelRatio);
        ssim = Math.min(ssim, metrics.ssim);
        samples.push({ replayIndex: left?.replayIndex, atMicros: left?.atMicros, status: passed ? 'passed' : 'failed', differenceCount: passed ? 0 : 1, ...metrics });
      } else {
        const passed = stableJson(left?.value) === stableJson(right?.value);
        if (!passed) differenceCount++;
        samples.push({ replayIndex: left?.replayIndex, atMicros: left?.atMicros, status: passed ? 'passed' : 'failed', differenceCount: passed ? 0 : 1 });
      }
    }
    return {
      schemaVersion: RIVE_ORACLE_CHANNEL_VERSION,
      kind: RIVE_ORACLE_COMPARISON_KIND,
      channel,
      assetId: identity.assetId,
      scenarioSha256: identity.scenarioSha256,
      officialCaptureSha256: identity.officialSha256,
      hyaCaptureSha256: identity.hyaSha256,
      status: differenceCount === 0 ? 'passed' : 'failed',
      differenceCount,
      ...(channel === 'pixels' ? { pixelAlgorithm: RIVE_ORACLE_PIXEL_ALGORITHM, maxChannelDelta, changedPixelRatio, ssim } : {}),
      samples,
    };
  }

  function comparePixelSamples(left, right) {
    if (!left || !right || left.width !== right.width || left.height !== right.height || left.dpr !== right.dpr) return { maxChannelDelta: 1, changedPixelRatio: 1, ssim: -1 };
    const leftBytes = artifactBytesByPath?.get(left.rgba?.path); const rightBytes = artifactBytesByPath?.get(right.rgba?.path);
    if (!leftBytes || !rightBytes) return { maxChannelDelta: 1, changedPixelRatio: 1, ssim: -1 };
    return rgbaMetrics(asBytes(leftBytes), asBytes(rightBytes));
  }

  function validateComparison(actual, expected) {
    const keys = ['schemaVersion', 'kind', 'channel', 'assetId', 'scenarioSha256', 'officialCaptureSha256', 'hyaCaptureSha256', 'status', 'differenceCount', 'samples'];
    if (channel === 'pixels') keys.push('pixelAlgorithm', 'maxChannelDelta', 'changedPixelRatio', 'ssim');
    exactKeys(actual, keys, 'comparison artifact');
    if (stableJson(actual) !== stableJson(expected)) violations.push(`${channel} comparison artifact differs from validator recomputation`);
  }

  function result(recomputed) {
    return Object.freeze({ schemaVersion: 1, contract: 'haiyue-rive-oracle-channel-evidence@1', status: violations.length === 0 ? 'passed' : 'failed', violations: Object.freeze(violations), recomputed });
  }
  function exactKeys(value, expected, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { violations.push(`${label} must be an object`); return; }
    const actual = Object.keys(value).sort(); const ordered = [...expected].sort();
    if (actual.length !== ordered.length || actual.some((key, index) => key !== ordered[index])) violations.push(`${label} fields do not match the frozen contract`);
  }
  function equal(actual, expected, label) { if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`); }
  function match(actual, expression, label) { if (typeof actual !== 'string' || !expression.test(actual)) violations.push(`${label} is invalid`); }
  function requiredString(actual, label) { if (typeof actual !== 'string' || actual.trim().length === 0) violations.push(`${label} is missing`); }
  function positiveInteger(actual, label) { if (!Number.isSafeInteger(actual) || actual < 1) violations.push(`${label} must be a positive safe integer`); }
}

export function createRiveOracleChannelComparison(options) {
  const officialBytes = Buffer.from(`${JSON.stringify(options.officialCapture)}\n`);
  const hyaBytes = Buffer.from(`${JSON.stringify(options.hyaCapture)}\n`);
  const officialReference = reference(options.officialPath, officialBytes);
  const hyaReference = reference(options.hyaPath, hyaBytes);
  const placeholderPath = options.comparisonPath;
  const artifactBytesByPath = new Map(options.artifactBytesByPath ?? []);
  artifactBytesByPath.set(officialReference.path, officialBytes); artifactBytesByPath.set(hyaReference.path, hyaBytes);
  const placeholder = Buffer.from('{}\n');
  artifactBytesByPath.set(placeholderPath, placeholder);
  const validation = validateRiveOracleChannelEvidence({
    ...options, officialReference, hyaReference,
    comparisonReference: reference(placeholderPath, placeholder), artifactBytesByPath,
  });
  if (!validation.recomputed) throw new Error('Rive channel comparison could not be recomputed.');
  const comparison = validation.recomputed;
  const comparisonBytes = Buffer.from(`${JSON.stringify(comparison)}\n`);
  const comparisonReference = reference(placeholderPath, comparisonBytes);
  artifactBytesByPath.set(placeholderPath, comparisonBytes);
  const verification = validateRiveOracleChannelEvidence({
    ...options, officialReference, hyaReference, comparisonReference, artifactBytesByPath, formal: true,
  });
  if (verification.status !== 'passed') throw new Error(`Generated Rive channel evidence is invalid:\n${verification.violations.join('\n')}`);
  return { comparison, comparisonBytes, officialBytes, hyaBytes, officialReference, hyaReference, comparisonReference };
}

function rgbaMetrics(left, right) {
  if (left.byteLength !== right.byteLength || left.byteLength === 0 || left.byteLength % 4 !== 0) return { maxChannelDelta: 1, changedPixelRatio: 1, ssim: -1 };
  let maximum = 0; let changedPixels = 0; let leftMean = 0; let rightMean = 0;
  for (let index = 0; index < left.byteLength; index++) { leftMean += left[index]; rightMean += right[index]; }
  leftMean /= left.byteLength; rightMean /= right.byteLength;
  let leftVariance = 0; let rightVariance = 0; let covariance = 0;
  for (let offset = 0; offset < left.byteLength; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const index = offset + channel; const delta = Math.abs(left[index] - right[index]);
      maximum = Math.max(maximum, delta); changed ||= delta !== 0;
      const leftCentered = left[index] - leftMean; const rightCentered = right[index] - rightMean;
      leftVariance += leftCentered * leftCentered; rightVariance += rightCentered * rightCentered; covariance += leftCentered * rightCentered;
    }
    if (changed) changedPixels++;
  }
  leftVariance /= left.byteLength; rightVariance /= right.byteLength; covariance /= left.byteLength;
  const c1 = (0.01 * 255) ** 2; const c2 = (0.03 * 255) ** 2;
  const score = ((2 * leftMean * rightMean + c1) * (2 * covariance + c2))
    / ((leftMean ** 2 + rightMean ** 2 + c1) * (leftVariance + rightVariance + c2));
  return { maxChannelDelta: maximum / 255, changedPixelRatio: changedPixels / (left.byteLength / 4), ssim: Math.max(-1, Math.min(1, score)) };
}

function reference(path, bytes) {
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, mediaType: 'application/json' };
}
function asBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Artifact bytes must be a Buffer or Uint8Array.');
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function isBoundedJson(value, depth = 0, state = { nodes: 0 }) {
  state.nodes++;
  if (state.nodes > 100_000 || depth > 32) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 1_048_576;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100_000 && value.every(item => isBoundedJson(item, depth + 1, state));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value);
  return entries.length <= 100_000 && entries.every(([key, item]) => key.length <= 4_096 && isBoundedJson(item, depth + 1, state));
}
function boundedMessage(error) { return String(error instanceof Error ? error.message : error).replace(/[\r\n]+/gu, ' ').slice(0, 256); }
