import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { encodeAnimationBinary, parseAnimation } from '../dist/index.js';
import { combineCubismCaptureClips, convertCubismCaptureToHya, CubismCaptureConversionError, listCubismModel3Motions, sampleCubismMotion3 } from '../dist/live2d.js';
import { createDeformableMesh2DFormatRegistry, decodeDeformableMesh2DData, encodeDeformableMesh2DData } from '../dist/deformable2d.js';

const CONTRACT = JSON.parse(await readFile(new URL('../schema/deformable-mesh-2d.contract.json', import.meta.url), 'utf8'));
const SCHEMA = JSON.parse(await readFile(new URL('../schema/deformable-mesh-2d-extension.schema.json', import.meta.url), 'utf8'));

test('deformable 2D machine-readable contract freezes the required extension and Web delivery boundary', () => {
  assert.equal(CONTRACT.extension.id, 'org.haiyue.deformable-mesh-2d@1');
  assert.equal(CONTRACT.extension.binaryMagic, 'HYDM');
  assert.equal(CONTRACT.profile.id, 'clip-baked');
  assert.equal(CONTRACT.runtime.sourceRuntimeDependency, false);
  assert.deepEqual(CONTRACT.runtime.supportedBlendModes, ['normal', 'additive', 'multiplicative']);
  assert.deepEqual(CONTRACT.runtime.supportedMasks, ['alpha', 'alpha-inverted']);
  assert.equal(CONTRACT.extension.binaryVersion, '1.1');
  assert.equal(SCHEMA.properties.type.const, CONTRACT.extension.id);
  assert.equal(SCHEMA.properties.textures.maxItems, CONTRACT.limits.maxTextures);
});

test('HYDM codec is deterministic, bounded and preserves frame-major mesh tracks', () => {
  const source = dataFixture();
  const first = encodeDeformableMesh2DData(source);
  const second = encodeDeformableMesh2DData(source);
  assert.deepEqual(new Uint8Array(first), new Uint8Array(second));
  const parsed = decodeDeformableMesh2DData(first);
  assert.equal(parsed.drawables[0].vertexCount, 3);
  assert.deepEqual([...parsed.drawables[0].positions], [...source.drawables[0].positions]);
  assert.equal(parsed.backingBuffer, first);
  assert.throws(() => decodeDeformableMesh2DData(first, { maxInputBytes: 8 }), /exceeds/);
  const unknownVersion = first.slice(0);
  new DataView(unknownVersion).setUint16(4, 2, true);
  assert.throws(() => decodeDeformableMesh2DData(unknownVersion), /Unsupported sidecar version 2.1/);
  const unknownMinor = first.slice(0);
  new DataView(unknownMinor).setUint16(6, 2, true);
  assert.throws(() => decodeDeformableMesh2DData(unknownMinor), /Unsupported sidecar version 1.2/);
  assert.throws(() => decodeDeformableMesh2DData(first.slice(0, 40)), /outside the buffer|unaccounted bytes/);
});

test('HYDM 1.1 preserves inverted masks while 1.0 remains readable as normal alpha', () => {
  const source = twoDrawableDataFixture();
  source.drawables[0].masks = ['back'];
  source.drawables[0].maskMode = 'alpha-inverted';
  const encoded = encodeDeformableMesh2DData(source);
  assert.equal(new DataView(encoded).getUint16(6, true), 1);
  assert.equal(decodeDeformableMesh2DData(encoded).drawables[0].maskMode, 'alpha-inverted');

  const legacy = rewriteHydmMetadata(encoded, metadata => {
    for (const drawable of metadata.drawables) delete drawable.maskMode;
  });
  new DataView(legacy).setUint16(6, 0, true);
  assert.equal(decodeDeformableMesh2DData(legacy).drawables[0].maskMode, 'alpha');
});

test('HYDM encoder rejects invalid indices, opacity and order before serialization', () => {
  const source = dataFixture();
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], indices: new Uint32Array([0, 1, 4]) }] }), /missing vertex/);
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], opacities: new Float32Array([1, 2]) }] }), /Opacity/);
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], renderOrders: new Float32Array([0, 0.5]) }] }), /safe integer/);
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], textureIndex: 32 }] }), /Texture index exceeds/);
});

test('HYDM rejects duplicate, cyclic, overlapping and unreferenced mask/pool data', () => {
  const source = twoDrawableDataFixture();
  assert.throws(() => encodeDeformableMesh2DData({
    ...source,
    drawables: source.drawables.map(drawable => ({ ...drawable, masks: drawable.id === 'front' ? ['back', 'back'] : [] })),
  }), /unique/);
  assert.throws(() => encodeDeformableMesh2DData({
    ...source,
    drawables: source.drawables.map(drawable => ({ ...drawable, masks: drawable.id === 'front' ? ['back'] : ['front'] })),
  }), /cycle/);

  const encoded = encodeDeformableMesh2DData(source);
  const overlapping = rewriteHydmMetadata(encoded, metadata => {
    metadata.drawables[0].positions = [...metadata.drawables[0].uvs];
  });
  assert.throws(() => decodeDeformableMesh2DData(overlapping), /overlap|unreferenced/);

  const cyclic = rewriteHydmMetadata(encoded, metadata => {
    metadata.drawables[0].masks = ['back'];
    metadata.drawables[1].masks = ['front'];
  });
  assert.throws(() => decodeDeformableMesh2DData(cyclic), /cycle/);
});

test('Cubism capture converts to required HYA extension and binary round-trips with explicit registry', () => {
  const converted = convertCubismCaptureToHya(captureFixture(), { dataUri: 'character.hydm', strict: true });
  assert.equal(converted.report.profile, 'clip-baked');
  assert.equal(converted.report.drawableCount, 1);
  assert.equal(converted.diagnostics.length, 0);
  const registry = createDeformableMesh2DFormatRegistry();
  const parsed = parseAnimation(encodeAnimationBinary(converted.document, { extensions: registry }), { extensions: registry });
  assert.deepEqual(parsed.extensionsRequired, ['org.haiyue.deformable-mesh-2d@1']);
  const data = decodeDeformableMesh2DData(converted.data);
  assert.deepEqual([...data.drawables[0].positions.slice(0, 6)], [128, 128, 138, 128, 128, 118]);
  assert.deepEqual([...data.drawables[0].uvs], [0, 0, 1, 0, 0, 1]);

  const cubismCoreCapture = captureFixture();
  cubismCoreCapture.canvas.uvOrigin = 'bottom-left';
  const normalized = decodeDeformableMesh2DData(convertCubismCaptureToHya(cubismCoreCapture, { strict: true }).data);
  assert.deepEqual([...normalized.drawables[0].uvs], [0, 1, 1, 1, 0, 0]);
});

test('Cubism capture tolerates float32 opacity drift and clamps the encoded track', () => {
  const capture = captureFixture();
  capture.frames[0].drawables[0].opacity = 1.0000001192092896;
  capture.frames[1].drawables[0].opacity = -0.0000000596046448;
  const converted = convertCubismCaptureToHya(capture, { strict: true });
  const data = decodeDeformableMesh2DData(converted.data);
  assert.deepEqual([...data.drawables[0].opacities], [1, 0]);

  capture.frames[0].drawables[0].opacity = 1.001;
  assert.throws(() => convertCubismCaptureToHya(capture), error => error instanceof CubismCaptureConversionError
    && error.diagnostics.some(item => item.code === 'E_CUBISM_CAPTURE_INVALID' && item.path === '$.frames[0].drawables[0].opacity'));
});

test('Cubism empty Core drawables normalize to invisible stable topology', () => {
  const capture = captureFixture();
  for (const frame of capture.frames) {
    frame.drawables[0].positions = [];
    frame.drawables[0].uvs = [];
    frame.drawables[0].indices = [];
  }
  const converted = convertCubismCaptureToHya(capture, { strict: true });
  const data = decodeDeformableMesh2DData(converted.data);
  assert.equal(converted.report.emptyDrawableCount, 1);
  assert.equal(data.drawables[0].vertexCount, 3);
  assert.deepEqual([...data.drawables[0].indices], [0, 1, 2]);
  assert.deepEqual([...data.drawables[0].opacities], [0, 0]);

  const indexless = captureFixture();
  for (const frame of indexless.frames) frame.drawables[0].indices = [];
  const normalized = convertCubismCaptureToHya(indexless, { strict: true });
  assert.equal(normalized.report.emptyDrawableCount, 1);
  assert.deepEqual([...decodeDeformableMesh2DData(normalized.data).drawables[0].opacities], [0, 0]);
});

test('Cubism conversion preserves non-normal blend modes while strict mode still rejects remaining approximations', () => {
  const additive = captureFixture();
  additive.frames[0].drawables[0].blendMode = 'additive';
  additive.frames[1].drawables[0].blendMode = 'additive';
  const converted = convertCubismCaptureToHya(additive, { strict: true });
  assert.equal(decodeDeformableMesh2DData(converted.data).drawables[0].blendMode, 'additive');

  const warning = captureFixture();
  warning.frames[0].drawables[0].culling = true;
  warning.frames[1].drawables[0].culling = true;
  assert.throws(() => convertCubismCaptureToHya(warning, { strict: true }), error => error instanceof CubismCaptureConversionError && error.diagnostics[0].code === 'W_CUBISM_CULLING_IGNORED');
});

test('Cubism topology changes have a stable diagnostic', () => {
  const changed = captureFixture();
  changed.frames[1].drawables[0].uvs[0] = 0.5;
  assert.throws(() => convertCubismCaptureToHya(changed), error => error instanceof CubismCaptureConversionError && error.diagnostics.some(item => item.code === 'E_CUBISM_TOPOLOGY_CHANGED'));
});

test('Cubism constant drawable flags cannot change across baked frames', () => {
  const changed = captureFixture();
  changed.frames[1].drawables[0].blendMode = 'additive';
  assert.throws(() => convertCubismCaptureToHya(changed), error => error instanceof CubismCaptureConversionError
    && error.diagnostics.some(item => item.code === 'E_CUBISM_TOPOLOGY_CHANGED' && item.path.includes('frames[1]')));
});

test('Motion3 sampler supports linear, stepped, inverse-stepped and Cubism Bezier segments', () => {
  const motion = { Meta: { Duration: 4 }, Curves: [
    { Target: 'Parameter', Id: 'Linear', Segments: [0, 0, 0, 1, 1] },
    { Target: 'Parameter', Id: 'Bezier', Segments: [0, 0, 1, 0.25, 0, 0.75, 1, 1, 1] },
    { Target: 'PartOpacity', Id: 'Step', Segments: [0, 0.25, 2, 1, 0.75] },
    { Target: 'Model', Id: 'Opacity', Segments: [0, 0.2, 3, 1, 0.8] },
  ] };
  const sampled = sampleCubismMotion3(motion, 0.5);
  assert.equal(sampled.parameters.get('Linear'), 0.5);
  assert.ok(Math.abs(sampled.parameters.get('Bezier') - 0.5) < 0.0001);
  assert.equal(sampled.partOpacities.get('Step'), 0.25);
  assert.equal(sampled.modelOpacity, 0.8);
});

test('model3 motion groups flatten into stable selectable actions', () => {
  const motions = listCubismModel3Motions({
    Tap: [{ File: 'motions/tap-01.motion3.json', FadeInTime: 0.25 }, { File: 'motions/tap-02.motion3.json' }],
    Idle: [{ File: 'motions/idle.motion3.json', Sound: 'sounds/idle.wav' }],
  });
  assert.deepEqual(motions, [
    { id: 'Tap:0', group: 'Tap', index: 0, file: 'motions/tap-01.motion3.json', fadeInTime: 0.25 },
    { id: 'Tap:1', group: 'Tap', index: 1, file: 'motions/tap-02.motion3.json' },
    { id: 'Idle:0', group: 'Idle', index: 0, file: 'motions/idle.motion3.json', sound: 'sounds/idle.wav' },
  ]);
  assert.deepEqual(listCubismModel3Motions(undefined), []);
  assert.throws(() => listCubismModel3Motions({ Tap: [{ FadeInTime: 0.2 }] }), /requires File/u);
});

test('Cubism action clips share one timeline while retaining non-overlapping playback ranges', () => {
  const first = captureFixture();
  const second = captureFixture();
  second.frames[0].drawables[0].positions[0] = 20;
  second.frames[1].drawables[0].positions[0] = 21;
  const combined = combineCubismCaptureClips([
    { id: 'idle', name: 'Idle', capture: first },
    { id: 'tap', name: 'Tap', capture: second },
  ], { interClipGap: 0.25 });
  assert.deepEqual(combined.clips, [
    { id: 'idle', name: 'Idle', start: 0, duration: 1, frameCount: 2 },
    { id: 'tap', name: 'Tap', start: 1.25, duration: 1, frameCount: 2 },
  ]);
  assert.deepEqual(combined.capture.frames.map(frame => frame.time), [0, 1, 1.25, 2.25]);
  assert.equal(combined.capture.duration, 2.25);
  assert.equal(decodeDeformableMesh2DData(convertCubismCaptureToHya(combined.capture).data).times.length, 4);
  assert.throws(() => combineCubismCaptureClips([{ id: 'idle', capture: first }, { id: 'idle', capture: second }]), /duplicated/u);
});

function dataFixture() {
  return {
    canvasWidth: 256, canvasHeight: 256, duration: 1, frameRate: 1,
    times: new Float32Array([0, 1]),
    drawables: [{
      id: 'mesh', textureIndex: 0, blendMode: 'normal', culling: false, masks: [],
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
      positions: new Float32Array([0, 0, 10, 0, 0, 10, 2, 2, 12, 2, 2, 12]),
      opacities: new Float32Array([1, 0.5]), renderOrders: new Float32Array([0, 1]),
    }],
  };
}

function twoDrawableDataFixture() {
  const first = dataFixture();
  const clone = drawable => ({
    ...drawable,
    uvs: drawable.uvs.slice(),
    indices: drawable.indices.slice(),
    positions: drawable.positions.slice(),
    opacities: drawable.opacities.slice(),
    renderOrders: drawable.renderOrders.slice(),
  });
  return {
    ...first,
    drawables: [
      { ...clone(first.drawables[0]), id: 'front', renderOrders: new Float32Array([1, 1]) },
      { ...clone(first.drawables[0]), id: 'back', renderOrders: new Float32Array([0, 0]) },
    ],
  };
}

function rewriteHydmMetadata(buffer, mutate) {
  const header = new DataView(buffer);
  const metadataOffset = header.getUint32(8, true);
  const metadataLength = header.getUint32(12, true);
  const oldFloatOffset = header.getUint32(16, true);
  const floatCount = header.getUint32(20, true);
  const oldIndexOffset = header.getUint32(24, true);
  const indexCount = header.getUint32(28, true);
  const metadata = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, metadataOffset, metadataLength)));
  mutate(metadata);
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  const floatOffset = (32 + bytes.length + 3) & ~3;
  const indexOffset = floatOffset + floatCount * 4;
  const result = new ArrayBuffer(indexOffset + indexCount * 4);
  const out = new DataView(result);
  new Uint8Array(result, 0, 32).set(new Uint8Array(buffer, 0, 32));
  out.setUint32(12, bytes.length, true);
  out.setUint32(16, floatOffset, true);
  out.setUint32(24, indexOffset, true);
  new Uint8Array(result, 32, bytes.length).set(bytes);
  new Uint8Array(result, floatOffset, floatCount * 4).set(new Uint8Array(buffer, oldFloatOffset, floatCount * 4));
  new Uint8Array(result, indexOffset, indexCount * 4).set(new Uint8Array(buffer, oldIndexOffset, indexCount * 4));
  return result;
}

function captureFixture() {
  const drawable = time => ({
    id: 'mesh', textureIndex: 0, renderOrder: 0, opacity: 1, blendMode: 'normal', culling: false, masks: [],
    positions: [time, 0, 10 + time, 0, time, 10], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2],
    multiplyColor: [1, 1, 1, 1], screenColor: [0, 0, 0, 0],
  });
  return {
    format: 'live2d-cubism-drawable-capture', version: 1, canvas: { width: 256, height: 256, pixelsPerUnit: 1, coordinateSystem: 'model-y-up' },
    duration: 1, frameRate: 1, textures: [{ id: 'texture', uri: 'texture.png' }],
    frames: [{ time: 0, drawables: [drawable(0)] }, { time: 1, drawables: [drawable(1)] }],
  };
}
