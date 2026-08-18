import { Camera2D, ColorSRGB, Entity, Material2D, Mesh2D, Transform2D, HaiyueEngine } from '@haiyue/engine';
import { createCircle2D, createRect2D } from '@haiyue/engine/geometry';
import { Physics2DBody, Physics2DSystem } from '@haiyue/engine/physics';

const CATEGORY_GROUND = 0x0001;
const CATEGORY_BLUE = 0x0002;
const CATEGORY_RED = 0x0004;
const CATEGORY_PLATFORM = 0x0008;

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({ canvas });
  await engine.init();

  const camera = new Entity();
  camera.addComponent(new Camera2D());
  const scene = engine.createScene({
    name: 'Box2DFiltering',
    camera: { type: '2d', entity: camera },
    render3D: false,
    render2D: { loadOp: 'clear', priority: 10 },
    pipelineLabel: 'Box2DFiltering.render',
  });
  const world = scene.world;

  scene.addSystem(new Physics2DSystem({ gravity: [0, -980], priority: 0 }), false);

  function addPlatform(name: string, x: number, y: number, width: number, height: number, color: [number, number, number, number], categoryBits: number, maskBits: number) {
    const entity = new Entity(name);
    entity.addComponent(new Transform2D({ x, y }));
    entity.addComponent(new Mesh2D(
      createRect2D({ width, height }),
      new Material2D({ color: new ColorSRGB(...color), blending: 'normal' }),
    ));
    entity.addComponent(new Physics2DBody({
      type: 'static',
      shape: 'box',
      width,
      height,
      categoryBits,
      maskBits,
    }));
    world.addEntity(entity);
    return entity;
  }

  function addBall(name: string, x: number, y: number, radius: number, color: [number, number, number, number], categoryBits: number, maskBits: number) {
    const entity = new Entity(name);
    entity.addComponent(new Transform2D({ x, y }));
    entity.addComponent(new Mesh2D(
      createCircle2D({ radius, segments: 40 }),
      new Material2D({ color: new ColorSRGB(...color), blending: 'normal' }),
    ));
    entity.addComponent(new Physics2DBody({
      type: 'dynamic',
      shape: 'circle',
      radius,
      density: 1,
      friction: 0.22,
      restitution: 0.22,
      categoryBits,
      maskBits,
    }));
    world.addEntity(entity);
    return entity;
  }

  addPlatform('ground', 0, -260, 780, 32, [0.34, 0.38, 0.43, 1], CATEGORY_GROUND, CATEGORY_BLUE | CATEGORY_RED);
  addPlatform('blue-only-platform', -185, -80, 250, 24, [0.15, 0.42, 0.92, 1], CATEGORY_PLATFORM, CATEGORY_BLUE);
  addPlatform('red-only-platform', 185, 20, 250, 24, [0.9, 0.2, 0.24, 1], CATEGORY_PLATFORM, CATEGORY_RED);

  addBall('blue-a', -230, 260, 34, [0.2, 0.58, 1, 1], CATEGORY_BLUE, CATEGORY_GROUND | CATEGORY_PLATFORM);
  addBall('blue-b', -135, 350, 34, [0.2, 0.58, 1, 1], CATEGORY_BLUE, CATEGORY_GROUND | CATEGORY_PLATFORM);
  addBall('red-a', 135, 260, 34, [1, 0.28, 0.3, 1], CATEGORY_RED, CATEGORY_GROUND | CATEGORY_PLATFORM);
  addBall('red-b', 230, 350, 34, [1, 0.28, 0.3, 1], CATEGORY_RED, CATEGORY_GROUND | CATEGORY_PLATFORM);

  engine.switchScene(scene);
  engine.run();
}

main();
