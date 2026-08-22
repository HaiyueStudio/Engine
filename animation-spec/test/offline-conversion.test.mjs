import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { encodeAnimationBinary, parseAnimation } from '../dist/index.js';
import {
  OfflineConversionError,
  runOfflineConversion,
  stableStringify,
} from '../dist/conversion.js';

test('offline conversion is adaptive, quantized, sparse-attributed and byte-exact across concurrency', async () => {
  const sourceBytes = new TextEncoder().encode('{"fixture":"parabola"}');
  const adapter = analyticAdapter();
  const execute = concurrency => runOfflineConversion({
    source: { amplitude: 1 }, sourceBytes, adapter,
    recipe: { id: 'bounce', clip: 'bounce', constants: { strength: 1 } },
    assets: [{ uri: 'texture.png', integrity: integrity(Uint8Array.of(1, 2, 3)) }],
    host: memoryHost(new Map([['texture.png', Uint8Array.of(1, 2, 3)]])),
    frame: scalarFrameOperations,
    sampling: { tolerance: 0.02, quantizationStep: 1 / 1024, maxDepth: 8, evaluationConcurrency: concurrency },
    mode: 'strict',
    encode: encodePlayableFixture,
  });
  const [serial, parallel] = await Promise.all([execute(1), execute(8)]);
  assert.ok(serial.frames.length > 3, 'parabola extrema must force adaptive subdivision');
  assert.deepEqual([...serial.times], [...parallel.times]);
  assert.deepEqual(serial.artifacts.map(item => [...item.bytes]), parallel.artifacts.map(item => [...item.bytes]));
  assert.deepEqual(serial.reportBytes, parallel.reportBytes, 'worker concurrency is operational and must not change provenance bytes');
  assert.equal(serial.report.unclassifiedFailureCount, 0);
  assert.ok(serial.report.sampling.dirtyChannelCount > 0);
  assert.deepEqual(parseAnimation(serial.artifacts.find(item => item.path === 'model.hya').bytes.buffer).name, 'Fake adapter output');
});

test('offline conversion rolls back strict diagnostics, missing assets and hash mismatches', async () => {
  const transactions = [];
  const host = memoryHost(new Map([['texture.png', Uint8Array.of(1)]]), transactions);
  const base = {
    source: {}, sourceBytes: Uint8Array.of(9), recipe: { id: 'idle', clip: 'idle' }, host,
    frame: scalarFrameOperations, sampling: { tolerance: 0.1, quantizationStep: 0.01 }, encode: encodePlayableFixture,
  };
  await assert.rejects(runOfflineConversion({ ...base, mode: 'strict', adapter: analyticAdapter([{ severity: 'warning', code: 'W_FIXTURE', message: 'loss', path: '$.feature' }]) }), error => error instanceof OfflineConversionError && error.code === 'E_CONVERSION_STRICT_DIAGNOSTIC');
  assert.equal(transactions.at(-1).rolledBack, 1);
  await assert.rejects(runOfflineConversion({ ...base, adapter: analyticAdapter(), assets: [{ uri: 'missing.png' }] }), error => error instanceof OfflineConversionError && error.code === 'E_CONVERSION_ASSET_MISSING');
  assert.equal(transactions.at(-1).rolledBack, 1);
  await assert.rejects(runOfflineConversion({ ...base, adapter: analyticAdapter(), assets: [{ uri: 'texture.png', integrity: `sha256-${'0'.repeat(64)}` }] }), error => error instanceof OfflineConversionError && error.code === 'E_CONVERSION_HASH_MISMATCH');
  assert.equal(transactions.at(-1).rolledBack, 1);
  assert.ok(transactions.every(item => item.committed === 0 && item.staged.size === 0), 'failed transactions must expose no partial artifact');
});

test('offline conversion aborts late evaluator results and leaves no committed output', async () => {
  const controller = new AbortController();
  const transactions = [];
  let releaseMiddle;
  const middle = new Promise(resolve => { releaseMiddle = resolve; });
  const adapter = analyticAdapter([], async time => {
    if (Math.abs(time - 0.5) < 1e-6) await middle;
    return { value: 4 * time * (1 - time) };
  });
  const pending = runOfflineConversion({
    source: {}, sourceBytes: Uint8Array.of(1), adapter, recipe: { id: 'idle', clip: 'idle' },
    host: memoryHost(new Map(), transactions), frame: scalarFrameOperations,
    sampling: { tolerance: 0.01, quantizationStep: 0.001 }, signal: controller.signal, encode: encodePlayableFixture,
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort('test');
  releaseMiddle();
  await assert.rejects(pending, error => error instanceof OfflineConversionError && error.code === 'E_CONVERSION_ABORTED');
  assert.equal(transactions[0].rolledBack, 1);
  assert.equal(transactions[0].committed, 0);
  assert.equal(transactions[0].staged.size, 0);
});

const scalarFrameOperations = {
  interpolate(left, right, progress) { return { value: left.value + (right.value - left.value) * progress }; },
  error(actual, interpolated) { return Math.abs(actual.value - interpolated.value); },
  quantize(frame, step) { return { value: Math.round(frame.value / step) * step }; },
  dirtyChannels(previous, current) { return previous?.value === current.value ? [] : ['drawable/mesh/vertices']; },
};

function analyticAdapter(diagnostics = [], evaluate = async time => ({ value: 4 * time * (1 - time) })) {
  return {
    id: 'fixture-analytic', version: '1.0.0',
    async open() {
      return {
        duration: 1, sourceVersion: 'fixture@1', evaluatorVersion: 'analytic@1', diagnostics,
        features: { deformation: true, drawableCount: 1 }, evaluate, close() {},
      };
    },
  };
}

function encodePlayableFixture(input) {
  const values = input.frames.flatMap(frame => [frame.value * 100, 50]);
  const document = {
    format: 'haiyue-animation', version: '1.0', name: 'Fake adapter output',
    canvas: { width: 100, height: 100, coordinateSystem: 'screen-y-down' }, duration: 1, endBehavior: 'hold',
    nodes: [{ id: 'shape', transform: { position: [0, 50], opacity: 1 }, components: [{ type: 'shape2d', shape: 'rect', size: [10, 10], fill: [1, 1, 1, 1] }] }],
    tracks: [{ node: 'shape', property: 'position', interpolation: 'linear', times: [...input.times], values }],
  };
  return [
    { path: 'samples.json', bytes: new TextEncoder().encode(stableStringify(input.frames)) },
    { path: 'model.hya', bytes: new Uint8Array(encodeAnimationBinary(document)), mimeType: 'application/vnd.haiyue.animation' },
  ];
}

function memoryHost(assets, transactions = []) {
  return {
    async readAsset(uri) { const value = assets.get(uri); if (!value) throw new Error('not found'); return value.slice(); },
    async sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); },
    beginTransaction() {
      const state = { staged: new Map(), committed: 0, rolledBack: 0 };
      transactions.push(state);
      return {
        stage(path, bytes) { state.staged.set(path, bytes.slice()); },
        commit() { state.committed++; },
        rollback() { state.rolledBack++; state.staged.clear(); },
      };
    },
  };
}

function integrity(bytes) { return `sha256-${createHash('sha256').update(bytes).digest('hex')}`; }
