import { Entity } from '@haiyue/engine';
import { Physics3DJoint, type Physics3DJointOptions } from '@haiyue/engine/physics';
import {
  addGround,
  addRigidBox,
  addRigidSphere,
  createPhysics3DExample,
  runExample,
} from '../physics3d-shared';

async function main(): Promise<void> {
  const context = await createPhysics3DExample({
    name: 'Physics3DJoints',
    camera: { radius: 20, theta: Math.PI * 0.13, phi: Math.PI * 0.31, target: [0, 2.2, 0] },
  });
  const { scene, physics } = context;
  addGround(scene, [22, 0.6, 13]);

  const hingeAnchor = addRigidSphere(
    scene,
    'Hinge anchor',
    [-6, 5.2, 0],
    0.32,
    [1, 0.73, 0.18, 1],
    { type: 'static', isSensor: true },
  );
  const hingeArm = addRigidBox(
    scene,
    'Revolute arm',
    [-6, 3.35, 0],
    [0.65, 3.7, 0.65],
    [0.12, 0.52, 1, 1],
    { density: 1.1, angularDamping: 0.08 },
  );
  addJoint(scene, 'Revolute joint', {
    type: 'revolute',
    bodyA: hingeAnchor.entity,
    bodyB: hingeArm.entity,
    anchorA: [0, 0, 0],
    anchorB: [0, 1.85, 0],
    axis: [0, 0, 1],
    limits: [-1.05, 1.05],
  });

  const ballAnchor = addRigidSphere(
    scene,
    'Spherical anchor',
    [-1.8, 5.1, 0],
    0.3,
    [1, 0.73, 0.18, 1],
    { type: 'static', isSensor: true },
  );
  const ball = addRigidSphere(
    scene,
    'Spherical pendulum',
    [-1.2, 2.4, 0.7],
    0.78,
    [0.66, 0.25, 0.96, 1],
    { density: 1.4, restitution: 0.2 },
  );
  addJoint(scene, 'Spherical joint', {
    type: 'spherical',
    bodyA: ballAnchor.entity,
    bodyB: ball.entity,
    anchorA: [0, 0, 0],
    anchorB: [-0.6, 2.7, -0.7],
  });

  const sliderAnchor = addRigidSphere(
    scene,
    'Prismatic anchor',
    [4.3, 3.25, 0],
    0.28,
    [1, 0.73, 0.18, 1],
    { type: 'static', isSensor: true },
  );
  const slider = addRigidBox(
    scene,
    'Prismatic carriage',
    [4.3, 3.25, 0],
    [1.6, 0.75, 1.1],
    [0.08, 0.82, 0.52, 1],
    { density: 1.2, friction: 0.25 },
  );
  addJoint(scene, 'Prismatic joint', {
    type: 'prismatic',
    bodyA: sliderAnchor.entity,
    bodyB: slider.entity,
    axis: [1, 0, 0],
    limits: [-2.1, 2.1],
  });

  const springAnchor = addRigidSphere(
    scene,
    'Spring anchor',
    [7.6, 6, 0],
    0.3,
    [1, 0.73, 0.18, 1],
    { type: 'static', isSensor: true },
  );
  const springWeight = addRigidSphere(
    scene,
    'Spring weight',
    [7.6, 2.15, 0],
    0.72,
    [1, 0.28, 0.2, 1],
    { density: 1.35, linearDamping: 0.12 },
  );
  addJoint(scene, 'Spring joint', {
    type: 'spring',
    bodyA: springAnchor.entity,
    bodyB: springWeight.entity,
    restLength: 2.5,
    stiffness: 46,
    damping: 4.4,
  });

  let kicked = false;
  context.engine.on('after-update', () => {
    if (kicked || hingeArm.body.handle === null || slider.body.handle === null) return;
    kicked = true;
    physics.applyAngularImpulse(hingeArm.body, 0, 0, 1.7);
    physics.applyLinearImpulse(slider.body, 3.2, 0, 0);
  });

  document.querySelector<HTMLButtonElement>('#kick')!.addEventListener('click', () => {
    physics.applyAngularImpulse(hingeArm.body, 0, 0, 2.2);
    physics.applyLinearImpulse(slider.body, -4.5, 0, 0);
    physics.applyLinearImpulse(ball.body, 1.2, 0, -1.5);
  });

  runExample(context);
}

function addJoint(
  scene: Parameters<typeof addGround>[0],
  name: string,
  options: Physics3DJointOptions,
): Entity {
  const entity = new Entity(name);
  entity.addComponent(new Physics3DJoint(options));
  scene.add(entity);
  return entity;
}

main().catch(error => {
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  console.error(error);
});
