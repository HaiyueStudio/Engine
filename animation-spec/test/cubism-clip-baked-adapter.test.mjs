import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseAnimation } from '../dist/index.js';
import { createDeformableMesh2DFormatRegistry, decodeDeformableMesh2DData } from '../dist/deformable2d.js';
import { OfflineConversionError } from '../dist/conversion.js';
import {
  CUBISM_CLIP_BAKED_UPDATE_ORDER,
  runCubismClipBakedConversion,
} from '../dist/live2d/clip-baked.js';

test('Cubism clip-baked adapter evaluates the frozen recipe order and emits standalone neutral HYA', async () => {
  const calls = [];
  let closeCount = 0;
  const source = cubismSource({
    async evaluate(time, recipe, updateOrder, signal) {
      assert.equal(signal.aborted, false);
      calls.push({ time, recipe, updateOrder });
      return captureFrame(time);
    },
    close() { closeCount++; },
  });
  const host = memoryHost(source);
  const options = {
    source, sourceBytes: host.assets.get('model.model3.json'), host,
    recipe: { id: 'full', clip: 'TapBody', motion: 'motions/tap.motion3.json', expression: 'expressions/smile.exp3.json', physics: true, pose: true, constants: { ParamAngleX: 5 } },
    sampling: { tolerance: 0.01, quantizationStep: 1 / 1024, maxDepth: 8, evaluationConcurrency: 4 }, mode: 'strict',
  };
  const result = await runCubismClipBakedConversion(options);
  assert.ok(calls.length > 3);
  assert.ok(calls.every(call => call.updateOrder === CUBISM_CLIP_BAKED_UPDATE_ORDER));
  assert.equal(closeCount, 1);
  assert.deepEqual(result.artifacts.map(item => item.path), ['model.hya', 'model.hydm', 'textures/texture.png']);
  assert.equal(result.report.features.motion, true);
  assert.equal(result.report.features.expression, true);
  assert.equal(result.report.features.physics, true);
  assert.equal(result.report.features.pose, true);
  assert.equal(result.report.features.drawableColorCapture, 'captured');
  assert.equal(result.report.features.multiplyColorDrawableCount, 0);
  assert.equal(result.report.adapter.version, '1.1.0');
  assert.equal(result.report.unclassifiedFailureCount, 0);
  const hya = result.artifacts.find(item => item.path === 'model.hya');
  const hydm = result.artifacts.find(item => item.path === 'model.hydm');
  const document = parseAnimation(hya.bytes.buffer, { extensions: createDeformableMesh2DFormatRegistry() });
  assert.equal(document.extensionsRequired[0], 'org.haiyue.deformable-mesh-2d@1');
  assert.match(document.resources.find(item => item.type === 'binary').integrity, /^sha256-[a-f\d]{64}$/u);
  const data = decodeDeformableMesh2DData(hydm.bytes.buffer);
  assert.equal(data.drawables[0].id, 'drawable-0000', 'Cubism drawable ids must be lowered to neutral stable identities');
  const middle = [...data.times].findIndex(time => Math.abs(time - 0.5) < 1e-6);
  assert.ok(middle >= 0);
  const positionOffset = middle * data.drawables[0].uvs.length;
  assert.ok(Math.abs(data.drawables[0].positions[positionOffset] - 129) < 1e-3, 'CPU pose oracle preserves the captured deformation');
  assert.equal(scanArtifacts(result.artifacts), false, 'Core, moc3, model3 and WPK bytes must not enter playback artifacts');

  const repeatedSource = cubismSource();
  const repeatedHost = memoryHost(repeatedSource);
  const repeated = await runCubismClipBakedConversion({ ...options, source: repeatedSource, host: repeatedHost, sourceBytes: repeatedHost.assets.get('model.model3.json') });
  assert.deepEqual(result.artifacts.map(item => [...item.bytes]), repeated.artifacts.map(item => [...item.bytes]));
});

test('Cubism adapter classifies unsupported containers, missing recipe capabilities and live inputs', async () => {
  const source = cubismSource({ capabilities: { motion: true, expression: false, physics: false, pose: false } });
  const host = memoryHost(source);
  const base = { source, sourceBytes: host.assets.get('model.model3.json'), host, sampling: { tolerance: 0.1, quantizationStep: 0.01 }, mode: 'normal' };
  await assert.rejects(runCubismClipBakedConversion({ ...base, recipe: { id: 'physics', clip: 'idle', expression: 'smile', physics: true } }), error => error instanceof OfflineConversionError && error.code === 'E_CUBISM_RECIPE_CAPABILITY_MISSING');
  await assert.rejects(runCubismClipBakedConversion({ ...base, recipe: { id: 'input', clip: 'idle', runtimeInputs: ['lip-sync'] } }), error => error instanceof OfflineConversionError && error.code === 'E_CUBISM_RUNTIME_INPUT_UNBAKED');
  const wpk = cubismSource();
  wpk.entry = 'character.wpk';
  const wpkHost = memoryHost(wpk);
  await assert.rejects(runCubismClipBakedConversion({ ...base, source: wpk, host: wpkHost, sourceBytes: wpkHost.assets.get('model.model3.json'), recipe: { id: 'wpk', clip: 'idle' } }), error => error instanceof OfflineConversionError && error.code === 'E_CUBISM_WPK_UNSUPPORTED');
});

test('Cubism strict conversion preserves represented culling and commits output', async () => {
  const source = cubismSource({ async evaluate(time) { const frame = captureFrame(time); frame.drawables[0].culling = true; return frame; } });
  const host = memoryHost(source);
  const result = await runCubismClipBakedConversion({
    source, sourceBytes: host.assets.get('model.model3.json'), host, recipe: { id: 'strict', clip: 'idle' },
    sampling: { tolerance: 0.1, quantizationStep: 0.01 }, mode: 'strict',
  });
  const hydm = result.artifacts.find(item => item.path === 'model.hydm');
  assert.equal(decodeDeformableMesh2DData(hydm.bytes.buffer).drawables[0].culling, true);
  assert.equal(host.transactions[0].committed, 1);
  assert.equal(host.transactions[0].rolledBack, 0);
});

test('Cubism adaptive sampling attributes nonlinear drawable colors and emits HYDM 1.2', async () => {
  const source = cubismSource({
    keyTimes: [],
    async evaluate(time) {
      const frame = captureFrame(time);
      frame.drawables[0].positions = [0, 0, 1, 0, 0, 1];
      const pulse = 4 * time * (1 - time);
      frame.drawables[0].multiplyColor = [1 - pulse, 1, 1, 0.25 + pulse * 0.5];
      frame.drawables[0].screenColor = [0, pulse, 0, pulse];
      return frame;
    },
  });
  const host = memoryHost(source);
  const result = await runCubismClipBakedConversion({
    source, sourceBytes: host.assets.get('model.model3.json'), host, recipe: { id: 'color', clip: 'idle' },
    sampling: { tolerance: 0.01, quantizationStep: 1 / 1024, maxDepth: 8 }, mode: 'strict',
  });
  assert.ok(result.times.length > 2, 'color error alone must refine the endpoint interval');
  assert.ok([...result.times].some(time => Math.abs(time - 0.5) < 1e-6));
  assert.equal(result.report.features.multiplyColorDrawableCount, 1);
  assert.equal(result.report.features.screenColorDrawableCount, 1);
  assert.ok(result.report.features.multiplyColorDrawableFrameCount > 0);
  assert.ok(result.report.sampling.dirtyChannelCount > 0);
  const hydm = result.artifacts.find(item => item.path === 'model.hydm');
  assert.equal(new DataView(hydm.bytes.buffer, hydm.bytes.byteOffset, hydm.bytes.byteLength).getUint16(6, true), 2);
  const data = decodeDeformableMesh2DData(hydm.bytes.buffer.slice(hydm.bytes.byteOffset, hydm.bytes.byteOffset + hydm.bytes.byteLength));
  const middle = [...data.times].findIndex(time => Math.abs(time - 0.5) < 1e-6);
  assert.ok(Math.abs(data.drawables[0].multiplyColors[middle * 4] - 0) < 1e-6);
  assert.ok(Math.abs(data.drawables[0].screenColors[middle * 4 + 1] - 1) < 1e-6);
});

test('Cubism evaluator color capability rejects missing RGBA with a stable code and classifies unavailable Core APIs', async () => {
  const missingSource = cubismSource({ async evaluate(time) { const frame = captureFrame(time); delete frame.drawables[0].screenColor; return frame; } });
  const missingHost = memoryHost(missingSource);
  await assert.rejects(runCubismClipBakedConversion({
    source: missingSource, sourceBytes: missingHost.assets.get('model.model3.json'), host: missingHost, recipe: { id: 'missing-color', clip: 'idle' },
    sampling: { tolerance: 0.1, quantizationStep: 0.01 }, mode: 'normal',
  }), error => error instanceof OfflineConversionError && error.code === 'E_CUBISM_DRAWABLE_COLOR_INVALID' && error.path.endsWith('.screenColor'));

  const unavailableSource = cubismSource({ capabilities: { motion: true, expression: true, physics: true, pose: true, drawableColors: false } });
  const unavailableHost = memoryHost(unavailableSource);
  await assert.rejects(runCubismClipBakedConversion({
    source: unavailableSource, sourceBytes: unavailableHost.assets.get('model.model3.json'), host: unavailableHost, recipe: { id: 'unavailable-color', clip: 'idle' },
    sampling: { tolerance: 0.1, quantizationStep: 0.01 }, mode: 'strict',
  }), error => error instanceof OfflineConversionError && error.code === 'E_CONVERSION_STRICT_DIAGNOSTIC');
  assert.equal(unavailableHost.transactions[0].rolledBack, 1);
});

function cubismSource(overrides = {}) {
  const evaluator = {
    version: 'fixture-evaluator@1', duration: 1, keyTimes: [0.5],
    capabilities: { motion: true, expression: true, physics: true, pose: true, drawableColors: true },
    async evaluate(time) { return captureFrame(time); }, close() {},
    ...overrides,
  };
  return {
    entry: 'model.model3.json', name: 'Licensed local fixture', sourceVersion: 'sha256-source', coreVersion: 'Core@5',
    canvas: { width: 256, height: 256, pixelsPerUnit: 1, coordinateSystem: 'model-y-up', uvOrigin: 'bottom-left' }, frameRate: 30,
    textures: [{ id: 'texture-0', uri: 'textures/texture.png', integrity: integrity(Uint8Array.of(1, 2, 3)) }],
    dependencies: [
      { uri: 'model.moc3', integrity: integrity(Uint8Array.of(4, 5, 6)) },
      { uri: 'textures/texture.png', integrity: integrity(Uint8Array.of(1, 2, 3)) },
      { uri: 'motions/tap.motion3.json', integrity: integrity(Uint8Array.of(7)) },
      { uri: 'expressions/smile.exp3.json', integrity: integrity(Uint8Array.of(8)) },
      { uri: 'physics.json', integrity: integrity(Uint8Array.of(9)) },
      { uri: 'pose.json', integrity: integrity(Uint8Array.of(10)) },
    ],
    evaluator,
  };
}

function captureFrame(time) {
  const x = 4 * time * (1 - time);
  return {
    time,
    drawables: [{
      id: 'ArtMeshSourceId', textureIndex: 0, renderOrder: time < 0.5 ? 1 : 2, opacity: 1,
      blendMode: 'normal', culling: false, masks: [], positions: [x, 0, x + 1, 0, x, 1],
      uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2], multiplyColor: [1, 1, 1, 1], screenColor: [0, 0, 0, 0],
    }],
  };
}

function memoryHost(source) {
  const assets = new Map([
    ['model.model3.json', new TextEncoder().encode('{"Version":3}')], ['model.moc3', Uint8Array.of(4, 5, 6)],
    ['textures/texture.png', Uint8Array.of(1, 2, 3)], ['motions/tap.motion3.json', Uint8Array.of(7)],
    ['expressions/smile.exp3.json', Uint8Array.of(8)], ['physics.json', Uint8Array.of(9)], ['pose.json', Uint8Array.of(10)],
  ]);
  const transactions = [];
  return {
    assets, transactions,
    async readAsset(uri) { const value = assets.get(uri); if (!value) throw new Error(`missing ${uri}`); return value.slice(); },
    async sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); },
    beginTransaction() {
      const state = { staged: new Map(), committed: 0, rolledBack: 0 }; transactions.push(state);
      return { stage(path, bytes) { state.staged.set(path, bytes.slice()); }, commit() { state.committed++; }, rollback() { state.rolledBack++; state.staged.clear(); } };
    },
  };
}

function scanArtifacts(artifacts) {
  const forbidden = ['Live2DCubismCore', '.moc3', '.model3.json', '.wpk'];
  return artifacts.some(artifact => forbidden.some(token => artifact.path.includes(token) || new TextDecoder().decode(artifact.bytes).includes(token)));
}

function integrity(bytes) { return `sha256-${createHash('sha256').update(bytes).digest('hex')}`; }
