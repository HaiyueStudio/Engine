import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import type { World } from '@haiyue/engine';

// 3D
import { Camera3D } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { createBox3D } from '@haiyue/engine';
import { createSphere3D } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';
import { requiredItemAt } from '../arrayAccess';

// 2D
import { Camera2D } from '@haiyue/engine';
import { Transform2D } from '@haiyue/engine';
import { Mesh2D } from '@haiyue/engine';
import { Material2D } from '@haiyue/engine';
import { createRect2D, createCircle2D, createPolygon2D } from '@haiyue/engine/geometry';

// ─────────────────────────────────────────────────────────────────────────────
// Mixed 3D + 2D demo
//
// A single World contains both 3D mesh entities and 2D HUD entities.
// Rendering order is controlled by System.priority:
//
//   priority 0 – Render3DSystem   (3D scene, clears the canvas)
//   priority 1 – Mesh2DRenderSystem  (2D HUD, loadOp:'load', always on top)
//
// The 2D pipeline uses depthCompare:'always' + depthWriteEnabled:false,
// so HUD shapes are never occluded by 3D depth values.
//
// HUD elements:
//   • Crosshair (center)
//   • Health bar (bottom-left)
//   • Radar ring + dot (bottom-right)
//   • Semi-transparent top strip (simulates a skill bar)
//   • Corner brackets (top-right)
// ─────────────────────────────────────────────────────────────────────────────

// ── Palette helpers ───────────────────────────────────────────────────────────
const rgba = (r: number, g: number, b: number, a: number) =>
  new ColorSRGB(r, g, b, a);

// ── HUD builder ───────────────────────────────────────────────────────────────

interface HudEntity { entity: Entity; transform: Transform2D; }

function makeHud(world: World, W: number, H: number): {
  hudEntities: HudEntity[];
  healthBarFill: Transform2D;
  radarDot: Transform2D;
} {
  const hudEntities: HudEntity[] = [];

  function add2D(
    geo: ReturnType<typeof createRect2D>,
    color: ColorSRGB,
    x: number, y: number,
    scaleX = 1, scaleY = 1,
    rotation = 0,
    blending: 'none' | 'normal' | 'additive' = 'normal',
  ): HudEntity {
    const e = new Entity();
    const mat = new Material2D({ color, blending });
    e.addComponent(new Mesh2D(geo, mat));
    const t = new Transform2D({ x, y, scaleX, scaleY, rotation });
    e.addComponent(t);
    world.addEntity(e);
    hudEntities.push({ entity: e, transform: t });
    return { entity: e, transform: t };
  }

  const hw = W / 2;
  const hh = H / 2;

  // ── Crosshair (centre) ────────────────────────────────────────────────────
  const chColor = rgba(0.9, 0.95, 0.9, 0.85);
  const chLen = 12, chThick = 2, chGap = 6;
  // horizontal bar
  add2D(createRect2D({ width: chLen, height: chThick }), chColor, -(chGap + chLen / 2), 0);
  add2D(createRect2D({ width: chLen, height: chThick }), chColor,  (chGap + chLen / 2), 0);
  // vertical bar
  add2D(createRect2D({ width: chThick, height: chLen }), chColor, 0, -(chGap + chLen / 2));
  add2D(createRect2D({ width: chThick, height: chLen }), chColor, 0,  (chGap + chLen / 2));
  // dot
  add2D(createCircle2D({ radius: 2, segments: 8 }), chColor, 0, 0);

  // ── Health bar (bottom-left) ──────────────────────────────────────────────
  const barX = -hw + 20;
  const barY = -hh + 30;
  const barW = 180, barH = 14;

  // background track
  add2D(createRect2D({ width: barW + 4, height: barH + 4 }),
    rgba(0, 0, 0, 0.55), barX + barW / 2, barY);

  // fill (starts at 70 % health — update in loop)
  const fillHealth = 0.7;
  const healthFill = add2D(
    createRect2D({ width: barW, height: barH }),
    rgba(0.15, 0.9, 0.35, 0.9),
    barX + (barW * fillHealth) / 2, barY,
    fillHealth,
  );
  // label strip (thin top line)
  add2D(createRect2D({ width: barW, height: 2 }),
    rgba(0.3, 1, 0.5, 0.5), barX + barW / 2, barY + barH / 2 + 1);

  // ── Skill bar (bottom-centre) ─────────────────────────────────────────────
  const slotW = 40, slotH = 40, slotGap = 6;
  const numSlots = 5;
  const sbTotalW = numSlots * slotW + (numSlots - 1) * slotGap;
  const slotColors = [
    rgba(0.4, 0.7, 1.0, 0.8),
    rgba(1.0, 0.5, 0.2, 0.8),
    rgba(0.8, 0.3, 1.0, 0.8),
    rgba(0.2, 0.9, 0.6, 0.8),
    rgba(1.0, 0.9, 0.2, 0.8),
  ];
  for (let i = 0; i < numSlots; i++) {
    const sx = -(sbTotalW / 2) + i * (slotW + slotGap) + slotW / 2;
    const sy = -hh + 30;
    // slot bg
    add2D(createRect2D({ width: slotW, height: slotH }),
      rgba(0, 0, 0, 0.5), sx, sy);
    // slot icon (inner polygon)
    const sides = 3 + i;
    add2D(createPolygon2D({ sides, radius: 12 }),
      requiredItemAt(slotColors, i, 'mixed scene slot colors'), sx, sy);
    // slot border
    add2D(createRect2D({ width: slotW, height: 2 }),
      rgba(1, 1, 1, 0.15), sx, sy - slotH / 2 + 1);
  }

  // ── Radar (bottom-right) ──────────────────────────────────────────────────
  const radarX = hw - 70;
  const radarY = -hh + 70;
  const radarR = 55;

  // outer ring (filled circle + darker inner = ring via additive layers)
  add2D(createCircle2D({ radius: radarR, segments: 64 }),
    rgba(0.05, 0.2, 0.1, 0.7), radarX, radarY);
  // inner mask
  add2D(createCircle2D({ radius: radarR - 3, segments: 64 }),
    rgba(0.02, 0.08, 0.04, 0.8), radarX, radarY);

  // compass ticks (4 cardinal lines)
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const tx = radarX + Math.cos(angle) * (radarR - 8);
    const ty = radarY + Math.sin(angle) * (radarR - 8);
    add2D(createRect2D({ width: 10, height: 2 }),
      rgba(0.3, 0.9, 0.4, 0.6), tx, ty, 1, 1, angle);
  }

  // sweep line
  add2D(createRect2D({ width: radarR - 4, height: 1 }),
    rgba(0.2, 1, 0.4, 0.5),
    radarX + (radarR - 4) / 2, radarY);

  // enemy dot (animated in loop)
  const radarDot = add2D(
    createCircle2D({ radius: 4, segments: 12 }),
    rgba(1, 0.2, 0.2, 1),
    radarX + 20, radarY - 15,
  );

  // friendly dot (player = centre)
  add2D(createCircle2D({ radius: 4, segments: 12 }),
    rgba(0.2, 1, 0.4, 1), radarX, radarY);

  // ── Corner bracket (top-right) ────────────────────────────────────────────
  const bkX = hw - 30, bkY = hh - 30;
  const bkLen = 20, bkT = 2;
  const bkColor = rgba(0.4, 0.85, 1.0, 0.7);
  // horizontal
  add2D(createRect2D({ width: bkLen, height: bkT }), bkColor, bkX - bkLen / 2, bkY);
  // vertical
  add2D(createRect2D({ width: bkT, height: bkLen }), bkColor, bkX, bkY - bkLen / 2);

  // top-left bracket
  const blX = -hw + 30, blY = hh - 30;
  add2D(createRect2D({ width: bkLen, height: bkT }), bkColor, blX + bkLen / 2, blY);
  add2D(createRect2D({ width: bkT, height: bkLen }), bkColor, blX, blY - bkLen / 2);

  // ── Top info strip ────────────────────────────────────────────────────────
  add2D(createRect2D({ width: W * 0.4, height: 28 }),
    rgba(0, 0.1, 0.2, 0.55), 0, hh - 20);

  return { hudEntities, healthBarFill: healthFill.transform, radarDot: radarDot.transform };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const W = 900, H = 600;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.04, g: 0.04, b: 0.09, a: 1 },
  });
  await engine.init();

  // ── 3D Camera ─────────────────────────────────────────────────────────────
  const spherical = new SphericalTransform3D({
    radius: 14, theta: Math.PI / 5, phi: Math.PI / 3, target: [0, 0, 0],
  });
  const cam3DEntity = new Entity('Camera3D');
  cam3DEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 200 }));
  cam3DEntity.addComponent(spherical);
  const scene = engine.createScene({
    name: 'MixedScene',
    camera: cam3DEntity,
    render3D: { priority: 0, loadOp: 'clear' },
    render2D: { priority: 1, loadOp: 'load' },
    gui: false,
    pipelineLabel: 'MixedScene.render',
  });
  const { world } = scene;

  const orbitControl = new OrbitControl(canvas, spherical, {
    minRadius: 3, maxRadius: 80, rotateSpeed: 0.8, zoomSpeed: 1.0,
  });

  // ── 3D scene ──────────────────────────────────────────────────────────────
  const palette = [
    rgba(0.9, 0.3, 0.3, 1),
    rgba(0.3, 0.8, 0.45, 1),
    rgba(0.3, 0.55, 0.95, 1),
    rgba(0.95, 0.75, 0.2, 1),
    rgba(0.75, 0.3, 0.95, 1),
    rgba(0.3, 0.9, 0.9, 1),
  ];

  const boxGeo  = createBox3D({ width: 1.2, height: 1.2, depth: 1.2 });
  const sphereGeo = createSphere3D({ radius: 0.7, widthSegments: 24, heightSegments: 16 });

  // Grid of boxes
  const meshEntities: { entity: Entity; t: CartesianTransform3D; rotSpeed: [number, number] }[] = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const e = new Entity(`Box_${i}_${j}`);
      const t = new CartesianTransform3D({
        position: [(i - 1.5) * 3, 0, (j - 1.5) * 3],
      });
      e.addComponent(t);
      e.addComponent(new Mesh3D(boxGeo, new BasicMaterial({
        color: requiredItemAt(palette, (i * 4 + j) % palette.length, 'mixed scene palette').clone(),
      })));
      world.addEntity(e);
      meshEntities.push({ entity: e, t, rotSpeed: [(i + 1) * 0.003, (j + 1) * 0.004] });
    }
  }

  // Orbiting spheres
  const orbitSpheres: { entity: Entity; t: CartesianTransform3D; angle: number; speed: number; r: number; y: number }[] = [];
  const sphereColors = [rgba(1, 0.4, 0.2, 1), rgba(0.2, 0.8, 1, 1), rgba(0.9, 0.9, 0.2, 1)];
  for (let i = 0; i < 3; i++) {
    const e = new Entity(`Sphere_${i}`);
    const t = new CartesianTransform3D({ position: [5, 0, 0] });
    e.addComponent(t);
    e.addComponent(new Mesh3D(sphereGeo, new BasicMaterial({ color: requiredItemAt(sphereColors, i, 'mixed scene sphere colors').clone() })));
    world.addEntity(e);
    orbitSpheres.push({ entity: e, t, angle: (i * Math.PI * 2) / 3, speed: 0.6 + i * 0.3, r: 5 + i * 1.5, y: (i - 1) * 1.5 });
  }

  // ── 2D camera ────────────────────────────────────────────────────────────
  const cam2DEntity = new Entity('Camera2D');
  cam2DEntity.addComponent(new Camera2D());
  world.addEntity(cam2DEntity);
  scene.render2DSystem?.setCameraEntity(cam2DEntity);

  // ── HUD entities ──────────────────────────────────────────────────────────
  const { hudEntities, healthBarFill, radarDot } = makeHud(world, W, H);

  const render2D = scene.render2DSystem!;

  // ── HUD toggle ────────────────────────────────────────────────────────────
  let hudVisible = true;
  const btnShow = document.getElementById('btn-show')!;
  const btnHide = document.getElementById('btn-hide')!;

  function setHudVisible(v: boolean) {
    hudVisible = v;
    render2D.disabled = !v;
    btnShow.classList.toggle('active',  v);
    btnHide.classList.toggle('active', !v);
  }

  btnShow.addEventListener('click', () => setHudVisible(true));
  btnHide.addEventListener('click', () => setHudVisible(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H') setHudVisible(!hudVisible);
  });
  setHudVisible(true);

  // ── Render loop ───────────────────────────────────────────────────────────
  engine.on('update', ({ detail: { time, delta } }) => {
    const t = time / 1000;

    // Orbit spheres
    for (const s of orbitSpheres) {
      s.angle += s.speed * delta / 1000;
      s.t.setPosition(
        Math.cos(s.angle) * s.r,
        s.y,
        Math.sin(s.angle) * s.r,
      );
    }

    // Spin boxes
    for (const m of meshEntities) {
      m.t.setRotation(
        Math.sin(t * m.rotSpeed[0]) * 0.8,
        t * m.rotSpeed[1],
        0,
      );
    }

    // Animate HUD: radar dot orbit
    const radarR = 55;
    const radarX = W / 2 - 70;
    const radarY = -(H / 2 - 70);
    const dotAngle = t * 0.7;
    const dotR = 22;
    radarDot.x = radarX + Math.cos(dotAngle) * dotR;
    radarDot.y = radarY + Math.sin(dotAngle) * dotR;

    // Pulse health bar
    const health = 0.65 + 0.05 * Math.sin(t * 0.5);
    const barW = 180;
    const barX = -W / 2 + 20;
    healthBarFill.x = barX + (barW * health) / 2;
    healthBarFill.scaleX = health;

  });

  engine.switchScene(scene);
  engine.run();
}

main();
