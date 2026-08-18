import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { InstancedMesh3D } from '@haiyue/engine/components';
import { InstancedMesh3DRenderSystem } from '@haiyue/engine/systems';
import { InstancedMaterial } from '@haiyue/engine/material';
import { createBox3D } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';
import { mat4 } from 'wgpu-matrix';

// ---------------------------------------------------------------------------
// Instancing demo — 100 cubes, each with a unique hue, rendered in 1 draw call.
// ---------------------------------------------------------------------------

const INSTANCE_COUNT = 100;
const GRID = 10;            // 10×10 grid
const SPACING = 2.8;

/** Convert hue [0,1] + fixed saturation/value to linear RGB. */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i  = Math.floor(h * 6);
  const f  = h * 6 - i;
  const p  = v * (1 - s);
  const q  = v * (1 - f * s);
  const t  = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.03, g: 0.03, b: 0.07, a: 1 },
  });
  await engine.init();

  // ── Camera ─────────────────────────────────────────────────────────────────
  const camSph = new SphericalTransform3D({
    radius: 32,
    theta:  Math.PI * 0.2,
    phi:    Math.PI * 0.35,
    target: [0, 0, 0],
  });
  const camEntity = new Entity('Camera');
  camEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 300 }));
  camEntity.addComponent(camSph);
  const scene = engine.createScene({
    name: 'Instancing',
    camera: camEntity,
    render3D: false,
  });

  new OrbitControl(canvas, camSph, { minRadius: 5, maxRadius: 100 });

  // ── Instanced geometry + material ──────────────────────────────────────────
  const geometry = createBox3D({ width: 1.5, height: 1.5, depth: 1.5 });
  const material = new InstancedMaterial(INSTANCE_COUNT);

  const offset = ((GRID - 1) * SPACING) / 2;

  for (let i = 0; i < INSTANCE_COUNT; i++) {
    const col = i % GRID;
    const row = Math.floor(i / GRID);

    // Position in a 10×10 grid centred at origin
    const x = col * SPACING - offset;
    const z = row * SPACING - offset;

    // Color: hue sweeps across hue wheel based on instance index
    const hue = i / INSTANCE_COUNT;
    const [r, g, b] = hsvToRgb(hue, 0.85, 0.95);
    material.setColor(i, r, g, b);

    // Initial transform: translate to grid position
    const m = mat4.translation([x, 0, z]) as Float32Array;
    material.setTransform(i, m);
  }

  const meshEntity = new Entity('InstancedCubes');
  meshEntity.addComponent(new InstancedMesh3D(geometry, material));
  scene.add(meshEntity);

  // ── Render system ──────────────────────────────────────────────────────────
  scene.addSystem(new InstancedMesh3DRenderSystem(engine, camEntity, { loadOp: 'clear' }));

  // ── Render loop ────────────────────────────────────────────────────────────
  engine.switchScene(scene);
  engine.on('update', ({ detail: { time } }) => {
    const t = time * 0.001;

    // Rotate each cube at a different speed based on its index
    for (let i = 0; i < INSTANCE_COUNT; i++) {
      const col = i % GRID;
      const row = Math.floor(i / GRID);
      const x = col * SPACING - offset;
      const z = row * SPACING - offset;

      // Unique rotation speed per instance
      const speed = 0.3 + (i / INSTANCE_COUNT) * 1.2;
      const angle = t * speed;

      const m = mat4.multiply(
        mat4.translation([x, 0, z]),
        mat4.rotationY(angle),
      ) as Float32Array;
      material.setTransform(i, m);
    }

  });

  engine.run();
}

main().catch(console.error);
