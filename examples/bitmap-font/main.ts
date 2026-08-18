import { HaiyueEngine } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { BitmapTextRenderSystem } from '@haiyue/engine/systems';
import { Mesh3DRenderer, setRender3DMeshRenderer } from '@haiyue/engine/experimental';
import { BitmapText } from '@haiyue/engine/components';
import { buildBitmapFont } from '@haiyue/engine/font';
import { createBox3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const engine = new HaiyueEngine({ canvas, clearColor: { r: 0.04, g: 0.04, b: 0.08, a: 1 } });
  await engine.init();

  // ── Font atlas ─────────────────────────────────────────────────────────────
  // Generate a normal-mode bitmap font from the system sans-serif font.
  const { data: fontNormal } = buildBitmapFont({
    fontSize:   36,
    fontFamily: 'sans-serif',
    padding:    4,
    atlasSize:  512,
  });

  // Bold variant
  const { data: fontBold } = buildBitmapFont({
    fontSize:   36,
    fontFamily: 'sans-serif',
    fontWeight: 'bold',
    padding:    4,
    atlasSize:  512,
  });

  // ── Camera ─────────────────────────────────────────────────────────────────
  const camSph = new SphericalTransform3D({
    radius: 14,
    theta:  Math.PI * 0.1,
    phi:    Math.PI * 0.4,
    target: [0, 0, 0],
  });
  const camEntity = new Entity('Camera');
  camEntity.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 200 }));
  camEntity.addComponent(camSph);
  const scene = engine.createScene({
    name: 'BitmapFontDemo',
    camera: camEntity,
    render3D: { loadOp: 'clear' },
    render2D: false,
    gui: false,
    pipelineLabel: 'BitmapFontDemo.render',
  });
  const { world } = scene;

  new OrbitControl(canvas, camSph, { minRadius: 3, maxRadius: 60 });

  // ── Scene: a few reference cubes ───────────────────────────────────────────
  const colors: [ColorSRGB, ColorSRGB, ColorSRGB] = [
    new ColorSRGB(0.85, 0.3,  0.3),
    new ColorSRGB(0.3,  0.75, 0.45),
    new ColorSRGB(0.35, 0.5,  0.95),
  ];
  for (let i = 0; i < 3; i++) {
    const box = new Entity(`Box${i}`);
    box.addComponent(new CartesianTransform3D({ position: [(i - 1) * 3.5, -1.2, 0] }));
    box.addComponent(new Mesh3D(createBox3D({ width: 1, height: 1, depth: 1 }), new BasicMaterial({ color: colors[i] ?? colors[0] })));
    world.addEntity(box);
  }

  // ── Text entities ──────────────────────────────────────────────────────────
  //
  // Row 0: title label  (normal, large)
  // Row 1: normal mode  (regular weight)
  // Row 2: sdf mode     (bold — demonstrates mode switching)
  // Row 3: msdf mode
  //
  // Note: with a canvas-generated atlas, SDF/MSDF modes use the alpha channel
  // of the atlas, which is not a true distance field — results will be identical
  // to normal mode.  For crisp SDF/MSDF results use a dedicated atlas generator.

  const title = new Entity('Title');
  title.addComponent(new CartesianTransform3D({ position: [-3, 2.6, 0] }));
  title.addComponent(new BitmapText(fontBold, 'Hello, WebGPU!', {
    fontSize: 0.9,
    color: new ColorSRGB(1, 0.9, 0.5),
    mode: 'normal',
  }));
  world.addEntity(title);

  const labelNormal = new Entity('LabelNormal');
  labelNormal.addComponent(new CartesianTransform3D({ position: [-4.5, 0.8, 0] }));
  labelNormal.addComponent(new BitmapText(fontNormal, 'mode: normal', {
    fontSize: 0.55,
    color: new ColorSRGB(0.8, 0.95, 0.8),
    mode: 'normal',
  }));
  world.addEntity(labelNormal);

  const labelSdf = new Entity('LabelSdf');
  labelSdf.addComponent(new CartesianTransform3D({ position: [-4.5, 0.0, 0] }));
  labelSdf.addComponent(new BitmapText(fontNormal, 'mode: sdf  (threshold 0.4, smoothing 0.15)', {
    fontSize: 0.55,
    color: new ColorSRGB(0.8, 0.85, 1.0),
    mode: 'sdf',
    threshold: 0.4,
    smoothing: 0.15,
  }));
  world.addEntity(labelSdf);

  const labelMsdf = new Entity('LabelMsdf');
  labelMsdf.addComponent(new CartesianTransform3D({ position: [-4.5, -0.8, 0] }));
  labelMsdf.addComponent(new BitmapText(fontNormal, 'mode: msdf  (threshold 0.5, smoothing 0.05)', {
    fontSize: 0.55,
    color: new ColorSRGB(1.0, 0.75, 0.9),
    mode: 'msdf',
    threshold: 0.5,
    smoothing: 0.05,
  }));
  world.addEntity(labelMsdf);

  // Live-edit text entity (bound to the input box)
  const liveLabel = new Entity('LiveLabel');
  liveLabel.addComponent(new CartesianTransform3D({ position: [-4.5, -2.0, 0] }));
  liveLabel.addComponent(new BitmapText(fontBold, 'Hello, WebGPU!', {
    fontSize: 0.75,
    color: new ColorSRGB(1, 1, 1),
    mode: 'normal',
  }));
  world.addEntity(liveLabel);

  // Wire up the input box
  const input = document.getElementById('textInput') as HTMLInputElement;
  input.addEventListener('input', () => {
    liveLabel.getComponent(BitmapText)!.text = input.value;
  });

  // ── Render systems ─────────────────────────────────────────────────────────
  const meshRenderer = new Mesh3DRenderer();

  const r3d = scene.render3DSystem!;
  setRender3DMeshRenderer(r3d, meshRenderer);

  const textSystem = new BitmapTextRenderSystem(engine, camEntity);
  scene.addSystem(textSystem);

  // ── Loop ───────────────────────────────────────────────────────────────────
  engine.switchScene(scene);
  engine.run();
}

main().catch(console.error);
