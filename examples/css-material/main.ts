import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { CanvasTextComponent } from '@haiyue/engine/components';
import { Mesh3D } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import { OrbitControl } from '@haiyue/engine';
import { createPlane3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { CssMaterial, type CssMaterialStyle } from '@haiyue/engine/material';
import type { Scene } from '@haiyue/engine';
import { mat4 } from 'wgpu-matrix';
import { requiredItemAt } from '../arrayAccess';

type ThemeName = 'blue' | 'amber' | 'mono';

const THEMES: Record<ThemeName, Pick<CssMaterialStyle, 'backgroundColor' | 'borderColor' | 'color'>> = {
  blue: {
    backgroundColor: 'rgba(28, 61, 122, 0.82)',
    borderColor: '#77b7ff',
    color: '#f2f8ff',
  },
  amber: {
    backgroundColor: 'rgba(124, 77, 22, 0.86)',
    borderColor: '#ffd180',
    color: '#fff7e6',
  },
  mono: {
    backgroundColor: 'rgba(18, 22, 30, 0.92)',
    borderColor: '#9aa8bb',
    color: '#edf2f7',
  },
};

function resizeCanvas(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
  canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
}

function setTransform(
  transform: Transform3D,
  position: [number, number, number],
  rotationY: number,
): void {
  const t = mat4.translation(position);
  const r = mat4.rotationY(rotationY);
  transform.localMatrix = mat4.multiply(t, r) as Float32Array;
}

function createTextPanel(
  scene: Scene,
  name: string,
  material: CssMaterial,
  position: [number, number, number],
  rotationY: number,
): Transform3D {
  const transform = new Transform3D();
  setTransform(transform, position, rotationY);

  const component = new CanvasTextComponent({ material });
  const entity = new Entity(name);
  entity.addComponent(transform);
  entity.addComponent(component);
  entity.addComponent(new Mesh3D(createPlane3D({ width: 3.6, height: 1.35 }), component.material));
  scene.add(entity);
  return transform;
}

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  resizeCanvas(canvas);

  const engine = new HaiyueEngine({
    canvas,
    msaaSamples: 4,
    clearColor: { r: 0.035, g: 0.045, b: 0.065, a: 1 },
  });
  await engine.init();

  window.addEventListener('resize', () => {
    resizeCanvas(canvas);
    engine.msaaSamples = engine.msaaSamples === 4 ? 1 : 4;
    engine.msaaSamples = 4;
  });

  const scene = engine.createScene({
    name: 'CssMaterial',
    camera: {
      camera3D: { type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 60 },
      orbit: {
        radius: 9,
        theta: Math.PI * 0.16,
        phi: Math.PI * 0.34,
        target: [0, 0.2, 0],
      },
    },
    render3D: { loadOp: 'clear' },
    pipelineLabel: 'CssMaterial.render',
  });
  const camSph = scene.cameraEntity.getComponent(SphericalTransform3D)!;
  new OrbitControl(canvas, camSph, { minRadius: 4, maxRadius: 24 });

  const baseStyle: CssMaterialStyle = {
    width: 512,
    height: 192,
    resolutionScale: 2,
    borderWidth: 3,
    borderRadius: 22,
    padding: [18, 28],
    textAlign: 'center',
    verticalAlign: 'middle',
    fontSize: 34,
    fontFamily: 'system-ui, sans-serif',
    fontWeight: 700,
    lineHeight: 1.18,
    whiteSpace: 'pre-line',
    ...THEMES.blue,
  };

  const mainMaterial = new CssMaterial({
    text: 'CssMaterial',
    style: baseStyle,
  });
  const leftMaterial = new CssMaterial({
    text: 'background\nborder\npadding',
    style: { ...baseStyle, fontSize: 26, ...THEMES.amber },
  });
  const rightMaterial = new CssMaterial({
    text: 'canvas -> ImageBitmap\n-> BasicMaterial.texture',
    style: { ...baseStyle, fontSize: 24, textAlign: 'left', ...THEMES.mono },
  });

  const transforms = [
    createTextPanel(scene, 'Main CssMaterial', mainMaterial, [0, 0.9, 0], 0),
    createTextPanel(scene, 'Left CssMaterial', leftMaterial, [-2.45, -1.0, -0.25], -0.32),
    createTextPanel(scene, 'Right CssMaterial', rightMaterial, [2.45, -1.0, -0.25], 0.32),
  ];

  const floorTransform = new Transform3D();
  floorTransform.localMatrix = mat4.translation([0, -1.92, 0]) as Float32Array;
  const floorEntity = new Entity('Floor');
  floorEntity.addComponent(floorTransform);
  floorEntity.addComponent(new Mesh3D(
    createPlane3D({ width: 9, height: 4.8, normal: 'y' }),
    new BasicMaterial({ color: [0.13, 0.15, 0.18, 1] }),
  ));
  scene.add(floorEntity);

  const textInput = document.getElementById('text') as HTMLInputElement;
  const fontSizeInput = document.getElementById('font-size') as HTMLInputElement;
  const fontSizeValue = document.getElementById('font-size-value') as HTMLSpanElement;
  const themeSelect = document.getElementById('theme') as HTMLSelectElement;

  function updateMaterial(): void {
    const fontSize = Number(fontSizeInput.value);
    const theme = themeSelect.value as ThemeName;
    fontSizeValue.textContent = String(fontSize);
    mainMaterial.setText(textInput.value || 'CssMaterial');
    mainMaterial.setStyle({
      ...baseStyle,
      ...THEMES[theme],
      fontSize,
    });
  }

  textInput.addEventListener('input', updateMaterial);
  fontSizeInput.addEventListener('input', updateMaterial);
  themeSelect.addEventListener('change', updateMaterial);
  updateMaterial();

  let elapsed = 0;
  engine.switchScene(scene);
  engine.on('update', ({ detail: { delta } }) => {
    elapsed += delta * 0.001;
    setTransform(requiredItemAt(transforms, 0, 'CSS material transforms'), [0, 0.9 + Math.sin(elapsed * 1.4) * 0.05, 0], Math.sin(elapsed * 0.5) * 0.05);
    setTransform(requiredItemAt(transforms, 1, 'CSS material transforms'), [-2.45, -1.0, -0.25], -0.32 + Math.sin(elapsed * 0.7) * 0.035);
    setTransform(requiredItemAt(transforms, 2, 'CSS material transforms'), [2.45, -1.0, -0.25], 0.32 + Math.cos(elapsed * 0.7) * 0.035);
  });

  engine.run();
}

main().catch(console.error);
