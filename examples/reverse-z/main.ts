import * as dat from 'dat.gui';
import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { createBox3D } from '@haiyue/engine';
import { createPlane3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';

// ---------------------------------------------------------------------------
// Z-Fighting Demo
//
// Two large wall planes (red and blue) are placed very far from the camera.
// The blue plane has a tiny depth offset and tilt, so parts of the two surfaces
// fall within the same depth-buffer precision bucket when reverse-Z is off.
//
// Without reverseZ (depth24plus + depthCompare:'less'):
//   At large view distances the 24-bit depth buffer cannot distinguish the
//   0.02-unit gap → the two planes flicker / z-fight.
//
// With reverseZ (depth32float + depthCompare:'greater'):
//   Floating-point depth has exceptional precision near zero (which maps to
//   the FAR end in reverse-Z), cleanly separating the planes.
// ---------------------------------------------------------------------------

async function main() {
  const engine = new HaiyueEngine({
    canvas: 'canvas',
    clearColor: { r: 0.05, g: 0.05, b: 0.1, a: 1 },
  });
  await engine.init();

  // ── Camera ─────────────────────────────────────────────────────────────
  const cameraEntity = new Entity('Camera');
  const camera = new Camera3D({
    type: 'perspective',
    fov: Math.PI / 5,
    near: 0.1,
    far: 10000,   // large far to maximise z-fighting without reverseZ
  });
  const cameraTransform = new CartesianTransform3D({ position: [0, 0, 0] });
  cameraEntity.addComponent(camera);
  cameraEntity.addComponent(cameraTransform);
  const scene = engine.createScene({
    name: 'ReverseZ',
    camera: cameraEntity,
    render3D: { renderProfile: 'simple' },
    pipelineLabel: 'ReverseZ.render',
  });
  const world = scene.world;

  // ── Two far overlapping wall planes ─────────────────────────────────────
  // Red is the reference surface. Blue is shifted a tiny amount in Z and
  // rotated by a tiny angle, producing a broad precision-sensitive overlap
  // region instead of a clean geometric separation.

  const planeGeo = createPlane3D({ width: 8000, height: 4500, normal: 'z' });
  const redTransform = new CartesianTransform3D({ position: [0, 0, -8000] });
  const blueTransform = new CartesianTransform3D({ position: [0, 0, -7999.5], rotation: [0, -0.02, 0] });

  const redEntity = new Entity('FarPlaneRed');
  redEntity.addComponent(redTransform);
  redEntity.addComponent(new Mesh3D(planeGeo, new BasicMaterial({
    color: new ColorSRGB(0.95, 0.18, 0.15),
    cullMode: 'none',
  })));
  world.addEntity(redEntity);

  const blueEntity = new Entity('FarPlaneBlue');
  blueEntity.addComponent(blueTransform);
  blueEntity.addComponent(new Mesh3D(planeGeo, new BasicMaterial({
    color: new ColorSRGB(0.15, 0.35, 1.0),
    cullMode: 'none',
  })));
  world.addEntity(blueEntity);

  // A few reference pillars so there's obvious 3D depth cue
  const pillarGeo = createBox3D({ width: 20, height: 260, depth: 20 });
  const pillarPositions = [
    [-2800, -1700, -7980], [-900, -1700, -7980],
    [900, -1700, -7980], [2800, -1700, -7980],
  ] as const;
  for (const [px, py, pz] of pillarPositions) {
    const e = new Entity('Pillar');
    e.addComponent(new CartesianTransform3D({ position: [px, py, pz] }));
    e.addComponent(new Mesh3D(pillarGeo, new BasicMaterial({ color: new ColorSRGB(0.8, 0.7, 0.3) })));
    world.addEntity(e);
  }

  // ── Render system ───────────────────────────────────────────────────────
  const renderSystem = scene.render3DSystem!;

  // ── dat.GUI ─────────────────────────────────────────────────────────────
  const infoEl = document.getElementById('info') as HTMLElement;

  const params = {
    reverseZ: false,
    near: 0.1,
    far: 10000,
    distance: 8000,
    separation: -0.5,
    tiltY: -0.02,
  };

  function applyParams() {
    renderSystem.reverseZ = params.reverseZ;
    camera.near = params.near;
    camera.far  = params.far;
    camera.setDirty();
    redTransform.setPosition(0, 0, -params.distance);
    redTransform.setRotation(0, 0, 0);
    blueTransform.setPosition(0, 0, -params.distance - params.separation);
    blueTransform.setRotation(0, params.tiltY, 0);
    infoEl.textContent =
      `Reverse-Z: ${params.reverseZ ? 'ON  ✓ (depth32float + greater)' : 'OFF  ✗ (depth24plus + less)'}\n` +
      `Near: ${params.near}  Far: ${params.far}\n` +
      `Distance: ${params.distance}  Separation: ${params.separation}  TiltY: ${params.tiltY}`;
  }

  const gui = new dat.GUI({ width: 300 });
  gui.add(params, 'reverseZ').name('Reverse-Z').onChange(applyParams);

  const clampFolder = gui.addFolder('Clipping Planes');
  clampFolder.add(params, 'near', 0.01, 10, 0.01).name('Near').onChange(applyParams);
  clampFolder.add(params, 'far', 100, 20000, 100).name('Far').onChange(applyParams);
  clampFolder.open();

  const sceneFolder = gui.addFolder('Precision Stress');
  sceneFolder.add(params, 'distance', 1000, 9500, 100).name('Distance').onChange(applyParams);
  sceneFolder.add(params, 'separation', -5, 5, 0.01).name('Z gap').onChange(applyParams);
  sceneFolder.add(params, 'tiltY', -0.05, 0.05, 0.0001).name('Blue tilt Y').onChange(applyParams);
  sceneFolder.open();

  applyParams();

  engine.switchScene(scene);
  engine.run();
}

main().catch(console.error);
