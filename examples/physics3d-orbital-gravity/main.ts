import {
  Physics3DBody,
  Physics3DGravitySource,
  Physics3DGravitySystem,
} from '@haiyue/engine/physics';
import {
  addRigidSphere,
  createPhysics3DExample,
  runExample,
} from '../physics3d-shared';

interface Orbiter {
  body: Physics3DBody;
  position: [number, number, number];
  velocity: [number, number, number];
}

async function main(): Promise<void> {
  const context = await createPhysics3DExample({
    name: 'Physics3DOrbitalGravity',
    camera: { radius: 25, theta: Math.PI * 0.2, phi: Math.PI * 0.26, target: [0, 0, 0] },
    gravity: [0, 0, 0],
    clearColor: { r: 0.002, g: 0.004, b: 0.015, a: 1 },
  });
  const { scene, physics } = context;
  const gravitationalParameter = 48;

  const star = addRigidSphere(
    scene,
    'Gravity source',
    [0, 0, 0],
    1.35,
    [1, 0.5, 0.05, 1],
    { type: 'static', restitution: 0.1 },
  );
  star.entity.addComponent(new Physics3DGravitySource({
    strength: gravitationalParameter,
    softening: 0.32,
    maxDistance: 40,
  }));

  const orbiters: Orbiter[] = [];
  const addOrbiter = (
    name: string,
    position: [number, number, number],
    radius: number,
    color: [number, number, number, number],
    speedScale = 1,
  ) => {
    const distance = Math.hypot(position[0], position[2]);
    const speed = Math.sqrt(gravitationalParameter / distance) * speedScale;
    const tangent: [number, number, number] = [
      -position[2] / distance * speed,
      0,
      position[0] / distance * speed,
    ];
    const item = addRigidSphere(scene, name, position, radius, color, {
      density: 1.2,
      restitution: 0.4,
      linearDamping: 0,
      angularDamping: 0.02,
      gravityScale: 0,
      ccd: true,
    });
    orbiters.push({ body: item.body, position, velocity: tangent });
  };

  addOrbiter('Inner planet', [5, 0, 0], 0.42, [0.22, 0.74, 1, 1]);
  addOrbiter('Middle planet', [0, 0.3, 8], 0.62, [0.92, 0.32, 0.18, 1], 0.96);
  addOrbiter('Outer planet', [-11, -0.35, 0], 0.82, [0.52, 0.3, 0.98, 1], 1.08);

  scene.addSystem(new Physics3DGravitySystem(physics), false);

  const resetOrbits = (): boolean => {
    if (orbiters.some(item => item.body.handle === null)) return false;
    for (const item of orbiters) {
      physics.teleportBody(item.body, item.position, [0, 0, 0, 1]);
      physics.setLinearVelocity(item.body, ...item.velocity);
      physics.setAngularVelocity(item.body, 0, 1.2, 0);
    }
    return true;
  };

  let initialized = false;
  let elapsed = 0;
  const elapsedOutput = document.querySelector<HTMLOutputElement>('#elapsed')!;
  context.engine.on('after-update', event => {
    if (!initialized) initialized = resetOrbits();
    elapsed += event.detail.delta / 1000;
    elapsedOutput.value = `${elapsed.toFixed(1)} s`;
  });

  document.querySelector<HTMLButtonElement>('#reset')!.addEventListener('click', () => {
    if (resetOrbits()) elapsed = 0;
  });

  runExample(context);
}

main().catch(error => {
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  console.error(error);
});
