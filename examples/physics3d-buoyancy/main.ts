import { BasicMaterial, Entity, Mesh3D, createBox3D } from '@haiyue/engine';
import {
  Physics3DBuoyancy,
  Physics3DBuoyancySystem,
  type Physics3DBody,
} from '@haiyue/engine/physics';
import { mat4 } from 'wgpu-matrix';
import {
  addGround,
  addRigidBox,
  addRigidSphere,
  createPhysics3DExample,
  runExample,
  transformAt,
} from '../physics3d-shared';

interface FloatingBody {
  body: Physics3DBody;
  buoyancy: Physics3DBuoyancy;
  position: [number, number, number];
}

async function main(): Promise<void> {
  const context = await createPhysics3DExample({
    name: 'Physics3DBuoyancy',
    camera: { radius: 19, theta: Math.PI * 0.12, phi: Math.PI * 0.3, target: [0, 0.5, 0] },
    clearColor: { r: 0.012, g: 0.035, b: 0.068, a: 1 },
  });
  const { scene, physics } = context;
  let fluidLevel = 1.2;

  addGround(scene, [18, 0.5, 12], [0, -3.25, 0]);
  addRigidBox(scene, 'Pool left', [-8.75, -0.2, 0], [0.5, 6, 12], [0.08, 0.15, 0.25, 1], { type: 'static' });
  addRigidBox(scene, 'Pool right', [8.75, -0.2, 0], [0.5, 6, 12], [0.08, 0.15, 0.25, 1], { type: 'static' });
  addRigidBox(scene, 'Pool back', [0, -0.2, -5.75], [18, 6, 0.5], [0.08, 0.15, 0.25, 1], { type: 'static' });

  const waterTransform = transformAt([0, (fluidLevel - 3) * 0.5, 0]);
  const waterMesh = new Mesh3D(
    createBox3D({ width: 17.4, height: fluidLevel + 3, depth: 11.4 }),
    new BasicMaterial({
      color: [0.05, 0.48, 0.9, 0.26],
      blending: 'normal',
      depthWrite: false,
      cullMode: 'none',
    }),
  );
  const water = new Entity('Water volume');
  water.addComponent(waterTransform);
  water.addComponent(waterMesh);
  scene.add(water);

  const floating: FloatingBody[] = [];
  const register = (
    item: { entity: Entity; body: Physics3DBody },
    position: [number, number, number],
    options: ConstructorParameters<typeof Physics3DBuoyancy>[0] = {},
  ) => {
    const buoyancy = new Physics3DBuoyancy({ fluidLevel, ...options });
    item.entity.addComponent(buoyancy);
    floating.push({ body: item.body, buoyancy, position });
  };

  const blueCrate = addRigidBox(
    scene,
    'Low-density crate',
    [-4.5, 5, 0],
    [2.2, 1.3, 1.7],
    [0.06, 0.48, 0.96, 1],
    { density: 0.55, restitution: 0.08, angularDamping: 0.18 },
    [0.1, 0, 0.14],
  );
  register(blueCrate, [-4.5, 5, 0], { linearDrag: 3.2, angularDrag: 1.8, centerOfBuoyancy: [0, 0.28, 0] });

  const redCrate = addRigidBox(
    scene,
    'Top-heavy crate',
    [0, 6.4, 0],
    [1.6, 2.5, 1.4],
    [0.96, 0.25, 0.18, 1],
    { density: 0.82, restitution: 0.05 },
    [0.12, 0.2, -0.16],
  );
  register(redCrate, [0, 6.4, 0], { linearDrag: 2.4, angularDrag: 1.1, centerOfBuoyancy: [0.38, -0.18, 0] });

  const ball = addRigidSphere(
    scene,
    'Floating sphere',
    [4.2, 7.5, 0.4],
    1.05,
    [0.98, 0.68, 0.1, 1],
    { density: 0.42, restitution: 0.18, linearDamping: 0.04 },
  );
  register(ball, [4.2, 7.5, 0.4], { linearDrag: 2.8, angularDrag: 1.6 });

  scene.addSystem(new Physics3DBuoyancySystem(physics), false);

  const levelInput = document.querySelector<HTMLInputElement>('#fluid-level')!;
  const levelOutput = document.querySelector<HTMLOutputElement>('#fluid-level-value')!;
  levelInput.addEventListener('input', () => {
    fluidLevel = Number(levelInput.value);
    for (const item of floating) item.buoyancy.fluidLevel = fluidLevel;
    waterTransform.setMatrix(mat4.translation([0, (fluidLevel - 3) * 0.5, 0]) as Float32Array);
    waterMesh.geometry = createBox3D({ width: 17.4, height: fluidLevel + 3, depth: 11.4 });
    levelOutput.value = fluidLevel.toFixed(1);
  });

  document.querySelector<HTMLButtonElement>('#reset')!.addEventListener('click', () => {
    for (const [index, item] of floating.entries()) {
      physics.teleportBody(item.body, item.position);
      physics.setLinearVelocity(item.body, 0, 0, 0);
      physics.setAngularVelocity(item.body, 0, 0, index === 1 ? 0.4 : 0);
    }
  });

  runExample(context);
}

main().catch(error => {
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  console.error(error);
});
