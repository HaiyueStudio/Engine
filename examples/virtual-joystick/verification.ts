import type { CartesianTransform3D, HaiyueEngine } from '@haiyue/engine';
import type { GuiRoot } from '@haiyue/engine/gui';
import type { VirtualJoystickControls } from '@haiyue/extensions/controls';

export async function verifyJoystick(engine: HaiyueEngine, canvas: HTMLCanvasElement, controls: VirtualJoystickControls, transform: CartesianTransform3D, root: GuiRoot) {
  const capture = canvas.setPointerCapture.bind(canvas), release = canvas.releasePointerCapture.bind(canvas);
  // Browser-dispatched fixtures have no OS-owned pointer capture. Real pointers are unchanged.
  canvas.setPointerCapture = id => { if (id !== 8101 && id !== 8102) capture(id); };
  canvas.releasePointerCapture = id => { if (id !== 8101 && id !== 8102) release(id); };
  try { return await run(engine, canvas, controls, transform, root); }
  finally { canvas.setPointerCapture = capture; canvas.releasePointerCapture = release; }
}

async function run(engine: HaiyueEngine, canvas: HTMLCanvasElement, controls: VirtualJoystickControls, transform: CartesianTransform3D, root: GuiRoot) {
  const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
  const frame = () => new Promise<void>(resolve => engine.once('after-update', () => resolve()));
  for (let i = 0; i < 6; i++) await frame();
  const rect = canvas.getBoundingClientRect();
  const press = (type: string, x: number, y: number, id = 8101) => {
    canvas.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 8101,
      clientX: rect.left + x, clientY: rect.top + y, button: 0, bubbles: true, cancelable: true }));
  };
  const center = controls.state.center;
  const x0 = transform.position[0]!;
  let frameCount = 0;
  const listener = () => { frameCount++; };
  controls.events.on('frame', listener);
  press('pointerdown', center.x, center.y);
  press('pointermove', center.x + 110, center.y - 25);
  for (let i = 0; i < 5; i++) await frame();
  assert(frameCount === 5, 'stationary held input must emit exactly once per engine frame');
  assert(controls.state.distance === 64 && controls.state.strength === 1, 'maximum travel clamp');
  assert(transform.position[0]! > x0 && transform.rotation[1]! < 0, 'entity translation and heading');
  const fixed = { distance: controls.state.distance, direction: controls.state.direction, frameCount };
  press('pointerdown', center.x + 20, center.y + 10, 8102);
  press('pointermove', center.x - 90, center.y, 8102);
  press('pointerup', center.x - 90, center.y, 8102);
  assert(controls.state.pointerId === 8101, 'second finger must not steal the stick');
  press('pointerup', center.x + 110, center.y - 25);
  const releasedX = transform.position[0]!;
  for (let i = 0; i < 3; i++) await frame();
  assert(transform.position[0] === releasedX && controls.state.strength === 0, 'release must stop movement');
  // Switch modes through the actual Engine GUI button.
  const floatX = 20 + (rect.width - 32) / 4 + (rect.width - 56) / 8;
  press('pointerdown', floatX, 101); press('pointerup', floatX, 101);
  await frame(); await frame();
  const floating = { x: rect.width * 0.32, y: rect.height * 0.72 };
  press('pointerdown', floating.x, floating.y);
  assert(controls.state.center.x === floating.x && controls.state.center.y === floating.y, 'floating GUI mode adopts press center');
  press('pointermove', floating.x - 90, floating.y + 40);
  await frame(); await frame();
  assert(controls.state.direction.x < 0 && controls.state.direction.y > 0, 'floating direction');
  press('pointercancel', floating.x, floating.y);
  assert(!controls.state.active && controls.state.distance === 0, 'cancel resets');
  controls.events.off('frame', listener);
  // Disposing another controller sharing the GUI root must leave existing HUD intact.
  const before = root.root.children.length;
  const { VirtualJoystickControls } = await import('@haiyue/extensions/controls');
  const transient = new VirtualJoystickControls(canvas, { guiRoot: root });
  transient.destroy(); transient.destroy();
  assert(root.root.children.length === before, 'GUI teardown ownership');
  // Deterministic final visual; leave a deflected stick without moving the player.
  const fixedX = 20 + (rect.width - 56) / 8;
  press('pointerdown', fixedX, 101); press('pointerup', fixedX, 101);
  await frame(); await frame();
  controls.configure({ moveSpeed: 0, turnSpeed: Infinity });
  transform.setPosition(0, 0.45, 0);
  press('pointerdown', center.x, center.y);
  press('pointermove', center.x + 45, center.y - 35);
  for (let i = 0; i < 3; i++) await frame();
  return { fixed, floating, checks: {
    fixed: true, floatingGui: true, frameEvents: true, entityMovement: true, entityHeading: true,
    clamped: true, multitouch: true, release: true, cancellation: true, guiCleanup: true,
  } };
}
