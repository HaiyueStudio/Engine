import { AmbientLight } from '@haiyue/engine/lighting';
import { CartesianTransform3D, DirectionalLight, Entity, HaiyueEngine, Mesh3D, OrbitControl, SphericalTransform3D, createPlane3D, createSphere3D } from '@haiyue/engine';
import { ToonMaterial } from '@haiyue/engine/material';
import { ToonRenderSystem } from '@haiyue/engine/systems';

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
  const engine = new HaiyueEngine({
    canvas,
    renderProfile: 'gpu-driven',
    msaaSamples: 4,
    clearColor: { r: 0.025, g: 0.035, b: 0.07, a: 1 },
  });
  await engine.init();
  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const scene = engine.createScene({
    name: 'Four-layer Toon',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 80 },
      orbit: { radius: 7, theta: Math.PI * 0.12, phi: Math.PI * 0.25, target: [0, 0.4, 0] },
    },
    render3D: { renderProfile: 'gpu-driven' },
    render2D: false,
    gui: false,
  });
  new OrbitControl(canvas, scene.cameraEntity.getComponent(SphericalTransform3D)!, { minRadius: 3, maxRadius: 15 });
  const toonSystem = new ToonRenderSystem(engine, scene.cameraEntity, { priority: -1, render3DSystem: scene.render3DSystem });
  scene.addSystem(toonSystem);

  const textures = [
    createPattern('#233052', '#172039', 'cross'),
    createPattern('#6170a0', '#46557e', 'dots'),
    createPattern('#d78191', '#ae5f79', 'stripes'),
    createPattern('#fff0c7', '#edbd79', 'spark'),
  ] as const;
  const material = new ToonMaterial({
    baseColor: [1, 1, 1, 1],
    bandSoftness: 0.012,
    layers: [
      { minLight: 0, color: [0.62, 0.7, 1, 1], texture: textures[0], sampler: { magFilter: 'nearest', minFilter: 'nearest' }, textureMapping: { scale: [3, 3] } },
      { minLight: 0.28, color: [0.8, 0.88, 1, 1], texture: textures[1], textureMapping: { scale: [4, 4] } },
      { minLight: 0.56, color: [1, 0.86, 0.92, 1], texture: textures[2], textureMapping: { scale: [5, 5] } },
      { minLight: 0.82, color: [1, 1, 0.9, 1], texture: textures[3], textureMapping: { scale: [3, 3] } },
    ],
  });
  addMesh(scene, 'Four texture bands', createSphere3D({ radius: 1.65, widthSegments: 64, heightSegments: 40 }), material, [0, 0.65, 0]);
  addMesh(scene, 'Ground', createPlane3D({ width: 12, height: 12, normal: 'y' }), new ToonMaterial({
    layers: [
      { minLight: 0, color: [0.12, 0.16, 0.25, 1] },
      { minLight: 0.45, color: [0.24, 0.3, 0.43, 1] },
    ],
  }), [0, -1.05, 0]);

  const ambient = new Entity('Ambient');
  ambient.addComponent(new AmbientLight({ color: [0.3, 0.4, 0.65], intensity: 0.12 }));
  scene.add(ambient);
  const sun = new Entity('Sun');
  sun.addComponent(new DirectionalLight({
    direction: [-0.75, -1, -0.4],
    color: [1, 0.92, 0.78],
    intensity: 1.35,
    castShadow: true,
    shadow: { mapSize: 1024, extent: 10, far: 30, bias: 0.001 },
  }));
  scene.add(sun);

  const warmup = await scene.warmupPipelines();
  if (warmup.status !== 'completed') throw warmup.error ?? new Error(`Pipeline warmup ended with ${warmup.status}.`);
  engine.switchScene(scene);
  let frames = 0;
  engine.on('after-update', () => {
    if (++frames !== 3) return;
    void finishValidation();
  });
  engine.run();

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    document.body.dataset.renderStatus = validationErrors.length ? 'failed' : 'passed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.toonLayers = String(material.layers.length);
  }
}

function addMesh(
  scene: ReturnType<HaiyueEngine['createScene']>,
  name: string,
  geometry: ReturnType<typeof createSphere3D> | ReturnType<typeof createPlane3D>,
  material: ToonMaterial,
  position: [number, number, number],
): void {
  const entity = new Entity(name);
  entity.addComponent(new CartesianTransform3D({ position }));
  entity.addComponent(new Mesh3D(geometry, material));
  scene.add(entity);
}

function createPattern(background: string, accent: string, pattern: 'cross' | 'dots' | 'stripes' | 'spark'): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d')!;
  context.fillStyle = background;
  context.fillRect(0, 0, 64, 64);
  context.fillStyle = accent;
  if (pattern === 'cross') {
    for (let index = 0; index < 64; index += 16) {
      context.fillRect(index, 0, 3, 64);
      context.fillRect(0, index, 64, 3);
    }
  } else if (pattern === 'dots') {
    for (let y = 8; y < 64; y += 16) for (let x = 8; x < 64; x += 16) {
      context.beginPath();
      context.arc(x, y, 3, 0, Math.PI * 2);
      context.fill();
    }
  } else if (pattern === 'stripes') {
    for (let x = -64; x < 64; x += 16) {
      context.save();
      context.translate(x, 0);
      context.rotate(-Math.PI / 6);
      context.fillRect(0, -32, 5, 128);
      context.restore();
    }
  } else {
    context.fillRect(29, 0, 6, 64);
    context.fillRect(0, 29, 64, 6);
    context.beginPath();
    context.arc(32, 32, 13, 0, Math.PI * 2);
    context.fill();
  }
  return canvas;
}

main().catch(error => {
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(error);
});
