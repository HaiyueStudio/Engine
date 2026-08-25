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
  assert.deepEqual(CONTRACT.runtime.sampledDrawableColors, ['multiply', 'screen']);
  assert.deepEqual(CONTRACT.runtime.renderedDrawableColors, []);
  assert.equal(CONTRACT.runtime.renderedDrawableColorsGoal, 'm05-g15-drawable-color-runtime-parity');
  assert.equal(CONTRACT.extension.binaryVersion, '1.2');
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
  new DataView(unknownMinor).setUint16(6, 3, true);
  assert.throws(() => decodeDeformableMesh2DData(unknownMinor), /Unsupported sidecar version 1.3/);
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
  assert.equal(decodeDeformableMesh2DData(legacy).drawables[0].multiplyColors, undefined);
  assert.equal(decodeDeformableMesh2DData(encoded).drawables[0].screenColors, undefined);
});

test('HYDM 1.2 preserves frame-major drawable colors and elides exact neutral tracks', () => {
  const source = dataFixture();
  source.drawables[0].multiplyColors = new Float32Array([1, 1, 1, 1, 0.5, 0.6, 0.7, 0.8]);
  source.drawables[0].screenColors = new Float32Array([0, 0, 0, 0, 0.1, 0.2, 0.3, 0.4]);
  const first = encodeDeformableMesh2DData(source);
  const second = encodeDeformableMesh2DData(source);
  assert.equal(new DataView(first).getUint16(6, true), 2);
  assert.deepEqual(new Uint8Array(first), new Uint8Array(second));
  const parsed = decodeDeformableMesh2DData(first).drawables[0];
  assert.deepEqual([...parsed.multiplyColors], [...source.drawables[0].multiplyColors]);
  assert.deepEqual([...parsed.screenColors], [...source.drawables[0].screenColors]);

  const neutral = dataFixture();
  neutral.drawables[0].multiplyColors = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]);
  neutral.drawables[0].screenColors = new Float32Array(8);
  const elided = encodeDeformableMesh2DData(neutral);
  assert.equal(new DataView(elided).getUint16(6, true), 1);
  assert.equal(decodeDeformableMesh2DData(elided).drawables[0].multiplyColors, undefined);
  assert.equal(decodeDeformableMesh2DData(elided).drawables[0].screenColors, undefined);
});

test('HYDM drawable color ranges reject malformed length, overlap, NaN and out-of-range input', () => {
  const source = dataFixture();
  source.drawables[0].multiplyColors = new Float32Array([1, 1, 1, 1, 0.5, 0.5, 0.5, 1]);
  source.drawables[0].screenColors = new Float32Array([0, 0, 0, 0, 0.25, 0.25, 0.25, 0]);
  const encoded = encodeDeformableMesh2DData(source);
  const short = rewriteHydmMetadata(encoded, metadata => { metadata.drawables[0].multiplyColors[1]--; });
  assert.throws(() => decodeDeformableMesh2DData(short), /four values per frame/u);
  const overlap = rewriteHydmMetadata(encoded, metadata => { metadata.drawables[0].screenColors = [...metadata.drawables[0].multiplyColors]; });
  assert.throws(() => decodeDeformableMesh2DData(overlap), /overlap/u);
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], multiplyColors: new Float32Array([1, 1, 1]) }] }), /four Float32 values per frame/u);
  const nan = source.drawables[0].multiplyColors.slice(); nan[4] = Number.NaN;
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], multiplyColors: nan }] }), /finite/u);
  const high = source.drawables[0].screenColors.slice(); high[4] = 1.01;
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], screenColors: high }] }), /inside \[0, 1\]/u);
});

test('HYDM encoder rejects invalid indices, opacity and order before serialization', () => {
  const source = dataFixture();
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], indices: new Uint32Array([0, 1, 4]) }] }), /missing vertex/);
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], opacities: new Float32Array([1, 2]) }] }), /Opacity/);
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], renderOrders: new Float32Array([0, 0.5]) }] }), /safe integer/);
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], textureIndex: 32 }] }), /Texture index exceeds/);
});

test('HYDM preserves repeated mask contributions and rejects cyclic, overlapping and unreferenced data', () => {
  const source = twoDrawableDataFixture();
  const repeated = encodeDeformableMesh2DData({
    ...source,
    drawables: source.drawables.map(drawable => ({ ...drawable, masks: drawable.id === 'front' ? ['back', 'back'] : [] })),
  });
  assert.deepEqual([...decodeDeformableMesh2DData(repeated).drawables.find(drawable => drawable.id === 'front').masks], ['back', 'back']);
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

test('Cubism capture preserves shared multi-source mask groups and applies inversion to the combined group', () => {
  const capture = multiMaskCaptureFixture();
  const converted = convertCubismCaptureToHya(capture, { strict: true });
  const data = decodeDeformableMesh2DData(converted.data);
  assert.equal(converted.report.maskReferenceCount, 4);
  assert.equal(converted.report.invertedMaskDrawableCount, 1);
  assert.deepEqual([...data.drawables[2].masks], ['drawable-0000', 'drawable-0001']);
  assert.deepEqual([...data.drawables[3].masks], ['drawable-0001', 'drawable-0000']);
  assert.equal(data.drawables[2].maskMode, 'alpha');
  assert.equal(data.drawables[3].maskMode, 'alpha-inverted');
});

test('Cubism capture preserves repeated mask contributions and classifies invalid mask graphs before HYDM encoding', () => {
  const repeated = multiMaskCaptureFixture();
  for (const frame of repeated.frames) frame.drawables[2].masks = ['mask-a', 'mask-a'];
  const repeatedResult = convertCubismCaptureToHya(repeated, { strict: true });
  assert.equal(repeatedResult.report.maskReferenceCount, 4);
  assert.deepEqual([...decodeDeformableMesh2DData(repeatedResult.data).drawables[2].masks], ['drawable-0000', 'drawable-0000']);

  const cyclic = multiMaskCaptureFixture();
  for (const frame of cyclic.frames) frame.drawables[0].masks = ['masked-alpha'];
  assert.throws(() => convertCubismCaptureToHya(cyclic), error => error instanceof CubismCaptureConversionError
    && error.diagnostics.some(item => item.code === 'E_CUBISM_CAPTURE_INVALID'
      && item.message.includes('cycle')
      && item.path.includes('frames[0]')));

  const meaninglessInversion = captureFixture();
  for (const frame of meaninglessInversion.frames) frame.drawables[0].invertedMask = true;
  assert.throws(() => convertCubismCaptureToHya(meaninglessInversion), error => error instanceof CubismCaptureConversionError
    && error.diagnostics.some(item => item.path === '$.frames[0].drawables[0].invertedMask'));
});

test('Cubism capture tolerates bounded Core opacity overshoot and clamps the encoded track', () => {
  const capture = captureFixture();
  // Rice's official extended-interpolation sample exposes this exact upper
  // overshoot through Cubism Core at its initial pose.
  capture.frames[0].drawables[0].opacity = 1.0000499486923218;
  capture.frames[1].drawables[0].opacity = -0.0000499486923218;
  const converted = convertCubismCaptureToHya(capture, { strict: true });
  const data = decodeDeformableMesh2DData(converted.data);
  assert.deepEqual([...data.drawables[0].opacities], [1, 0]);

  capture.frames[0].drawables[0].opacity = 1.001;
  assert.throws(() => convertCubismCaptureToHya(capture), error => error instanceof CubismCaptureConversionError
    && error.diagnostics.some(item => item.code === 'E_CUBISM_CAPTURE_INVALID' && item.path === '$.frames[0].drawables[0].opacity'));
});

test('Cubism capture preserves dynamic multiply/screen RGBA in strict mode with separate feature attribution', () => {
  const capture = captureFixture();
  capture.capabilities = { drawableColors: 'captured' };
  capture.frames[0].drawables[0].multiplyColor = [1, 0.75, 0.5, 0.25];
  capture.frames[1].drawables[0].screenColor = [0.1, 0.2, 0.3, 0.4];
  const converted = convertCubismCaptureToHya(capture, { strict: true });
  assert.equal(converted.diagnostics.length, 0);
  assert.equal(converted.report.multiplyColorDrawableCount, 1);
  assert.equal(converted.report.screenColorDrawableCount, 1);
  assert.equal(converted.report.multiplyColorDrawableFrameCount, 1);
  assert.equal(converted.report.screenColorDrawableFrameCount, 1);
  assert.equal(converted.report.unsupportedRuntimeFeatures.includes('multiply-screen-color'), false);
  const data = decodeDeformableMesh2DData(converted.data);
  assert.equal(new DataView(converted.data).getUint16(6, true), 2);
  assertFloatArrayClose(data.drawables[0].multiplyColors, [1, 0.75, 0.5, 0.25, 1, 1, 1, 1]);
  assertFloatArrayClose(data.drawables[0].screenColors, [0, 0, 0, 0, 0.1, 0.2, 0.3, 0.4]);

  const alphaOnly = captureFixture();
  alphaOnly.capabilities = { drawableColors: 'captured' };
  alphaOnly.frames[1].drawables[0].multiplyColor = [1, 1, 1, 0.25];
  alphaOnly.frames[1].drawables[0].screenColor = [0, 0, 0, 0.75];
  const alphaOnlyResult = convertCubismCaptureToHya(alphaOnly, { strict: true });
  assert.equal(alphaOnlyResult.report.multiplyColorDrawableCount, 0, 'Cubism color feature attribution is RGB-only.');
  assert.equal(alphaOnlyResult.report.screenColorDrawableCount, 0, 'Cubism color feature attribution is RGB-only.');
  assert.equal(new DataView(alphaOnlyResult.data).getUint16(6, true), 2, 'Non-default alpha must still round-trip.');
  const alphaOnlyData = decodeDeformableMesh2DData(alphaOnlyResult.data);
  assert.equal(alphaOnlyData.drawables[0].multiplyColors[7], 0.25);
  assert.equal(alphaOnlyData.drawables[0].screenColors[7], 0.75);
});

test('Cubism drawable color capability classifies unavailable and invalid capture paths', () => {
  const unavailable = captureFixture();
  unavailable.capabilities = { drawableColors: 'unavailable' };
  const normal = convertCubismCaptureToHya(unavailable);
  assert.equal(normal.diagnostics[0].code, 'W_CUBISM_DRAWABLE_COLOR_UNAVAILABLE');
  assert.throws(() => convertCubismCaptureToHya(unavailable, { strict: true }), error => error instanceof CubismCaptureConversionError
    && error.diagnostics.some(item => item.code === 'W_CUBISM_DRAWABLE_COLOR_UNAVAILABLE' && item.path === '$.capabilities.drawableColors'));

  const missing = captureFixture();
  missing.capabilities = { drawableColors: 'captured' };
  delete missing.frames[1].drawables[0].screenColor;
  assert.throws(() => convertCubismCaptureToHya(missing), error => error instanceof CubismCaptureConversionError
    && error.diagnostics.some(item => item.code === 'E_CUBISM_DRAWABLE_COLOR_INVALID' && item.path === '$.frames[1].drawables[0].screenColor'));

  const invalid = captureFixture();
  invalid.frames[0].drawables[0].multiplyColor = [1.001, 1, 1, 1];
  assert.throws(() => convertCubismCaptureToHya(invalid), error => error instanceof CubismCaptureConversionError
    && error.diagnostics.some(item => item.code === 'E_CUBISM_DRAWABLE_COLOR_INVALID' && item.path === '$.frames[0].drawables[0].multiplyColor'));
});

test('official Core capture page records drawable color arrays and capability availability', async () => {
  const source = await readFile(new URL('../live2d/tools/capture-page.mjs', import.meta.url), 'utf8');
  assert.match(source, /drawables\.multiplyColors/u);
  assert.match(source, /drawables\.screenColors/u);
  assert.match(source, /drawableColors:.*captured.*unavailable/u);
  assert.match(source, /CubismExpressionMotion/u);
  assert.match(source, /CubismPhysics/u);
  assert.match(source, /CubismPose/u);
  assert.match(source, /motionQueue\?\.doUpdateMotion\(model, time\)[\s\S]*expressionQueue\?\.doUpdateMotion\(model, time\)[\s\S]*applyConstantInputs[\s\S]*physics\?\.evaluate[\s\S]*pose\?\.updateParameters[\s\S]*model\.update\(\)/u);
  assert.match(source, /recipeAssets[\s\S]*sha256/u);
});

test('Cubism dynamic visibility suppresses only the baked main-pass opacity', () => {
  const capture = captureFixture();
  capture.frames[0].drawables[0].visible = false;
  capture.frames[1].drawables[0].visible = true;
  capture.frames[1].drawables[0].opacity = 0.5;
  const converted = convertCubismCaptureToHya(capture, { strict: true });
  assert.deepEqual([...decodeDeformableMesh2DData(converted.data).drawables[0].opacities], [0, 0.5]);

  capture.frames[0].drawables[0].visible = 'yes';
  assert.throws(() => convertCubismCaptureToHya(capture), error => error instanceof CubismCaptureConversionError
    && error.diagnostics.some(item => item.path === '$.frames[0].drawables[0].visible'));
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
  assert.equal(converted.report.additiveDrawableCount, 1);
  assert.equal(converted.report.multiplicativeDrawableCount, 0);

  const multiplicative = captureFixture();
  multiplicative.frames[0].drawables[0].blendMode = 'multiplicative';
  multiplicative.frames[1].drawables[0].blendMode = 'multiplicative';
  const multiplied = convertCubismCaptureToHya(multiplicative, { strict: true });
  assert.equal(decodeDeformableMesh2DData(multiplied.data).drawables[0].blendMode, 'multiplicative');
  assert.equal(multiplied.report.additiveDrawableCount, 0);
  assert.equal(multiplied.report.multiplicativeDrawableCount, 1);

  const unknown = captureFixture();
  unknown.frames[0].drawables[0].blendMode = 'overlay';
  unknown.frames[1].drawables[0].blendMode = 'overlay';
  assert.throws(() => convertCubismCaptureToHya(unknown), error => error instanceof CubismCaptureConversionError
    && error.diagnostics.some(item => item.code === 'E_CUBISM_CAPTURE_INVALID'
      && item.path === '$.frames[0].drawables[0].blendMode'));

  const culled = captureFixture();
  culled.frames[0].drawables[0].culling = true;
  culled.frames[1].drawables[0].culling = true;
  const culledResult = convertCubismCaptureToHya(culled, { strict: true });
  assert.equal(decodeDeformableMesh2DData(culledResult.data).drawables[0].culling, true);
  assert.equal(culledResult.report.unsupportedRuntimeFeatures.includes('culling'), false);
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
  const changedCulling = captureFixture();
  changedCulling.frames[1].drawables[0].culling = true;
  assert.throws(() => convertCubismCaptureToHya(changedCulling), error => error instanceof CubismCaptureConversionError
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

function assertFloatArrayClose(actual, expected, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) assert.ok(Math.abs(actual[index] - expected[index]) <= tolerance, `index ${index}: ${actual[index]} != ${expected[index]}`);
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

function multiMaskCaptureFixture() {
  const drawable = (id, renderOrder, masks = [], invertedMask = false, offset = 0) => ({
    id,
    textureIndex: 0,
    renderOrder,
    opacity: 1,
    blendMode: 'normal',
    culling: false,
    masks,
    invertedMask,
    positions: [offset, 0, 10 + offset, 0, offset, 10],
    uvs: [0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    multiplyColor: [1, 1, 1, 1],
    screenColor: [0, 0, 0, 0],
  });
  const frame = time => ({ time, drawables: [
    drawable('mask-a', 0, [], false, time),
    drawable('mask-b', 1, [], false, 4 + time),
    drawable('masked-alpha', 2, ['mask-a', 'mask-b'], false, time),
    drawable('masked-inverted', 3, ['mask-b', 'mask-a'], true, time),
  ] });
  return {
    format: 'live2d-cubism-drawable-capture',
    version: 1,
    canvas: { width: 256, height: 256, pixelsPerUnit: 1, coordinateSystem: 'model-y-up' },
    duration: 1,
    frameRate: 1,
    textures: [{ id: 'texture', uri: 'texture.png' }],
    frames: [frame(0), frame(1)],
  };
}
