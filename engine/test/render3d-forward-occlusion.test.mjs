import assert from 'node:assert/strict';
import test from 'node:test';
import { importEngineSource } from './helpers/internal-source.mjs';

const { Render3DForwardOcclusion, registerForwardOcclusionRenderer } =
  await importEngineSource('systems/Render3DForwardOcclusion.ts');
const { MaterialRendererRegistry } = await importEngineSource('renderer/MaterialRendererRegistry.ts');
const { BasicMaterial } = await importEngineSource('material/BasicMaterial.ts');
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
  const near = draw(centerTriangle, 0.1);
  const hidden = draw(centerTriangle, 0.6);
  const tie = draw(centerTriangle, 0.200001);
  const multi = draw([...centerTriangle, 0.65, 0.4, 0, 0.95, 0.4, 0, 0.8, 0.7, 0], 0.6);
  const hiddenBlend = draw(centerTriangle, 0.6, blended);
  const nearBlend = draw(centerTriangle, 0.1, blended);
  const opaque = [hidden, tie, multi, ...Array(1024).fill(occluder), near];
  const transparent = [hiddenBlend, nearBlend];

  assert.equal(culling.prepare(opaque, transparent, view, identity, registry), true);
  assert.deepEqual(culling.opaqueItems, opaque.slice(1));
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
