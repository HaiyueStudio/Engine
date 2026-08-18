import {
  BasicMaterial,
  Camera3D,
  CartesianTransform3D,
  ColorSRGB,
  Entity,
  HaiyueEngine,
  Mesh3D,
  createPlane3D,
} from '@haiyue/engine';
import { Mesh3DRenderer, setRender3DMeshRenderer } from '@haiyue/engine/experimental';
import {
  TextureBlurProcessor,
  type BlurMethod,
  type ConvolutionKernelSize,
  type TextureBlurSettings,
} from './TextureBlurProcessor';

const TEXTURE_WIDTH = 768;
const TEXTURE_HEIGHT = 512;
const PANEL_HEIGHT = 3.35;

interface SideControls {
  method: HTMLSelectElement;
  kernelSize: HTMLSelectElement;
  radius: HTMLInputElement;
  radiusValue: HTMLOutputElement;
  iterations: HTMLInputElement;
  iterationsValue: HTMLOutputElement;
  passCount: HTMLElement;
  label: HTMLElement;
}

interface SideState {
  settings: TextureBlurSettings;
  controls: SideControls;
  material: BasicMaterial;
  destination: () => GPUTexture;
  scheduled: boolean;
}

interface TextureState {
  sourceTexture: GPUTexture;
  leftOutputTexture: GPUTexture;
  rightOutputTexture: GPUTexture;
  width: number;
  height: number;
}

const METHOD_LABELS: Record<BlurMethod, string> = {
  none: 'No blur',
  convolution: 'Square convolution',
  gaussian: 'Separable Gaussian',
  box: 'Separable Box',
  mipmap: 'Mipmap blur',
  kawase: 'Kawase blur',
};

async function main(): Promise<void> {
  const uploadButton = query<HTMLButtonElement>('#upload-button');
  const uploadInput = query<HTMLInputElement>('#upload-input');
  const uploadName = query<HTMLElement>('#upload-name');
  const engine = new HaiyueEngine({
    canvas: 'canvas',
    clearColor: { r: 0.03, g: 0.04, b: 0.07, a: 1 },
    msaaSamples: 4,
  });
  await engine.init();

  let textureState = createDefaultTextureState(engine.device);
  const processor = new TextureBlurProcessor(engine);
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 100 }));
  camera.addComponent(new CartesianTransform3D({ position: [0, 0, 7] }));
  const scene = engine.createScene({
    name: 'Texture blur comparison',
    camera,
    render3D: { msaaSamples: 4, renderProfile: 'simple' },
    render2D: false,
    gui: false,
    pipelineLabel: 'TextureBlurComparison.render',
  });

  const plane = createPlane3D({ width: 1, height: 1 });
  const leftTransform = new CartesianTransform3D({ position: [-2, 0, 0] });
  const leftMaterial = new BasicMaterial({
    color: new ColorSRGB(1, 1, 1, 1),
    texture: textureState.leftOutputTexture,
  });
  const left = new Entity('Left blur comparison');
  left.addComponent(leftTransform);
  left.addComponent(new Mesh3D(plane, leftMaterial));
  scene.world.addEntity(left);

  const rightTransform = new CartesianTransform3D({ position: [2, 0, 0] });
  const rightMaterial = new BasicMaterial({
    color: new ColorSRGB(1, 1, 1, 1),
    texture: textureState.rightOutputTexture,
  });
  const right = new Entity('Right blur comparison');
  right.addComponent(rightTransform);
  right.addComponent(new Mesh3D(plane, rightMaterial));
  scene.world.addEntity(right);

  setRender3DMeshRenderer(scene.render3DSystem!, new Mesh3DRenderer());

  const leftState: SideState = {
    settings: { method: 'convolution', kernelSize: 7, radius: 10, iterations: 4 },
    controls: collectControls('left'),
    material: leftMaterial,
    destination: () => textureState.leftOutputTexture,
    scheduled: false,
  };
  const rightState: SideState = {
    settings: { method: 'gaussian', kernelSize: 7, radius: 14, iterations: 4 },
    controls: collectControls('right'),
    material: rightMaterial,
    destination: () => textureState.rightOutputTexture,
    scheduled: false,
  };

  const applySide = (side: 'left' | 'right', state: SideState): void => {
    state.scheduled = false;
    const { settings, controls } = state;
    syncControls(settings, controls);
    if (settings.method === 'none') {
      state.material.texture = textureState.sourceTexture;
      controls.passCount.textContent = '0 passes';
    } else {
      processor.process({
        sourceView: textureState.sourceTexture.createView(),
        destination: state.destination(),
        width: textureState.width,
        height: textureState.height,
        settings,
      });
      state.material.texture = state.destination();
      controls.passCount.textContent = `${processor.lastPassCount} ${processor.lastPassCount === 1 ? 'pass' : 'passes'}`;
    }
    controls.label.textContent = describeSettings(settings);
    document.body.dataset[`${side}Blur`] = settings.method;
    document.body.dataset[`${side}Passes`] = settings.method === 'none'
      ? '0'
      : String(processor.lastPassCount);
  };

  const scheduleSide = (side: 'left' | 'right', state: SideState): void => {
    if (state.scheduled) return;
    state.scheduled = true;
    requestAnimationFrame(() => applySide(side, state));
  };

  bindControls(leftState, () => scheduleSide('left', leftState));
  bindControls(rightState, () => scheduleSide('right', rightState));

  const updatePlaneLayout = (): void => {
    const aspect = textureState.width / textureState.height;
    const width = Math.min(4.15, PANEL_HEIGHT * aspect);
    const scale: [number, number, number] = [width, PANEL_HEIGHT, 1];
    leftTransform.setScale(...scale);
    rightTransform.setScale(...scale);
    const gap = 0.12;
    const offset = width / 2 + gap;
    leftTransform.setPosition(-offset, 0, 0);
    rightTransform.setPosition(offset, 0, 0);
  };

  const replaceTextureState = (next: TextureState): void => {
    textureState.sourceTexture.destroy();
    textureState.leftOutputTexture.destroy();
    textureState.rightOutputTexture.destroy();
    textureState = next;
    updatePlaneLayout();
    applySide('left', leftState);
    applySide('right', rightState);
  };

  const loadUploadedImage = async (file: File): Promise<void> => {
    const bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none' });
    try {
      const next = createTextureStateFromSource(engine.device, bitmap, file.name);
      uploadName.textContent = `${file.name} (${next.width}×${next.height})`;
      replaceTextureState(next);
    } finally {
      bitmap.close();
    }
  };

  uploadButton.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', () => {
    const file = uploadInput.files?.[0];
    uploadInput.value = '';
    if (file) void loadUploadedImage(file).catch(error => {
      uploadName.textContent = error instanceof Error ? error.message : String(error);
      console.error(error);
    });
  });

  updatePlaneLayout();
  applySide('left', leftState);
  applySide('right', rightState);
  engine.switchScene(scene);
  let renderedFrames = 0;
  engine.on('after-update', () => {
    if (++renderedFrames === 4) document.body.dataset.renderStatus = 'passed';
  });
  engine.run();

  window.addEventListener('beforeunload', () => {
    processor.destroy();
    textureState.sourceTexture.destroy();
    textureState.leftOutputTexture.destroy();
    textureState.rightOutputTexture.destroy();
  }, { once: true });
}

function collectControls(side: 'left' | 'right'): SideControls {
  return {
    method: query(`#${side}-method`),
    kernelSize: query(`#${side}-kernel-size`),
    radius: query(`#${side}-radius`),
    radiusValue: query(`#${side}-radius-value`),
    iterations: query(`#${side}-iterations`),
    iterationsValue: query(`#${side}-iterations-value`),
    passCount: query(`#${side}-pass-count`),
    label: query(`#${side}-label`),
  };
}

function bindControls(state: SideState, apply: () => void): void {
  const { controls, settings } = state;
  controls.method.value = settings.method;
  controls.kernelSize.value = String(settings.kernelSize);
  controls.radius.value = String(settings.radius);
  controls.iterations.value = String(settings.iterations);
  controls.method.addEventListener('change', () => {
    settings.method = parseMethod(controls.method.value);
    apply();
  });
  controls.kernelSize.addEventListener('change', () => {
    settings.kernelSize = parseKernelSize(controls.kernelSize.value);
    apply();
  });
  controls.radius.addEventListener('input', () => {
    settings.radius = Number(controls.radius.value);
    apply();
  });
  controls.iterations.addEventListener('input', () => {
    settings.iterations = Number(controls.iterations.value);
    apply();
  });
  syncControls(settings, controls);
}

function syncControls(settings: TextureBlurSettings, controls: SideControls): void {
  controls.method.value = settings.method;
  controls.kernelSize.value = String(settings.kernelSize);
  controls.radius.value = String(settings.radius);
  controls.iterations.value = String(settings.iterations);
  controls.kernelSize.disabled = settings.method !== 'convolution';
  controls.radius.disabled = settings.method !== 'gaussian' && settings.method !== 'box';
  controls.iterations.disabled = settings.method !== 'mipmap' && settings.method !== 'kawase';
  controls.radiusValue.value = `${settings.radius}px`;
  controls.iterationsValue.value = String(settings.iterations);
}

function describeSettings(settings: TextureBlurSettings): string {
  switch (settings.method) {
    case 'none': return METHOD_LABELS.none;
    case 'convolution': return `${settings.kernelSize}×${settings.kernelSize} ${METHOD_LABELS.convolution}`;
    case 'gaussian': return `${METHOD_LABELS.gaussian} · radius ${settings.radius}`;
    case 'box': return `${METHOD_LABELS.box} · radius ${settings.radius}`;
    case 'mipmap': return `${METHOD_LABELS.mipmap} · level ${settings.iterations}`;
    case 'kawase': return `${METHOD_LABELS.kawase} · ${settings.iterations} iterations`;
  }
}

function parseMethod(value: string): BlurMethod {
  return value === 'convolution'
    || value === 'gaussian'
    || value === 'box'
    || value === 'mipmap'
    || value === 'kawase'
    ? value
    : 'none';
}

function parseKernelSize(value: string): ConvolutionKernelSize {
  return value === '5' ? 5 : value === '7' ? 7 : 3;
}

function createDefaultTextureState(device: GPUDevice): TextureState {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_WIDTH;
  canvas.height = TEXTURE_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Texture blur example requires a 2D canvas context.');
  const gradient = context.createLinearGradient(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);
  gradient.addColorStop(0, '#15366e');
  gradient.addColorStop(0.46, '#2dd4bf');
  gradient.addColorStop(1, '#f97316');
  context.fillStyle = gradient;
  context.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

  context.fillStyle = 'rgba(255,255,255,0.94)';
  context.font = '700 94px system-ui, sans-serif';
  context.fillText('WebGPU Blur', 50, 126);
  context.font = '600 38px system-ui, sans-serif';
  context.fillText('compare edges · text · fine detail', 55, 180);

  context.lineWidth = 8;
  context.strokeStyle = 'rgba(3,7,18,0.84)';
  context.strokeRect(54, 238, 220, 190);
  context.fillStyle = '#f8fafc';
  context.fillRect(332, 238, 178, 178);
  context.fillStyle = '#111827';
  context.beginPath();
  context.arc(421, 327, 69, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = 'rgba(255,255,255,0.86)';
  context.lineWidth = 3;
  for (let index = 0; index < 13; index++) {
    context.beginPath();
    context.moveTo(62, 246 + index * 14);
    context.lineTo(266, 416 - index * 10);
    context.stroke();
  }
  for (let y = 230; y < 432; y += 12) {
    for (let x = 548; x < 736; x += 12) {
      context.fillStyle = (x + y) % 24 === 0 ? '#0f172a' : '#f8fafc';
      context.fillRect(x, y, 8, 8);
    }
  }
  return createTextureStateFromSource(device, canvas, 'Generated blur test');
}

function createTextureStateFromSource(
  device: GPUDevice,
  source: ImageBitmap | HTMLCanvasElement,
  label: string,
): TextureState {
  const width = Math.max(1, source.width);
  const height = Math.max(1, source.height);
  const sourceTexture = device.createTexture({
    label: `${label} source`,
    size: [width, height],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source }, { texture: sourceTexture }, [width, height]);
  return {
    sourceTexture,
    leftOutputTexture: createOutputTexture(device, width, height, `${label} left output`),
    rightOutputTexture: createOutputTexture(device, width, height, `${label} right output`),
    width,
    height,
  };
}

function createOutputTexture(device: GPUDevice, width: number, height: number, label: string): GPUTexture {
  return device.createTexture({
    label,
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing texture blur example element: ${selector}`);
  return element;
}

main().catch(error => {
  console.error(error);
  document.body.dataset.renderStatus = 'failed';
  document.body.dataset.renderError = error instanceof Error ? error.message : String(error);
});
