import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import { Mesh3D } from '@haiyue/engine';
import { MeshHelper } from '@haiyue/engine/components';
import type { HelperMode } from '@haiyue/engine/components';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { createBox3D } from '@haiyue/engine';
import { createSphere3D } from '@haiyue/engine';
import { createCone3D } from '@haiyue/engine/geometry';
import { OrbitControl } from '@haiyue/engine';
import { mat4 } from 'wgpu-matrix';

// ─────────────────────────────────────────────────────────────────────────────
// Mesh helper demo
//
// Three objects side-by-side, all rotating.  Switch the helper mode with
// buttons or keyboard shortcuts 1 / 2 / 3:
//   1 – AABB  : axis-aligned world bounding box (grows as the object rotates)
//   2 – OBB   : object-oriented box (follows the object's rotation)
//   3 – Wireframe: edges of the geometry
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.04, g: 0.04, b: 0.09, a: 1 },
  });
  await engine.init();

  // ── Camera ───────────────────────────────────────────────────────────────────
  const camSph = new SphericalTransform3D({
    radius: 18,
    theta:  Math.PI * 0.15,
    phi:    Math.PI * 0.35,
    target: [0, 0, 0],
  });
  const camEntity = new Entity('Camera');
  camEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.5, far: 100 }));
  camEntity.addComponent(camSph);
  const scene = engine.createScene({
    name: 'MeshHelper',
    camera: camEntity,
  });

  new OrbitControl(canvas, camSph, { minRadius: 5, maxRadius: 40 });

  // ── Objects ──────────────────────────────────────────────────────────────────
  const geoBox    = createBox3D({ width: 2, height: 2.8, depth: 1.4 });
  const geoSphere = createSphere3D({ radius: 1.3, widthSegments: 20, heightSegments: 14 });
  const geoCone   = createCone3D({ radius: 1.1, height: 2.6, radialSegments: 20 });

  interface ObjectRecord {
    entity:    Entity;
    transform: Transform3D;
    helper:    MeshHelper;
    rotAxis:   [number, number, number];
    rotSpeed:  number;
  }

  const helperColor: [number, number, number, number] = [0.1, 1, 0.4, 1];

  const buildObject = (
    geo: ReturnType<typeof createBox3D>,
    x: number,
    color: [number, number, number],
    rotAxis: [number, number, number],
    rotSpeed: number,
  ): ObjectRecord => {
    const transform = new Transform3D();
    transform.localMatrix = mat4.translation([x, 0, 0]) as Float32Array;

    const helper = new MeshHelper({ mode: 'aabb', color: helperColor });

    const entity = new Entity('Object');
    entity.addComponent(transform);
    entity.addComponent(new Mesh3D(geo, new BasicMaterial({ color: new ColorSRGB(...color, 1) })));
    entity.addComponent(helper);
    scene.add(entity);

    return { entity, transform, helper, rotAxis, rotSpeed };
  };

  const objects: ObjectRecord[] = [
    buildObject(geoBox,    -5, [0.9, 0.4, 0.3], [0, 1, 0.3], 0.0006),
    buildObject(geoSphere,  0, [0.3, 0.8, 0.4], [1, 0.5, 0], 0.0008),
    buildObject(geoCone,    5, [0.3, 0.5, 1.0], [0.4, 1, 0.2], 0.0007),
  ];

  // ── UI ───────────────────────────────────────────────────────────────────────
  const btnAabb = document.getElementById('btn-aabb') as HTMLButtonElement;
  const btnObb  = document.getElementById('btn-obb')  as HTMLButtonElement;
  const btnWire = document.getElementById('btn-wire') as HTMLButtonElement;

  function setMode(mode: HelperMode) {
    for (const { helper } of objects) {
      helper.mode = mode;
    }
    btnAabb.className = mode === 'aabb'      ? 'active' : '';
    btnObb.className  = mode === 'obb'       ? 'active' : '';
    btnWire.className = mode === 'wireframe' ? 'active' : '';
  }

  btnAabb.addEventListener('click', () => setMode('aabb'));
  btnObb.addEventListener('click',  () => setMode('obb'));
  btnWire.addEventListener('click', () => setMode('wireframe'));

  window.addEventListener('keydown', (e) => {
    if (e.key === '1') btnAabb.click();
    if (e.key === '2') btnObb.click();
    if (e.key === '3') btnWire.click();
  });

  setMode('aabb');

  // ── Render loop ───────────────────────────────────────────────────────────────
  engine.switchScene(scene);
  engine.on('update', ({ detail: { time } }) => {
    for (const { transform, rotAxis, rotSpeed } of objects) {
      const angle = time * rotSpeed;
      const [ax, ay, az] = rotAxis;
      const len   = Math.sqrt(ax * ax + ay * ay + az * az);
      const rot   = mat4.axisRotation([ax / len, ay / len, az / len], angle) as Float32Array;
      // Keep translation, apply rotation
      const tx = transform.localMatrix[12] ?? 0;
      const ty = transform.localMatrix[13] ?? 0;
      const tz = transform.localMatrix[14] ?? 0;
      transform.localMatrix = rot;
      transform.localMatrix[12] = tx;
      transform.localMatrix[13] = ty;
      transform.localMatrix[14] = tz;
    }

  });

  engine.run();
}

main().catch(console.error);
