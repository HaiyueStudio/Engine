import type {GamepadAxisBinding, InputActionBinding, InputActionMapDescriptor, KeyboardAxisBinding} from './InputActionMap';

const empty: readonly string[] = Object.freeze([]);
/** One normalized descriptor/index owner shared by the boolean and value maps. */
export class InputBindings {
  private bindings = new Map<string, Readonly<InputActionBinding>>();
  private keys = new Map<string, readonly string[]>();
  private pointers = new Map<number, readonly string[]>();
  private descriptor: InputActionMapDescriptor = Object.freeze({});

  entries(): IterableIterator<[string, Readonly<InputActionBinding>]> { return this.bindings.entries(); }
  get(action: string): Readonly<InputActionBinding> | undefined { return this.bindings.get(action); }
  has(action: string): boolean { return this.bindings.has(action); }
  forKey(code: string): readonly string[] { return this.keys.get(code) ?? empty; }
  forPointer(button: number): readonly string[] { return this.pointers.get(button) ?? empty; }
  json(): InputActionMapDescriptor { return this.descriptor; }
  replace(entries: Iterable<readonly [string, Readonly<InputActionBinding>]>): void {
    this.bindings = new Map(entries); this.index();
  }
  set(action: string, binding: Readonly<InputActionBinding>): void { this.bindings.set(action, binding); this.index(); }
  remove(action: string): void { if (this.bindings.delete(action)) this.index(); }
  private index(): void {
    const keys = new Map<string, string[]>(), pointers = new Map<number, string[]>();
    const add = <T>(index: Map<T,string[]>, key: T, action: string) => {
      const actions = index.get(key) ?? []; if (!actions.includes(action)) actions.push(action); index.set(key, actions);
    };
    for (const [action, binding] of this.bindings) {
      for (const key of binding.keys ?? []) add(keys, key, action);
      for (const axis of binding.keyboardAxes ?? []) for (const key of [...axis.negative, ...axis.positive]) add(keys, key, action);
      for (const button of binding.pointerButtons ?? []) add(pointers, button, action);
    }
    this.keys = new Map([...keys].map(([key, actions]) => [key, Object.freeze(actions)]));
    this.pointers = new Map([...pointers].map(([key, actions]) => [key, Object.freeze(actions)]));
    this.descriptor = Object.freeze(Object.fromEntries([...this.bindings].sort((a,b) => a[0].localeCompare(b[0]))));
  }
}

export function normalizeAction(action: string): string {
  if (typeof action !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,95}$/u.test(action)) throw new TypeError('Input action name is invalid.');
  return action;
}
export function normalizeBinding(binding: InputActionBinding): Readonly<InputActionBinding> {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new TypeError('Input action binding must be an object.');
  const keys = strings(binding.keys ?? []), pointerButtons = integers(binding.pointerButtons ?? [],32,31), gamepadButtons = integers(binding.gamepadButtons ?? [],64,255);
  if (!Array.isArray(binding.gamepadAxes ?? []) || (binding.gamepadAxes?.length ?? 0) > 32) throw new RangeError('Input action supports at most 32 gamepad axes.');
  const gamepadAxes = Array.from(binding.gamepadAxes ?? []).map((axis): GamepadAxisBinding => {
    if (!axis || !Number.isSafeInteger(axis.axis) || axis.axis < 0 || axis.axis > 63 || (axis.direction !== undefined && !['positive','negative','both'].includes(axis.direction))) throw new TypeError('Gamepad axis binding is invalid.');
    const deadZone = axis.deadZone ?? .15, scale = scaleValue(axis.scale,true);
    if (!Number.isFinite(deadZone) || deadZone < 0 || deadZone >= 1) throw new TypeError('Gamepad axis deadZone is invalid.');
    return Object.freeze({axis:axis.axis,direction:axis.direction ?? 'both',deadZone,scale});
  });
  if (!Array.isArray(binding.keyboardAxes ?? []) || (binding.keyboardAxes?.length ?? 0) > 32) throw new RangeError('Input action supports at most 32 keyboard axes.');
  const keyboardAxes = Array.from(binding.keyboardAxes ?? []).map((axis): KeyboardAxisBinding => {
    if (!axis || typeof axis !== 'object') throw new TypeError('Keyboard axis binding is invalid.');
    return Object.freeze({negative:strings(axis.negative),positive:strings(axis.positive),scale:scaleValue(axis.scale)});
  });
  return Object.freeze({...(keys.length?{keys}:{}),...(pointerButtons.length?{pointerButtons}:{}),...(gamepadButtons.length?{gamepadButtons}:{}),
    ...(gamepadAxes.length?{gamepadAxes:Object.freeze(gamepadAxes)}:{}),...(keyboardAxes.length?{keyboardAxes:Object.freeze(keyboardAxes)}:{})});
}
function strings(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 64 || Array.from(values).some(v => typeof v !== 'string' || !v || v.length > 64)) throw new TypeError('Input action key bindings are invalid.');
  return Object.freeze([...new Set(values)]);
}
function integers(values: readonly number[], count: number, max: number): readonly number[] {
  if (!Array.isArray(values) || values.length > count || Array.from(values).some(v => !Number.isSafeInteger(v) || v < 0 || v > max)) throw new TypeError('Input action button bindings are invalid.');
  return Object.freeze([...new Set(values)]);
}
function scaleValue(scale = 1, signed = false): number {
  if (!Number.isFinite(scale) || scale === 0 || Math.abs(scale) > 10 || (!signed && scale < 0)) throw new TypeError('Input action scale is invalid.'); return scale;
}
