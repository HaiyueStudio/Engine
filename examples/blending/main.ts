import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import { Mesh3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { createBox3D } from '@haiyue/engine';
import { createPlane3D } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';
import { mat4 } from 'wgpu-matrix';

// ---------------------------------------------------------------------------
// Blending demo — three groups side by side:
//   Left:   opaque cubes  (blending: 'none')
//   Middle: alpha-blended panes  (blending: 'normal')
//   Right:  additive-blended panes  (blending: 'additive')
// ---------------------------------------------------------------------------

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.05, g: 0.05, b: 0.1, a: 1 },
  });
  await engine.init();

  const scene = engine.createScene({
    name: 'Blending',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 200 },
      orbit: {
        radius: 22,
        theta: Math.PI * 0.15,
        phi: Math.PI * 0.32,
        target: [0, 0, 0],
      },
    },
    render3D: { loadOp: 'clear' },
    pipelineLabel: 'Blending.render',
  });
  const camSph = scene.cameraEntity.getComponent(SphericalTransform3D)!;

  new OrbitControl(canvas, camSph, { minRadius: 5, maxRadius: 60 });

  const geometry = createBox3D({ width: 1.8, height: 1.8, depth: 1.8 });
  const planeGeo = createPlane3D({ width: 2.2, height: 2.2 });

  // ── Helper ─────────────────────────────────────────────────────────────────
  function addMesh(name: string, x: number, y: number, z: number, mat: BasicMaterial): Entity {
    const e = new Entity(name);
    const t = new Transform3D();
    t.localMatrix = mat4.translation([x, y, z]) as Float32Array;
    e.addComponent(t);
    e.addComponent(new Mesh3D(geometry, mat));
    scene.add(e);
    return e;
  }

  function addPlane(name: string, x: number, y: number, z: number, mat: BasicMaterial): Entity {
    const e = new Entity(name);
    const t = new Transform3D();
    t.localMatrix = mat4.translation([x, y, z]) as Float32Array;
    e.addComponent(t);
    e.addComponent(new Mesh3D(planeGeo, mat));
    scene.add(e);
    return e;
  }

  // ── LEFT: opaque cubes ─────────────────────────────────────────────────────
  addMesh('Opaque0', -9, 0, -1.0, new BasicMaterial({ color: [1.0, 0.25, 0.25, 1], blending: 'none' }));
  addMesh('Opaque1', -9, 0,  0.0, new BasicMaterial({ color: [0.25, 1.0, 0.25, 1], blending: 'none' }));
  addMesh('Opaque2', -9, 0,  1.0, new BasicMaterial({ color: [0.25, 0.4,  1.0, 1], blending: 'none' }));

  // ── MIDDLE: normal (alpha) blended panes ───────────────────────────────────
  // Back → front order ensures correct compositing
  addPlane('Alpha0', 0, 0, -2.0, new BasicMaterial({ color: [1.0, 0.3, 0.3, 0.6], blending: 'normal' }));
  addPlane('Alpha1', 0, 0,  0.0, new BasicMaterial({ color: [0.3, 1.0, 0.3, 0.6], blending: 'normal' }));
  addPlane('Alpha2', 0, 0,  2.0, new BasicMaterial({ color: [0.3, 0.4, 1.0, 0.6], blending: 'normal' }));

  // ── RIGHT: additive blended panes ─────────────────────────────────────────
  addPlane('Add0', 9, 0, -2.0, new BasicMaterial({ color: [1.0, 0.0, 0.0, 0.8], blending: 'additive' }));
  addPlane('Add1', 9, 0,  0.0, new BasicMaterial({ color: [0.0, 1.0, 0.0, 0.8], blending: 'additive' }));
  addPlane('Add2', 9, 0,  2.0, new BasicMaterial({ color: [0.0, 0.0, 1.0, 0.8], blending: 'additive' }));

  // ── Render loop ────────────────────────────────────────────────────────────
  engine.switchScene(scene);
  engine.run();
}

main().catch(console.error);
