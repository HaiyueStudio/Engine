import assert from 'node:assert/strict';
import test from 'node:test';
import { importEngineSource } from './helpers/internal-source.mjs';

const { Render3DForwardOcclusion, registerForwardOcclusionRenderer } =
  await importEngineSource('systems/Render3DForwardOcclusion.ts');
const { MaterialRendererRegistry } = await importEngineSource('renderer/MaterialRendererRegistry.ts');
const { BasicMaterial } = await importEngineSource('material/BasicMaterial.ts');
const { PbrMaterial } = await importEngineSource('material/PbrMaterial.ts');
const { VolumeMaterial } = await importEngineSource('material/VolumeMaterial.ts');
const { Geometry3D } = await importEngineSource('geometry/Geometry3D.ts');

const identity = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
const view = { width: 128, height: 128 };
const solid = new BasicMaterial();
const blended = new BasicMaterial({ blending: 'normal', depthWrite: false });
const solidTriangle = [-0.8, -0.8, 0, 0.8, -0.8, 0, 0, 0.8, 0];
const centerTriangle = [-0.2, -0.2, 0, 0.2, -0.2, 0, 0, 0.2, 0];

function draw(positions, depth, material = solid, geometryOptions = {}) {
  const worldMatrix = identity.slice();
  worldMatrix[14] = depth;
  return {
    geometry: new Geometry3D({ positions: Float32Array.from(positions), ...geometryOptions }),
    material, worldMatrix, clippingPlanes: null,
  };
}

function create() {
  const registry = new MaterialRendererRegistry();
  registerForwardOcclusionRenderer(registry, { materialType: BasicMaterial, renderItem() {} });
  return { registry, culling: new Render3DForwardOcclusion() };
}

test('forward occlusion retains the original order, ties and partially visible items', () => {
  const { culling, registry } = create();
  const occluder = draw(solidTriangle, 0.2);
  const near = draw([-0.55, -0.4, 0, -0.3, -0.4, 0, -0.425, -0.15, 0], 0.1);
  const hidden = draw(centerTriangle, 0.6);
  const tie = draw(centerTriangle, 0.200001);
  const multi = draw([...centerTriangle, 0.65, 0.4, 0, 0.95, 0.4, 0, 0.8, 0.7, 0], 0.6);
  const hiddenBlend = draw(centerTriangle, 0.6, blended);
  const nearBlend = draw(centerTriangle, 0.1, blended);
  const opaque = [hidden, tie, multi, ...Array(1024).fill(occluder), near];
  const transparent = [hiddenBlend, nearBlend];

  assert.equal(culling.prepare(opaque, transparent, view, identity, registry), true);
  assert.deepEqual(culling.opaqueItems.map(item => item.geometry.id), opaque.slice(1).map(item => item.geometry.id));
  assert.deepEqual(culling.transparentItems, [nearBlend]);
  assert.equal(opaque[0], hidden);
  assert.deepEqual(transparent, [hiddenBlend, nearBlend]);
});

test('forward occlusion cannot use back faces, clipped draws or unknown renderers as occluders', () => {
  const { culling, registry } = create();
  const culledFace = draw(solidTriangle, 0.2, solid, { frontFace: 'cw' });
  const clipped = { ...draw(solidTriangle, 0.2), clippingPlanes: {} };
  const nearPlane = draw(solidTriangle, 0.000001);
  const hidden = draw(centerTriangle, 0.6);
  const objects = [hidden, clipped, nearPlane, ...Array(1024).fill(culledFace)];

  assert.equal(culling.prepare(objects, [], view, identity, registry), false);
  assert.deepEqual(culling.opaqueItems, objects);

  registry.register({ materialType: BasicMaterial, renderItem() {} });
  const occluder = draw(solidTriangle, 0.2);
  assert.equal(culling.prepare([hidden, ...Array(1024).fill(occluder)], [], view, identity, registry), false);
  assert.deepEqual(culling.opaqueItems, []);
});

test('separate occluders can cover different samples of the same tile', () => {
  const { culling, registry } = create();
  const seam = 65 / 64 - 1;
  const left = draw([-0.8, -0.8, 0, seam, -0.8, 0, seam, 0.8, 0], 0.2);
  const right = draw([seam, -0.8, 0, 0.8, -0.8, 0, seam, 0.8, 0], 0.3);
  const behind = draw(centerTriangle, 0.6);
  const occluders = [right, ...Array(512).fill(left)];
  assert.equal(culling.prepare([behind, ...occluders], [], view, identity, registry), true);
  assert.deepEqual(culling.opaqueItems, occluders);
});

test('forward occlusion skips empty volume intervals with the eye outside the slab', () => {
  const { culling, registry } = create();
  registerForwardOcclusionRenderer(registry, { materialType: VolumeMaterial, renderItem() {} });
  const opaque = Array(512).fill(draw(solidTriangle, 0.8));
  const volume = new VolumeMaterial();
  const empty = draw(centerTriangle, 0.5, volume);
  const coplanar = draw(centerTriangle, 0.6, volume);
  const filled = draw([-0.2, -0.2, -0.1, 0.2, -0.2, 0.1, 0, 0.2, 0], 0.5, volume);
  const eye = Float32Array.of(0, 0, coplanar.worldMatrix[14]);
  assert.equal(culling.prepare(opaque, [empty, coplanar, filled], view, identity, registry, eye), true);
  assert.deepEqual(culling.transparentItems, [coplanar, filled]);
});

test('a partially hidden lit triangle keeps only a conservative visible rectangle', () => {
  const { culling, registry } = create();
  registerForwardOcclusionRenderer(registry, { materialType: PbrMaterial, renderItem() {} });
  const cover = draw([-0.9, -0.9, 0, 0.48, -0.9, 0, -0.2, 0.95, 0], 0.2);
  const lit = draw([-0.36, -0.5, 0, 0.55, -0.5, 0, 0, 0.25, 0], 0.6, new PbrMaterial());
  const opaque = [lit, ...Array(512).fill(cover)];
  assert.equal(culling.prepare(opaque, [], view, identity, registry), true);
  assert.equal(culling.opaqueItems[0], lit);
  const rectangle = culling.scissors?.rectangles.get(lit);
  assert(rectangle && rectangle.x > 60 && rectangle.width < 32);
  culling.clear();
  assert.equal(culling.scissors, undefined);
});
