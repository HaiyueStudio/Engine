import { BlinnPhongMaterial, InstancedMaterial } from '@haiyue/engine/material';
import { BlinnPhongRenderSystem, InstancedMesh3DRenderSystem } from '@haiyue/engine/systems';
import { BasicMaterial, Camera3D, CartesianTransform3D, DirectionalLight, Entity, HaiyueEngine, Mesh3D, OrbitControl, PbrMaterial, SphericalTransform3D, createBox3D, createPlane3D, createSphere3D } from '@haiyue/engine';
import { Fog } from '@haiyue/engine/lighting';
import { InstancedMesh3D } from '@haiyue/engine/components';
import { createCone3D } from '@haiyue/engine/geometry';
import { mat4 } from 'wgpu-matrix';

const FOG_COLOR: [number, number, number, number] = [0.48, 0.57, 0.68, 1];

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: FOG_COLOR[0], g: FOG_COLOR[1], b: FOG_COLOR[2], a: 1 },
  });
  await engine.init();
  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const cameraTransform = new SphericalTransform3D({
    target: [0, 1, -30],
    radius: 20,
    theta: Math.PI * 0.12,
    phi: Math.PI * 0.38,
  });
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 3, near: 0.1, far: 160 }));
  camera.addComponent(cameraTransform);

  const scene = engine.createScene({
    name: 'Fog',
    camera,
    defaults: { clearColor: { r: FOG_COLOR[0], g: FOG_COLOR[1], b: FOG_COLOR[2], a: 1 } },
    render3D: { loadOp: 'clear' },
    render2D: false,
    gui: false,
    pipelineLabel: 'Fog.render',
  });
  const { world } = scene;
  const query = new URLSearchParams(location.search);
  const initialMode = query.get('mode') === 'height' ? 'height' : 'distance';
  const fogState = query.get('fog');
  const initialMaxOpacity = query.has('maxOpacity') ? Number(query.get('maxOpacity')) : 1;
  if (query.get('regression') === '1') document.body.classList.add('regression');

  new OrbitControl(canvas, cameraTransform, {
    minRadius: 8,
    maxRadius: 70,
    rotateSpeed: 0.7,
  });

  const fogEntity = new Entity('Scene Fog');
  const fog = new Fog({
    mode: initialMode,
    color: FOG_COLOR,
    maxOpacity: initialMaxOpacity,
    distanceStart: 8,
    distanceEnd: 65,
    baseHeight: 0,
    density: 0.055,
    heightFalloff: 0.28,
  });
  if (fogState !== 'none') {
    fogEntity.addComponent(fog);
    world.addEntity(fogEntity);
  }

  const render3DSystem = scene.render3DSystem!;
  scene.addSystem(new BlinnPhongRenderSystem(engine, camera, {
    priority: -1,
    render3DSystem,
  }));
  const instancedRenderSystem = new InstancedMesh3DRenderSystem(engine, camera, {
    loadOp: 'load',
  });
  instancedRenderSystem.priority = 1;
  scene.addSystem(instancedRenderSystem);

  world.addEntity(new Entity('Fog validation sun').addComponent(new DirectionalLight({
    direction: [-0.6, -1, -0.35],
    intensity: 1.4,
    castShadow: false,
  })));

  const geometries = [
    createBox3D({ width: 2.4, height: 2.4, depth: 2.4 }),
    createSphere3D({ radius: 1.45, widthSegments: 24, heightSegments: 16 }),
    createCone3D({ radius: 1.5, height: 3, radialSegments: 24 }),
  ];
  const palette: Array<[number, number, number, number]> = [
    [0.96, 0.35, 0.24, 1],
    [0.25, 0.72, 0.95, 1],
    [0.98, 0.75, 0.2, 1],
    [0.42, 0.9, 0.48, 1],
    [0.72, 0.4, 0.96, 1],
  ];

  // Long rows make the linear distance ramp easy to read. Alternating heights
  // make the vertical density gradient obvious after switching to height fog.
  for (let row = 0; row < 10; row++) {
    const z = -row * 8;
    for (let column = -1; column <= 1; column++) {
      const y = (row + column + 3) % 3 === 0 ? 5.5 : 0;
      const entity = new Entity(`Marker ${row}:${column}`);
      entity.addComponent(new CartesianTransform3D({ position: [column * 5.2, y, z] }));
      const color = palette[(row * 2 + column + 5) % palette.length]!;
      const material = row === 0 && column === 1
        ? new BasicMaterial({ color: [color[0], color[1], color[2], 0.42], blending: 'normal', depthWrite: false })
        : row === 1 && column === -1
          ? new PbrMaterial({ baseColor: color, metallic: 0.35, roughness: 0.38 })
          : row === 1 && column === 0
            ? new BlinnPhongMaterial({ diffuse: color, ambient: [0.08, 0.08, 0.08, 1], shininess: 48 })
            : new BasicMaterial({ color });
      entity.addComponent(new Mesh3D(geometries[(row + column + 3) % geometries.length]!, material));
      world.addEntity(entity);
    }
  }

  const instancedMaterial = new InstancedMaterial(1);
  instancedMaterial.setColor(0, 0.95, 0.42, 0.75, 1);
  instancedMaterial.setTransform(0, mat4.translation([5.2, 2.4, -52]) as Float32Array);
  world.addEntity(new Entity('Fog validation instanced mesh').addComponent(new InstancedMesh3D(
    createBox3D({ width: 2.8, height: 2.8, depth: 2.8 }),
    instancedMaterial,
  )));

  const ground = new Entity('Ground');
  ground.addComponent(new CartesianTransform3D({ position: [0, -1.65, -35] }));
  ground.addComponent(new Mesh3D(
    createPlane3D({ width: 22, height: 100, normal: 'y' }),
    new BasicMaterial({ color: [0.16, 0.2, 0.25, 1] }),
  ));
  world.addEntity(ground);

  bindControls(fog, initialMode, fogState !== 'disabled', initialMaxOpacity);
  let validationFrames = 0;
  let validationFinished = false;
  engine.switchScene(scene);
  engine.on('after-update', () => {
    if (!validationFinished && ++validationFrames >= 3) {
      validationFinished = true;
      void finishValidation();
    }
  });
  engine.run();

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const error = await engine.device.popErrorScope();
    if (error) validationErrors.push(error.message);
    document.body.dataset.fogShaderValidation = 'basic,pbr,blinn,instanced';
    document.body.dataset.renderStatus = validationErrors.length ? 'failed' : 'passed';
    document.body.dataset.renderError = validationErrors.join('\n');
  }
}

function bindControls(
  fog: Fog,
  initialMode: 'distance' | 'height',
  initialEnabled: boolean,
  initialMaxOpacity: number,
): void {
  const distancePanel = document.querySelector<HTMLElement>('#distance-controls')!;
  const heightPanel = document.querySelector<HTMLElement>('#height-controls')!;
  const distanceButton = document.querySelector<HTMLButtonElement>('#distance-mode')!;
  const heightButton = document.querySelector<HTMLButtonElement>('#height-mode')!;
  const toggleButton = document.querySelector<HTMLButtonElement>('#toggle-fog')!;
  document.querySelector<HTMLInputElement>('#max-opacity')!.value = `${initialMaxOpacity}`;

  const setMode = (mode: 'distance' | 'height') => {
    fog.mode = mode;
    distanceButton.classList.toggle('active', mode === 'distance');
    heightButton.classList.toggle('active', mode === 'height');
    distancePanel.hidden = mode !== 'distance';
    heightPanel.hidden = mode !== 'height';
  };
  const setEnabled = (enabled: boolean) => {
    fog.disabled = !enabled;
    toggleButton.classList.toggle('active', enabled);
    toggleButton.textContent = enabled ? 'Fog enabled' : 'Fog disabled';
  };
  const bindRange = (id: string, outputId: string, apply: (value: number) => void) => {
    const input = document.querySelector<HTMLInputElement>(`#${id}`)!;
    const output = document.querySelector<HTMLOutputElement>(`#${outputId}`)!;
    const update = () => {
      const value = Number(input.value);
      apply(value);
      output.value = value.toFixed(input.step.includes('.') ? input.step.split('.')[1]!.length : 0);
    };
    input.addEventListener('input', update);
    update();
  };

  distanceButton.addEventListener('click', () => setMode('distance'));
  heightButton.addEventListener('click', () => setMode('height'));
  toggleButton.addEventListener('click', () => setEnabled(fog.disabled));
  bindRange('distance-start', 'distance-start-value', value => { fog.distanceStart = value; });
  bindRange('distance-end', 'distance-end-value', value => { fog.distanceEnd = value; });
  bindRange('base-height', 'base-height-value', value => { fog.baseHeight = value; });
  bindRange('density', 'density-value', value => { fog.density = value; });
  bindRange('height-falloff', 'height-falloff-value', value => { fog.heightFalloff = value; });
  bindRange('max-opacity', 'max-opacity-value', value => { fog.maxOpacity = value; });

  document.addEventListener('keydown', event => {
    if (event.key === '1') setMode('distance');
    if (event.key === '2') setMode('height');
    if (event.key === '0') setEnabled(fog.disabled);
  });
  setMode(initialMode);
  setEnabled(initialEnabled);
}

main().catch(error => {
  document.body.dataset.renderStatus = 'error';
  console.error(error);
});
