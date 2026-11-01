import { HaiyueEngine } from '@haiyue/engine';
import { Entity, System } from '@haiyue/engine/ecs';
import { Camera2D, Transform2D, Mesh2D, KeyboardComponent } from '@haiyue/engine/components';
import { Physics2DSystem, Physics2DBody } from '@haiyue/engine/physics';
import { createBox2DPhysics2DBackend } from '@haiyue/engine/physics/backend';
import { createRect2D } from '@haiyue/engine/geometry';
import { Material2D } from '@haiyue/engine/material';
import { ColorSRGB } from '@haiyue/engine/color';
import { Mesh2DRenderSystem } from '@haiyue/engine/systems';
import { GuiRoot, GuiLabel, GuiButton, GuiSystem } from '@haiyue/engine/gui';
import { createCharacter2D } from '@haiyue/extensions/character2d';
import { createCamera2DController } from '@haiyue/extensions/camera2d';

/** This exact source is also strictly compiled against installed candidate tarballs. */
export async function createCameraExample(canvas: HTMLCanvasElement, options: { samples?: 1 | 4 } = {}) {
  const coldStart = { startedAt: performance.now(), readyAt: 0, frameDeltas: [] as { raw: number; applied: number }[] };
  const engine = new HaiyueEngine({ canvas, msaaSamples: options.samples ?? 1, timestampQuery: false, diagnostics: { enabled: true }, clearColor: { r: .025, g: .045, b: .08, a: 1 } });
  await engine.init();
  const scene = engine.createScene({ name: 'Camera follow', camera: { type: '2d', camera2D: { designWidth: 740, designHeight: 640, viewportMode: 'expand' } }, render3D: false, render2D: false, gui: false });
  const camera = scene.cameraEntity.getComponent(Camera2D)!, cameraTransform = new Transform2D(); scene.cameraEntity.addComponent(cameraTransform);
  const view = scene.renderView, sidebar = view.createRegion({ id: 'camera-controls', bounds: { x: 0, y: 0, width: 220, height: 640 }, updateMode: 'demand', clearMode: 'on-update', visible: true });
  const dynamic = view.createRegion({ id: 'camera-world', bounds: { x: 220, y: 0, width: 740, height: 640 }, updateMode: 'continuous', clearMode: 'on-update', visible: true });
  let activeWorlds = 0, totalWorlds = 0;
  const original = createBox2DPhysics2DBackend(), backend = { id: original.id, capabilities: original.capabilities, createWorld: (options: Parameters<typeof original.createWorld>[0]) => {
    const driver = original.createWorld(options), destroy = driver.destroy.bind(driver); let alive = true; activeWorlds++; totalWorlds++;
    driver.destroy = () => { if (alive) { alive = false; activeWorlds--; destroy(); } }; return driver;
  } };
  const physics = new Physics2DSystem({ backend, gravity: [0, 0], priority: -100 }); scene.addSystem(physics, false);
  const rectangle = (name: string, x: number, y: number, width: number, height: number, color: readonly [number, number, number], type?: 'static' | 'kinematic', rotation = 0) => {
    const entity = new Entity(name).addComponent(new Transform2D({ x, y, rotation })).addComponent(new Mesh2D(createRect2D({ width, height }), new Material2D({ color: new ColorSRGB(...color, 1) })));
    if (type) entity.addComponent(new Physics2DBody({ type, width, height })); scene.add(entity); return entity;
  };
  rectangle('Floor', 0, -250, 2400, 24, [.16, .29, .43], 'static');
  rectangle('Slope', 450, -175, 280, 20, [.2, .4, .55], 'static', Math.PI / 6);
  rectangle('Wall', 950, -50, 8, 400, [.2, .4, .55], 'static');
  const platform = rectangle('Translating platform', -300, -100, 180, 18, [.45, .36, .65], 'kinematic');
  rectangle('Landmark', 650, 0, 60, 140, [.95, .65, .2]);
  const actor = new Entity('Character physics').addComponent(new Transform2D({ x: -500, y: 100 })).addComponent(new Physics2DBody({ type: 'kinematic', width: 40, height: 40 })); scene.add(actor);
  const visual = rectangle('Character presentation', -500, 100, 40, 40, [.2, .72, .98]);
  const keyboard = new KeyboardComponent(); scene.add(new Entity('Existing keyboard owner').addComponent(keyboard));
  let axis = 0, jump = false, spaceHeld = false, direction = 1, fixedTarget: readonly [number, number] | null = null, landmark = false, paused = false, activations = 0;
  let character: ReturnType<typeof createCharacter2D>;
  const before = physics.onFixedStep(event => {
    if (event.phase !== 'before') return;
    const pt = platform.getComponent(Transform2D)!; if (pt.x > -120) direction = -1; else if (pt.x < -400) direction = 1;
    physics.setLinearVelocity(platform.getComponent(Physics2DBody)!, direction * .45, 0, false);
    const state = character.state, space = keyboard.isKeyPressed('Space'), jumping = jump || (space && !spaceHeld); jump = false; spaceHeld = space;
    const horizontal = axis || Number(keyboard.isKeyPressed('ArrowRight') || keyboard.isKeyPressed('KeyD')) - Number(keyboard.isKeyPressed('ArrowLeft') || keyboard.isKeyPressed('KeyA'));
    character.setVelocity([horizontal * 180, jumping && state.grounded ? 330 : state.grounded ? 0 : Math.max(-500, state.velocity[1] - 800 * event.deltaSeconds)]);
  });
  character = createCharacter2D({ physics, entity: actor });
  const target = () => fixedTarget ?? (landmark ? [650, 0] as const : character.state.position);
  const controller = createCamera2DController({ camera: scene.cameraEntity, target, damping: 8, deadZone: { width: 100, height: 60 }, bounds: { x: -1200, y: -500, width: 2400, height: 1000 }, interpolation: () => {
    if (fixedTarget || landmark) { const value = target(); return { previous: value, current: value, alpha: 1 }; }
    const state = character.state; return { previous: state.previousPosition, current: state.position, alpha: physics.interpolationAlpha };
  } });
  let lastWidth = -1, lastHeight = -1;
  const resize = () => {
    const width = engine.displayWidth, height = engine.displayHeight, side = Math.min(220, width * .3);
    camera.resize(width - side, height);
    if (width === lastWidth && height === lastHeight) return;
    lastWidth = width; lastHeight = height;
    sidebar.setBounds({ x: 0, y: 0, width: side, height }); dynamic.setBounds({ x: side, y: 0, width: width - side, height });
  };
  engine.on('resize', resize); resize(); controller.reset();
  const frame = new System(entity => entity === visual, (_world, _time, delta) => {
    resize(); const state = character.state, alpha = physics.interpolationAlpha, transform = visual.getComponent(Transform2D)!;
    transform.x = state.previousPosition[0] + (state.position[0] - state.previousPosition[0]) * alpha;
    transform.y = state.previousPosition[1] + (state.position[1] - state.previousPosition[1]) * alpha;
    // The original FrameLoop's first RAF timestamp may precede start().now().
    // Match the original physics adapter for finite negative frame deltas only.
    const applied = Number.isFinite(delta) ? Math.max(0, delta) : delta;
    if (coldStart.frameDeltas.length < 32) coldStart.frameDeltas.push({ raw: delta, applied });
    controller.update(applied);
  }); frame.priority = -50; scene.addSystem(frame, false);
  const actions = {
    switchTarget: () => { activations++; fixedTarget = null; landmark = !landmark; },
    setTarget: (value: readonly [number, number] | null) => { fixedTarget = value; },
    shake: () => controller.shake({ amplitude: 18, durationMs: 600, seed: 7 }),
    zoom: () => { camera.zoom = camera.zoom === 1 ? 1.5 : 1; },
    pause: () => { paused = !paused; physics.disabled = paused; camera.disabled = paused; },
    reset: () => { fixedTarget = null; landmark = false; character.teleport([-500, 100]); character.setVelocity([0, 0]); controller.reset(); },
    move: (value: number) => { axis = Math.max(-1, Math.min(1, value)); }, jump: () => { jump = true; },
  };
  const root = new GuiRoot({ theme: { fontSize: 15, radius: 6 } });
  const title = root.add(new GuiLabel({ x: 16, y: 18, width: 190, height: 34, text: 'CAMERA 2D', fontSize: 22 }));
  const buttons = [root.add(new GuiButton({ x: 16, y: 70, width: 188, height: 36, text: 'Switch target', onClick: actions.switchTarget })),
    root.add(new GuiButton({ x: 16, y: 120, width: 188, height: 36, text: 'Shake', onClick: actions.shake })),
    root.add(new GuiButton({ x: 16, y: 170, width: 188, height: 36, text: 'Zoom', onClick: actions.zoom })),
    root.add(new GuiButton({ x: 16, y: 220, width: 188, height: 36, text: 'Pause / resume', onClick: actions.pause })),
    root.add(new GuiButton({ x: 16, y: 270, width: 188, height: 36, text: 'Reset', onClick: actions.reset }))];
  for (const [line, text] of ['Arrow keys / A D', 'Space to jump', 'GUI stays fixed.', 'The world camera moves.'].entries())
    root.add(new GuiLabel({ x: 16, y: 335 + line * 24, width: 188, height: 22, text, fontSize: 14 }));
  let guiRecords = 0;
  class MeasuredGui extends GuiSystem {
    override record(world: Parameters<GuiSystem['record']>[0], context: Parameters<GuiSystem['record']>[1]): this { guiRecords++; return super.record(world, context); }
  }
  scene.add(new Entity('Cached GUI').addComponent(root));
  scene.addSystem(new Mesh2DRenderSystem(engine, scene.cameraEntity), { region: dynamic, pass: 'isolated' });
  scene.addSystem(new MeasuredGui(engine, { roots: new Set([root]) }), { region: sidebar, pass: 'isolated' });
  const restored = () => controller.reset(); engine.on('device-restored', restored);
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; engine.off('resize', resize); engine.off('device-restored', restored); before(); controller.dispose(); character.dispose(); scene.destroy(); engine.destroy(); };
  engine.switchScene(scene).run(); coldStart.readyAt = performance.now();
  return { engine, scene, camera, cameraTransform, controller, character, actor, visual, physics, root, title, buttons, sidebar, dynamic, actions, resize, dispose, coldStart,
    stats: () => ({ activeWorlds, totalWorlds, activations, guiRecords, resources: physics.resourceSnapshot() }) };
}
