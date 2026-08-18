import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera2D } from '@haiyue/engine';
import { Transform2D } from '@haiyue/engine';
import { Mesh2D } from '@haiyue/engine';
import { Material2D } from '@haiyue/engine';
import type { BlendMode2D } from '@haiyue/engine/material';
import { ColorSRGB } from '@haiyue/engine';
import { createRect2D, createCircle2D, createTriangle2D, createPolygon2D } from '@haiyue/engine/geometry';

// ─────────────────────────────────────────────────────────────────────────────
// 2D shapes demo
//
// Displays four shape types arranged in a 2×2 grid, each with a distinct
// colour and alpha.  A fifth large semi-transparent circle sits behind them
// to showcase blending modes.
//
// Keyboard:
//   1 – Opaque    (blending: 'none')
//   2 – Normal alpha (blending: 'normal')
//   3 – Additive  (blending: 'additive')
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({ canvas });
  await engine.init();

  // ── Camera ────────────────────────────────────────────────────────────────
  const camEntity = new Entity();
  camEntity.addComponent(new Camera2D());
  const scene = engine.createScene({
    name: 'Shapes2D',
    camera: { type: '2d', entity: camEntity },
    render3D: false,
    render2D: { loadOp: 'clear' },
    pipelineLabel: 'Shapes2D.render',
  });

  // ── Helper: build a shape entity ─────────────────────────────────────────
  function makeShape(
    geometry: ReturnType<typeof createRect2D>,
    color: [number, number, number, number],
    x: number,
    y: number,
    scaleX = 1,
    scaleY = 1,
  ): Entity {
    const e = new Entity();
    const mat = new Material2D({ color: new ColorSRGB(...color), blending: 'normal' });
    e.addComponent(new Mesh2D(geometry, mat));
    e.addComponent(new Transform2D({ x, y, scaleX, scaleY }));
    scene.add(e);
    return e;
  }

  // ── Background disc (large, semi-transparent) ─────────────────────────────
  const bgCircle = makeShape(
    createCircle2D({ radius: 280, segments: 64 }),
    [0.15, 0.15, 0.35, 0.55],
    0, 0,
  );

  // ── Rectangle (top-left) ─────────────────────────────────────────────────
  const rect = makeShape(
    createRect2D({ width: 200, height: 130 }),
    [0.2, 0.6, 1.0, 0.85],
    -220, 110,
  );

  // ── Circle (top-right) ───────────────────────────────────────────────────
  const circle = makeShape(
    createCircle2D({ radius: 80, segments: 48 }),
    [1.0, 0.35, 0.35, 0.85],
    200, 110,
  );

  // ── Triangle (bottom-left) ────────────────────────────────────────────────
  const triangle = makeShape(
    createTriangle2D({ p1: [0, 90], p2: [-90, -70], p3: [90, -70] }),
    [0.3, 1.0, 0.5, 0.85],
    -220, -110,
  );

  // ── Pentagon (bottom-right) ───────────────────────────────────────────────
  const pentagon = makeShape(
    createPolygon2D({ sides: 5, radius: 80 }),
    [1.0, 0.85, 0.2, 0.85],
    200, -110,
  );

  // Collect materials for blend-mode switching
  const allMats: Material2D[] = [bgCircle, rect, circle, triangle, pentagon]
    .map(e => e.getComponent(Mesh2D)!.material);

  // ── Blend-mode UI ─────────────────────────────────────────────────────────
  let blendMode: BlendMode2D = 'normal';

  const btnNone     = document.getElementById('btn-none')!;
  const btnNormal   = document.getElementById('btn-normal')!;
  const btnAdditive = document.getElementById('btn-additive')!;
  const buttons     = [btnNone, btnNormal, btnAdditive];

  function setBlend(mode: BlendMode2D, activeBtn: HTMLElement) {
    blendMode = mode;
    allMats.forEach(m => { m.blending = mode; });
    buttons.forEach(b => b.classList.remove('active'));
    activeBtn.classList.add('active');
  }

  btnNone    .addEventListener('click', () => setBlend('none',     btnNone));
  btnNormal  .addEventListener('click', () => setBlend('normal',   btnNormal));
  btnAdditive.addEventListener('click', () => setBlend('additive', btnAdditive));

  document.addEventListener('keydown', (e) => {
    if (e.key === '1') setBlend('none',     btnNone);
    if (e.key === '2') setBlend('normal',   btnNormal);
    if (e.key === '3') setBlend('additive', btnAdditive);
  });

  // Default active
  btnNormal.classList.add('active');

  // ── Transforms for animation ──────────────────────────────────────────────
  const rectT     = rect    .getComponent(Transform2D)!;
  const circleT   = circle  .getComponent(Transform2D)!;
  const triangleT = triangle.getComponent(Transform2D)!;
  const pentagonT = pentagon.getComponent(Transform2D)!;
  const bgT       = bgCircle.getComponent(Transform2D)!;

  // ── Render loop ───────────────────────────────────────────────────────────
  engine.switchScene(scene);
  engine.on('update', ({ detail: { time } }) => {
    const t = time / 1000;

    rectT.rotation     =  t * 0.6;
    circleT.rotation   = -t * 0.4;
    triangleT.rotation =  t * 0.9;
    pentagonT.rotation = -t * 0.5;
    bgT.rotation       =  t * 0.08;

    // Gentle pulse on background disc
    const pulse = 1.0 + 0.06 * Math.sin(t * 1.2);
    bgT.scaleX = pulse;
    bgT.scaleY = pulse;

  });

  engine.run();
}

main();
