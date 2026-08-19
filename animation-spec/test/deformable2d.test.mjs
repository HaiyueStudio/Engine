import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { encodeAnimationBinary, parseAnimation } from '../dist/index.js';
import { convertCubismCaptureToHya, CubismCaptureConversionError, sampleCubismMotion3 } from '../dist/live2d.js';
import { createDeformableMesh2DFormatRegistry, decodeDeformableMesh2DData, encodeDeformableMesh2DData } from '../dist/deformable2d.js';

const CONTRACT = JSON.parse(await readFile(new URL('../schema/deformable-mesh-2d.contract.json', import.meta.url), 'utf8'));
const SCHEMA = JSON.parse(await readFile(new URL('../schema/deformable-mesh-2d-extension.schema.json', import.meta.url), 'utf8'));

test('deformable 2D machine-readable contract freezes the required extension and Web delivery boundary', () => {
  assert.equal(CONTRACT.extension.id, 'org.haiyue.deformable-mesh-2d@1');
  assert.equal(CONTRACT.extension.binaryMagic, 'HYDM');
  assert.equal(CONTRACT.profile.id, 'clip-baked');
  assert.equal(CONTRACT.runtime.sourceRuntimeDependency, false);
  assert.deepEqual(CONTRACT.runtime.supportedBlendModes, ['normal']);
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
  assert.throws(() => decodeDeformableMesh2DData(unknownVersion), /Unsupported sidecar version 2.0/);
  assert.throws(() => decodeDeformableMesh2DData(first.slice(0, 40)), /outside the buffer|unaccounted bytes/);
});

test('HYDM encoder rejects invalid indices, opacity and order before serialization', () => {
  const source = dataFixture();
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], indices: new Uint32Array([0, 1, 4]) }] }), /missing vertex/);
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], opacities: new Float32Array([1, 2]) }] }), /Opacity/);
  assert.throws(() => encodeDeformableMesh2DData({ ...source, drawables: [{ ...source.drawables[0], renderOrders: new Float32Array([0, 0.5]) }] }), /safe integer/);
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
});

test('strict conversion rejects approximations and topology changes have a stable diagnostic', () => {
  const warning = captureFixture();
  warning.frames[0].drawables[0].blendMode = 'additive';
  warning.frames[1].drawables[0].blendMode = 'additive';
  assert.throws(() => convertCubismCaptureToHya(warning, { strict: true }), error => error instanceof CubismCaptureConversionError && error.diagnostics[0].code === 'W_CUBISM_BLEND_APPROXIMATED');
  const changed = captureFixture();
  changed.frames[1].drawables[0].uvs[0] = 0.5;
  assert.throws(() => convertCubismCaptureToHya(changed), error => error instanceof CubismCaptureConversionError && error.diagnostics.some(item => item.code === 'E_CUBISM_TOPOLOGY_CHANGED'));
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
