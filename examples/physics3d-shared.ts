import {
  BasicMaterial,
  Camera3D,
  CartesianTransform3D,
  DirectionalLight,
  Entity,
  EnvironmentLight,
  HaiyueEngine,
  Mesh3D,
  OrbitControl,
  PbrMaterial,
  SphericalTransform3D,
  createBox3D,
  createSphere3D,
  type Scene,
} from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import { Ray } from '@haiyue/engine/math';
import { Physics3DBody, Physics3DSystem, type Physics3DBodyOptions } from '@haiyue/engine/physics';
import { createRapierPhysics3DBackend } from '@haiyue/engine/physics/backend';
import { mat4 } from 'wgpu-matrix';

export interface Physics3DExampleContext {
  engine: HaiyueEngine;
  canvas: HTMLCanvasElement;
  scene: Scene;
  physics: Physics3DSystem;
  camera: Entity;
  cameraComponent: Camera3D;
  cameraTransform: SphericalTransform3D;
  orbit: OrbitControl;
}

export async function createPhysics3DExample(options: {
  name: string;
  camera?: {
    radius?: number;
    theta?: number;
    phi?: number;
    target?: [number, number, number];
  };
  gravity?: [number, number, number];
  clearColor?: { r: number; g: number; b: number; a: number };
}): Promise<Physics3DExampleContext> {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
  const engine = new HaiyueEngine({
    canvas,
    msaaSamples: 4,
    clearColor: options.clearColor ?? { r: 0.018, g: 0.027, b: 0.05, a: 1 },
  });
  await engine.init();
  const backend = await createRapierPhysics3DBackend();

  const cameraTransform = new SphericalTransform3D({
    radius: options.camera?.radius ?? 16,
    theta: options.camera?.theta ?? Math.PI * 0.16,
    phi: options.camera?.phi ?? Math.PI * 0.28,
    target: options.camera?.target ?? [0, 1.5, 0],
  });
  const cameraComponent = new Camera3D({
    type: 'perspective',
    fov: Math.PI / 4,
    near: 0.1,
    far: 180,
  });
  const camera = new Entity('Camera');
  camera.addComponent(cameraComponent);
  camera.addComponent(cameraTransform);

  const scene = engine.createScene({
    name: options.name,
    camera,
    render3D: { loadOp: 'clear' },
    render2D: false,
    gui: false,
    pipelineLabel: `${options.name}.render`,
  });
  const physics = new Physics3DSystem({
    backend,
    gravity: options.gravity ?? [0, -9.81, 0],
    fixedTimeStep: 1 / 60,
    maxSubSteps: 5,
    solverIterations: 8,
    priority: -10,
  });
  scene.addSystem(physics, false);
  const orbit = new OrbitControl(canvas, cameraTransform, {
    minRadius: 5,
    maxRadius: 46,
    rotateSpeed: 0.72,
  });
  addStudioLighting(scene);
  beginGpuValidation(engine);
  return { engine, canvas, scene, physics, camera, cameraComponent, cameraTransform, orbit };
}

export function addRigidBox(
  scene: Scene,
  name: string,
  position: readonly [number, number, number],
  size: readonly [number, number, number],
  color: readonly [number, number, number, number],
  options: Physics3DBodyOptions = {},
  rotation: readonly [number, number, number] = [0, 0, 0],
): { entity: Entity; body: Physics3DBody; transform: Transform3D } {
  const transform = transformAt(position, rotation);
  const body = new Physics3DBody({
    ...options,
    type: options.type ?? 'dynamic',
    shape: 'box',
    width: size[0],
    height: size[1],
    depth: size[2],
  });
  const entity = new Entity(name);
  entity.addComponent(transform);
  entity.addComponent(new Mesh3D(
    createBox3D({ width: size[0], height: size[1], depth: size[2] }),
    new PbrMaterial({
      baseColor: color,
      metallic: 0.12,
      roughness: options.type === 'static' ? 0.72 : 0.34,
    }),
  ));
  entity.addComponent(body);
  scene.add(entity);
  return { entity, body, transform };
}

export function addRigidSphere(
  scene: Scene,
  name: string,
  position: readonly [number, number, number],
  radius: number,
  color: readonly [number, number, number, number],
  options: Physics3DBodyOptions = {},
): { entity: Entity; body: Physics3DBody; transform: Transform3D } {
  const transform = transformAt(position);
  const body = new Physics3DBody({
    ...options,
    type: options.type ?? 'dynamic',
    shape: 'sphere',
    radius,
  });
  const entity = new Entity(name);
  entity.addComponent(transform);
  entity.addComponent(new Mesh3D(
    createSphere3D({ radius, widthSegments: 30, heightSegments: 18 }),
    new PbrMaterial({ baseColor: color, metallic: 0.18, roughness: 0.24 }),
  ));
  entity.addComponent(body);
  scene.add(entity);
  return { entity, body, transform };
}

export function addGround(
  scene: Scene,
  size: readonly [number, number, number] = [18, 0.6, 14],
  position: readonly [number, number, number] = [0, -0.3, 0],
): ReturnType<typeof addRigidBox> {
  return addRigidBox(
    scene,
    'Ground',
    position,
    size,
    [0.12, 0.16, 0.23, 1],
    { type: 'static', friction: 0.72, restitution: 0.05, density: 0 },
  );
}

export function transformAt(
  position: readonly [number, number, number],
  rotation: readonly [number, number, number] = [0, 0, 0],
): Transform3D {
  const transform = new Transform3D();
  const translation = mat4.translation(position);
  const yaw = mat4.rotationY(rotation[1]);
  const pitch = mat4.rotationX(rotation[0]);
  const roll = mat4.rotationZ(rotation[2]);
  transform.setMatrix(mat4.multiply(
    translation,
    mat4.multiply(yaw, mat4.multiply(pitch, roll)),
  ) as Float32Array);
  return transform;
}

export function pointerRay(
  context: Physics3DExampleContext,
  event: PointerEvent,
  ray = new Ray(),
): Ray {
  const canvas = context.canvas;
  const rect = canvas.getBoundingClientRect();
  const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = 1 - ((event.clientY - rect.top) / rect.height) * 2;
  context.cameraComponent.updateAspect(context.engine.width / context.engine.height);
  context.cameraTransform.updateWorldMatrix();
  const view = mat4.inverse(context.cameraTransform.worldMatrix);
  const viewProjection = mat4.multiply(context.cameraComponent.projectionMatrix, view);
  const inverseViewProjection = mat4.inverse(viewProjection);
  return ray.setFromCamera(
    ndcX,
    ndcY,
    context.cameraTransform.eyePosition,
    inverseViewProjection as Float32Array,
  );
}

export function rayTuple(ray: Ray): {
  origin: [number, number, number];
  direction: [number, number, number];
} {
  return {
    origin: [ray.origin[0] ?? 0, ray.origin[1] ?? 0, ray.origin[2] ?? 0],
    direction: [ray.direction[0] ?? 0, ray.direction[1] ?? 0, ray.direction[2] ?? -1],
  };
}

export function addBackdrop(scene: Scene): void {
  const backdrop = new Entity('Backdrop');
  backdrop.addComponent(new CartesianTransform3D({ position: [0, 5, -16] }));
  backdrop.addComponent(new Mesh3D(
    createBox3D({ width: 36, height: 20, depth: 0.2 }),
    new BasicMaterial({ color: [0.025, 0.045, 0.085, 1] }),
  ));
  scene.add(backdrop);
}

export function runExample(context: Physics3DExampleContext): void {
  context.engine.switchScene(context.scene);
  context.engine.run();
}

function addStudioLighting(scene: Scene): void {
  const sun = new Entity('Sun');
  sun.addComponent(new DirectionalLight({
    direction: [-0.6, -1, -0.35],
    color: [1, 0.93, 0.82],
    intensity: 3.2,
    castShadow: true,
    shadow: { mapSize: 1024, extent: 18, far: 55, bias: 0.0015 },
  }));
  scene.add(sun);

  const environment = new Entity('Environment');
  environment.addComponent(new EnvironmentLight({
    intensity: 0.72,
    diffuseColor: [0.12, 0.24, 0.45],
    specularColor: [0.72, 0.86, 1],
  }));
  scene.add(environment);
}

function beginGpuValidation(engine: HaiyueEngine): void {
  const errors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  engine.device.pushErrorScope('validation');
  let frames = 0;
  let finished = false;
  engine.on('after-update', () => {
    if (finished || ++frames < 4) return;
    finished = true;
    void (async () => {
      await engine.device.queue.onSubmittedWorkDone();
      const error = await engine.device.popErrorScope();
      if (error) errors.push(error.message);
      document.body.dataset.physicsBackend = 'rapier3d';
      document.body.dataset.renderStatus = errors.length ? 'failed' : 'passed';
      document.body.dataset.renderError = errors.join('\n');
    })();
  });
}
