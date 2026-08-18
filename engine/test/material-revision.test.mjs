import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  BasicMaterial,
  BlinnPhongMaterial,
  CssMaterial,
  DepthMaterial,
  InstancedMaterial,
  InstancedPbrMaterial,
  LineMaterial,
  Material2D,
  NormalMaterial,
  PbrMaterial,
  RadialShadowMaterial,
  ToonMaterial,
  VolumeMaterial,
  createMaterialFromDescriptor,
} from '../dist/material.js';

test('MaterialDescriptor is the importer-neutral PBR construction boundary', () => {
  const descriptor = {
    shadingModel: 'pbr-metallic-roughness',
    state: { metallic: 0.35, roughness: 0.6, clearcoatFactor: 0.2 },
    variants: [{ name: 'polished', state: { metallic: 0.8, roughness: 0.1 } }],
  };
  const material = createMaterialFromDescriptor(descriptor);

  assert.ok(material instanceof PbrMaterial);
  assert.equal(material.metallic, 0.35);
  assert.equal(material.roughness, 0.6);
  assert.deepEqual(material.variantNames, ['polished']);
  material.setVariant('polished');
  assert.equal(material.metallic, 0.8);
  assert.equal(material.roughness, 0.1);
  assert.throws(
    () => createMaterialFromDescriptor({ shadingModel: 'unlit', state: {} }),
    /Unsupported material descriptor shading model/,
  );
});

test('ToonMaterial exposes one to four ordered independent texture layers', () => {
  const shadowTexture = { texture: { createView() {} }, version: 1 };
  const material = createMaterialFromDescriptor({
    shadingModel: 'toon',
    state: {
      baseColor: [0.8, 0.9, 1, 1],
      bandSoftness: 0.03,
      layers: [
        { minLight: 0, color: [0.25, 0.3, 0.45, 1], texture: shadowTexture, textureMapping: { texCoord: 1, scale: [2, 2] } },
        { minLight: 0.5, color: [0.7, 0.75, 0.85, 1] },
        { minLight: 0.8, color: [1, 1, 1, 1], sampler: { magFilter: 'nearest' } },
      ],
    },
  });

  assert.ok(material instanceof ToonMaterial);
  assert.equal(material.layers.length, 3);
  assert.equal(material.layers[0].texture, shadowTexture);
  assert.equal(material.layers[0].textureMapping.texCoord, 1);
  assert.deepEqual(material.layers[0].textureMapping.scale, [2, 2]);
  assert.equal(material.getShaderContract().shadingModel, 'toon');
  assert.ok(material.getShaderContract().features.includes('four-independent-layer-textures'));

  material.setLayer(1, { minLight: 0.4, color: [0.6, 0.65, 0.8, 1] });
  assert.equal(material.revision, 1);
  assert.equal(material.layers[1].minLight, 0.4);
  const clone = material.clone();
  assert.notEqual(clone, material);
  assert.equal(clone.layers.length, 3);
  assert.equal(clone.layers[0].texture, shadowTexture);

  assert.throws(() => new ToonMaterial({ layers: [] }), /between 1 and 4/);
  assert.throws(() => new ToonMaterial({ layers: Array.from({ length: 5 }, (_, index) => ({ minLight: index / 5 })) }), /between 1 and 4/);
  assert.throws(() => new ToonMaterial({ layers: [{ minLight: 0.1 }] }), /must be 0/);
  assert.throws(() => new ToonMaterial({ layers: [{ minLight: 0 }, { minLight: 0.5 }, { minLight: 0.5 }] }), /strictly increasing/);
});

test('Toon shader keeps four independent bindings and explicit texture gradients', async () => {
  const [shader, renderer] = await Promise.all([
    readFile(new URL('../src/shaders/generated/material-lighting-toon.generated.wgsl', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/ToonRenderer.ts', import.meta.url), 'utf8'),
  ]);
  assert.equal((shader.match(/var layerTexture\d/g) ?? []).length, 4);
  assert.equal((shader.match(/var layerSampler\d/g) ?? []).length, 4);
  assert.doesNotMatch(shader, /texture_2d_array/);
  assert.match(shader, /textureSampleGrad/);
  assert.match(shader, /shadowVisibility/);
  assert.match(shader, /shadowVisibility\(0u,\s*in\.worldPos,\s*N,\s*L\)/);
  assert.doesNotMatch(shader, /shadow\.lightViewProj/);
  assert.match(renderer, /getBuiltinMaterialLightingShader\(device, 'toon'/);
  assert.match(renderer, /dimension:\s*'2d-array'/);
  assert.match(renderer, /viewDimension:\s*'2d-array'/);
  assert.match(renderer, /shadow\?\.arrayView\s*\?\?/);
  assert.match(renderer, /\(shadow\.layer\s*\?\?\s*0\)\s*\+\s*1/);
});

test('material setters validate values and increment revision only for effective changes', () => {
  const material = new BasicMaterial();
  assert.equal(material.revision, 0);

  material.blending = 'none';
  assert.equal(material.revision, 0);
  material.blending = 'normal';
  assert.equal(material.revision, 1);
  material.color = [1, 1, 1, 1];
  assert.equal(material.revision, 1);
  material.depthWrite = false;
  assert.equal(material.revision, 2);
  material.emissiveFactor = [2, 1, 0.5];
  assert.equal(material.revision, 3);
  assert.equal(Object.isFrozen(material.emissiveFactor), true);

  assert.throws(() => { material.blending = 'screen'; }, /BasicMaterial\.blending/);
  assert.throws(() => { material.emissiveFactor = [1, Number.NaN, 1]; }, /must be finite/);
  assert.throws(() => { material.sampler = { magFilter: 'cubic' }; }, /BasicMaterial\.sampler\.magFilter/);
  assert.equal(material.revision, 3);

  const descriptor = { lodMinClamp: 1 };
  material.sampler = descriptor;
  assert.equal(material.revision, 4);
  descriptor.lodMinClamp = 4;
  assert.equal(material.sampler.lodMinClamp, 1);
  assert.equal(Object.isFrozen(material.sampler), true);

  material.color.a = 0.5;
  assert.equal(material.revision, 4);
  assert.equal(material.markDirty(), material);
  assert.equal(material.revision, 5);
});

test('PBR applyState and variants are atomic revision changes', () => {
  const material = new PbrMaterial({
    variants: [{ name: 'coated', state: { metallic: 0.8, roughness: 0.1, clearcoatFactor: 1 } }],
  });
  assert.equal(material.revision, 0);
  assert.equal(material.variantNames, material.variantNames, 'variant name snapshots are stable and allocation-free');

  material.applyState({ metallic: 0.25, roughness: 0.4, clearcoatFactor: 0.6 });
  assert.equal(material.revision, 1);
  assert.equal(material.metallic, 0.25);
  assert.equal(material.roughness, 0.4);

  material.applyState({ metallic: 0.25, roughness: 0.4, clearcoatFactor: 0.6 });
  assert.equal(material.revision, 1);
  material.metallic = 2;
  assert.equal(material.metallic, 1);
  assert.equal(material.revision, 2);
  material.metallic = 4;
  assert.equal(material.revision, 2);

  material.setVariant('coated');
  assert.equal(material.revision, 3);
  assert.equal(material.activeVariant, 'coated');
  material.setVariant('coated');
  assert.equal(material.revision, 3);
  assert.throws(() => { material.normalScale = Number.POSITIVE_INFINITY; }, /must be finite/);
  assert.equal(material.revision, 3);
  assert.throws(() => material.setTextureMapping('invalid-slot'), /PBR texture slot/);

  material.roughness = 0.9;
  assert.equal(material.revision, 4);
  material.setVariant('coated');
  assert.equal(material.roughness, 0.1);
  assert.equal(material.revision, 5);

  material.baseColor.a = 0.25;
  material.markDirty();
  assert.equal(material.revision, 6);
  material.setVariant('coated');
  assert.equal(material.baseColor.a, 1, 'cached variants restore explicitly dirtied nested color state');
  assert.equal(material.revision, 7);
});

test('all built-in material families participate in the shared revision contract', () => {
  const cases = [
    [new BlinnPhongMaterial(), material => { material.shininess = 16; }],
    [new DepthMaterial(), material => { material.far = 200; }],
    [new NormalMaterial(), material => { material.space = 'world'; }],
    [new LineMaterial(), material => { material.width = 2; }],
    [new Material2D(), material => { material.blending = 'additive'; }],
    [new RadialShadowMaterial(), material => { material.opacity = 0.5; }],
    [new ToonMaterial(), material => { material.bandSoftness = 0.05; }],
    [new VolumeMaterial(), material => { material.steps = 64; }],
    [new InstancedMaterial(1), material => { material.setColor(0, 1, 0, 0); }],
    [new InstancedPbrMaterial(1), material => { material.roughness = 0.35; }],
  ];

  for (const [material, mutate] of cases) {
    assert.equal(material.revision, 0, material.type);
    mutate(material);
    assert.equal(material.revision, 1, material.type);
  }

  const css = new CssMaterial();
  assert.equal(css.revision, 0);
  css.text = 'revision';
  assert.equal(css.revision, 1);
  css.style = { width: 320, padding: [8, 12] };
  assert.equal(css.revision, 2);
  assert.equal(Object.isFrozen(css.style), true);
  assert.equal(Object.isFrozen(css.style.padding), true);
  assert.throws(() => { css.style = { width: Number.NaN }; }, /style\.width must be finite/);
  assert.equal(css.revision, 2);
  assert.throws(() => { new DepthMaterial({ near: 10, far: 1 }); }, /far must be greater than near/);
  assert.throws(() => { new VolumeMaterial({ steps: 2.5 }); }, /must be an integer/);
});

test('InstancedPbrMaterial exposes validated metallic-roughness and alpha state', () => {
  const material = new InstancedPbrMaterial(4, { metallic: 0.15, roughness: 0.64, alphaMode: 'blend' });
  assert.equal(material.type, 'instanced-pbr');
  assert.equal(material.getShaderContract().shadingModel, 'metallic-roughness');
  assert.equal(material.metallic, 0.15);
  assert.equal(material.roughness, 0.64);
  assert.equal(material.alphaMode, 'blend');
  material.metallic = 2;
  assert.equal(material.metallic, 1);
  material.alphaMode = 'opaque';
  assert.equal(material.alphaMode, 'opaque');
  assert.throws(() => { material.roughness = Number.NaN; }, /must be finite/);
  assert.throws(() => { material.alphaMode = 'mask'; }, /must be one of/);
});
