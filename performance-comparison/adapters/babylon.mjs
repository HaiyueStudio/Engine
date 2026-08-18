import {
  Color3,
  Color4,
  DirectionalLight,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  PBRMetallicRoughnessMaterial,
  Quaternion,
  Scene,
  Vector3,
  WebGPUEngine,
} from '/node_modules/@babylonjs/core/index.js';
import { expectedStructuralEvidence } from '../scene-contract.mjs';

export async function createAdapter({ canvas, contract, objects, version }) {
  const engine = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false });
  await engine.initAsync();
  engine.setSize(contract.viewport.width, contract.viewport.height, true);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(...contract.clearColor);
  const camera = new FreeCamera('Comparison camera', new Vector3(...contract.camera.position), scene);
  camera.fov = contract.camera.fovRadians;
  camera.minZ = contract.camera.near;
  camera.maxZ = contract.camera.far;
  camera.setTarget(new Vector3(...contract.camera.target));
  scene.activeCamera = camera;
  const key = new DirectionalLight('Key light', new Vector3(-0.55, -1, -0.4), scene);
  key.intensity = 2.2;
  const ambient = new HemisphericLight('Ambient light', new Vector3(0, 1, 0), scene);
  ambient.intensity = 0.65;
  for (let materialIndex = 0; materialIndex < contract.materialCount; materialIndex++) {
    const descriptors = objects.filter(object => object.materialIndex === materialIndex);
    const materialContract = contract.materials[materialIndex];
    const material = new PBRMetallicRoughnessMaterial(`Material ${materialIndex}`, scene);
    material.baseColor = new Color3(...materialContract.color);
    material.metallic = materialContract.metallic;
    material.roughness = materialContract.roughness;
    const source = MeshBuilder.CreateBox(`Box ${descriptors[0].id}`, { size: contract.grid.boxSize }, scene);
    source.material = material;
    applyTransform(source, descriptors[0]);
    descriptors.slice(1).forEach(descriptor => applyTransform(source.createInstance(`Box ${descriptor.id}`), descriptor));
  }

  await scene.whenReadyAsync();

  const device = engine._device;
  if (!device?.queue) throw new Error('Babylon.js WebGPU device is unavailable.');
  const structural = {
    ...expectedStructuralEvidence(contract),
    implementation: '8 source meshes with hardware instances',
    runtimeMeshCount: scene.meshes.length,
    observedActiveMeshCount: 0,
  };
  return {
    engineId: 'babylon',
    displayName: 'Babylon.js',
    version,
    backend: 'webgpu',
    nativeBackend: true,
    adapterInfo: plainAdapterInfo(engine._adapter?.info),
    structural,
    async render() {
      engine.beginFrame();
      scene.render();
      engine.endFrame();
      structural.observedActiveMeshCount = scene.getActiveMeshes().length;
    },
    async settle() { await device.queue.onSubmittedWorkDone(); },
    async dispose() { await device.queue.onSubmittedWorkDone(); scene.dispose(); engine.dispose(); },
  };
}

function applyTransform(mesh, descriptor) {
  mesh.position.set(...descriptor.position);
  mesh.rotationQuaternion = Quaternion.FromEulerAngles(...descriptor.rotation);
}
function plainAdapterInfo(info) {
  return info ? { vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '', description: info.description ?? '' } : {};
}
