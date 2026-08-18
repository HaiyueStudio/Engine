import { Camera2D, ColorSRGB, Entity, Material2D, Mesh2D, Transform2D, HaiyueEngine } from '@haiyue/engine';
import { createCircle2D, createRect2D } from '@haiyue/engine/geometry';
import { Physics2DBody, Physics2DSystem } from '@haiyue/engine/physics';

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({ canvas });
  await engine.init();

  const camera = new Entity();
  camera.addComponent(new Camera2D());
  const scene = engine.createScene({
    name: 'Box2DCollision',
    camera: { type: '2d', entity: camera },
    render3D: false,
    render2D: { loadOp: 'clear', priority: 10 },
    pipelineLabel: 'Box2DCollision.render',
  });
  const world = scene.world;

  scene.addSystem(new Physics2DSystem({ gravity: [0, -980], priority: 0 }), false);

  function addBox(name: string, x: number, y: number, width: number, height: number, color: [number, number, number, number], type: 'static' | 'dynamic' = 'dynamic') {
    const entity = new Entity(name);
    entity.addComponent(new Transform2D({ x, y }));
    entity.addComponent(new Mesh2D(
      createRect2D({ width, height }),
      new Material2D({ color: new ColorSRGB(...color), blending: 'normal' }),
    ));
    entity.addComponent(new Physics2DBody({
      type,
      shape: 'box',
      width,
      height,
      density: type === 'dynamic' ? 1 : 0,
      friction: 0.45,
      restitution: type === 'dynamic' ? 0.18 : 0,
    }));
    world.addEntity(entity);
    return entity;
  }

  function addBall(name: string, x: number, y: number, radius: number, color: [number, number, number, number]) {
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
      friction: 0.25,
      restitution: 0.42,
    }));
    world.addEntity(entity);
    return entity;
  }

  addBox('ground', 0, -255, 760, 34, [0.36, 0.39, 0.44, 1], 'static');
  addBox('left-wall', -390, -85, 34, 310, [0.24, 0.28, 0.34, 1], 'static');
  addBox('right-wall', 390, -85, 34, 310, [0.24, 0.28, 0.34, 1], 'static');
  addBox('ramp', 160, -150, 260, 24, [0.48, 0.38, 0.24, 1], 'static')
    .getComponent(Transform2D)!.rotation = -0.18;

  addBox('box-a', -140, 190, 74, 74, [0.18, 0.58, 0.96, 1]);
  addBox('box-b', -40, 285, 86, 54, [0.16, 0.72, 0.46, 1]);
  addBox('box-c', 70, 365, 66, 92, [0.95, 0.68, 0.18, 1]);
  addBall('ball-a', 145, 235, 38, [0.96, 0.25, 0.28, 1]);
  addBall('ball-b', -230, 330, 32, [0.73, 0.42, 0.95, 1]);

  engine.switchScene(scene);
  engine.run();
}

main();
