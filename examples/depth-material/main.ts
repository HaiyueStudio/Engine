import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import { Mesh3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { DepthMaterial } from '@haiyue/engine/material';
import { ColorSRGB } from '@haiyue/engine';
import { createBox3D } from '@haiyue/engine';
import { createSphere3D } from '@haiyue/engine';
import { createCone3D } from '@haiyue/engine/geometry';
import { OrbitControl } from '@haiyue/engine';
import { mat4 } from 'wgpu-matrix';

// ─────────────────────────────────────────────────────────────────────────────
// Depth material demo
//
// Scene: several objects spread at different depths.
// P — toggle perspective / orthographic projection
// V — toggle between DepthMaterial (grayscale depth) and BasicMaterial (color)
// ─────────────────────────────────────────────────────────────────────────────

const NEAR = 1;
const FAR  = 60;

interface ObjectRecord {
  entity:        Entity;
  mesh:          Mesh3D;
  depthMaterial: DepthMaterial;
  colorMaterial: BasicMaterial;
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.05, g: 0.05, b: 0.1, a: 1 },
  });
  await engine.init();

  let isOrtho = false;
  const scene = engine.createScene({
    name: 'DepthMaterial',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: NEAR, far: FAR },
      orbit: {
        radius: 22,
        theta: Math.PI * 0.15,
        phi: Math.PI * 0.3,
        target: [0, 0, 0],
      },
    },
    render3D: { loadOp: 'clear' },
    pipelineLabel: 'DepthMaterial.render',
  });
  const cam3d = scene.cameraEntity.getComponent(Camera3D)!;
  const camSph = scene.cameraEntity.getComponent(SphericalTransform3D)!;

  new OrbitControl(canvas, camSph, { minRadius: 5, maxRadius: 60 });

  // ── Objects at varying depths ────────────────────────────────────────────────
  const geoBox    = createBox3D({ width: 2, height: 2, depth: 2 });
  const geoSphere = createSphere3D({ radius: 1.2, widthSegments: 24, heightSegments: 16 });
  const geoCone   = createCone3D({ radius: 1.1, height: 2.4, radialSegments: 24 });

  const placements: Array<{ geo: ReturnType<typeof createBox3D>; pos: [number, number, number]; color: [number, number, number] }> = [
    { geo: geoBox,    pos: [-6,  0, -2],  color: [1.0, 0.3, 0.3] },
    { geo: geoSphere, pos: [ 0,  0,  0],  color: [0.3, 1.0, 0.3] },
    { geo: geoCone,   pos: [ 6,  0,  2],  color: [0.3, 0.5, 1.0] },
    { geo: geoBox,    pos: [-4,  0, -10], color: [1.0, 0.8, 0.2] },
    { geo: geoSphere, pos: [ 4,  0, -12], color: [0.8, 0.3, 1.0] },
    { geo: geoCone,   pos: [ 0,  0, -18], color: [0.2, 0.9, 0.9] },
    { geo: geoBox,    pos: [-3,  0,  8],  color: [1.0, 0.5, 0.1] },
    { geo: geoSphere, pos: [ 5,  0,  6],  color: [0.5, 0.9, 0.3] },
  ];

  const objects: ObjectRecord[] = [];

  for (const { geo, pos, color } of placements) {
    const depthMaterial = new DepthMaterial({ near: NEAR, far: FAR, isOrthographic: false });
    const colorMaterial = new BasicMaterial({ color: new ColorSRGB(...color, 1) });

    const transform = new Transform3D();
    transform.localMatrix = mat4.translation(pos) as Float32Array;

    const mesh = new Mesh3D(geo, depthMaterial);

    const entity = new Entity('Object');
    entity.addComponent(transform);
    entity.addComponent(mesh);
    scene.add(entity);

    objects.push({ entity, mesh, depthMaterial, colorMaterial });
  }

  // ── UI ───────────────────────────────────────────────────────────────────────
  let showDepth = true;

  const btnProj = document.getElementById('btn-proj') as HTMLButtonElement;
  const btnView = document.getElementById('btn-view') as HTMLButtonElement;

  function updateUI() {
    btnProj.textContent = `Projection: ${isOrtho ? 'Orthographic' : 'Perspective'}`;
    btnProj.className   = isOrtho ? 'active' : '';
    btnView.textContent = `View: ${showDepth ? 'Depth' : 'Color'}`;
    btnView.className   = showDepth ? 'active' : '';
  }

  function toggleProjection() {
    isOrtho = !isOrtho;
    if (isOrtho) {
      cam3d.projectionType = 'orthographic';
      cam3d.orthoLeft   = -14;
      cam3d.orthoRight  =  14;
      cam3d.orthoTop    =  9.33;
      cam3d.orthoBottom = -9.33;
      cam3d.near = NEAR;
      cam3d.far  = FAR;
    } else {
      cam3d.projectionType = 'perspective';
      cam3d.fov  = Math.PI / 4;
      cam3d.near = NEAR;
      cam3d.far  = FAR;
    }
    cam3d.setDirty();
    for (const { depthMaterial } of objects) {
      depthMaterial.isOrthographic = isOrtho;
    }
    updateUI();
  }

  function toggleView() {
    showDepth = !showDepth;
    for (const { mesh, depthMaterial, colorMaterial } of objects) {
      mesh.material = showDepth ? depthMaterial : colorMaterial;
    }
    updateUI();
  }

  btnProj.addEventListener('click', toggleProjection);
  btnView.addEventListener('click', toggleView);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'p' || e.key === 'P') btnProj.click();
    if (e.key === 'v' || e.key === 'V') btnView.click();
  });

  updateUI();

  // ── Render loop ───────────────────────────────────────────────────────────────
  engine.switchScene(scene);
  engine.run();
}

main().catch(console.error);
