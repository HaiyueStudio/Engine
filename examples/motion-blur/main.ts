import { BasicMaterial, CartesianTransform3D, DirectionalLight, Entity, EnvironmentLight, Geometry3D, HaiyueEngine, Mesh3D, OrbitControl, SphericalTransform3D, createBox3D, createPlane3D, createSphere3D } from '@haiyue/engine';
import { createTorus3D } from '@haiyue/engine/geometry';
import { MotionBlurPass, PostProcessRenderFeature } from '@haiyue/engine/postprocess';
import { applyGltfAnimationClip, disposeGltfModel, loadGltfModel, type LoadedGltfModel } from '@haiyue/extensions/gltf';

type Vec3 = [number, number, number];

interface MovingObject {
  readonly transform: CartesianTransform3D;
  readonly phase: number;
  readonly radius: number;
  readonly height: number;
}

async function main(): Promise<void> {
  const canvas = query<HTMLCanvasElement>('#canvas');
  const queryParams = new URLSearchParams(location.search);
  const regression = queryParams.get('regression') === '1';
  const requestedDisplayMode = parseDisplayMode(queryParams.get('mode'));
  const requestedReconstruction = queryParams.get('reconstruction') === 'centered' ? 'centered' : 'tile-neighbor-max';
  const initiallyEnabled = queryParams.get('blur') !== 'off';
  const engine = new HaiyueEngine({
    canvas,
    msaaSamples: 4,
    clearColor: { r: 0.006, g: 0.01, b: 0.024, a: 1 },
  });
  await engine.init();
  const validationErrors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  engine.device.pushErrorScope('validation');

  const scene = engine.createScene({
    name: 'Motion blur laboratory',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4.3, near: 0.1, far: 100 },
      orbit: { radius: 16, theta: Math.PI * 0.12, phi: Math.PI * 0.34, target: [0, 1.5, -1.5] },
    },
    render3D: { renderProfile: 'gpu-driven' },
    render2D: false,
    gui: false,
    pipelineLabel: 'MotionBlur.render',
  });
  const cameraTransform = scene.cameraEntity.getComponent(SphericalTransform3D)!;
  new OrbitControl(canvas, cameraTransform, { minRadius: 8, maxRadius: 30, rotateSpeed: 0.55 });

  const motionBlur = new MotionBlurPass({
    shutterAngle: 270,
    intensity: Number(queryParams.get('intensity') ?? 2.75),
    sampleCount: 24,
    maxBlurPixels: 48,
    displayMode: requestedDisplayMode,
    reconstruction: requestedReconstruction,
  });
  const postProcess = new PostProcessRenderFeature(scene.render3DSystem!, initiallyEnabled ? [motionBlur] : []);
  scene.addSystem(postProcess);

  const highFrequencyTexture = createHighFrequencyTexture();
  const dark = new BasicMaterial({ color: [0.025, 0.045, 0.085, 1] });
  const cyan = new BasicMaterial({ color: [0.08, 0.92, 0.88, 1], texture: highFrequencyTexture });
  const orange = new BasicMaterial({ color: [1, 0.3, 0.06, 1], texture: highFrequencyTexture });
  const magenta = new BasicMaterial({ color: [1, 0.12, 0.64, 1], texture: highFrequencyTexture });
  const white = new BasicMaterial({ color: [0.86, 0.95, 1, 1], texture: highFrequencyTexture });

  addMesh(scene, 'Ground', createPlane3D({ width: 28, height: 28, normal: 'y' }), dark, [0, -0.08, -3]);
  const tileGeometry = createBox3D({ width: 0.62, height: 0.035, depth: 0.62 });
  for (let z = 0; z < 13; z++) for (let x = -9; x <= 9; x++) {
    if ((x + z) % 2 !== 0) continue;
    addMesh(scene, `Speed grid ${x}:${z}`, tileGeometry, (x + z) % 4 === 0 ? cyan : white, [x * 0.68, 0, 2.5 - z * 0.68]);
  }

  const rotorTransforms: CartesianTransform3D[] = [];
  const bladeGeometry = createBox3D({ width: 5.4, height: 0.1, depth: 0.22 });
  for (let index = 0; index < 3; index++) {
    rotorTransforms.push(addMesh(
      scene,
      `Rotor blade ${index}`,
      bladeGeometry,
      index === 0 ? orange : index === 1 ? magenta : white,
      [0, 2.65, -1],
      [0, 0, index * Math.PI / 3],
    ).getComponent(CartesianTransform3D)!);
  }
  addMesh(scene, 'Rotor hub', createSphere3D({ radius: 0.34, widthSegments: 20, heightSegments: 12 }), orange, [0, 2.65, -1]);
  const patternedTorus = addMesh(
    scene,
    'High-frequency patterned torus',
    createTorus3D({ radius: 1.45, tube: 0.28, radialSegments: 32, tubularSegments: 96 }),
    cyan,
    [0, 2.65, -1],
    [Math.PI / 2, 0, 0],
  ).getComponent(CartesianTransform3D)!;

  const movingObjects: MovingObject[] = [];
  const movingGeometry = createBox3D({ width: 0.72, height: 0.72, depth: 0.72 });
  const movingMaterials = [cyan, orange, magenta, white];
  for (let index = 0; index < 8; index++) {
    const phase = index / 8 * Math.PI * 2;
    const transform = addMesh(
      scene,
      `Orbiter ${index}`,
      movingGeometry,
      movingMaterials[index % movingMaterials.length]!,
      [Math.cos(phase) * 5.2, 1.2, -1 + Math.sin(phase) * 3.4],
    ).getComponent(CartesianTransform3D)!;
    movingObjects.push({ transform, phase, radius: 5.2, height: 1.15 + index % 2 * 0.8 });
  }

  // A real 19-joint glTF fixture exercises animated skinning rather than a
  // hand-authored quad. It is loaded before warmup so its PBR/skinned pipeline
  // and motion-vector deformation path are both present in the first frame.
  const characterModel = await loadMotionBlurCharacter();
  const characterActor = new Entity('Rigged Figure character').addComponent(new CartesianTransform3D({
    position: [3.0, 0.05, -4.2],
    rotation: [0, Math.PI, 0],
    scale: [3.2, 3.2, 3.2],
  }));
  characterActor.addChild(characterModel.root);
  scene.add(characterActor);
  const characterClip = characterModel.animationClips[0];
  if (!characterClip) throw new Error('Rigged Figure fixture did not provide its skin animation clip.');
  scene.add(new Entity('Character key light').addComponent(new DirectionalLight({
    direction: [-0.55, -1, -0.35],
    color: [1, 0.94, 0.82],
    intensity: 3.4,
    castShadow: true,
    shadow: { mapSize: 512, extent: 14, far: 40, bias: 0.0012 },
  })));
  scene.add(new Entity('Character environment').addComponent(new EnvironmentLight({
    intensity: 0.65,
    diffuseColor: [0.12, 0.22, 0.38],
    specularColor: [0.62, 0.82, 1],
  })));

  const params = { enabled: initiallyEnabled, animate: true, cameraMotion: !regression, speed: regression ? 1.5 : 1 };
  bindControls(motionBlur, postProcess, params);
  const warmupStartedAt = performance.now();
  const warmup = await scene.warmupPipelines();
  const pipelineWarmupMs = performance.now() - warmupStartedAt;
  if (warmup.status !== 'completed') throw warmup.error ?? new Error(`Pipeline warmup ended with ${warmup.status}.`);
  engine.switchScene(scene);

  let previousTime = 0;
  let motionTime = 0;
  let regressionFrame = 0;
  engine.on('update', ({ detail: { time } }) => {
    const deltaSeconds = regression
      ? 1 / 60
      : previousTime > 0 ? Math.min(0.1, Math.max(0, (time - previousTime) * 0.001)) : 0;
    previousTime = time;
    if (params.animate) {
      motionTime += deltaSeconds * params.speed;
      const elapsed = motionTime;
      const rotorAngle = elapsed * 8;
      for (let index = 0; index < rotorTransforms.length; index++) {
        rotorTransforms[index]!.setRotation(0, Math.sin(elapsed * 0.7) * 0.12, rotorAngle + index * Math.PI / 3);
      }
      patternedTorus.setRotation(Math.PI / 2 + Math.sin(elapsed * 0.9) * 0.2, rotorAngle * 0.55, rotorAngle * 0.9);
      for (const object of movingObjects) {
        const angle = elapsed * 2.2 + object.phase;
        object.transform
          .setPosition(Math.cos(angle) * object.radius, object.height + Math.sin(angle * 2) * 0.28, -1 + Math.sin(angle) * 3.4)
          .setRotation(angle * 0.4, angle * 1.8, angle * 0.7);
      }
      applyGltfAnimationClip(characterClip, characterClip.duration > 0 ? elapsed % characterClip.duration : elapsed);
    }
    if (params.cameraMotion) cameraTransform.theta += deltaSeconds * 0.18;
    regressionFrame++;
  });

  let frames = 0;
  let validationFinished = false;
  engine.on('after-update', () => {
    updateStats(motionBlur);
    if (!validationFinished && ++frames >= (regression ? 24 : 14)) {
      validationFinished = true;
      if (regression) engine.stop();
      void finishValidation();
    }
  });
  engine.run();

  window.addEventListener('beforeunload', () => {
    disposeGltfModel(characterModel);
  }, { once: true });

  async function finishValidation(): Promise<void> {
    await engine.device.queue.onSubmittedWorkDone();
    const scopedError = await engine.device.popErrorScope();
    if (scopedError) validationErrors.push(scopedError.message);
    if (params.enabled && motionBlur.stats.appliedFrameCount < 2) validationErrors.push('Motion blur did not run across continuous frames.');
    const coverage = 'pbr,gltf-skinning,shadow,motion-vector,intensity,velocity-heatmap,split,tile-neighbor-max';
    document.body.dataset.renderStatus = validationErrors.length ? 'failed' : 'passed';
    document.body.dataset.renderError = validationErrors.join('\n');
    document.body.dataset.motionBlurFrames = String(motionBlur.stats.appliedFrameCount);
    document.body.dataset.characterAnimationValidation = coverage;
    document.body.dataset.motionBlurMode = params.enabled ? motionBlur.displayMode : 'raw';
    document.body.dataset.motionBlurIntensity = String(motionBlur.intensity);
    document.body.dataset.motionBlurReconstruction = motionBlur.reconstruction;
    const result = query<HTMLElement>('#result');
    result.dataset.status = validationErrors.length ? 'failed' : 'passed';
    result.textContent = JSON.stringify({
      status: result.dataset.status,
      errors: validationErrors,
      coverage,
      mode: params.enabled ? motionBlur.displayMode : 'raw',
      intensity: motionBlur.intensity,
      reconstruction: motionBlur.reconstruction,
      characterJoints: 19,
      pipelineWarmupMs,
      stats: motionBlur.stats,
    });
  }
}

function addMesh(
  scene: ReturnType<HaiyueEngine['createScene']>,
  name: string,
  geometry: Geometry3D,
  material: BasicMaterial,
  position: Vec3,
  rotation: Vec3 = [0, 0, 0],
): Entity {
  const entity = new Entity(name)
    .addComponent(new CartesianTransform3D({ position, rotation }))
    .addComponent(new Mesh3D(geometry, material));
  scene.add(entity);
  return entity;
}

async function loadMotionBlurCharacter(): Promise<LoadedGltfModel> {
  const assetUrl = new URL(
    '../../scripts/webgpu-gate/assets/gltf-corpus/medium-rigged-figure-draco/RiggedFigure.gltf',
    window.location.href,
  ).href;
  const decoderScriptUrl = new URL(
    '../../node_modules/draco3dgltf/draco_decoder_gltf_nodejs.js',
    window.location.href,
  ).href;
  const decoderWasmUrl = new URL(
    '../../node_modules/draco3dgltf/draco_decoder_gltf.wasm',
    window.location.href,
  ).href;
  const response = await fetch(decoderWasmUrl);
  if (!response.ok) throw new Error(`Could not load the Draco decoder (${response.status}).`);
  return loadGltfModel(assetUrl, {
    dracoDecoderConfig: {
      scriptUrl: decoderScriptUrl,
      wasmBinary: await response.arrayBuffer(),
    },
  });
}

function createHighFrequencyTexture(): HTMLCanvasElement {
  const texture = document.createElement('canvas');
  texture.width = 128;
  texture.height = 128;
  const context = texture.getContext('2d');
  if (!context) throw new Error('Motion blur texture requires a 2D canvas context.');
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      context.fillStyle = (x + y) % 2 === 0 ? '#f7fbff' : '#07111e';
      context.fillRect(x * 8, y * 8, 8, 8);
    }
  }
  context.strokeStyle = '#ffdf5a';
  context.lineWidth = 3;
  for (let offset = -128; offset < 256; offset += 24) {
    context.beginPath();
    context.moveTo(offset, 0);
    context.lineTo(offset + 128, 128);
    context.stroke();
  }
  return texture;
}

function parseDisplayMode(value: string | null): 'blur' | 'split' | 'velocity' {
  if (value === 'blur' || value === 'velocity') return value;
  return 'split';
}

function bindControls(
  blur: MotionBlurPass,
  postProcess: PostProcessRenderFeature,
  params: { enabled: boolean; animate: boolean; cameraMotion: boolean; speed: number },
): void {
  const enabled = query<HTMLInputElement>('#blur-enabled');
  const animate = query<HTMLInputElement>('#scene-animate');
  const animateValue = query<HTMLOutputElement>('#scene-animate-value');
  const cameraMotion = query<HTMLInputElement>('#camera-motion');
  const cameraMotionValue = query<HTMLOutputElement>('#camera-motion-value');
  const motionSpeed = query<HTMLInputElement>('#motion-speed');
  const motionSpeedValue = query<HTMLOutputElement>('#motion-speed-value');
  const shutter = query<HTMLInputElement>('#shutter');
  const shutterValue = query<HTMLOutputElement>('#shutter-value');
  const intensity = query<HTMLInputElement>('#intensity');
  const intensityValue = query<HTMLOutputElement>('#intensity-value');
  const samples = query<HTMLInputElement>('#samples');
  const samplesValue = query<HTMLOutputElement>('#samples-value');
  const radius = query<HTMLInputElement>('#radius');
  const radiusValue = query<HTMLOutputElement>('#radius-value');
  const displayMode = query<HTMLSelectElement>('#display-mode');
  const reconstruction = query<HTMLSelectElement>('#reconstruction');

  enabled.checked = params.enabled;
  cameraMotion.checked = params.cameraMotion;
  cameraMotionValue.value = params.cameraMotion ? 'on' : 'off';
  motionSpeed.value = String(params.speed);
  motionSpeedValue.value = `${params.speed.toFixed(2)}×`;
  shutter.value = String(blur.shutterAngle);
  shutterValue.value = `${blur.shutterAngle.toFixed(0)}°`;
  intensity.value = String(blur.intensity);
  intensityValue.value = `${blur.intensity.toFixed(2)}×`;
  radius.value = String(blur.maxBlurPixels);
  radiusValue.value = `${blur.maxBlurPixels.toFixed(0)}px`;
  displayMode.value = blur.displayMode;
  reconstruction.value = blur.reconstruction;
  document.body.classList.toggle('blur-off', !params.enabled);
  document.body.dataset.displayMode = params.enabled ? blur.displayMode : 'raw';

  enabled.addEventListener('change', () => {
    params.enabled = enabled.checked;
    blur.resetHistory();
    postProcess.setPasses(params.enabled ? [blur] : []);
    document.body.classList.toggle('blur-off', !params.enabled);
    document.body.dataset.displayMode = params.enabled ? blur.displayMode : 'raw';
  });
  animate.addEventListener('change', () => {
    params.animate = animate.checked;
    animateValue.value = params.animate ? 'on' : 'off';
    blur.resetHistory();
  });
  cameraMotion.addEventListener('change', () => {
    params.cameraMotion = cameraMotion.checked;
    cameraMotionValue.value = params.cameraMotion ? 'on' : 'off';
    blur.resetHistory();
  });
  motionSpeed.addEventListener('input', () => {
    params.speed = Number(motionSpeed.value);
    motionSpeedValue.value = `${params.speed.toFixed(2)}×`;
  });
  shutter.addEventListener('input', () => {
    blur.shutterAngle = Number(shutter.value);
    shutterValue.value = `${blur.shutterAngle.toFixed(0)}°`;
  });
  intensity.addEventListener('input', () => {
    blur.intensity = Number(intensity.value);
    intensityValue.value = `${blur.intensity.toFixed(2)}×`;
  });
  samples.addEventListener('input', () => {
    blur.sampleCount = Number(samples.value);
    samplesValue.value = blur.sampleCount.toFixed(0);
  });
  radius.addEventListener('input', () => {
    blur.maxBlurPixels = Number(radius.value);
    radiusValue.value = `${blur.maxBlurPixels.toFixed(0)}px`;
  });
  displayMode.addEventListener('change', () => {
    blur.displayMode = parseDisplayMode(displayMode.value);
    document.body.dataset.displayMode = params.enabled ? blur.displayMode : 'raw';
  });
  reconstruction.addEventListener('change', () => {
    blur.reconstruction = reconstruction.value === 'centered' ? 'centered' : 'tile-neighbor-max';
  });
}

function updateStats(blur: MotionBlurPass): void {
  query<HTMLElement>('#frame-count').textContent = blur.stats.appliedFrameCount.toLocaleString();
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing motion blur example element: ${selector}`);
  return element;
}

void main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = message;
  const result = document.querySelector<HTMLElement>('#result');
  if (result) { result.dataset.status = 'failed'; result.textContent = JSON.stringify({ status: 'failed', errors: [message] }); }
  console.error(error);
});
