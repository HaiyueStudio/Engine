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
  private readonly _bindings = new Map<string, Readonly<InputActionBinding>>();

  constructor(descriptor: InputActionMapDescriptor = {}) { this.setBindings(descriptor); }

  static standardGameplay(): InputActionMap {
    return new InputActionMap({
      MoveX: { keys: ['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'], gamepadAxes: [{ axis: 0, direction: 'both', deadZone: 0.15 }] },
      MoveY: { keys: ['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS'], gamepadAxes: [{ axis: 1, direction: 'both', deadZone: 0.15 }] },
      Jump: { keys: ['Space'], gamepadButtons: [0] },
      Fire: { pointerButtons: [0], gamepadButtons: [7] },
      Pause: { keys: ['Escape', 'KeyP'], gamepadButtons: [9] },
    });
  }

  setBindings(descriptor: InputActionMapDescriptor): this {
    this._bindings.clear();
    for (const [action, binding] of Object.entries(descriptor)) this.setAction(action, binding);
    return this;
  }

  setAction(action: string, binding: InputActionBinding): this {
    const name = normalizeAction(action);
    this._bindings.set(name, normalizeBinding(binding));
    return this;
  }

  removeAction(action: string): this { this._bindings.delete(action); return this; }
  hasAction(action: string): boolean { return this._bindings.has(action); }

  actionsForKey(code: string): readonly string[] {
    return Object.freeze([...this._bindings].filter(([, binding]) => binding.keys?.includes(code)).map(([action]) => action));
  }

  actionsForPointerButton(button: number): readonly string[] {
    return Object.freeze([...this._bindings].filter(([, binding]) => binding.pointerButtons?.includes(button)).map(([action]) => action));
  }

  actionNames(): readonly string[] {
    return Object.freeze([...this._bindings.keys()].sort());
  }

  sampleKeyboard(codes: Iterable<string>): readonly InputActionValue[] {
    const held = codes instanceof Set ? codes : new Set(codes);
    const values: InputActionValue[] = [];
    for (const [action, binding] of this._bindings) {
      if (binding.keys?.some(code => held.has(code))) values.push(Object.freeze({ action, value: 1 }));
    }
    return Object.freeze(values);
  }

  sampleGamepad(gamepad: StandardGamepadSnapshot | null): readonly InputActionValue[] {
    if (!gamepad?.connected) return Object.freeze([]);
    const values: InputActionValue[] = [];
    for (const [action, binding] of this._bindings) {
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
    return Object.freeze(Object.fromEntries([...this._bindings].sort((left, right) => left[0].localeCompare(right[0])).map(([action, binding]) => [action, binding])));
  }
}

function normalizeBinding(binding: InputActionBinding): Readonly<InputActionBinding> {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new TypeError('Input action binding must be an object.');
  const keys = uniqueStrings(binding.keys ?? [], 64, 64, 'key');
  const pointerButtons = uniqueIntegers(binding.pointerButtons ?? [], 32, 0, 31, 'pointer button');
  const gamepadButtons = uniqueIntegers(binding.gamepadButtons ?? [], 64, 0, 255, 'gamepad button');
  const gamepadAxes = (binding.gamepadAxes ?? []).map(axis => {
    if (!axis || !Number.isSafeInteger(axis.axis) || axis.axis < 0 || axis.axis > 63 || (axis.direction !== undefined && !['positive', 'negative', 'both'].includes(axis.direction))) throw new TypeError('Gamepad axis binding is invalid.');
    const deadZone = axis.deadZone ?? 0.15;
    const scale = axis.scale ?? 1;
    if (!Number.isFinite(deadZone) || deadZone < 0 || deadZone >= 1 || !Number.isFinite(scale) || scale <= 0 || scale > 10) throw new TypeError('Gamepad axis deadZone/scale is invalid.');
    return Object.freeze({ axis: axis.axis, direction: axis.direction ?? 'both', deadZone, scale });
  });
  if (gamepadAxes.length > 32) throw new RangeError('Input action binding supports at most 32 gamepad axes.');
  return Object.freeze({
    ...(keys.length ? { keys } : {}),
    ...(pointerButtons.length ? { pointerButtons } : {}),
    ...(gamepadButtons.length ? { gamepadButtons } : {}),
    ...(gamepadAxes.length ? { gamepadAxes: Object.freeze(gamepadAxes) } : {}),
  });
}

function normalizeAction(action: string): string { if (typeof action !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,95}$/u.test(action)) throw new TypeError('Input action name is invalid.'); return action; }
function uniqueStrings(values: readonly string[], maximum: number, maxLength: number, label: string): readonly string[] { if (!Array.isArray(values) || values.length > maximum || values.some(value => typeof value !== 'string' || !value || value.length > maxLength)) throw new TypeError(`Input action ${label} bindings are invalid.`); return Object.freeze([...new Set(values)]); }
function uniqueIntegers(values: readonly number[], maximum: number, minimum: number, upper: number, label: string): readonly number[] { if (!Array.isArray(values) || values.length > maximum || values.some(value => !Number.isSafeInteger(value) || value < minimum || value > upper)) throw new TypeError(`Input action ${label} bindings are invalid.`); return Object.freeze([...new Set(values)]); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function strongest(left: number, right: number): number { return Math.abs(right) > Math.abs(left) ? right : left; }
