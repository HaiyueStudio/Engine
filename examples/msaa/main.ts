import * as dat from 'dat.gui';
import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { createBox3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { requiredItemAt } from '../arrayAccess';

// ---------------------------------------------------------------------------
// MSAA Demo
//
// A 4×3 grid of rotating boxes with high-contrast colors against a dark
// background.  The diagonal edges of the boxes are the easiest place to
// spot aliasing.
//
// MSAA OFF (1×): you can clearly see the "staircase" (jagged) pixel steps
//               on every slanted edge.
// MSAA ON  (4×): the GPU sub-samples each pixel 4 times and blends the
//               results, smoothing the stair-steps into clean edges.
// ---------------------------------------------------------------------------

async function main() {
  const engine = new HaiyueEngine({
    canvas: 'canvas',
    clearColor: { r: 0.04, g: 0.04, b: 0.08, a: 1 },
  });
  await engine.init();

  const cameraEntity = new Entity('Camera');
  const cameraTransform = new CartesianTransform3D({ position: [0, 0, 18] });
  cameraEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 200 }));
  cameraEntity.addComponent(cameraTransform);
  const scene = engine.createScene({
    name: 'MSAA',
    camera: {
      entity: cameraEntity,
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 200 },
    },
    render3D: { loadOp: 'clear' },
    pipelineLabel: 'MSAA.render',
  });

  // ── 4×3 grid of boxes ───────────────────────────────────────────────────
  const colors = [
    new ColorSRGB(0.95, 0.25, 0.25),  // red
    new ColorSRGB(0.25, 0.85, 0.35),  // green
    new ColorSRGB(0.25, 0.45, 0.95),  // blue
    new ColorSRGB(0.95, 0.80, 0.15),  // yellow
    new ColorSRGB(0.85, 0.35, 0.90),  // purple
    new ColorSRGB(0.20, 0.85, 0.85),  // cyan
    new ColorSRGB(0.95, 0.55, 0.15),  // orange
    new ColorSRGB(0.90, 0.90, 0.90),  // white
    new ColorSRGB(0.95, 0.40, 0.65),  // pink
    new ColorSRGB(0.35, 0.75, 0.45),  // lime
    new ColorSRGB(0.50, 0.60, 0.95),  // light blue
    new ColorSRGB(0.95, 0.65, 0.45),  // salmon
  ];

  const boxGeo = createBox3D({ width: 1.6, height: 1.6, depth: 1.6 });
  const cols = 4;
  const rows = 3;
  const spacingX = 3.6;
  const spacingY = 3.2;
  const offsetX = ((cols - 1) * spacingX) / 2;
  const offsetY = ((rows - 1) * spacingY) / 2;

  const boxTransforms: CartesianTransform3D[] = [];
  const rotationSpeeds: [number, number, number][] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const entity = new Entity(`Box_${idx}`);
      const t = new CartesianTransform3D({
        position: [c * spacingX - offsetX, -(r * spacingY - offsetY), 0],
      });
      entity.addComponent(t);
      entity.addComponent(new Mesh3D(
        boxGeo,
        new BasicMaterial({ color: requiredItemAt(colors, idx % colors.length, 'MSAA colors').clone() }),
      ));
      scene.add(entity);
      boxTransforms.push(t);
      // Each box gets a unique rotation axis combo so edges appear at all angles
      rotationSpeeds.push([
        0.00025 * (1 + idx * 0.3),
        0.00040 * (1 + idx * 0.2),
        0.00015 * (1 + idx * 0.4),
      ]);
    }
  }

  const renderSystem = scene.render3DSystem!;

  // ── dat.GUI ─────────────────────────────────────────────────────────────
  const infoEl = document.getElementById('info') as HTMLElement;

  const params = {
    msaa: false,   // false = 1×, true = 4×
    speed: 1.0,
  };

  function applyParams() {
    renderSystem.msaaSamples = params.msaa ? 4 : 1;
    infoEl.textContent = params.msaa
      ? 'MSAA: ON  (4×) — edges smoothed'
      : 'MSAA: OFF (1×) — jagged edges visible';
  }

  const gui = new dat.GUI({ width: 260 });
  gui.add(params, 'msaa').name('MSAA 4×').onChange(applyParams);
  gui.add(params, 'speed', 0, 3, 0.1).name('Rotation speed');

  applyParams();

  // ── Render loop ─────────────────────────────────────────────────────────
  const angles = boxTransforms.map(() => [0, 0, 0] as [number, number, number]);

  engine.switchScene(scene);
  engine.on('update', ({ detail: { delta } }) => {
    const s = params.speed;
    for (let i = 0; i < boxTransforms.length; i++) {
      const angle = requiredItemAt(angles, i, 'MSAA box angles');
      const speed = requiredItemAt(rotationSpeeds, i, 'MSAA rotation speeds');
      const transform = requiredItemAt(boxTransforms, i, 'MSAA box transforms');
      angle[0] += speed[0] * delta * s;
      angle[1] += speed[1] * delta * s;
      angle[2] += speed[2] * delta * s;
      transform.setRotation(angle[0], angle[1], angle[2]);
    }
  });

  engine.run();
}

main().catch(console.error);
