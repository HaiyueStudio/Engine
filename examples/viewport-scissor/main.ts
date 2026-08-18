import { HaiyueEngine } from '@haiyue/engine';
import { World } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { Render3DSystem } from '@haiyue/engine/systems';
import { RenderIntegration, RenderView, RenderViewFamily } from '@haiyue/engine/experimental';
import { createBox3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';
import type { ViewportRect, ScissorRect } from '@haiyue/engine/core';
import { requiredItemAt } from '../arrayAccess';

// ---------------------------------------------------------------------------
// Viewport & Scissor Demo — 4-pane split-screen
//
// Canvas is fullscreen. Each pane occupies one quadrant of the current canvas.
//
//   ┌──────────┬──────────┐
//   │  FRONT   │  TOP     │
//   │ (persp)  │ (ortho)  │
//   ├──────────┼──────────┤
//   │  SIDE    │  FREE    │
//   │ (ortho)  │ (orbit)  │
//   └──────────┴──────────┘
//
// One Render3DSystem extracts the scene once, then renders four view-local
// camera/culling/sort/LOD frames. The first view clears the target and the
// remaining views load it before drawing their viewport/scissor region.
// ---------------------------------------------------------------------------

type PaneId = 'tl' | 'tr' | 'bl' | 'br';

interface PaneLayout {
  id: PaneId;
  viewport: ViewportRect;
  scissor: ScissorRect;
}

function paneRect(x: number, y: number, width: number, height: number): { viewport: ViewportRect; scissor: ScissorRect } {
  return {
    viewport: { x, y, width, height },
    scissor:  { x, y, width, height },
  };
}

function getPaneLayouts(engine: HaiyueEngine): PaneLayout[] {
  const leftWidth = Math.floor(engine.width / 2);
  const topHeight = Math.floor(engine.height / 2);
  const rightWidth = engine.width - leftWidth;
  const bottomHeight = engine.height - topHeight;
  return [
    { id: 'tl', ...paneRect(0, 0, leftWidth, topHeight) },
    { id: 'tr', ...paneRect(leftWidth, 0, rightWidth, topHeight) },
    { id: 'bl', ...paneRect(0, topHeight, leftWidth, bottomHeight) },
    { id: 'br', ...paneRect(leftWidth, topHeight, rightWidth, bottomHeight) },
  ];
}

// ── Scene objects (shared across all four views) ───────────────────────────

function buildScene(world: World): void {
  const boxGeo = createBox3D({ width: 1, height: 1, depth: 1 });
  const palette = [
    new ColorSRGB(0.9, 0.3, 0.3),
    new ColorSRGB(0.3, 0.8, 0.4),
    new ColorSRGB(0.3, 0.5, 0.95),
    new ColorSRGB(0.9, 0.75, 0.2),
    new ColorSRGB(0.7, 0.3, 0.9),
    new ColorSRGB(0.25, 0.8, 0.85),
  ];

  // 3×3 grid of boxes on the XZ plane
  let idx = 0;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const e = new Entity(`Box_${i}_${j}`);
      e.addComponent(new CartesianTransform3D({ position: [i * 2.2, 0, j * 2.2] }));
      e.addComponent(new Mesh3D(boxGeo, new BasicMaterial({ color: requiredItemAt(palette, idx++ % palette.length, 'viewport palette').clone() })));
      world.addEntity(e);
    }
  }

  // Central tall landmark
  const tall = new Entity('Tall');
  tall.addComponent(new CartesianTransform3D({ position: [0, 1.8, 0] }));
  tall.addComponent(new Mesh3D(
    createBox3D({ width: 0.4, height: 3.6, depth: 0.4 }),
    new BasicMaterial({ color: new ColorSRGB(1, 1, 0.35) }),
  ));
  world.addEntity(tall);

  // Ground
  const ground = new Entity('Ground');
  ground.addComponent(new CartesianTransform3D({ position: [0, -0.52, 0] }));
  ground.addComponent(new Mesh3D(
    createBox3D({ width: 12, height: 0.04, depth: 12 }),
    new BasicMaterial({ color: new ColorSRGB(0.16, 0.16, 0.2) }),
  ));
  world.addEntity(ground);
}

// ── Camera factory helpers ─────────────────────────────────────────────────

function makePerspCamera(
  world: World, pos: [number, number, number], label: string,
): Entity {
  const e = new Entity(label);
  e.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 200 }));
  e.addComponent(new CartesianTransform3D({ position: pos }));
  world.addEntity(e);
  return e;
}

function makeOrthoCamera(
  world: World, pos: [number, number, number], label: string, size: number,
): Entity {
  const aspect = 1;
  const h = size / 2;
  const w = h * aspect;
  const e = new Entity(label);
  e.addComponent(new Camera3D({
    type: 'orthographic',
    left: -w, right: w, top: h, bottom: -h,
    near: 0.1, far: 200,
  }));
  e.addComponent(new CartesianTransform3D({ position: pos }));
  world.addEntity(e);
  return e;
}

function setOrthoBounds(camera: Camera3D, size: number, aspect: number): void {
  const h = size / 2;
  const w = h * aspect;
  camera.orthoLeft = -w;
  camera.orthoRight = w;
  camera.orthoTop = h;
  camera.orthoBottom = -h;
  camera.setDirty();
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.06, g: 0.06, b: 0.1, a: 1 },
  });
  await engine.init();

  const world = new World('ViewportScissor');

  // ── Scene ────────────────────────────────────────────────────────────────
  buildScene(world);

  // ── Cameras ───────────────────────────────────────────────────────────────
  // FRONT — perspective, camera at +Z looking at origin
  const frontCam = makePerspCamera(world, [0, 2, 12], 'CamFront');
  // Aim the camera: add a small downward tilt so it looks at the scene
  frontCam.getComponent(CartesianTransform3D)!.setRotation(-0.12, 0, 0);

  // TOP — orthographic, bird's-eye view
  const topCam = makeOrthoCamera(world, [0, 15, 0], 'CamTop', 14);
  // Rotate to look straight down (-Y direction = camera looking down)
  topCam.getComponent(CartesianTransform3D)!.setRotation(-Math.PI / 2, 0, 0);

  // SIDE — orthographic, from +X looking left
  const sideCam = makeOrthoCamera(world, [15, 2, 0], 'CamSide', 14);
  sideCam.getComponent(CartesianTransform3D)!.setRotation(0, Math.PI / 2, 0);

  // FREE — perspective with orbit control (SphericalTransform3D)
  const freeSpherical = new SphericalTransform3D({
    radius: 16, theta: Math.PI / 5, phi: Math.PI / 3, target: [0, 0, 0],
  });
  const freeCam = new Entity('CamFree');
  freeCam.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 200 }));
  freeCam.addComponent(freeSpherical);
  world.addEntity(freeCam);

  // Orbit control only fires inside the bottom-right pane
  new OrbitControl(canvas, freeSpherical, {
    minRadius: 2,
    maxRadius: 80,
    inputRegion: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  });

  // ── Render views — one family consumed by one Render3DSystem ──────────────
  const renderViews: { id: PaneId; view: RenderView }[] = [];
  const viewFamily = new RenderViewFamily();

  function addView(id: PaneId, cam: Entity, isFirst: boolean): void {
    const layout = getPaneLayouts(engine).find(pane => pane.id === id)!;
    const view = new RenderView({
      key: `viewport-scissor:${id}`,
      camera: cam,
      target: engine.renderTarget,
      viewport: layout.viewport,
      scissor: layout.scissor,
      loadOp: isFirst ? 'clear' : 'load',
    });
    renderViews.push({ id, view });
    viewFamily.add(view);
  }

  addView('tl', frontCam, true);
  addView('tr', topCam, false);
  addView('bl', sideCam, false);
  addView('br', freeCam, false);
  const renderSystem = new Render3DSystem(engine, frontCam);
  world.addSystem(renderSystem);
  const renderIntegration = new RenderIntegration(engine, { label: 'ViewportScissor.render', viewFamily });
  world.addRuntimeIntegration(renderIntegration);
  renderIntegration.register(renderSystem, { pass: 'isolated' });

  function syncPaneLayout(): void {
    const layouts = getPaneLayouts(engine);
    for (const { id, view } of renderViews) {
      const layout = layouts.find(pane => pane.id === id)!;
      view.viewport = layout.viewport;
      view.scissor = layout.scissor;
    }

    const topLayout = layouts.find(pane => pane.id === 'tr')!;
    const sideLayout = layouts.find(pane => pane.id === 'bl')!;
    setOrthoBounds(topCam.getComponent(Camera3D)!, 14, topLayout.viewport.width / topLayout.viewport.height);
    setOrthoBounds(sideCam.getComponent(Camera3D)!, 14, sideLayout.viewport.width / sideLayout.viewport.height);
  }

  // ── Render loop ───────────────────────────────────────────────────────────
  engine.on('update', ({ detail: { time, delta } }) => {
    syncPaneLayout();
    world.update(time, delta);
  });

  engine.run();
}

main().catch(console.error);
