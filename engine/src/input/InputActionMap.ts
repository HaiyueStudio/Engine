export interface GamepadAxisBinding {
  readonly axis: number;
  readonly direction?: 'positive' | 'negative' | 'both';
  readonly deadZone?: number;
  readonly scale?: number;
}

export interface InputActionBinding {
  readonly keys?: readonly string[];
  readonly pointerButtons?: readonly number[];
  readonly gamepadButtons?: readonly number[];
  readonly gamepadAxes?: readonly GamepadAxisBinding[];
  readonly keyboardAxes?: readonly KeyboardAxisBinding[];
}

export interface KeyboardAxisBinding {
  readonly negative: readonly string[];
  readonly positive: readonly string[];
  readonly scale?: number;
}

export type InputActionMapDescriptor = Readonly<Record<string, InputActionBinding>>;

export interface StandardGamepadSnapshot {
  readonly connected: boolean;
  readonly buttons: readonly Readonly<{ readonly pressed: boolean; readonly value: number }>[];
  readonly axes: readonly number[];
}

export interface InputActionValue {
  readonly action: string;
  readonly value: number;
}

/** Serializable physical-input to gameplay-action map, including the standard Gamepad layout. */
export class InputActionMap {
  private readonly _bindings = new InputBindings();

  constructor(descriptor: InputActionMapDescriptor = {}) { this.setBindings(descriptor); }

  /** Standard gamepad UI bindings; the host's existing sampler owns polling. */
  static guiNavigation(): InputActionMap {
    return new InputActionMap({
      next:{gamepadButtons:[5]},previous:{gamepadButtons:[4]},
      left:{gamepadButtons:[14],gamepadAxes:[{axis:0,direction:'negative',deadZone:0.25}]},
      right:{gamepadButtons:[15],gamepadAxes:[{axis:0,direction:'positive',deadZone:0.25}]},
      up:{gamepadButtons:[12],gamepadAxes:[{axis:1,direction:'negative',deadZone:0.25}]},
      down:{gamepadButtons:[13],gamepadAxes:[{axis:1,direction:'positive',deadZone:0.25}]},
      confirm:{gamepadButtons:[0]},cancel:{gamepadButtons:[1]},
    });
  }

  static standardGameplay(): InputActionMap {
    return new InputActionMap({
      MoveX: { keyboardAxes: [{negative:['ArrowLeft','KeyA'],positive:['ArrowRight','KeyD']}], gamepadAxes: [{ axis: 0, direction: 'both', deadZone: 0.15 }] },
      MoveY: { keyboardAxes: [{negative:['ArrowUp','KeyW'],positive:['ArrowDown','KeyS']}], gamepadAxes: [{ axis: 1, direction: 'both', deadZone: 0.15 }] },
      Jump: { keys: ['Space'], gamepadButtons: [0] },
      Fire: { pointerButtons: [0], gamepadButtons: [7] },
      Pause: { keys: ['Escape', 'KeyP'], gamepadButtons: [9] },
    });
  }

  setBindings(descriptor: InputActionMapDescriptor): this {
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) throw new TypeError('Input action descriptor must be an object.');
    const entries = Object.entries(descriptor).map(([action,binding]) => [normalizeAction(action),normalizeBinding(binding)] as const);
    this._bindings.replace(entries);
    return this;
  }

  setAction(action: string, binding: InputActionBinding): this {
    const name = normalizeAction(action);
    this._bindings.set(name, normalizeBinding(binding));
    return this;
  }

  removeAction(action: string): this { this._bindings.remove(action); return this; }
  hasAction(action: string): boolean { return this._bindings.has(action); }

  actionsForKey(code: string): readonly string[] {
    return this._bindings.forKey(code);
  }

  actionsForPointerButton(button: number): readonly string[] {
    return this._bindings.forPointer(button);
  }

  actionNames(): readonly string[] {
    return Object.freeze(Object.keys(this._bindings.json()).sort());
  }

  sampleKeyboard(codes: Iterable<string>): readonly InputActionValue[] {
    const held = codes instanceof Set ? codes : new Set(codes);
    const values: InputActionValue[] = [];
    for (const [action, binding] of this._bindings.entries()) {
      let value = binding.keys?.some(code => held.has(code)) ? 1 : 0;
      for (const axis of binding.keyboardAxes ?? []) {
        const negative = axis.negative.some(code => held.has(code)), positive = axis.positive.some(code => held.has(code));
        value = strongest(value, clamp((Number(positive)-Number(negative)) * (axis.scale ?? 1),-1,1));
      }
      if (value !== 0) values.push(Object.freeze({action,value}));
    }
    return Object.freeze(values);
  }

  sampleGamepad(gamepad: StandardGamepadSnapshot | null): readonly InputActionValue[] {
    if (!gamepad?.connected) return Object.freeze([]);
    const values: InputActionValue[] = [];
    for (const [action, binding] of this._bindings.entries()) {
      let value = 0;
      for (const button of binding.gamepadButtons ?? []) value = strongest(value, clamp(gamepad.buttons[button]?.value ?? 0, 0, 1));
      for (const axis of binding.gamepadAxes ?? []) {
        const raw = clamp(gamepad.axes[axis.axis] ?? 0, -1, 1);
        const directed = axis.direction === 'positive' ? Math.max(0, raw) : axis.direction === 'negative' ? Math.max(0, -raw) : raw;
        const deadZone = axis.deadZone ?? 0.15;
        const normalized = Math.abs(directed) <= deadZone ? 0 : Math.sign(directed) * ((Math.abs(directed) - deadZone) / (1 - deadZone));
        value = strongest(value, clamp(normalized * (axis.scale ?? 1), -1, 1));
      }
      if (value !== 0) values.push(Object.freeze({ action, value }));
    }
    return Object.freeze(values);
  }

  toJSON(): InputActionMapDescriptor {
    return this._bindings.json();
  }
}

function clamp(value: number, minimum: number, maximum: number): number { return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : 0; }
function strongest(left: number, right: number): number { return Math.abs(right) > Math.abs(left) ? right : left; }
import {InputBindings, normalizeAction, normalizeBinding} from './InputBindings';
