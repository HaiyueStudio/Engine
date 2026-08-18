import { Camera2D, ColorSRGB, Entity, Material2D, Mesh2D, Transform2D, HaiyueEngine } from '@haiyue/engine';
import { createCircle2D, createRect2D } from '@haiyue/engine/geometry';
import { Physics2DBody, Physics2DJoint, Physics2DSystem } from '@haiyue/engine/physics';

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({ canvas });
  await engine.init();

  const camera = new Entity();
  camera.addComponent(new Camera2D());

  const scene = engine.createScene({
    name: 'Box2DJoints',
    camera: { type: '2d', entity: camera },
    render3D: false,
    render2D: { loadOp: 'clear', priority: 10 },
    pipelineLabel: 'Box2DJoints.render',
  });
  const world = scene.world;

  scene.addSystem(new Physics2DSystem({ gravity: [0, -980], priority: 0 }), false);

  function addRect(name: string, x: number, y: number, width: number, height: number, color: [number, number, number, number], type: 'static' | 'dynamic' = 'dynamic') {
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
      friction: 0.42,
      restitution: 0.08,
    }));
    world.addEntity(entity);
    return entity;
  }

  function addCircle(name: string, x: number, y: number, radius: number, color: [number, number, number, number], type: 'static' | 'dynamic' = 'dynamic') {
    const entity = new Entity(name);
    entity.addComponent(new Transform2D({ x, y }));
    entity.addComponent(new Mesh2D(
      createCircle2D({ radius, segments: 40 }),
      new Material2D({ color: new ColorSRGB(...color), blending: 'normal' }),
    ));
    entity.addComponent(new Physics2DBody({
      type,
      shape: 'circle',
      radius,
      density: type === 'dynamic' ? 1 : 0,
      friction: 0.35,
      restitution: 0.16,
    }));
    world.addEntity(entity);
    return entity;
  }

  addRect('ground', 0, -260, 760, 32, [0.35, 0.38, 0.43, 1], 'static');

  const pivot = addCircle('pivot', -220, 170, 18, [0.92, 0.84, 0.46, 1], 'static');
  const pendulum = addRect('pendulum', -220, 40, 42, 230, [0.26, 0.58, 0.95, 1]);
  const weight = addCircle('weight', -220, -105, 42, [0.95, 0.34, 0.32, 1]);

  const hinge = new Entity('hinge');
  hinge.addComponent(new Physics2DJoint({
    type: 'revolute',
    bodyA: pivot,
    bodyB: pendulum,
    anchor: [-220, 170],
    enableLimit: true,
    lowerAngle: -0.95,
    upperAngle: 0.95,
  }));
  world.addEntity(hinge);

  const bobLink = new Entity('bob-link');
  bobLink.addComponent(new Physics2DJoint({
    type: 'distance',
    bodyA: pendulum,
    bodyB: weight,
    anchorA: [-220, -80],
    anchorB: [-220, -105],
    length: 26,
    frequencyHz: 3,
    dampingRatio: 0.25,
  }));
  world.addEntity(bobLink);

  const leftAnchor = addCircle('left-anchor', 160, 170, 16, [0.92, 0.84, 0.46, 1], 'static');
  const rightAnchor = addCircle('right-anchor', 340, 170, 16, [0.92, 0.84, 0.46, 1], 'static');
  const bridgeA = addRect('bridge-a', 190, 75, 90, 24, [0.18, 0.72, 0.48, 1]);
  const bridgeB = addRect('bridge-b', 310, 75, 90, 24, [0.18, 0.72, 0.48, 1]);

  [
    ['left-rope', leftAnchor, bridgeA, [160, 170], [190, 75]],
    ['middle-rope', bridgeA, bridgeB, [190, 75], [310, 75]],
    ['right-rope', bridgeB, rightAnchor, [310, 75], [340, 170]],
  ].forEach(([name, bodyA, bodyB, anchorA, anchorB]) => {
    const joint = new Entity(name as string);
    joint.addComponent(new Physics2DJoint({
      type: 'distance',
      bodyA: bodyA as Entity,
      bodyB: bodyB as Entity,
      anchorA: anchorA as [number, number],
      anchorB: anchorB as [number, number],
      frequencyHz: 2.2,
      dampingRatio: 0.18,
    }));
    world.addEntity(joint);
  });

  engine.switchScene(scene);
  engine.run();
}

main();
