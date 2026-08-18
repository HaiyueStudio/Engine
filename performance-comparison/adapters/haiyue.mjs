import {
  Camera3D,
  CartesianTransform3D,
  DirectionalLight,
  Entity,
  EnvironmentLight,
  HaiyueEngine,
  Mesh3D,
  PbrMaterial,
  SphericalTransform3D,
  createBox3D,
} from '/engine/dist/index.js';
import { expectedStructuralEvidence } from '../scene-contract.mjs';

export async function createAdapter({ canvas, contract, objects, version }) {
  const engine = new HaiyueEngine({
    canvas,
    devicePixelRatio: 1,
    msaaSamples: 1,
    timestampQuery: false,
    clearColor: rgba(contract.clearColor),
  });
  await engine.init();
  const camera = new Entity('Comparison camera')
    .addComponent(new Camera3D({
      type: 'perspective',
      fov: contract.camera.fovRadians,
      near: contract.camera.near,
      far: contract.camera.far,
    }))
    .addComponent(sphericalCameraTransform(contract.camera));
  const scene = engine.createScene({ name: contract.id, camera, render3D: true, render2D: false, gui: false });
  const geometry = createBox3D({
    width: contract.grid.boxSize,
    height: contract.grid.boxSize,
    depth: contract.grid.boxSize,
  });
  const materials = contract.materials.map(material => new PbrMaterial({
    baseColor: [...material.color, 1],
    metallic: material.metallic,
    roughness: material.roughness,
  }));
  for (const object of objects) {
    scene.add(new Entity(`Box ${object.id}`)
      .addComponent(new CartesianTransform3D({ position: object.position, rotation: object.rotation }))
      .addComponent(new Mesh3D(geometry, materials[object.materialIndex])));
  }
  scene.add(new Entity('Key light').addComponent(new DirectionalLight({
    direction: [-0.55, -1, -0.4],
    color: [1, 0.96, 0.9],
    intensity: 2.2,
    castShadow: false,
  })));
  scene.add(new Entity('Ambient light').addComponent(new EnvironmentLight({ intensity: 0.65 })));
  engine.switchScene(scene);

  return {
    engineId: 'haiyue',
    displayName: 'HaiYue Engine',
    version,
    backend: 'webgpu',
    nativeBackend: true,
    adapterInfo: plainAdapterInfo(engine.adapter?.info),
    structural: { ...expectedStructuralEvidence(contract), implementation: 'shared geometry/material ECS batches' },
    async render(frame) {
      engine.updateActiveScene(frame * (1000 / 60), 1000 / 60);
    },
    async settle() { await engine.device.queue.onSubmittedWorkDone(); },
    async dispose() { await engine.device.queue.onSubmittedWorkDone(); engine.destroy(); },
  };
}

function rgba(value) { return { r: value[0], g: value[1], b: value[2], a: value[3] }; }
function sphericalCameraTransform(camera) {
  const [x, y, z] = camera.position.map((value, index) => value - camera.target[index]);
  const radius = Math.hypot(x, y, z);
  return new SphericalTransform3D({
    radius,
    theta: Math.atan2(x, z),
    phi: Math.acos(y / radius),
    target: camera.target,
  });
}
function plainAdapterInfo(info) {
  return info ? { vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '', description: info.description ?? '' } : {};
}
