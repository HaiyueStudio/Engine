import { Physics3DBody } from '@haiyue/engine/physics';
import type { Physics3DDragHandle } from '@haiyue/engine/physics/backend';
import { Ray } from '@haiyue/engine/math';
import {
  addGround,
  addRigidBox,
  addRigidSphere,
  createPhysics3DExample,
  pointerRay,
  rayTuple,
  runExample,
} from '../physics3d-shared';

interface ResettableBody {
  body: Physics3DBody;
  position: [number, number, number];
}

async function main(): Promise<void> {
  const context = await createPhysics3DExample({
    name: 'Physics3DCollision',
    camera: { radius: 18, theta: Math.PI * 0.14, phi: Math.PI * 0.29, target: [0, 2, 0] },
  });
  const { scene, physics, orbit, canvas } = context;
  const status = document.querySelector<HTMLElement>('#status')!;
  const resettable: ResettableBody[] = [];

  addGround(scene, [18, 0.6, 14]);
  addRigidBox(scene, 'Left wall', [-8.7, 2.2, 0], [0.5, 5, 14], [0.1, 0.18, 0.3, 1], { type: 'static' });
  addRigidBox(scene, 'Right wall', [8.7, 2.2, 0], [0.5, 5, 14], [0.1, 0.18, 0.3, 1], { type: 'static' });
  addRigidBox(
    scene,
    'Ramp',
    [3.2, 1.1, 0],
    [5.5, 0.35, 5],
    [0.32, 0.22, 0.1, 1],
    { type: 'static', friction: 0.7 },
    [0, 0, -0.22],
  );

  const bodies = [
    addRigidBox(scene, 'Blue crate', [-3.4, 5.8, 0], [1.4, 1.4, 1.4], [0.08, 0.42, 0.95, 1], { restitution: 0.12 }),
    addRigidBox(scene, 'Green crate', [-1.3, 8, 0.5], [1.8, 1.1, 1.3], [0.08, 0.72, 0.42, 1], { restitution: 0.16 }),
    addRigidBox(scene, 'Amber crate', [1, 10.2, -0.4], [1.2, 1.8, 1.2], [0.94, 0.56, 0.08, 1], { restitution: 0.08 }),
    addRigidSphere(scene, 'Red ball', [3.5, 7.2, 1], 0.78, [0.95, 0.12, 0.18, 1], { restitution: 0.62, ccd: true }),
    addRigidSphere(scene, 'Violet ball', [-5.2, 9.5, -0.6], 0.68, [0.58, 0.22, 0.94, 1], { restitution: 0.48 }),
  ];
  for (const item of bodies) {
    const matrix = item.transform.localMatrix;
    resettable.push({
      body: item.body,
      position: [matrix[12] ?? 0, matrix[13] ?? 0, matrix[14] ?? 0],
    });
  }

  let pointerId = -1;
  let drag: Physics3DDragHandle | null = null;
  let dragDistance = 0;
  const ray = new Ray();

  canvas.addEventListener('pointerdown', event => {
    const current = pointerRay(context, event, ray);
    const values = rayTuple(current);
    const hit = physics.castRay(values.origin, values.direction, 100);
    if (!hit || hit.body.type !== 'dynamic') return;
    drag = physics.createDragConstraint(hit.body, hit.point, hit.point, {
      stiffness: 120,
      damping: 18,
      maxForce: 650,
    });
    if (drag === null) return;
    pointerId = event.pointerId;
    dragDistance = hit.distance;
    orbit.enableRotate = false;
    canvas.setPointerCapture(pointerId);
    canvas.style.cursor = 'grabbing';
    status.textContent = `拉动：${hit.entity.name}`;
    event.preventDefault();
  });

  canvas.addEventListener('pointermove', event => {
    if (event.pointerId !== pointerId || drag === null) return;
    const current = pointerRay(context, event, ray);
    const values = rayTuple(current);
    physics.updateDragConstraint(drag, [
      values.origin[0] + values.direction[0] * dragDistance,
      values.origin[1] + values.direction[1] * dragDistance,
      values.origin[2] + values.direction[2] * dragDistance,
    ]);
    event.preventDefault();
  });

  const release = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    physics.destroyDragConstraint(drag);
    drag = null;
    pointerId = -1;
    orbit.enableRotate = true;
    canvas.style.cursor = 'grab';
    status.textContent = '点击物体并拖拽';
    event.preventDefault();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  document.querySelector<HTMLButtonElement>('#reset')!.addEventListener('click', () => {
    resettable.forEach((item, index) => {
      physics.teleportBody(item.body, item.position);
      physics.setLinearVelocity(item.body, 0, 0, 0);
      physics.setAngularVelocity(item.body, 0, 0, 0);
      physics.applyAngularImpulse(item.body, 0, (index - 2) * 0.08, 0);
    });
  });

  runExample(context);
}

main().catch(error => {
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
  console.error(error);
});
