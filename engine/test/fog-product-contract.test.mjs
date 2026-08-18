import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Fog } from '../dist/lighting.js';
import { writeSceneFrameUniforms } from '../dist/experimental.js';

const identity = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function camera(position) {
  return {
    viewProjectionMatrix: identity,
    viewMatrix: identity,
    inverseViewProjectionMatrix: identity,
    position,
    width: 1,
    height: 1,
  };
}

test('disabled Fog writes the exact no-Fog SceneFrame uniform representation', () => {
  const disabled = new Fog({ mode: 'height', maxOpacity: 1, density: 0.2 });
  disabled.disabled = true;
  const withoutFog = writeSceneFrameUniforms(new Float32Array(68), camera([2, 3, 4]), null);
  const withDisabledFog = writeSceneFrameUniforms(new Float32Array(68), camera([2, 3, 4]), disabled);

  assert.deepEqual(withDisabledFog, withoutFog);
});

test('maxOpacity zero remains an enabled Fog whose shader contribution is clamped to zero', () => {
  const fog = new Fog({ mode: 'distance', maxOpacity: 0, distanceStart: 1, distanceEnd: 10 });
  const uniforms = writeSceneFrameUniforms(new Float32Array(68), camera([0, 0, 0]), fog);
  const fogSource = shaderSource('generated/material-lighting-fog.generated.wgsl');

  assert.equal(uniforms[60], 1);
  assert.equal(uniforms[63], 0);
  assert.match(fogSource, /return min\(clamp\(amount, 0\.0, 1\.0\), clamp\(fog\.distanceParams\.w, 0\.0, 1\.0\)\);/);
});

test('Basic, PBR, Blinn and Instanced Fog paths preserve material alpha', () => {
  const contracts = [
    ['generated/deformation-forward.generated.wgsl', /vec4<f32>\(applyFog\([^;]+\), outColor\.a\)/],
    ['generated/deformation-forward-skinned.generated.wgsl', /vec4<f32>\(applyFog\([^;]+\), outColor\.a\)/],
    ['generated/material-lighting-pbr.generated.wgsl', /vec4<f32>\(applyFog\([^;]+\), base\.a\)/],
    ['generated/material-lighting-blinn-phong.generated.wgsl', /vec4<f32>\(applyFog\([^;]+\), material\.diffuse\.a\)/],
    ['generated/specialized-instanced-mesh3d.generated.wgsl', /vec4<f32>\(applyFog\([^;]+\), in\.color\.a\)/],
  ];

  for (const [file, pattern] of contracts) {
    const source = shaderSource(file);
    assert.match(source, pattern, `${file} must apply Fog to RGB without replacing alpha`);
  }
});

function shaderSource(file) {
  return readFileSync(new URL(`../src/shaders/${file}`, import.meta.url), 'utf8');
}
