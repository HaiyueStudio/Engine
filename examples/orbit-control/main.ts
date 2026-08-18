import * as dat from 'dat.gui';
import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { createBox3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';
import { LineGeometry } from '@haiyue/engine/geometry';
import { LineMaterial } from '@haiyue/engine/material';
import { Line3D } from '@haiyue/engine/components';
import { Line3DRenderSystem } from '@haiyue/engine/systems';
import { requiredItemAt, requiredNumberAt } from '../arrayAccess';

// ---------------------------------------------------------------------------
// Orbit Control Demo
//
// Scene:
//   • 5×5 grid of coloured boxes arranged on the XZ plane
//   • A central tall box acting as a landmark
//   • A world-axis helper drawn as 3 thick lines (R=X, G=Y, B=Z)
//
// Controls (mouse / touch):
//   Left drag     → orbit (theta / phi)
//   Right / mid   → pan (translate orbit target)
//   Scroll wheel  → zoom (radius)
//   Pinch         → zoom
//
// dat.gui lets you inspect / reset the spherical state.
// ---------------------------------------------------------------------------

function makeAxesLines(): { entity: Entity }[] {
  const axisLen = 4;
  const specs: [ColorSRGB, [number, number, number][]][] = [
    [new ColorSRGB(1, 0.2, 0.2), [[0,0,0],[axisLen,0,0]]],  // +X red
    [new ColorSRGB(0.2, 1, 0.2), [[0,0,0],[0,axisLen,0]]],  // +Y green
    [new ColorSRGB(0.2, 0.4, 1), [[0,0,0],[0,0,axisLen]]],  // +Z blue
  ];
  return specs.map(([color, pts]) => {
    const e = new Entity('Axis');
    e.addComponent(new CartesianTransform3D());
    e.addComponent(new Line3D(
      new LineGeometry(new Float32Array(pts.flat())),
      new LineMaterial({ color, width: 3, screenSpace: true, cap: 'butt' }),
    ));
    return { entity: e };
  });
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.05, g: 0.05, b: 0.1, a: 1 },
  });
  await engine.init();

  // ── Camera with SphericalTransform3D ──────────────────────────────────────
  const spherical = new SphericalTransform3D({
    radius: 18,
    theta: Math.PI / 6,
    phi: Math.PI / 3,
    target: [0, 0, 0],
  });
  const cameraEntity = new Entity('Camera');
  cameraEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 200 }));
  cameraEntity.addComponent(spherical);
  const scene = engine.createScene({
    name: 'OrbitControl',
    camera: cameraEntity,
  });

  // ── Orbit control ─────────────────────────────────────────────────────────
  const orbitControl = new OrbitControl(canvas, spherical, {
    minRadius: 2,
    maxRadius: 120,
    rotateSpeed: 0.8,
    zoomSpeed: 1.0,
    panSpeed: 1.2,
  });

  // ── Scene: 5×5 grid of boxes ──────────────────────────────────────────────
  const boxGeo = createBox3D({ width: 1, height: 1, depth: 1 });
  const palette = [
    new ColorSRGB(0.9, 0.3, 0.3),
    new ColorSRGB(0.3, 0.8, 0.4),
    new ColorSRGB(0.3, 0.5, 0.95),
    new ColorSRGB(0.9, 0.7, 0.2),
    new ColorSRGB(0.7, 0.3, 0.9),
  ];

  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const e = new Entity(`Box_${i}_${j}`);
      e.addComponent(new CartesianTransform3D({ position: [(i - 2) * 2.5, 0, (j - 2) * 2.5] }));
      e.addComponent(new Mesh3D(boxGeo, new BasicMaterial({ color: requiredItemAt(palette, (i + j) % palette.length, 'orbit control palette').clone() })));
      scene.add(e);
    }
  }

  // ── Central landmark ──────────────────────────────────────────────────────
  const landmarkGeo = createBox3D({ width: 0.6, height: 4, depth: 0.6 });
  const landmark = new Entity('Landmark');
  landmark.addComponent(new CartesianTransform3D({ position: [0, 2, 0] }));
  landmark.addComponent(new Mesh3D(landmarkGeo, new BasicMaterial({ color: new ColorSRGB(1, 1, 0.3) })));
  scene.add(landmark);

  // ── Ground plane ──────────────────────────────────────────────────────────
  const groundGeo = createBox3D({ width: 16, height: 0.05, depth: 16 });
  const ground = new Entity('Ground');
  ground.addComponent(new CartesianTransform3D({ position: [0, -0.55, 0] }));
  ground.addComponent(new Mesh3D(groundGeo, new BasicMaterial({ color: new ColorSRGB(0.18, 0.18, 0.22) })));
  scene.add(ground);

  // ── World-axis helper lines ────────────────────────────────────────────────
  const axes = makeAxesLines();
  for (const { entity } of axes) scene.add(entity);

  // ── Systems ───────────────────────────────────────────────────────────────
  const lineSystem = new Line3DRenderSystem(engine, cameraEntity);
  scene.addSystem(lineSystem);

  // ── dat.gui ───────────────────────────────────────────────────────────────
  const gui = new dat.GUI({ width: 260 });

  const state = {
    radius: spherical.radius,
    thetaDeg: (spherical.theta * 180 / Math.PI),
    phiDeg: (spherical.phi * 180 / Math.PI),
    targetX: spherical.target[0],
    targetY: spherical.target[1],
    targetZ: spherical.target[2],
    reset: () => {
      spherical.set(18, Math.PI / 6, Math.PI / 3);
      spherical.setTarget(0, 0, 0);
      syncGui();
    },
  };

  function syncGui() {
    state.radius   = spherical.radius;
    state.thetaDeg = spherical.theta * 180 / Math.PI;
    state.phiDeg   = spherical.phi   * 180 / Math.PI;
    state.targetX  = spherical.target[0];
    state.targetY  = spherical.target[1];
    state.targetZ  = spherical.target[2];
    const controllers = (gui as unknown as { __controllers: Array<{ updateDisplay(): void }> }).__controllers;
    for (const controller of controllers) controller.updateDisplay();
  }

  const sphFolder = gui.addFolder('Spherical State (read-only)');
  sphFolder.add(state, 'radius').name('radius').listen();
  sphFolder.add(state, 'thetaDeg').name('theta (°)').listen();
  sphFolder.add(state, 'phiDeg').name('phi (°)').listen();
  sphFolder.add(state, 'targetX').name('target.x').listen();
  sphFolder.add(state, 'targetY').name('target.y').listen();
  sphFolder.add(state, 'targetZ').name('target.z').listen();
  sphFolder.open();

  const orbitFolder = gui.addFolder('Orbit Control');
  orbitFolder.add(orbitControl, 'rotateSpeed', 0.1, 3, 0.1).name('Rotate Speed');
  orbitFolder.add(orbitControl, 'zoomSpeed',   0.1, 3, 0.1).name('Zoom Speed');
  orbitFolder.add(orbitControl, 'panSpeed',    0.1, 3, 0.1).name('Pan Speed');
  orbitFolder.add(orbitControl, 'minRadius',   0.5, 10, 0.5).name('Min Radius').onChange((v: number) => {
    orbitControl.minRadius = v;
  });
  orbitFolder.add(orbitControl, 'maxRadius', 20, 200, 5).name('Max Radius').onChange((v: number) => {
    orbitControl.maxRadius = v;
  });
  orbitFolder.add(orbitControl, 'enablePan').name('Enable Pan');
  orbitFolder.open();

  gui.add(state, 'reset').name('Reset Camera');

  // ── Render loop ───────────────────────────────────────────────────────────
  engine.switchScene(scene);
  engine.on('after-update', () => {
    // Sync display-only state every frame
    state.radius   = Math.round(spherical.radius * 100) / 100;
    state.thetaDeg = Math.round(spherical.theta * 180 / Math.PI * 10) / 10;
    state.phiDeg   = Math.round(spherical.phi   * 180 / Math.PI * 10) / 10;
    state.targetX  = Math.round(requiredNumberAt(spherical.target, 0, 'orbit target') * 100) / 100;
    state.targetY  = Math.round(requiredNumberAt(spherical.target, 1, 'orbit target') * 100) / 100;
    state.targetZ  = Math.round(requiredNumberAt(spherical.target, 2, 'orbit target') * 100) / 100;

  });

  engine.run();
}

main().catch(console.error);
