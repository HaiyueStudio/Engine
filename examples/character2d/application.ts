import { HaiyueEngine } from '@haiyue/engine';
import { Entity, System } from '@haiyue/engine/ecs';
import { Camera2D, KeyboardComponent, Mesh2D, Transform2D } from '@haiyue/engine/components';
import { Physics2DBody, Physics2DSystem } from '@haiyue/engine/physics';
import { createBox2DPhysics2DBackend } from '@haiyue/engine/physics/backend';
import { createRect2D, createCircle2D } from '@haiyue/engine/geometry';
import { Material2D } from '@haiyue/engine/material';
import { ColorSRGB } from '@haiyue/engine/color';
import { createCharacter2D } from '@haiyue/extensions/character2d';

/** The packed-browser gate strictly compiles and executes this exact application. */
export async function createCharacterExample(canvas: HTMLCanvasElement, options: { shape?: 'box' | 'circle'; gameRules?: boolean } = {}) {
  const coldStart = { startedAt: performance.now(), readyAt: 0 };
  const engine = new HaiyueEngine({ canvas, timestampQuery: false, diagnostics: { enabled: true }, defaults: { render2D: { loadOp: 'clear' } }, clearColor: { r: .025, g: .045, b: .08, a: 1 } });
  await engine.init();
  const scene = engine.createScene('2d');
  const camera = scene.cameraEntity.getComponent(Camera2D)!;
  camera.designWidth = 960; camera.designHeight = 640; camera.viewportMode = 'fit';
  let activeWorlds = 0, totalWorlds = 0;
  const original = createBox2DPhysics2DBackend();
  const backend = { id: original.id, capabilities: original.capabilities, createWorld: (input: Parameters<typeof original.createWorld>[0]) => {
    activeWorlds++; totalWorlds++;
    const driver = original.createWorld(input), destroy = driver.destroy.bind(driver); let alive = true;
    driver.destroy = () => { if (!alive) return; alive = false; activeWorlds--; destroy(); };
    return driver;
  } };
  const physics = new Physics2DSystem({ backend, gravity: [0, 0], priority: -100 }); scene.world.addSystem(physics);
  const mesh = (width: number, height: number, color: readonly [number, number, number], circle = false) => new Mesh2D(
    circle ? createCircle2D({ radius: width / 2 }) : createRect2D({ width, height }), new Material2D({ color: new ColorSRGB(...color, 1) }));
  const obstacle = (name: string, x: number, y: number, width: number, height: number, rotation = 0, type: 'static' | 'kinematic' = 'static') => {
    const entity = new Entity(name).addComponent(new Transform2D({ x, y, rotation })).addComponent(new Physics2DBody({ type, width, height })).addComponent(mesh(width, height, [.18, .3, .43])); scene.add(entity); return entity;
  };
  obstacle('Ground', 0, -220, 900, 24);
  obstacle('30 degree slope', 140, -153, 240, 18, Math.PI / 6);
  obstacle('Thin wall', 420, -80, 8, 260);
  const platform = obstacle('Moving platform', -240, -85, 140, 16, 0, 'kinematic');
  const actor = new Entity('Character physics').addComponent(new Transform2D({ x: -350, y: 0 })).addComponent(new Physics2DBody({ type: 'kinematic', shape: options.shape ?? 'box', width: 40, height: 40, radius: 20 })); scene.add(actor);
  const visual = new Entity('Character presentation').addComponent(new Transform2D({ x: -350, y: 0 })).addComponent(mesh(40, 40, [.2, .72, .98], options.shape === 'circle')); scene.add(visual);
  const keyboard = new KeyboardComponent(); scene.add(new Entity('Existing keyboard input').addComponent(keyboard));
  let axis = 0, jumpQueued = false, spaceHeld = false, platformDirection = 1;
  let controller: ReturnType<typeof createCharacter2D>;
  const before = physics.onFixedStep(event => {
    if (event.phase !== 'before') return;
    const transform = platform.getComponent(Transform2D)!;
    if (transform.x > -130) platformDirection = -1;
    else if (transform.x < -300) platformDirection = 1;
    physics.setLinearVelocity(platform.getComponent(Physics2DBody)!, platformDirection * .45, 0, false);
    if (options.gameRules === false) return;
    const state = controller.state, space = keyboard.isKeyPressed('Space');
    const jump = jumpQueued || (space && !spaceHeld); jumpQueued = false; spaceHeld = space;
    const x = axis || (Number(keyboard.isKeyPressed('ArrowRight') || keyboard.isKeyPressed('KeyD')) - Number(keyboard.isKeyPressed('ArrowLeft') || keyboard.isKeyPressed('KeyA')));
    const y = jump && state.grounded ? 330 : state.grounded ? 0 : Math.max(-500, state.velocity[1] - 800 * event.deltaSeconds);
    controller.setVelocity([x * 180, y]);
  });
  controller = createCharacter2D({ physics, entity: actor });
  const presentation = new System(entity => entity === visual, () => {
    const state = controller.state, alpha = physics.interpolationAlpha, transform = visual.getComponent(Transform2D)!;
    // Interpolate a separate drawing entity; never feed presentation into physics.
    transform.x = state.previousPosition[0] + (state.position[0] - state.previousPosition[0]) * alpha;
    transform.y = state.previousPosition[1] + (state.position[1] - state.previousPosition[1]) * alpha;
  }); presentation.priority = -50; scene.world.addSystem(presentation);
  const reset = () => {
    controller.teleport([-350, 0]); controller.setVelocity([0, 0]); axis = 0; jumpQueued = false; spaceHeld = false; platformDirection = 1;
    const transform = platform.getComponent(Transform2D)!; transform.x = -240; transform.y = -85;
    if (physics.hasBody(platform.getComponent(Physics2DBody)!)) physics.teleportBody(platform.getComponent(Physics2DBody)!, -240, -85);
  };
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; before(); controller.dispose(); scene.destroy(); engine.destroy(); };
  engine.switchScene(scene).run(); coldStart.readyAt = performance.now();
  return { engine, scene, physics, actor, visual, platform, controller, presentation, coldStart, reset, dispose,
    move: (value: number) => { axis = Math.max(-1, Math.min(1, value)); }, jump: () => { jumpQueued = true; },
    pause: (value: boolean) => { physics.disabled = value; }, stats: () => ({ activeWorlds, totalWorlds, resources: physics.resourceSnapshot() }) };
}
