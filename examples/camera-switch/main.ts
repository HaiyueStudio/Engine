import * as dat from 'dat.gui';
import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { createBox3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { requiredItemAt, requiredNumberAt } from '../arrayAccess';

// ---------------------------------------------------------------------------
// Scene: a 5×3 grid of boxes at 3 different Z depths.
// With perspective: distant rows appear smaller.
// With orthographic: all rows are the same apparent size.
// ---------------------------------------------------------------------------

async function main() {
  const engine = new HaiyueEngine({
    canvas: 'canvas',
    clearColor: { r: 0.07, g: 0.07, b: 0.12, a: 1 },
  });
  await engine.init();

  // ── Camera ──────────────────────────────────────────────────────────────
  const cameraEntity = new Entity('Camera');
  const camera = new Camera3D({
    type: 'perspective',
    fov: Math.PI / 4,   // 45°
    near: 0.1,
    far: 200,
  });
  const cameraTransform = new CartesianTransform3D({ position: [0, 3, 15] });
  cameraEntity.addComponent(camera);
  cameraEntity.addComponent(cameraTransform);
  const scene = engine.createScene({
    name: 'CameraSwitch',
    camera: cameraEntity,
  });

  // ── Scene objects ────────────────────────────────────────────────────────
  // 3 depth layers, 5 columns each. Colors distinguish depth layers.
  const layerColors = [
    new ColorSRGB(0.95, 0.45, 0.45), // red   – front  (z =  0)
    new ColorSRGB(0.45, 0.85, 0.45), // green – middle (z = -6)
    new ColorSRGB(0.45, 0.55, 0.95), // blue  – back   (z = -12)
  ];
  const depths   = [0, -6, -12];
  const xSlots   = [-4, -2, 0, 2, 4];
  const boxGeo   = createBox3D({ width: 1.2, height: 1.2, depth: 1.2 });

  // Collect transforms for animation
  const boxTransforms: CartesianTransform3D[] = [];

  for (let d = 0; d < depths.length; d++) {
    for (let x = 0; x < xSlots.length; x++) {
      const entity = new Entity(`Box_d${d}_x${x}`);
      const t = new CartesianTransform3D({ position: [requiredNumberAt(xSlots, x, 'camera demo x slots'), 0, requiredNumberAt(depths, d, 'camera demo depths')] });
      entity.addComponent(t);
      entity.addComponent(new Mesh3D(boxGeo, new BasicMaterial({ color: requiredItemAt(layerColors, d, 'camera demo colors').clone() })));
      scene.add(entity);
      boxTransforms.push(t);
    }
  }

  // ── dat.GUI ──────────────────────────────────────────────────────────────
  const label = document.getElementById('proj-label') as HTMLElement;

  const params = {
    projection: 'perspective' as 'perspective' | 'orthographic',
    // Perspective
    fov:  45,
    // Shared
    near: 0.1,
    far:  200,
    // Orthographic
    orthoSize: 8,      // half-height of the visible area
    // Camera position
    camX: 0,
    camY: 3,
    camZ: 15,
  };

  /** Sync params → Camera3D fields. Called on every GUI change. */
  function applyToCamera(): void {
    camera.projectionType = params.projection;
    camera.near = params.near;
    camera.far  = params.far;

    if (params.projection === 'perspective') {
      camera.fov = params.fov * (Math.PI / 180);
    } else {
      // Compute aspect-corrected orthographic bounds
      const aspect = engine.width / engine.height;
      const h = params.orthoSize;
      const w = h * aspect;
      camera.orthoLeft   = -w;
      camera.orthoRight  =  w;
      camera.orthoTop    =  h;
      camera.orthoBottom = -h;
    }

    // Force matrix recompute on next frame (updateAspect will also do this,
    // but setDirty is explicit and safe)
    camera.setDirty();

    cameraTransform.setPosition(params.camX, params.camY, params.camZ);

    label.textContent = `Projection: ${params.projection.charAt(0).toUpperCase() + params.projection.slice(1)}`;
  }

  const gui = new dat.GUI({ width: 280 });

  // Projection type ── top-level
  gui.add(params, 'projection', ['perspective', 'orthographic'])
    .name('Projection Type')
    .onChange(applyToCamera);

  // Perspective folder
  const perspFolder = gui.addFolder('Perspective');
  perspFolder
    .add(params, 'fov', 10, 120, 1)
    .name('FOV (°)')
    .onChange(applyToCamera);
  perspFolder.open();

  // Orthographic folder
  const orthoFolder = gui.addFolder('Orthographic');
  orthoFolder
    .add(params, 'orthoSize', 1, 25, 0.25)
    .name('Ortho Size')
    .onChange(applyToCamera);
  orthoFolder.open();

  // Clipping planes (shared)
  const clipFolder = gui.addFolder('Clipping Planes');
  clipFolder.add(params, 'near', 0.01, 10,  0.01).name('Near').onChange(applyToCamera);
  clipFolder.add(params, 'far',  10,   500, 1)   .name('Far') .onChange(applyToCamera);
  clipFolder.open();

  // Camera position
  const posFolder = gui.addFolder('Camera Position');
  posFolder.add(params, 'camX', -20, 20, 0.5).name('X').onChange(applyToCamera);
  posFolder.add(params, 'camY', -10, 20, 0.5).name('Y').onChange(applyToCamera);
  posFolder.add(params, 'camZ',   1, 40, 0.5).name('Z').onChange(applyToCamera);
  posFolder.open();

  // Apply initial state
  applyToCamera();

  // ── Render loop ───────────────────────────────────────────────────────────
  let rotY = 0;

  engine.switchScene(scene);
  engine.on('update', ({ detail: { delta } }) => {
    // Slowly rotate all boxes so the 3D structure is visible
    rotY += delta * 0.0004;
    for (const t of boxTransforms) {
      t.setRotation(0, rotY, 0);
    }
  });

  engine.run();
}

main().catch(console.error);
