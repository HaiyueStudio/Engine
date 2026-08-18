import { HaiyueEngine } from '@haiyue/engine';
import { World } from '@haiyue/engine';
import { Entity } from '@haiyue/engine';
import { Camera3D } from '@haiyue/engine';
import { CartesianTransform3D } from '@haiyue/engine';
import { SphericalTransform3D } from '@haiyue/engine';
import { Mesh3D } from '@haiyue/engine';
import { Render3DSystem } from '@haiyue/engine/systems';
import { Mesh3DRenderer, RenderIntegration, setRender3DMeshRenderer } from '@haiyue/engine/experimental';
import { RttRenderContributor, RttTexture } from '@haiyue/engine/rtt';
import { createBox3D } from '@haiyue/engine';
import { createPlane3D } from '@haiyue/engine';
import { BasicMaterial } from '@haiyue/engine';
import { ColorSRGB } from '@haiyue/engine';
import { OrbitControl } from '@haiyue/engine';

// ---------------------------------------------------------------------------
// RTT Demo — a spinning cube scene rendered off-screen, displayed on a panel.
//
//  Off-screen (512 × 384):  3 spinning coloured cubes → GPUTexture
//  Main canvas (900 × 600):  flat panel with that texture, orbit control
// ---------------------------------------------------------------------------

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.03, g: 0.03, b: 0.08, a: 1 },
  });
  await engine.init();

  // ── Off-screen (RTT) setup ─────────────────────────────────────────────────

  const rtt = new RttTexture(engine, {
    width:      512,
    height:     384,
    clearColor: { r: 0.05, g: 0.02, b: 0.12, a: 1 },
  });

  // RTT camera
  const rttCamSph = new SphericalTransform3D({
    radius: 9,
    theta: Math.PI * 0.1,
    phi: Math.PI * 0.38,
    target: [0, 0, 0],
  });
  const rttCam = new Entity('RttCam');
  rttCam.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 3.5, near: 0.1, far: 200 }));
  rttCam.addComponent(rttCamSph);
  rtt.world.addEntity(rttCam);

  // RTT scene: 3 coloured spinning cubes
  const rttColors: [ColorSRGB, ColorSRGB, ColorSRGB] = [
    new ColorSRGB(0.9, 0.25, 0.25),
    new ColorSRGB(0.25, 0.8, 0.4),
    new ColorSRGB(0.3, 0.5, 1.0),
  ];
  const rttBoxes: Array<{ entity: Entity; transform: CartesianTransform3D; speed: [number, number] }> = [];

  for (let i = 0; i < 3; i++) {
    const t = new CartesianTransform3D({ position: [(i - 1) * 2.8, 0, 0] });
    const e = new Entity(`RttBox${i}`);
    e.addComponent(t);
    e.addComponent(new Mesh3D(createBox3D({ width: 1.4, height: 1.4, depth: 1.4 }), new BasicMaterial({ color: rttColors[i] ?? rttColors[0] })));
    rtt.world.addEntity(e);
    rttBoxes.push({ entity: e, transform: t, speed: [0.6 + i * 0.2, 0.4 + i * 0.15] });
  }

  // RTT render system — uses rtt.engine so it draws into the off-screen texture
  const rttRenderer = new Mesh3DRenderer();
  const rttRenderSys = new Render3DSystem(rtt.engine, rttCam);
  setRender3DMeshRenderer(rttRenderSys, rttRenderer);
  rtt.world.addSystem(rttRenderSys);
  const rttRenderIntegration = new RenderIntegration(rtt.engine, { label: 'RTT.offscreen.render' });
  rtt.world.addRuntimeIntegration(rttRenderIntegration);
  rttRenderIntegration.registerAll(rtt.world);

  // ── Main scene ─────────────────────────────────────────────────────────────

  const mainWorld = new World('Main');

  // Main camera with orbit control
  const mainCamSph = new SphericalTransform3D({
    radius: 10,
    theta: Math.PI * 0.05,
    phi: Math.PI * 0.42,
    target: [0, 0, 0],
  });
  const mainCam = new Entity('MainCam');
  mainCam.addComponent(new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 200 }));
  mainCam.addComponent(mainCamSph);
  mainWorld.addEntity(mainCam);

  new OrbitControl(canvas, mainCamSph, { minRadius: 3, maxRadius: 40 });

  // The "TV panel" showing the RTT texture
  const panel = new Entity('Panel');
  const panelTransform = new CartesianTransform3D({ position: [0, 0, 0] });
  panelTransform.setRotation(0, 0.18, 0); // slight tilt for depth
  panel.addComponent(panelTransform);
  panel.addComponent(new Mesh3D(
    createPlane3D({ width: 6.82, height: 5.12 }), // 4:3 aspect matches 512×384
    new BasicMaterial({ texture: rtt.texture }),   // GPUTexture passed directly
  ));
  mainWorld.addEntity(panel);

  // A dark frame border around the panel
  const frame = new Entity('Frame');
  const frameTransform = new CartesianTransform3D({ position: [0, 0, -0.02] });
  frameTransform.setRotation(0, 0.18, 0);
  frame.addComponent(frameTransform);
  frame.addComponent(new Mesh3D(
    createPlane3D({ width: 7.2, height: 5.5 }),
    new BasicMaterial({ color: new ColorSRGB(0.08, 0.08, 0.1) }),
  ));
  mainWorld.addEntity(frame);

  // Main render system
  const mainRenderer = new Mesh3DRenderer();
  const mainRenderSys = new Render3DSystem(engine, mainCam, { loadOp: 'clear' });
  setRender3DMeshRenderer(mainRenderSys, mainRenderer);
  mainWorld.addSystem(mainRenderSys);
  const mainRenderIntegration = new RenderIntegration(engine, { label: 'RTT.main.render' });
  mainWorld.addRuntimeIntegration(mainRenderIntegration);
  mainRenderIntegration.register(new RttRenderContributor(rtt));
  mainRenderIntegration.registerAll(mainWorld);

  // ── Render loop ────────────────────────────────────────────────────────────

  engine.on('update', ({ detail: { time, delta } }) => {
    const t = time * 0.001;

    // Animate RTT cubes
    for (const { transform, speed } of rttBoxes) {
      transform.setRotation(t * speed[0], t * speed[1], 0);
    }

    // Also slowly orbit the RTT camera
    rttCamSph.set(9, Math.PI * 0.1 + t * 0.06, Math.PI * 0.38);

    // RenderPipeline first updates the RTT contributor, then renders the main scene.
    mainWorld.update(time, delta);
  });

  engine.run();
}

main().catch(console.error);
