/** Known-answer controls are independent of scene pixels and use nonzero, varying data. */
export const CONTROL_WIDTH = 63;
export const CONTROL_HEIGHT = 5;
export const CONTROL_WORDS = 256;
export function controlWords() {
  return Array.from({ length: CONTROL_WORDS }, (_, i) => (0x9e3779b9 ^ Math.imul(i + 1, 0x45d9f3b)) >>> 0);
}
export function controlRgba() {
  return Array.from({ length: CONTROL_WIDTH * CONTROL_HEIGHT * 4 }, (_, i) =>
    i % 4 === 3 ? 255 : (Math.floor(i / 4) * 37 + (i % 4) * 71 + 19) % 256);
}
export function decodeBgraRows(bytes, width, height, bytesPerRow) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 ||
      bytesPerRow < width * 4 || bytesPerRow % 256 || bytes.length !== bytesPerRow * height)
    throw Error('Invalid BGRA readback extent/layout');
  const pixels = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = y * bytesPerRow + x * 4;
    pixels.push(bytes[o + 2] / 255, bytes[o + 1] / 255, bytes[o] / 255, bytes[o + 3] / 255);
  }
  return pixels;
}
function compare(actual, expected, tolerance) {
  if (!Array.isArray(actual) || actual.length !== expected.length || !actual.every(Number.isFinite))
    return { status: 'failed', reason: 'missing/nonfinite/wrong-size', expectedComponents: expected.length };
  let maxDelta = 0, mismatches = 0;
  for (let i = 0; i < expected.length; i++) {
    const delta = Math.abs(actual[i] - expected[i]);
    maxDelta = Math.max(maxDelta, delta); if (delta > tolerance) mismatches++;
  }
  return { status: mismatches ? 'failed' : 'passed', maxDelta, mismatches, expectedComponents: expected.length };
}
export function assessReadbackControls(value, frameId) {
  const expectedImage = controlRgba().map(v => v / 255);
  const checks = {
    buffer: compare(value?.buffer, controlWords(), 0),
    textureCompute: compare(value?.textureCompute, expectedImage, 1e-6),
    textureCopy: compare(value?.textureCopy, expectedImage, 1e-6),
    witness: compare(value?.witness, [4660, frameId, 64, 64, 22136, frameId, 64, 64], 0),
  };
  return { status: Object.values(checks).every(c => c.status === 'passed') ? 'passed' : 'failed', checks };
}
export function classifyAtomicReadback(result) {
  const atomic = result?.atomicReadback;
  if (atomic?.schemaVersion !== 1 || atomic.submissions !== 1 || atomic.frameId !== 5 ||
      atomic.resourcesRetainedUntilAllMapsSettled !== true ||
      !Array.isArray(atomic.mapErrors) ||
      !['audited', 'native', 'native-encoding'].includes(atomic.access))
    throw Error('Incomplete same-submission readback contract');
  if (result.deviceLoss || atomic.completionError) return { status: 'failed', classification: 'capture-unreliable',
    failureStage: result.deviceLoss ? 'device-lost' : 'queue-completion', deviceLoss: result.deviceLoss ?? null,
    completionError: atomic.completionError ?? null, mapErrors: atomic.mapErrors, controls: null, pair: null };
  if (atomic.mapErrors.length) return { status: 'failed', classification: 'capture-unreliable',
    failureStage: 'mapping', mapErrors: atomic.mapErrors, controls: null, pair: null };
  if (!Array.isArray(result.computed) || result.computed.length !== 16384 || !result.computed.every(Number.isFinite))
    throw Error('Missing/nonfinite main-image readback');
  const controls = assessReadbackControls(atomic.controls, atomic.frameId);
  const pair = result.copySource ? compare(result.copied, result.computed, 1e-6) : null;
  const reliable = controls.status === 'passed' && (!pair || pair.status === 'passed');
  return { status: reliable ? 'passed' : 'failed',
    classification: reliable ? 'capture-consistent' : 'capture-unreliable', controls, pair };
}
