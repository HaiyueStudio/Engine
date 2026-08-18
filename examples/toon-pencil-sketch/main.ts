import { AmbientLight } from '@haiyue/engine/lighting';
import { CartesianTransform3D, DirectionalLight, Entity, Geometry3D, HaiyueEngine, Mesh3D, OrbitControl, SphericalTransform3D, createBox3D, createPlane3D, createSphere3D } from '@haiyue/engine';
import { OutlineTarget } from '@haiyue/engine/components';
import { ToonMaterial } from '@haiyue/engine/material';
import { ToonRenderSystem } from '@haiyue/engine/systems';
import { createCylinder3D, createTorus3D } from '@haiyue/engine/geometry';
import { FxaaPass, OutlinePass, PostProcessRenderFeature } from '@haiyue/engine/postprocess';

type Vec3 = [number, number, number];

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
  const engine = new HaiyueEngine({
    canvas,
    renderProfile: 'gpu-driven',
    msaaSamples: 4,
    clearColor: { r: 0.93, g: 0.9, b: 0.82, a: 1 },
  });
  await engine.init();

  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const scene = engine.createScene({
    name: 'Toon pencil sketch',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4.4, near: 0.1, far: 80 },
      orbit: { radius: 8.8, theta: Math.PI * 0.11, phi: Math.PI * 0.27, target: [0, 0.25, 0] },
    },
    render3D: { renderProfile: 'gpu-driven' },
    render2D: false,
    gui: false,
  });
  new OrbitControl(canvas, scene.cameraEntity.getComponent(SphericalTransform3D)!, {
    minRadius: 4.5,
    maxRadius: 16,
    rotateSpeed: 0.65,
  });

  const toonSystem = new ToonRenderSystem(engine, scene.cameraEntity, {
    render3DSystem: scene.render3DSystem,
  });
  scene.addSystem(toonSystem);

  const outline = new OutlinePass({
    visibleEdgeColor: [0.12, 0.105, 0.09],
    hiddenEdgeColor: [0.48, 0.43, 0.36],
    edgeStrength: 0.92,
    edgeThickness: 1.35,
    edgeGlow: 0.06,
    blendMode: 'multiply',
  });
  const fxaa = new FxaaPass();
  const postProcess = new PostProcessRenderFeature(scene.render3DSystem!, [outline, fxaa]);
  scene.addSystem(postProcess);

  const pencilTextures = createPencilTextures();
  const sketchMaterial = createSketchMaterial(pencilTextures);
  const paperMaterial = new ToonMaterial({
    baseColor: [1, 0.985, 0.94, 1],
    layers: [{
      minLight: 0,
      color: [1, 1, 1, 1],
      texture: pencilTextures[3],
      sampler: repeatSampler(),
      textureMapping: { scale: [7, 7], rotation: 0.08 },
    }],
    doubleSided: true,
  });

  addSketchMesh(scene, 'Study sphere', createSphere3D({ radius: 1.55, widthSegments: 64, heightSegments: 40 }), sketchMaterial, {
    position: [0, 0.55, 0],
  });
  addSketchMesh(scene, 'Leaning cylinder', createCylinder3D({ radiusTop: 0.72, radiusBottom: 0.9, height: 2.6, radialSegments: 48 }), sketchMaterial, {
    position: [-2.45, 0.15, -0.35],
    rotation: [0.08, -0.18, 0.24],
  });
  addSketchMesh(scene, 'Tilted torus', createTorus3D({ radius: 1.05, tube: 0.34, radialSegments: 32, tubularSegments: 72 }), sketchMaterial, {
    position: [2.55, 0.15, -0.2],
    rotation: [1.12, 0.28, -0.12],
  });
  addSketchMesh(scene, 'Back cube', createBox3D({ width: 1.55, height: 1.55, depth: 1.55 }), sketchMaterial, {
    position: [1.45, -0.1, -2.55],
    rotation: [0.08, 0.5, 0.03],
  });
  addSketchMesh(scene, 'Small sphere', createSphere3D({ radius: 0.72, widthSegments: 40, heightSegments: 28 }), sketchMaterial, {
    position: [-1.25, -0.2, -2.35],
  });
  addMesh(scene, 'Paper ground', createPlane3D({ width: 14, height: 11, normal: 'y' }), paperMaterial, {
    position: [0, -1.02, -0.5],
  });

  const ambient = new Entity('Soft fill');
  ambient.addComponent(new AmbientLight({ color: [0.82, 0.79, 0.7], intensity: 0.12 }));
  scene.add(ambient);

  const keyLight = new Entity('Window light');
  keyLight.addComponent(new DirectionalLight({
    direction: [-0.75, -1, -0.45],
    color: [1, 0.96, 0.86],
    intensity: 1.15,
    castShadow: true,
    shadow: { mapSize: 1024, extent: 10, far: 30, bias: 0.0012 },
  }));
  scene.add(keyLight);

  bindControls(outline, postProcess, fxaa);

  const warmup = await scene.warmupPipelines();
  if (warmup.status !== 'completed') {
    throw warmup.error ?? new Error(`Pipeline warmup ended with ${warmup.status}.`);
  }
  engine.switchScene(scene);

  let frames = 0;
  engine.on('after-update', () => {
    if (++frames === 3) void finishValidation();
  });
  engine.run();

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    document.body.dataset.renderStatus = validationErrors.length ? 'failed' : 'passed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.toonLayers = String(sketchMaterial.layers.length);
    document.body.dataset.outlineBlend = outline.blendMode;
    document.body.dataset.pencilTextures = String(pencilTextures.length);
  }
}

function createSketchMaterial(
  textures: readonly [HTMLCanvasElement, HTMLCanvasElement, HTMLCanvasElement, HTMLCanvasElement],
): ToonMaterial {
  return new ToonMaterial({
    baseColor: [0.98, 0.965, 0.91, 1],
    bandSoftness: 0.02,
    layers: [
      {
        minLight: 0,
        color: [0.72, 0.7, 0.66, 1],
        texture: textures[0],
        sampler: repeatSampler(),
        textureMapping: { scale: [4.8, 4.8], rotation: 0.05 },
      },
      {
        minLight: 0.3,
        color: [0.83, 0.81, 0.76, 1],
        texture: textures[1],
        sampler: repeatSampler(),
        textureMapping: { scale: [4.2, 4.2], rotation: -0.08 },
      },
      {
        minLight: 0.57,
        color: [0.92, 0.9, 0.84, 1],
        texture: textures[2],
        sampler: repeatSampler(),
        textureMapping: { scale: [3.7, 3.7], rotation: 0.1 },
      },
      {
        minLight: 0.82,
        color: [1, 0.985, 0.93, 1],
        texture: textures[3],
        sampler: repeatSampler(),
        textureMapping: { scale: [2.8, 2.8], rotation: -0.04 },
      },
    ],
  });
}

function repeatSampler(): GPUSamplerDescriptor {
  return {
    addressModeU: 'repeat',
    addressModeV: 'repeat',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
  };
}

function createPencilTextures(): readonly [HTMLCanvasElement, HTMLCanvasElement, HTMLCanvasElement, HTMLCanvasElement] {
  return [
    createPencilTexture({ seed: 17, paper: '#756f66', grain: 0.15, hatches: [[-0.68, 5, 0.38], [0.72, 7, 0.3]] }),
    createPencilTexture({ seed: 29, paper: '#a49d90', grain: 0.12, hatches: [[-0.66, 7, 0.3], [0.76, 12, 0.16]] }),
    createPencilTexture({ seed: 41, paper: '#d1c9b9', grain: 0.09, hatches: [[-0.62, 11, 0.2]] }),
    createPencilTexture({ seed: 53, paper: '#f0eadd', grain: 0.065, hatches: [] }),
  ];
}

function createPencilTexture(options: {
  seed: number;
  paper: string;
  grain: number;
  hatches: readonly (readonly [angle: number, spacing: number, alpha: number])[];
}): HTMLCanvasElement {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  const random = mulberry32(options.seed);

  context.fillStyle = options.paper;
  context.fillRect(0, 0, size, size);

  for (let index = 0; index < 1800; index++) {
    const shade = random() > 0.48 ? 255 : 30;
    context.fillStyle = `rgba(${shade}, ${shade}, ${shade}, ${options.grain * random()})`;
    const radius = 0.25 + random() * 0.9;
    context.fillRect(random() * size, random() * size, radius, radius);
  }

  for (const [angle, spacing, alpha] of options.hatches) {
    context.save();
    context.translate(size / 2, size / 2);
    context.rotate(angle);
    context.translate(-size / 2, -size / 2);
    context.strokeStyle = `rgba(28, 27, 25, ${alpha})`;
    context.lineWidth = 0.55;
    context.lineCap = 'round';
    for (let y = -size; y < size * 2; y += spacing) {
      context.beginPath();
      context.moveTo(-size, y + (random() - 0.5) * 1.8);
      for (let x = -size; x <= size * 2; x += 12) {
        context.lineTo(x, y + (random() - 0.5) * 2.2);
      }
      context.stroke();
    }
    context.restore();
  }

  return canvas;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ result >>> 15, result | 1);
    result ^= result + Math.imul(result ^ result >>> 7, result | 61);
    return ((result ^ result >>> 14) >>> 0) / 4294967296;
  };
}

function addSketchMesh(
  scene: ReturnType<HaiyueEngine['createScene']>,
  name: string,
  geometry: Geometry3D,
  material: ToonMaterial,
  transform: { position: Vec3; rotation?: Vec3; scale?: Vec3 },
): Entity {
  const entity = addMesh(scene, name, geometry, material, transform);
  entity.addComponent(new OutlineTarget());
  return entity;
}

function addMesh(
  scene: ReturnType<HaiyueEngine['createScene']>,
  name: string,
  geometry: Geometry3D,
  material: ToonMaterial,
  transform: { position: Vec3; rotation?: Vec3; scale?: Vec3 },
): Entity {
  const entity = new Entity(name);
  entity.addComponent(new CartesianTransform3D(transform));
  entity.addComponent(new Mesh3D(geometry, material));
  scene.add(entity);
  return entity;
}

function bindControls(
  outline: OutlinePass,
  postProcess: PostProcessRenderFeature,
  fxaa: FxaaPass,
): void {
  const outlineToggle = document.querySelector<HTMLInputElement>('#outline-toggle')!;
  const outlineState = document.querySelector<HTMLOutputElement>('#outline-state')!;
  const strength = document.querySelector<HTMLInputElement>('#outline-strength')!;
  const strengthValue = document.querySelector<HTMLOutputElement>('#outline-strength-value')!;

  const updatePasses = (): void => {
    postProcess.setPasses(outlineToggle.checked ? [outline, fxaa] : [fxaa]);
    outlineState.value = outlineToggle.checked ? 'on' : 'off';
  };
  outlineToggle.addEventListener('change', updatePasses);
  strength.addEventListener('input', () => {
    outline.edgeStrength = Number(strength.value);
    strengthValue.value = Number(strength.value).toFixed(2);
  });
}

main().catch(error => {
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(error);
});
