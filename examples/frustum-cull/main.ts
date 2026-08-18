import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import { Mesh3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { ColorHSL } from '@haiyue/engine/color';
import type { ColorValue } from '@haiyue/engine/color';
import { createBox3D } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';
import { System } from '@haiyue/engine';
import { computeBoundingSphere, transformBoundingSphere } from '@haiyue/engine/math';
import { mat4 } from 'wgpu-matrix';

// ────────────────────────────────────────────────────────────────────────────
// Frustum-cull demo
//
// 10×10 grid of cubes.  Toggle frustum culling and debug mode with the
// on-screen buttons or keyboard shortcuts:
//   C  — toggle frustum culling
//   D  — toggle debug mode (culled cubes shown as translucent gray)
// ────────────────────────────────────────────────────────────────────────────

const GRID     = 10;
const SPACING  = 3.2;
const TOTAL    = GRID * GRID;
const CUBE_SIZE = 1.4;

class FrustumCullDebugSystem extends System {
  constructor(private readonly updateDebugState: () => void) {
    super(() => false, undefined, 'FrustumCullDebugSystem');
    this.priority = 1000;
  }

  override update(): this {
    this.updateDebugState();
    return this;
  }
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.05, g: 0.05, b: 0.1, a: 1 },
  });
  await engine.init();

  // ── Camera ─────────────────────────────────────────────────────────────────
  const camSph = new SphericalTransform3D({
    radius: 28,
    theta:  Math.PI * 0.2,
    phi:    Math.PI * 0.3,
    target: [0, 0, 0],
  });
  const camEntity = new Entity('Camera');
  camEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.5, far: 200 }));
  camEntity.addComponent(camSph);

  const scene = engine.createScene({
    name: 'FrustumCull',
    camera: camEntity,
    render3D: {
      loadOp: 'clear',
      renderProfile: 'batched',
    },
    pipelineLabel: 'FrustumCull.render',
  });
  const world = scene.world;
  const renderSystem = scene.render3DSystem!;

  new OrbitControl(canvas, camSph, { minRadius: 6, maxRadius: 80 });

  // ── Build 10×10 grid ───────────────────────────────────────────────────────
  const boxGeo      = createBox3D({ width: CUBE_SIZE, height: CUBE_SIZE, depth: CUBE_SIZE });
  const localSphere = computeBoundingSphere(boxGeo.positions);
  const offset      = ((GRID - 1) * SPACING) / 2;

  interface CubeRecord {
    entity:       Entity;
    transform:    Transform3D;
    material:     BasicMaterial;
    originalColor: ColorValue;
  }
  const cubes: CubeRecord[] = [];

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const x = col * SPACING - offset;
      const z = row * SPACING - offset;

      const hue = ((row * GRID + col) / TOTAL) * 360;
      const material = new BasicMaterial({ color: new ColorHSL(hue, 0.75, 0.55) });
      const originalColor = material.color.clone();

      const transform = new Transform3D();
      transform.localMatrix = mat4.translation([x, 0, z]) as Float32Array;

      const entity = new Entity(`Cube_${row}_${col}`);
      entity.addComponent(transform);
      entity.addComponent(new Mesh3D(boxGeo, material));
      world.addEntity(entity);

      cubes.push({ entity, transform, material, originalColor });
    }
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  let debugMode = false;
  let cullingEnabled = true;

  const btnCull  = document.getElementById('btn-cull')  as HTMLButtonElement;
  const btnDebug = document.getElementById('btn-debug') as HTMLButtonElement;
  const statEl   = document.getElementById('stat')      as HTMLDivElement;

  function updateButtonState() {
    btnCull.textContent  = `Frustum Cull: ${cullingEnabled ? 'ON' : 'OFF'}`;
    btnCull.className    = cullingEnabled ? 'active' : '';
    btnDebug.textContent = `Debug Mode: ${debugMode ? 'ON' : 'OFF'}`;
    btnDebug.className   = debugMode ? 'active' : '';
  }

  btnCull.addEventListener('click', () => {
    cullingEnabled = !cullingEnabled;
    if (!debugMode) renderSystem.setRenderProfile(cullingEnabled ? 'batched' : 'simple');
    updateButtonState();
  });

  btnDebug.addEventListener('click', () => {
    debugMode = !debugMode;
    renderSystem.setRenderProfile(debugMode ? 'simple' : cullingEnabled ? 'batched' : 'simple');
    if (!debugMode) restoreColors();
    updateButtonState();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'c' || e.key === 'C') btnCull.click();
    if (e.key === 'd' || e.key === 'D') btnDebug.click();
  });

  updateButtonState();

  // ── Debug helpers ──────────────────────────────────────────────────────────
  function restoreColors() {
    for (const { material, originalColor } of cubes) {
      material.color = originalColor;
      material.blending = 'none';
    }
  }

  function applyDebugColors() {
    const frustum = renderSystem.frustum;
    for (const { transform, material, originalColor } of cubes) {
      const worldSphere = transformBoundingSphere(localSphere, transform.worldMatrix);
      const visible     = frustum.containsSphere(worldSphere);
      if (visible) {
        material.color = originalColor;
        material.blending = 'none';
      } else {
        material.color = [0.45, 0.45, 0.45, 0.22];
        material.blending = 'normal';
      }
    }
  }

  scene.addSystem(new FrustumCullDebugSystem(() => {
    // In debug mode, use the simple profile so all objects render, then
    // recolour culled ones as translucent gray after the previous frame's frustum.
    if (debugMode) {
      applyDebugColors();
    }
  }), false);

  // ── Render loop ────────────────────────────────────────────────────────────
  engine.on('after-update', () => {
    // Stats are from the just-completed frame
    const visible = debugMode
      ? cubes.filter(({ transform }) =>
          renderSystem.frustum.containsSphere(transformBoundingSphere(localSphere, transform.worldMatrix))
        ).length
      : renderSystem.lastVisibleCount;

    statEl.textContent = `Visible: ${visible} / ${TOTAL}   Culled: ${TOTAL - visible}`;
  });

  engine.switchScene(scene);
  engine.run();
}

main().catch(console.error);
