import type { CartesianTransform3D } from '@haiyue/engine';
import type { FirstPersonControls } from '@haiyue/engine/controls';

export interface FirstPersonBrowserRegression {
  readonly movedForward: boolean;
  readonly tallStepBlocked: boolean;
  readonly jumpReachedStep: boolean;
  readonly landedOnStep: boolean;
  readonly fellThroughHole: boolean;
  readonly resetToSpawn: boolean;
  readonly disposeStoppedInput: boolean;
  readonly finalPosition: readonly number[];
}

export interface FirstPersonBrowserRegressionOptions {
  readonly spawn: readonly [number, number, number];
  readonly playerRadius: number;
  readonly eyeOffset: number;
}

export function runFirstPersonBrowserRegression(
  canvas: HTMLCanvasElement,
  controls: FirstPersonControls,
  transform: CartesianTransform3D,
  options: FirstPersonBrowserRegressionOptions,
): FirstPersonBrowserRegression {
  const position = (): readonly number[] => Array.from(transform.position);
  const key = (type: 'keydown' | 'keyup', code: string): void => {
    globalThis.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
  };
  canvas.dispatchEvent(new PointerEvent('pointerdown', {
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    bubbles: true,
  }));

  controls.teleport(options.spawn, true);
  const start = position();
  key('keydown', 'KeyW');
  controls.step(100);
  key('keyup', 'KeyW');
  const moved = position();
  const movedForward = moved[2]! < start[2]! - 0.3;

  const groundOffset = options.playerRadius + options.eyeOffset;
  const stairApproach: readonly [number, number, number] = [4.15, groundOffset, 2.65];
  controls.teleport(stairApproach, true);
  key('keydown', 'KeyW');
  controls.step(100);
  key('keyup', 'KeyW');
  const blocked = position();
  const tallStepBlocked = Math.abs(blocked[2]! - stairApproach[2]) < 1e-4;

  controls.teleport(stairApproach, true);
  key('keydown', 'Space');
  key('keydown', 'KeyW');
  controls.step(100);
  key('keyup', 'Space');
  key('keyup', 'KeyW');
  const jumped = position();
  const jumpReachedStep = jumped[2]! < 2.45 && jumped[1]! > stairApproach[1] + 0.2;
  for (let frame = 0; frame < 12; frame++) controls.step(100);
  const landed = position();
  const landedOnStep = controls.grounded && Math.abs(landed[1]! - (0.28 + groundOffset)) < 1e-3;

  controls.teleport([0, groundOffset, 1.45], true);
  key('keydown', 'KeyW');
  for (let frame = 0; frame < 9; frame++) controls.step(100);
  key('keyup', 'KeyW');
  const fallen = position();
  const fellThroughHole = !controls.grounded && fallen[1]! < -2;

  controls.teleport(options.spawn, true);
  const reset = position();
  const resetToSpawn = reset.every((value, index) => Math.abs(value - options.spawn[index]!) < 1e-5)
    && controls.grounded;

  controls.dispose();
  const beforeDisposedInput = position();
  canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, bubbles: true }));
  key('keydown', 'KeyW');
  controls.step(100);
  key('keyup', 'KeyW');
  const afterDisposedInput = position();
  const disposeStoppedInput = afterDisposedInput.every(
    (value, index) => Math.abs(value - beforeDisposedInput[index]!) < 1e-6,
  );

  return {
    movedForward,
    tallStepBlocked,
    jumpReachedStep,
    landedOnStep,
    fellThroughHole,
    resetToSpawn,
    disposeStoppedInput,
    finalPosition: afterDisposedInput,
  };
}
