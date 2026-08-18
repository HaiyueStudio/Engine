import {
  Camera,
  Color,
  DirectLight,
  MeshRenderer,
  PBRMaterial,
  PrimitiveMesh,
  Vector3,
  WebGLEngine,
  WebGLMode,
  version as galaceanRuntimeVersion,
} from '@galacean/engine';
import { expectedStructuralEvidence } from '../scene-contract.mjs';

export async function createAdapter({ canvas, contract, objects, version }) {
  const engine = await WebGLEngine.create({
    canvas,
    graphicDeviceOptions: { webGLMode: WebGLMode.WebGL2, alpha: false, preserveDrawingBuffer: true },
  });
  canvas.width = contract.viewport.width;
  canvas.height = contract.viewport.height;
  const scene = engine.sceneManager.activeScene;
  scene.background.solidColor = new Color(...contract.clearColor);
  const root = scene.createRootEntity(contract.id);
  const cameraEntity = root.createChild('Comparison camera');
  cameraEntity.transform.setPosition(...contract.camera.position);
  cameraEntity.transform.lookAt(new Vector3(...contract.camera.target));
  const camera = cameraEntity.addComponent(Camera);
  camera.fieldOfView = contract.camera.fovRadians * 180 / Math.PI;
  camera.nearClipPlane = contract.camera.near;
  camera.farClipPlane = contract.camera.far;
  const keyEntity = root.createChild('Key light');
  keyEntity.transform.setRotation(-45, -35, 0);
  const key = keyEntity.addComponent(DirectLight);
  key.intensity = 2.2;
  scene.ambientLight.diffuseSolidColor = new Color(0.65, 0.65, 0.65, 1);
  const geometry = PrimitiveMesh.createCuboid(engine, contract.grid.boxSize, contract.grid.boxSize, contract.grid.boxSize);
  const materials = contract.materials.map(materialContract => {
    const material = new PBRMaterial(engine);
    material.baseColor = new Color(...materialContract.color, 1);
    material.metallic = materialContract.metallic;
    material.roughness = materialContract.roughness;
    return material;
  });
  for (const object of objects) {
    const entity = root.createChild(`Box ${object.id}`);
    entity.transform.setPosition(...object.position);
    entity.transform.setRotation(object.rotation[0] * 180 / Math.PI, object.rotation[1] * 180 / Math.PI, 0);
    const renderer = entity.addComponent(MeshRenderer);
    renderer.mesh = geometry;
    renderer.setMaterial(materials[object.materialIndex]);
  }
  engine.pause();
  const hardware = engine._hardwareRenderer;
  const gl = hardware?.gl;
  if (!(gl instanceof WebGL2RenderingContext)) throw new Error('Galacean did not create a WebGL2 context.');
  return {
    engineId: 'galacean',
    displayName: 'Galacean Engine',
    version: version || galaceanRuntimeVersion,
    backend: 'webgl2',
    nativeBackend: true,
    adapterInfo: { renderer: hardware.renderer ?? 'unknown' },
    structural: { ...expectedStructuralEvidence(contract), implementation: 'shared mesh/material renderers (WebGL2 informational)' },
    async render() { engine.update(); },
    async settle() { gl.finish(); },
    async dispose() { gl.finish(); engine.destroy(); },
  };
}

