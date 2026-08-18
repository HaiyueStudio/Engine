import * as pc from '/node_modules/playcanvas/build/playcanvas/src/index.js';
import { expectedStructuralEvidence } from '../scene-contract.mjs';

export async function createAdapter({ canvas, contract, objects, version }) {
  const graphicsDevice = await pc.createGraphicsDevice(canvas, {
    deviceTypes: [pc.DEVICETYPE_WEBGPU],
    antialias: false,
    alpha: false,
  });
  if (graphicsDevice.deviceType !== pc.DEVICETYPE_WEBGPU) throw new Error(`PlayCanvas selected ${graphicsDevice.deviceType}.`);
  const app = new pc.Application(canvas, { graphicsDevice });
  app.setCanvasResolution(pc.RESOLUTION_FIXED, contract.viewport.width, contract.viewport.height);
  app.autoRender = false;
  const camera = new pc.Entity('Comparison camera');
  camera.addComponent('camera', { clearColor: new pc.Color(...contract.clearColor), fov: contract.camera.fovRadians * 180 / Math.PI, nearClip: contract.camera.near, farClip: contract.camera.far });
  camera.setPosition(...contract.camera.position);
  camera.lookAt(...contract.camera.target);
  app.root.addChild(camera);
  const key = new pc.Entity('Key light');
  key.addComponent('light', { type: 'directional', intensity: 2.2, castShadows: false });
  key.setEulerAngles(45, 35, 0);
  app.root.addChild(key);
  app.scene.ambientLight = new pc.Color(0.65, 0.65, 0.65);
  const materials = contract.materials.map(materialContract => {
    const material = new pc.StandardMaterial();
    material.diffuse = new pc.Color(...materialContract.color);
    material.useMetalness = true;
    material.metalness = materialContract.metallic;
    material.gloss = 1 - materialContract.roughness;
    material.update();
    return material;
  });
  for (const object of objects) {
    const entity = new pc.Entity(`Box ${object.id}`);
    entity.addComponent('render', { type: 'box', material: materials[object.materialIndex], castShadows: false });
    entity.setPosition(...object.position);
    entity.setEulerAngles(object.rotation[0] * 180 / Math.PI, object.rotation[1] * 180 / Math.PI, 0);
    app.root.addChild(entity);
  }
  const device = graphicsDevice.wgpu;
  if (!device?.queue) throw new Error('PlayCanvas WebGPU device is unavailable.');
  return {
    engineId: 'playcanvas',
    displayName: 'PlayCanvas Engine',
    version,
    backend: 'webgpu',
    nativeBackend: true,
    adapterInfo: plainAdapterInfo(graphicsDevice.gpuAdapter?.info),
    structural: { ...expectedStructuralEvidence(contract), implementation: 'render components using shared primitive/material caches' },
    async render() { app.update(1 / 60); app.render(); },
    async settle() { await device.queue.onSubmittedWorkDone(); },
    async dispose() { await device.queue.onSubmittedWorkDone(); app.destroy(); },
  };
}

function plainAdapterInfo(info) {
  return info ? { vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '', description: info.description ?? '' } : {};
}

