import { Entity, CartesianTransform3D } from '@haiyue/engine';
import { GuiRoot } from '@haiyue/engine/gui';
import { VirtualJoystickControls, type VirtualJoystickFrame, type VirtualJoystickOptions } from '@haiyue/extensions/controls';

declare const canvas: HTMLCanvasElement;
const options: VirtualJoystickOptions = {
  mode: 'floating',
  region: ({ width, height }) => ({ x: 0, y: height / 2, width: width / 2, height: height / 2 }),
  target: new Entity().addComponent(new CartesianTransform3D()),
  guiRoot: new GuiRoot(),
  maxDistance: 72,
};
const controls = new VirtualJoystickControls(canvas, options);
controls.events.on('frame', ({ detail }) => {
  const frame: VirtualJoystickFrame = detail;
  const dt: number = frame.deltaSeconds;
  const direction: number = frame.direction.x;
  void [dt, direction];
  // @ts-expect-error snapshots are immutable
  frame.direction.x = 2;
});
controls.configure({ mode: 'fixed', center: { x: 90, y: 300 }, deadZone: 0.15 });
controls.step(16).cancel().destroy();
// @ts-expect-error unsupported mode
const badMode: VirtualJoystickOptions = { mode: 'follow-pointer' };
// @ts-expect-error center is a point, not an array
const badCenter: VirtualJoystickOptions = { center: [100, 100] };
void [badMode, badCenter];
