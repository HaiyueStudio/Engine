import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { InteractionSystem } from '@haiyue/engine/systems';
import { createBox3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { Interactive } from '@haiyue/engine/components';
import { ColorSRGB } from '@haiyue/engine';

// ---------------------------------------------------------------------------
// Scene layout (all at z = 0, camera at z = 8):
//
//   x = -3   x = 0   x = 3
//   [RED]   [GREEN]  [BLUE]        ← 3 clickable boxes (z = 0)
//
//   [───── GREY ─────]             ← non-interactive occluder  (z = 1)
//      covers red & green
//
//                     [YELLOW]     ← Interactive penetrable=true (z = 1)
//                      over blue
//
// Expected behaviour:
//  • Clicking on the GREY slab → blocked, red/green receive nothing
//  • Clicking on YELLOW → ray passes through, BLUE box receives click
//  • Hovering any interactive box (red / green / blue) → cursor changes + glow
// ---------------------------------------------------------------------------

const logEl = document.getElementById('log') as HTMLElement;
function log(msg: string) {
  logEl.textContent = msg;
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.05, g: 0.05, b: 0.1, a: 1 },
  });
  await engine.init();

  // ── Camera ───────────────────────────────────────────────────────────────
  const cameraEntity = new Entity('Camera');
  cameraEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 }));
  cameraEntity.addComponent(new CartesianTransform3D({ position: [0, 0, 8] }));

  const scene = engine.createScene({
    name: 'Interactive',
    camera: cameraEntity,
    render3D: true,
    pipelineLabel: 'Interactive.render',
  });
  const world = scene.world;

  // ── Helper: build a coloured interactive box ─────────────────────────────
  const boxGeo = createBox3D({ width: 1.8, height: 1.8, depth: 1.8 });

  function makeInteractiveBox(
    name: string,
    x: number,
    color: ColorSRGB,
  ): Entity {
    const baseR = color.r, baseG = color.g, baseB = color.b;
    const mat = new BasicMaterial({ color: color.clone() });

    const entity = new Entity(name);
    entity.addComponent(new CartesianTransform3D({ position: [x, 0, 0] }));
    entity.addComponent(new Mesh3D(boxGeo, mat));
    entity.addComponent(new Interactive({
      onPointerEnter: () => {
        mat.color = new ColorSRGB(Math.min(1, baseR + 0.35), Math.min(1, baseG + 0.35), Math.min(1, baseB + 0.35));
        canvas.style.cursor = 'pointer';
        log(`Hover → ${name}`);
      },
      onPointerLeave: () => {
        mat.color = new ColorSRGB(baseR, baseG, baseB);
        canvas.style.cursor = 'default';
        log(`Leave → ${name}`);
      },
      onClick: (e) => {
        log(`Click → ${name}  dist=${e.distance.toFixed(2)}  normal=(${Array.from(e.normal as Float32Array).map(n => n.toFixed(2)).join(',')})`);
      },
    }));
    return entity;
  }

  const redBox   = makeInteractiveBox('RedBox',   -3, new ColorSRGB(0.88, 0.22, 0.22));
  const greenBox = makeInteractiveBox('GreenBox',  0, new ColorSRGB(0.22, 0.75, 0.22));
  const blueBox  = makeInteractiveBox('BlueBox',   3, new ColorSRGB(0.22, 0.40, 0.92));
  world.addEntity(redBox);
  world.addEntity(greenBox);
  world.addEntity(blueBox);

  // ── Grey occluder (no Interactive) ───────────────────────────────────────
  // Covers red and green boxes. Rays hitting this slab stop here — no event
  // is fired, but nothing behind it can be reached.
  const occluderGeo = createBox3D({ width: 4.2, height: 2.2, depth: 0.15 });
  const occluder = new Entity('Occluder');
  occluder.addComponent(new CartesianTransform3D({ position: [-1.5, 0, 1.2] }));
  occluder.addComponent(new Mesh3D(occluderGeo, new BasicMaterial({ color: new ColorSRGB(0.55, 0.55, 0.55) })));
  // ← deliberately no Interactive component
  world.addEntity(occluder);

  // ── Yellow penetrable box (Interactive + penetrable=true) ────────────────
  // Sits in front of the blue box. Because penetrable=true the ray is not
  // tested against it at all, so blue box clicks work normally through it.
  const penetrableGeo = createBox3D({ width: 2.0, height: 2.0, depth: 0.15 });
  const penetrable = new Entity('Penetrable');
  penetrable.addComponent(new CartesianTransform3D({ position: [3, 0, 1.2] }));
  penetrable.addComponent(new Mesh3D(penetrableGeo, new BasicMaterial({ color: new ColorSRGB(0.92, 0.82, 0.12) })));
  penetrable.addComponent(new Interactive({ penetrable: true })); // transparent to rays
  world.addEntity(penetrable);

  const interactionSystem = new InteractionSystem(engine, cameraEntity);
  scene.addSystem(interactionSystem, false);

  engine.switchScene(scene);
  engine.run();
}

main().catch(console.error);
