import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ColorHSL,
  ColorLinear,
  resolveColor,
  toColorSRGB,
  writeColorLinear,
  writeColorSRGB,
} from '../dist/color.js';
import { BitmapText, MeshHelper } from '../dist/components.js';
import { AmbientLight, Fog, PointLight } from '../dist/lighting.js';
import {
  BlinnPhongMaterial,
  LineMaterial,
  RadialShadowMaterial,
  VolumeMaterial,
} from '../dist/material.js';
import {
  BasicMaterial,
  ColorSRGB,
  DirectionalLight,
  EnvironmentLight,
  Material2D,
  PbrMaterial,
} from '../dist/index.js';
import { OutlinePass } from '../dist/experimental.js';

const EPSILON = 1e-6;

function assertChannels(actual, expected, message) {
  let channels;
  if (typeof actual?.writeSRGB === 'function') {
    const data = new Float32Array(4);
    actual.writeSRGB(data);
    channels = [...data];
  } else {
    channels = Array.isArray(actual) || ArrayBuffer.isView(actual)
      ? [actual[0], actual[1], actual[2], actual[3] ?? 1]
      : [actual.r, actual.g, actual.b, actual.a];
  }
  expected.forEach((value, index) => {
    assert.ok(
      Math.abs(channels[index] - value) <= EPSILON,
      `${message}: channel ${index} expected ${value}, received ${channels[index]}`,
    );
  });
}

test('ColorLike normalizes every public representation to an owned ColorSRGB', () => {
  const srgb = new ColorSRGB(0.1, 0.2, 0.3, 0.4);
  const cloned = toColorSRGB(srgb);
  assert.ok(cloned instanceof ColorSRGB);
  assert.notEqual(cloned, srgb);
  assertChannels(cloned, [0.1, 0.2, 0.3, 0.4], 'ColorSRGB');

  assertChannels(toColorSRGB(new ColorHSL(120, 1, 0.5, 0.25)), [0, 1, 0, 0.25], 'ColorHSL');
  assertChannels(
    toColorSRGB(new ColorLinear(0.25, 0.5, 0.75, 0.6)),
    [
      ColorSRGB.linearToSRGB(0.25),
      ColorSRGB.linearToSRGB(0.5),
      ColorSRGB.linearToSRGB(0.75),
      0.6,
    ],
    'ColorLinear',
  );
  assertChannels(toColorSRGB([0.2, 0.3, 0.4]), [0.2, 0.3, 0.4, 1], 'tuple');
  assertChannels(toColorSRGB({ r: 0.3, g: 0.4, b: 0.5, a: 0.7 }), [0.3, 0.4, 0.5, 0.7], 'channels');

  const crossRuntimeColor = {
    toSRGB() { return { r: 0.4, g: 0.5, b: 0.6, a: 0.8 }; },
  };
  const normalized = toColorSRGB(crossRuntimeColor);
  assert.ok(normalized instanceof ColorSRGB);
  assertChannels(normalized, [0.4, 0.5, 0.6, 0.8], 'cross-runtime convertible');
});

test('ColorLike GPU writers preserve offsets and explicit color-space semantics', () => {
  const srgbOut = new Float32Array(8).fill(-1);
  assert.equal(writeColorSRGB(new ColorHSL(240, 1, 0.5, 0.4), srgbOut, 2), srgbOut);
  assertChannels(srgbOut.subarray(2, 6), [0, 0, 1, 0.4], 'sRGB writer');
  assert.equal(srgbOut[1], -1);
  assert.equal(srgbOut[6], -1);

  const linearOut = new Float32Array(6).fill(-1);
  const linear = new ColorLinear(0.125, 0.25, 0.5, 0.75);
  assert.equal(writeColorLinear(linear, linearOut, 1), linearOut);
  assertChannels(linearOut.subarray(1, 5), [0.125, 0.25, 0.5, 0.75], 'linear writer');

  const roundTrip = new Float32Array(4);
  writeColorLinear(toColorSRGB(linear), roundTrip);
  assertChannels(roundTrip, [0.125, 0.25, 0.5, 0.75], 'linear round trip');
});

test('resolveColor preserves the input color model while owning a clone', () => {
  const hsl = new ColorHSL(210, 0.6, 0.4, 0.7);
  const resolved = resolveColor(hsl);
  assert.ok(resolved instanceof ColorHSL);
  assert.notEqual(resolved, hsl);
  assert.equal(resolved.h, 210);
  assert.equal(resolved.s, 0.6);
  assert.equal(resolved.l, 0.4);
  assert.equal(resolved.a, 0.7);

  const tuple = resolveColor([0.1, 0.2, 0.3, 0.4]);
  assert.ok(tuple instanceof ColorSRGB);
  assertChannels(tuple, [0.1, 0.2, 0.3, 0.4], 'tuple fallback model');
});

test('render-facing color APIs accept and preserve HSL objects', () => {
  const green = new ColorHSL(120, 1, 0.5, 0.35);
  const font = { size: 16 };
  const cases = [
    ['BasicMaterial.color', new BasicMaterial({ color: green }).color, [0, 1, 0, 0.35]],
    ['Material2D.color', new Material2D({ color: green }).color, [0, 1, 0, 0.35]],
    ['LineMaterial.color', new LineMaterial({ color: green }).color, [0, 1, 0, 0.35]],
    ['VolumeMaterial.color', new VolumeMaterial({ color: green }).color, [0, 1, 0, 0.35]],
    ['PbrMaterial.baseColor', new PbrMaterial({ baseColor: green }).baseColor, [0, 1, 0, 0.35]],
    ['BlinnPhongMaterial.diffuse', new BlinnPhongMaterial({ diffuse: green }).diffuse, [0, 1, 0, 0.35]],
    ['AmbientLight.color', new AmbientLight({ color: green }).color, [0, 1, 0, 0.35]],
    ['DirectionalLight.color', new DirectionalLight({ color: green }).color, [0, 1, 0, 0.35]],
    ['PointLight.color', new PointLight({ color: green }).color, [0, 1, 0, 0.35]],
    ['EnvironmentLight.diffuseColor', new EnvironmentLight({ diffuseColor: green }).diffuseColor, [0, 1, 0, 0.35]],
    ['Fog.color', new Fog({ color: green }).color, [0, 1, 0, 0.35]],
    ['MeshHelper.color', new MeshHelper({ color: green }).color, [0, 1, 0, 0.35]],
    ['BitmapText.color', new BitmapText(font, 'color', { color: green }).color, [0, 1, 0, 0.35]],
    ['RadialShadowMaterial.color', new RadialShadowMaterial({ color: green }).color, [0, 1, 0, 0.35]],
    ['OutlinePass.visibleEdgeColor', new OutlinePass({ visibleEdgeColor: green }).visibleEdgeColor, [0, 1, 0, 0.35]],
  ];

  for (const [label, color, expected] of cases) {
    assert.ok(color instanceof ColorHSL, `${label} should preserve ColorHSL`);
    assertChannels(color, expected, label);
  }

  green.set(0, 0, 0, 1);
  for (const [label, color, expected] of cases) {
    assertChannels(color, expected, `${label} owns its normalized value`);
  }
});

test('color property setters accept alternate spaces after construction', () => {
  const material = new BasicMaterial();
  material.color = new ColorLinear(0.25, 0.5, 0.75, 0.8);
  const linearOut = new Float32Array(4);
  writeColorLinear(material.color, linearOut);
  assertChannels(linearOut, [0.25, 0.5, 0.75, 0.8], 'material setter');

  const text = new BitmapText({ size: 12 }, 'dirty');
  text.clearDirty();
  text.color = new ColorHSL(0, 1, 0.5);
  assert.equal(text.dirty, true);

  const outline = new OutlinePass();
  outline.hiddenEdgeColor = new ColorHSL(60, 1, 0.5);
  assertChannels(outline.hiddenEdgeColor, [1, 1, 0, 1], 'outline setter');
});

test('generic color edits preserve the model and refresh both GPU representations', () => {
  const color = new ColorHSL(0, 1, 0.5, 0.75);
  const initialVersion = color.version;
  color.setFromSRGB(0, 1, 0, 0.5);
  assert.ok(color instanceof ColorHSL);
  assert.ok(Math.abs(color.h - 120) <= EPSILON);
  assert.equal(color.a, 0.5);
  assert.ok(color.version > initialVersion);

  const srgb = new Float32Array(4);
  const linear = new Float32Array(4);
  color.writeSRGB(srgb);
  color.writeLinear(linear);
  assertChannels(srgb, [0, 1, 0, 0.5], 'updated sRGB GPU data');
  assertChannels(linear, [0, 1, 0, 0.5], 'updated linear GPU data');
});
