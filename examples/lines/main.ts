import * as dat from 'dat.gui';
import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { Line3DRenderSystem } from '@haiyue/engine/systems';
import { Mesh3DRenderer, setRender3DMeshRenderer } from '@haiyue/engine/experimental';
import { createBox3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { LineGeometry } from '@haiyue/engine/geometry';
import { LineMaterial } from '@haiyue/engine/material';
import { Line3D } from '@haiyue/engine/components';
import { ColorSRGB } from '@haiyue/engine';

// ---------------------------------------------------------------------------
// Lines Demo
//
// Shows three polylines:
//   • A screen-space constant-width zigzag (stays same pixel width at any depth)
//   • A world-space width spiral (width shrinks with distance from camera)
//   • A helix with round caps toggled via dat.gui
//
// Controls (dat.gui):
//   • Line Width    — pixels (screen-space) or world units (world-space)
//   • Screen Space  — toggle between screen-space and world-space width
//   • Cap Style     — round vs butt
//   • MSAA 4×       — toggle anti-aliasing
// ---------------------------------------------------------------------------

const params = {
  lineWidth: 8,
  screenSpace: true,
  cap: 'round' as 'round' | 'butt',
  msaa: false,
};

function makeZigzag(z: number, segments = 20): Float32Array {
  const pts: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = (t - 0.5) * 8;
    const y = Math.sin(t * Math.PI * 4) * 1.5;
    pts.push(x, y, z);
  }
  return new Float32Array(pts);
}

function makeSpiral(z: number, turns = 3, steps = 60): Float32Array {
  const pts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = t * Math.PI * 2 * turns;
    const r = 0.3 + t * 2.5;
    pts.push(Math.cos(angle) * r, Math.sin(angle) * r, z + t * 0.5);
  }
  return new Float32Array(pts);
}

function makeHelix(steps = 80): Float32Array {
  const pts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = t * Math.PI * 6;
    pts.push(Math.cos(angle) * 1.5, (t - 0.5) * 4, Math.sin(angle) * 1.5);
  }
  return new Float32Array(pts);
}

async function main() {
  const engine = new HaiyueEngine({
    canvas: 'canvas',
    clearColor: { r: 0.04, g: 0.04, b: 0.08, a: 1 },
  });
  await engine.init();

  // ── Camera ────────────────────────────────────────────────────────────────
  const cameraEntity = new Entity('Camera');
  cameraEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 }));
  cameraEntity.addComponent(new CartesianTransform3D({ position: [0, 0, 12] }));
  const scene = engine.createScene({
    name: 'Lines',
    camera: cameraEntity,
    render3D: true,
    render2D: false,
    gui: false,
    pipelineLabel: 'LinesDemo.render',
  });
  const { world } = scene;

  // ── Reference box so depth compositing is visible ─────────────────────────
  const boxEntity = new Entity('Box');
  boxEntity.addComponent(new CartesianTransform3D({ position: [0, 0, -1] }));
  boxEntity.addComponent(new Mesh3D(
    createBox3D({ width: 14, height: 8, depth: 0.05 }),
    new BasicMaterial({ color: new ColorSRGB(0.15, 0.15, 0.2) }),
  ));
  world.addEntity(boxEntity);

  // ── Line entities ─────────────────────────────────────────────────────────
  const zigzagGeo = new LineGeometry(makeZigzag(-0.5));
  const zigzagMat = new LineMaterial({
    color: new ColorSRGB(0.2, 0.8, 1.0),
    width: params.lineWidth,
    screenSpace: params.screenSpace,
    cap: params.cap,
  });
  const zigzagEntity = new Entity('Zigzag');
  zigzagEntity.addComponent(new CartesianTransform3D({ position: [0, 2, 0] }));
  zigzagEntity.addComponent(new Line3D(zigzagGeo, zigzagMat));
  world.addEntity(zigzagEntity);

  const spiralGeo = new LineGeometry(makeSpiral(0));
  const spiralMat = new LineMaterial({
    color: new ColorSRGB(1.0, 0.5, 0.1),
    width: params.lineWidth,
    screenSpace: params.screenSpace,
    cap: params.cap,
  });
  const spiralEntity = new Entity('Spiral');
  spiralEntity.addComponent(new CartesianTransform3D({ position: [-3.5, -1.5, 0] }));
  spiralEntity.addComponent(new Line3D(spiralGeo, spiralMat));
  world.addEntity(spiralEntity);

  const helixGeo = new LineGeometry(makeHelix());
  const helixMat = new LineMaterial({
    color: new ColorSRGB(0.4, 1.0, 0.4),
    width: params.lineWidth,
    screenSpace: params.screenSpace,
    cap: params.cap,
  });
  const helixEntity = new Entity('Helix');
  helixEntity.addComponent(new CartesianTransform3D({ position: [3.5, 0, 0] }));
  helixEntity.addComponent(new Line3D(helixGeo, helixMat));
  world.addEntity(helixEntity);

  const allMats = [zigzagMat, spiralMat, helixMat];

  // ── Systems ───────────────────────────────────────────────────────────────
  const renderSystem = scene.render3DSystem!;
  setRender3DMeshRenderer(renderSystem, new Mesh3DRenderer());

  const lineSystem = new Line3DRenderSystem(engine, cameraEntity);
  scene.addSystem(lineSystem);

  // ── dat.gui ───────────────────────────────────────────────────────────────
  const gui = new dat.GUI({ width: 260 });
  gui.add(params, 'lineWidth', 1, 40, 1).name('Line Width').onChange((v: number) => {
    allMats.forEach(m => { m.width = v; });
  });
  gui.add(params, 'screenSpace').name('Screen Space').onChange((v: boolean) => {
    allMats.forEach(m => { m.screenSpace = v; });
  });
  gui.add(params, 'cap', ['round', 'butt']).name('Cap Style').onChange((v: 'round' | 'butt') => {
    allMats.forEach(m => { m.cap = v; });
  });
  gui.add(params, 'msaa').name('MSAA 4×').onChange((v: boolean) => {
    renderSystem.msaaSamples = v ? 4 : 1;
    lineSystem.msaaSamples   = v ? 4 : 1;
  });

  // ── Render loop ───────────────────────────────────────────────────────────
  engine.switchScene(scene);
  engine.run();
}

main().catch(console.error);
