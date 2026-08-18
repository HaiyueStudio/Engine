import * as THREE from '/node_modules/three/build/three.webgpu.js';
import { expectedStructuralEvidence } from '../scene-contract.mjs';

export async function createAdapter({ canvas, contract, objects, version }) {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false });
  renderer.setPixelRatio(1);
  renderer.setSize(contract.viewport.width, contract.viewport.height, false);
  await renderer.init();
  if (!renderer.backend?.isWebGPUBackend) throw new Error('Three.js selected a non-WebGPU backend.');
  renderer.setClearColor(new THREE.Color(...contract.clearColor.slice(0, 3)), contract.clearColor[3]);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    contract.camera.fovRadians * 180 / Math.PI,
    contract.viewport.width / contract.viewport.height,
    contract.camera.near,
    contract.camera.far,
  );
  camera.position.set(...contract.camera.position);
  camera.lookAt(...contract.camera.target);
  scene.add(new THREE.DirectionalLight(0xfff5e6, 2.2));
  scene.children.at(-1).position.set(8, 14, 10);
  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const geometry = new THREE.BoxGeometry(contract.grid.boxSize, contract.grid.boxSize, contract.grid.boxSize);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  for (let materialIndex = 0; materialIndex < contract.materialCount; materialIndex++) {
    const descriptors = objects.filter(object => object.materialIndex === materialIndex);
    const materialContract = contract.materials[materialIndex];
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(...materialContract.color),
      metalness: materialContract.metallic,
      roughness: materialContract.roughness,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, descriptors.length);
    descriptors.forEach((object, index) => {
      position.set(...object.position);
      quaternion.setFromEuler(new THREE.Euler(...object.rotation));
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
  }

  return {
    engineId: 'three',
    displayName: 'Three.js',
    version,
    backend: 'webgpu',
    nativeBackend: true,
    adapterInfo: plainAdapterInfo(renderer.backend.device?.adapterInfo),
    structural: { ...expectedStructuralEvidence(contract), implementation: '8 InstancedMesh draws' },
    async render() { await renderer.renderAsync(scene, camera); },
    async settle() { await renderer.backend.device.queue.onSubmittedWorkDone(); },
    async dispose() { await renderer.backend.device.queue.onSubmittedWorkDone(); renderer.dispose(); },
  };
}

function plainAdapterInfo(info) {
  return info ? { vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '', description: info.description ?? '' } : {};
}

