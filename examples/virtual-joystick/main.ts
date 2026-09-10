import {
  HaiyueEngine, Entity, Camera3D, CartesianTransform3D, SphericalTransform3D,
  Mesh3D, PbrMaterial, DirectionalLight, EnvironmentLight, createBox3D, createSphere3D,
} from '@haiyue/engine';
import { createCylinder3D } from '@haiyue/engine/geometry';
import { GuiRoot, GuiButton, GuiLabel, type GuiElement, type GuiRect } from '@haiyue/engine/gui';
import { VirtualJoystickControls } from '@haiyue/extensions/controls';
import { verifyJoystick } from './verification';

function place(element: GuiElement, layout: (viewport: GuiRect) => GuiRect): void {
  element.layout = (viewport) => { element.rect = layout(viewport); };
}
async function main(): Promise<void> {
  const engine = new HaiyueEngine({ canvas: '#canvas', msaaSamples: 4,
    clearColor: { r: 0.014, g: 0.027, b: 0.049, a: 1 } });
  await engine.init();
  const canvas = engine.canvas!;
  const errors: string[] = [];
  engine.device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  engine.device.pushErrorScope('validation');
  const camera = new Camera3D({ type: 'perspective', fov: Math.PI / 4, near: 0.1, far: 80 });
  const orbit = new SphericalTransform3D({ radius: 15, theta: 0, phi: 0.58 });
  const scene = engine.createScene({ name: 'Virtual joystick',
    camera: new Entity('Camera').addComponent(camera).addComponent(orbit),
    render3D: { renderProfile: 'simple' }, render2D: false, gui: { loadOp: 'load' } });
  const root = new GuiRoot();
  scene.add(new Entity('Engine GUI').addComponent(root));
  const tiles = [new PbrMaterial({ baseColor: [0.06, 0.14, 0.19, 1], roughness: 0.85 }),
    new PbrMaterial({ baseColor: [0.085, 0.19, 0.25, 1], roughness: 0.85 })];
  const tile = createBox3D({ width: 0.98, height: 0.1, depth: 0.98 });
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) {
    scene.add(new Entity('Arena tile').addComponent(new CartesianTransform3D({ position: [x, -0.1, z] }))
      .addComponent(new Mesh3D(tile, tiles[(x + z + 10) % 2]!)));
  }
  const transform = new CartesianTransform3D({ position: [0, 0.45, 0] });
  const player = new Entity('Player').addComponent(transform).addComponent(new Mesh3D(
    createSphere3D({ radius: 0.4, widthSegments: 24, heightSegments: 16 }),
    new PbrMaterial({ baseColor: [0.04, 0.75, 0.95, 1], metallic: 0.4, roughness: 0.25 }),
  ));
  player.add(new Entity('Forward arrow').addComponent(new CartesianTransform3D({
    position: [0, 0.04, -0.53], rotation: [-Math.PI / 2, 0, 0],
  })).addComponent(new Mesh3D(createCylinder3D({ radiusTop: 0, radiusBottom: 0.22, height: 0.65, radialSegments: 3 }),
    new PbrMaterial({ baseColor: [1, 0.7, 0.12, 1], roughness: 0.4 }))));
  scene.add(player);
  scene.add(new Entity('Sun').addComponent(new DirectionalLight({ direction: [-0.4, -1, -0.4], intensity: 3 })));
  scene.add(new Entity('Ambient').addComponent(new EnvironmentLight({ intensity: 0.8 })));

  let mode: 'fixed' | 'floating' = 'fixed', maxDistance = 64, moveSpeed = 4;
  const controls = new VirtualJoystickControls(canvas, {
    mode, target: player, guiRoot: root, maxDistance, moveSpeed, turnSpeed: 10,
    center: ({ width, height }) => ({ x: Math.min(118, width / 4), y: height - 120 }),
    region: ({ width, height }) => ({ x: 0, y: Math.max(180, height * 0.5), width: width * 0.55, height: Math.max(0, height - Math.max(180, height * 0.5)) }),
  });
  scene.addSystem(controls, false);
  const title = root.add(new GuiLabel({ text: 'VIRTUAL JOYSTICK', fontSize: 26, style: { color: '#e4f4ff' } }));
  place(title, r => ({ x: 20, y: 16, width: r.width - 40, height: 36 }));
  const subtitle = root.add(new GuiLabel({ text: 'Drag to move. The gold arrow follows your heading.', fontSize: 12, style: { color: '#87a9bd' } }));
  place(subtitle, r => ({ x: 20, y: 55, width: r.width - 40, height: 22 }));
  const metrics = root.add(new GuiLabel({ text: '', fontSize: 12, style: { color: '#a4dfed' } }));
  place(metrics, r => ({ x: 20, y: 126, width: r.width - 40, height: 24 }));
  const hint = root.add(new GuiLabel({ text: '', fontSize: 12, style: { color: '#a2c5d9' } }));
  place(hint, r => ({ x: 20, y: r.height - 30, width: r.width - 40, height: 22 }));
  const buttons: GuiButton[] = [];
  const update = () => {
    controls.configure({ mode, maxDistance, moveSpeed });
    hint.text = mode === 'fixed' ? 'FIXED: drag the bottom-left stick' : 'FLOATING: press anywhere in the bottom-left area';
    buttons[0]!.text = mode === 'fixed' ? 'FIXED *' : 'FIXED';
    buttons[1]!.text = mode === 'floating' ? 'FLOAT *' : 'FLOAT';
    buttons[2]!.text = `R: ${maxDistance}`;
    buttons[3]!.text = `SPEED: ${moveSpeed}`;
  };
  const actions = [() => { mode = 'fixed'; update(); }, () => { mode = 'floating'; update(); },
    () => { maxDistance = maxDistance === 64 ? 42 : 64; update(); },
    () => { moveSpeed = moveSpeed === 4 ? 7 : 4; update(); }];
  actions.forEach((action, i) => {
    const button = root.add(new GuiButton({ text: '', onClick: action }));
    place(button, r => ({ x: 20 + i * (r.width - 32) / 4, y: 84, width: (r.width - 56) / 4, height: 34 }));
    buttons.push(button);
  });
  update();
  const reset = root.add(new GuiButton({ text: 'RESET', onClick: () => { controls.cancel(); transform.setPosition(0, 0.45, 0); } }));
  place(reset, r => ({ x: r.width - 100, y: r.height - 78, width: 80, height: 34 }));
  controls.events.on('frame', ({ detail }) => {
    metrics.text = `${detail.deltaMilliseconds.toFixed(1)} ms   dir ${detail.direction.x.toFixed(2)}, ${detail.direction.y.toFixed(2)}   ${detail.distance.toFixed(0)} px   ${(detail.strength * 100).toFixed(0)}%`;
  });
  const resize = () => {
    const { width, height } = canvas.getBoundingClientRect();
    camera.updateAspect(width / Math.max(1, height));
    orbit.radius = width < height ? 20 : 16;
  };
  engine.on('update', resize);
  engine.switchScene(scene);
  engine.run();

  const cleanup = () => { controls.destroy(); engine.off('update', resize); engine.destroy(); };
  window.addEventListener('pagehide', cleanup, { once: true });
  if (new URLSearchParams(location.search).get('verify') === '1') {
    const result = await verifyJoystick(engine, canvas, controls, transform, root);
    await engine.device.queue.onSubmittedWorkDone();
    const error = await engine.device.popErrorScope();
    if (error) errors.push(error.message);
    const node = document.getElementById('result')!;
    node.dataset.status = errors.length ? 'failed' : 'passed';
    node.textContent = JSON.stringify({ schemaVersion: 1, suite: 'virtual-joystick', status: node.dataset.status, errors, ...result });
  } else {
    const error = await engine.device.popErrorScope();
    if (error) throw error;
  }
}
void main().catch(error => {
  document.getElementById('error')!.textContent = String(error);
  const result = document.getElementById('result')!;
  result.dataset.status = 'failed';
  result.textContent = JSON.stringify({ status: 'failed', errors: [String(error)] });
  console.error(error);
});
