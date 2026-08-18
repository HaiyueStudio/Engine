import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { BlinnPhongRenderSystem } from '@haiyue/engine/systems';
import { BlinnPhongMaterial } from '@haiyue/engine/material';
import { ColorSRGB } from '@haiyue/engine';
import { AmbientLight } from '@haiyue/engine/lighting';
import { DirectionalLight } from '@haiyue/engine';
import { PointLight } from '@haiyue/engine/lighting';
import { createBox3D } from '@haiyue/engine';
import { createSphere3D } from '@haiyue/engine';
import { createCone3D } from '@haiyue/engine/geometry';
import { createPlane3D } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';
import { requiredItemAt, requiredNumberAt } from '../arrayAccess';

// ─────────────────────────────────────────────────────────────────────────────
// Blinn-Phong lighting demo
//
// Scene contains:
//   • Ground plane with a dull material
//   • 9 objects (boxes, spheres, cones) arranged in a 3×3 grid, each with
//     distinct diffuse/specular/shininess properties
//   • Ambient light, directional "sun", and a coloured orbiting point light
//
// Keyboard / UI:
//   A  – toggle ambient light
//   D  – toggle directional light
//   P  – toggle point light
//   S  – cycle shininess (low / med / high)
//   Left drag  – orbit camera
//   Scroll     – zoom
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.04, g: 0.04, b: 0.09, a: 1 },
  });
  await engine.init();

  // ── Camera ─────────────────────────────────────────────────────────────────
  const spherical = new SphericalTransform3D({
    radius: 16, theta: Math.PI / 6, phi: Math.PI / 3.5,
    target: [0, 0, 0],
  });
  const camEntity = new Entity('Camera');
  camEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 200 }));
  camEntity.addComponent(spherical);
  const scene = engine.createScene({
    name: 'BlinnPhong',
    camera: camEntity,
    render3D: { loadOp: 'clear', priority: 0 },
    render2D: false,
    gui: false,
    pipelineLabel: 'BlinnPhong.render',
  });
  const { world } = scene;

  const orbitCtl = new OrbitControl(canvas, spherical, {
    minRadius: 4, maxRadius: 60, rotateSpeed: 0.8,
  });

  // ── Render system ──────────────────────────────────────────────────────────
  const render3DSystem = scene.render3DSystem!;
  const blinnPhong = new BlinnPhongRenderSystem(engine, camEntity, { priority: -1, render3DSystem });
  scene.addSystem(blinnPhong);

  // ── Geometries (shared) ────────────────────────────────────────────────────
  const geoBox    = createBox3D({ width: 1.2, height: 1.2, depth: 1.2 });
  const geoSphere = createSphere3D({ radius: 0.7, widthSegments: 32, heightSegments: 20 });
  const geoCone   = createCone3D({ radius: 0.65, height: 1.3, radialSegments: 32 });
  const geoPlane  = createPlane3D({ width: 12, height: 12 });

  // ── Ground plane ───────────────────────────────────────────────────────────
  const ground = new Entity('Ground');
  ground.addComponent(new CartesianTransform3D({ position: [0, -0.85, 0] }));
  ground.addComponent(new Mesh3D(geoPlane, new BlinnPhongMaterial({
    ambient:   [0.05, 0.05, 0.05],
    diffuse:   [0.35, 0.35, 0.38],
    specular:  [0.1,  0.1,  0.1],
    shininess: 8,
  })));
  world.addEntity(ground);

  // ── 3×3 grid of objects ────────────────────────────────────────────────────
  // Each row uses a different geometry; each column varies the material.
  const rows: Array<{ geo: typeof geoBox; yOff: number }> = [
    { geo: geoBox,    yOff: 0    },
    { geo: geoSphere, yOff: 0    },
    { geo: geoCone,   yOff: -0.2 },
  ];

  // Column materials: matte, plastic, metallic
  const colMats = (diffuse: [number,number,number]) => [
    new BlinnPhongMaterial({ // matte
      ambient:   [diffuse[0]*0.08, diffuse[1]*0.08, diffuse[2]*0.08],
      diffuse:   [diffuse[0], diffuse[1], diffuse[2]],
      specular:  [0.05, 0.05, 0.05],
      shininess: 8,
    }),
    new BlinnPhongMaterial({ // plastic
      ambient:   [diffuse[0]*0.1, diffuse[1]*0.1, diffuse[2]*0.1],
      diffuse:   [diffuse[0], diffuse[1], diffuse[2]],
      specular:  [0.6, 0.6, 0.6],
      shininess: 64,
    }),
    new BlinnPhongMaterial({ // metallic (specular ≈ diffuse colour)
      ambient:   [diffuse[0]*0.1, diffuse[1]*0.1, diffuse[2]*0.1],
      diffuse:   [diffuse[0]*0.6, diffuse[1]*0.6, diffuse[2]*0.6],
      specular:  [diffuse[0], diffuse[1], diffuse[2]],
      shininess: 256,
    }),
  ];

  const palette: [number,number,number][] = [
    [0.9, 0.3, 0.2],
    [0.3, 0.75, 0.3],
    [0.25, 0.5, 1.0],
  ];

  // Keep materials for shininess animation
  const allMats: BlinnPhongMaterial[] = [];

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const { geo, yOff } = requiredItemAt(rows, row, 'Blinn-Phong rows');
      const mat = requiredItemAt(colMats(requiredItemAt(palette, col, 'Blinn-Phong palette')), row, 'Blinn-Phong materials');
      allMats.push(mat);

      const e = new Entity(`obj_${row}_${col}`);
      e.addComponent(new CartesianTransform3D({
        position: [(col - 1) * 3.2, yOff, (row - 1) * 3.2],
      }));
      e.addComponent(new Mesh3D(geo, mat));
      world.addEntity(e);
    }
  }

  // ── Lights ─────────────────────────────────────────────────────────────────

  // Ambient
  const ambientEntity = new Entity('AmbientLight');
  const ambientLight = new AmbientLight({ color: [1, 1, 1], intensity: 0.12 });
  ambientEntity.addComponent(ambientLight);
  world.addEntity(ambientEntity);

  // Directional "sun"
  const dirEntity = new Entity('DirLight');
  const dirLight = new DirectionalLight({
    color: [1, 0.95, 0.85], intensity: 1.0,
    direction: [-0.6, -1, -0.4],
  });
  dirEntity.addComponent(dirLight);
  world.addEntity(dirEntity);

  // Point light (orbiting, coloured) — position via CartesianTransform3D
  const pointEntity = new Entity('PointLight');
  const pointTransform = new CartesianTransform3D({ position: [5, 3, 0] });
  const pointLight = new PointLight({ color: [0.4, 0.7, 1.0], intensity: 2.5, range: 14 });
  pointEntity.addComponent(pointTransform);
  pointEntity.addComponent(pointLight);
  world.addEntity(pointEntity);

  // Small sphere to visualise the point-light position
  const bulbEntity = new Entity('PointLightBulb');
  const bulbTransform = new CartesianTransform3D({ position: [5, 3, 0] });
  bulbEntity.addComponent(bulbTransform);
  bulbEntity.addComponent(new Mesh3D(
    createSphere3D({ radius: 0.12, widthSegments: 12, heightSegments: 8 }),
    new BlinnPhongMaterial({
      ambient:  [0.4, 0.7, 1.0],
      diffuse:  [0.4, 0.7, 1.0],
      specular: [1, 1, 1],
      shininess: 512,
    }),
  ));
  world.addEntity(bulbEntity);

  // ── UI ─────────────────────────────────────────────────────────────────────
  const btnAmbient = document.getElementById('btn-ambient')!;
  const btnDir     = document.getElementById('btn-dir')!;
  const btnPoint   = document.getElementById('btn-point')!;
  const btnShLo    = document.getElementById('btn-sh-lo')!;
  const btnShMd    = document.getElementById('btn-sh-md')!;
  const btnShHi    = document.getElementById('btn-sh-hi')!;

  let ambientOn = true, dirOn = true, pointOn = true;
  const shininesses = [8, 64, 256];
  let shIdx = 1;

  function setAmbient(on: boolean) {
    ambientOn = on;
    ambientLight.intensity = on ? 0.12 : 0;
    btnAmbient.classList.toggle('active', on);
  }
  function setDir(on: boolean) {
    dirOn = on;
    dirLight.intensity = on ? 1.0 : 0;
    btnDir.classList.toggle('active', on);
  }
  function setPoint(on: boolean) {
    pointOn = on;
    pointLight.intensity = on ? 2.5 : 0;
    btnPoint.classList.toggle('active', on);
  }
  function setShininess(idx: number) {
    shIdx = idx;
    const sh = requiredNumberAt(shininesses, idx, 'shininess presets');
    allMats.forEach(m => { m.shininess = sh; });
    [btnShLo, btnShMd, btnShHi].forEach((b, i) => b.classList.toggle('active', i === idx));
  }

  btnAmbient.addEventListener('click', () => setAmbient(!ambientOn));
  btnDir    .addEventListener('click', () => setDir(!dirOn));
  btnPoint  .addEventListener('click', () => setPoint(!pointOn));
  btnShLo   .addEventListener('click', () => setShininess(0));
  btnShMd   .addEventListener('click', () => setShininess(1));
  btnShHi   .addEventListener('click', () => setShininess(2));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'a' || e.key === 'A') setAmbient(!ambientOn);
    if (e.key === 'd' || e.key === 'D') setDir(!dirOn);
    if (e.key === 'p' || e.key === 'P') setPoint(!pointOn);
    if (e.key === 's' || e.key === 'S') setShininess((shIdx + 1) % 3);
  });
  setShininess(1); // start at medium

  // ── Render loop ────────────────────────────────────────────────────────────
  engine.on('update', ({ detail: { time } }) => {
    const t = time / 1000;

    // Orbit the point light
    const r = 7;
    const px = Math.cos(t * 0.7) * r;
    const pz = Math.sin(t * 0.7) * r;
    const py = 3 + Math.sin(t * 1.1) * 1.5;
    pointTransform.setPosition(px, py, pz);
    bulbTransform .setPosition(px, py, pz);

    // Update point light colour (slow hue cycle)
    const hue = (t * 40) % 360;
    const [lr, lg, lb] = hslToRgb(hue / 360, 0.8, 0.65);
    if (pointLight.color instanceof ColorSRGB) pointLight.color.set(lr, lg, lb);
    const bm = bulbEntity.getComponent(Mesh3D)!.material as BlinnPhongMaterial;
    if (bm.ambient instanceof ColorSRGB) bm.ambient.set(lr * 0.8, lg * 0.8, lb * 0.8);
    if (bm.diffuse instanceof ColorSRGB) bm.diffuse.set(lr * 0.8, lg * 0.8, lb * 0.8);
    if (bm.specular instanceof ColorSRGB) bm.specular.set(lr, lg, lb);

  });

  engine.switchScene(scene);
  engine.run();
}

// HSL → RGB helper
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

main();
