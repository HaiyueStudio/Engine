import { Component, ComponentLifecycleFlags, UniqueCheckType } from '../ecs/Component';
import type { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';
import { InputMap, type InputActionBindings, type InputActionSnapshot } from '../input/InputMap';

export interface KeyboardSnapshot {
  pressed: string[];
  down: string[];
  up: string[];
}

interface KeyState {
  pressed: boolean;
  downFrame: number;
  upFrame: number;
}

export class KeyboardComponent extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('KeyboardComponent');
  static override Lifecycle =
    ComponentLifecycleFlags.Update |
    ComponentLifecycleFlags.EntityAddToWorld |
    ComponentLifecycleFlags.EntityRemoveFromWorld;
  static editor = {
    fields: {
      preventDefaultForMappedKeys: {
        type: 'boolean',
        label: 'Prevent Default For Mapped Keys',
        get: () => KeyboardComponent.preventDefaultForMappedKeys,
        set: (_component: KeyboardComponent, value: unknown) => {
          KeyboardComponent.preventDefaultForMappedKeys = Boolean(value);
        },
      },
    },
  };

  private static readonly _keys = new Map<string, KeyState>();
  private static _frame = 0;
  private static _lastUpdateTime = -1;
  private static _listenerCount = 0;
  private static _listening = false;
  private static _inputMap = InputMap.defaultTetris();
  private static _preventDefaultForMappedKeys = true;

  constructor() {
    super('KeyboardComponent');
  }

  static isPressed(code: string): boolean {
    return KeyboardComponent._inputMap.matches(code, KeyboardComponent._isKeyPressed);
  }

  static wasPressed(code: string): boolean {
    return KeyboardComponent._inputMap.matches(code, KeyboardComponent._wasKeyPressed);
  }

  static wasReleased(code: string): boolean {
    return KeyboardComponent._inputMap.matches(code, KeyboardComponent._wasKeyReleased);
  }

  static isKeyPressed(code: string): boolean {
    return KeyboardComponent._isKeyPressed(code);
  }

  static wasKeyPressed(code: string): boolean {
    return KeyboardComponent._wasKeyPressed(code);
  }

  static wasKeyReleased(code: string): boolean {
    return KeyboardComponent._wasKeyReleased(code);
  }

  static setInputMap(inputMap: InputMap | InputActionBindings): void {
    KeyboardComponent._inputMap = inputMap instanceof InputMap ? inputMap : new InputMap(inputMap);
  }

  static getInputMap(): InputMap {
    return KeyboardComponent._inputMap;
  }

  static defineAction(action: string, codes: Iterable<string>): void {
    KeyboardComponent._inputMap.setAction(action, codes);
  }

  static getActionKeys(action: string): ReadonlySet<string> {
    return KeyboardComponent._inputMap.getKeys(action);
  }

  static actionSnapshot(): InputActionSnapshot {
    return KeyboardComponent._inputMap.snapshot({
      pressed: KeyboardComponent._isKeyPressed,
      down: KeyboardComponent._wasKeyPressed,
      up: KeyboardComponent._wasKeyReleased,
    });
  }

  static get preventDefaultForMappedKeys(): boolean {
    return KeyboardComponent._preventDefaultForMappedKeys;
  }

  static set preventDefaultForMappedKeys(value: boolean) {
    KeyboardComponent._preventDefaultForMappedKeys = value;
  }

  static snapshot(): KeyboardSnapshot {
    const pressed: string[] = [];
    const down: string[] = [];
    const up: string[] = [];
    for (const [code, state] of KeyboardComponent._keys) {
      if (state.pressed) pressed.push(code);
      if (state.downFrame === KeyboardComponent._frame) down.push(code);
      if (state.upFrame === KeyboardComponent._frame) up.push(code);
    }
    return { pressed, down, up };
  }

  isPressed(code: string): boolean {
    return KeyboardComponent.isPressed(code);
  }

  wasPressed(code: string): boolean {
    return KeyboardComponent.wasPressed(code);
  }

  wasReleased(code: string): boolean {
    return KeyboardComponent.wasReleased(code);
  }

  isKeyPressed(code: string): boolean {
    return KeyboardComponent.isKeyPressed(code);
  }

  wasKeyPressed(code: string): boolean {
    return KeyboardComponent.wasKeyPressed(code);
  }

  wasKeyReleased(code: string): boolean {
    return KeyboardComponent.wasKeyReleased(code);
  }

  actionSnapshot(): InputActionSnapshot {
    return KeyboardComponent.actionSnapshot();
  }

  snapshot(): KeyboardSnapshot {
    return KeyboardComponent.snapshot();
  }

  onUpdate(_entity: Entity, time: number, _delta: number, _world: World): void {
    if (KeyboardComponent._lastUpdateTime === time) return;
    KeyboardComponent._lastUpdateTime = time;
    KeyboardComponent._frame++;
  }

  onEntityAddToWorld(): void {
    KeyboardComponent._listenerCount++;
    KeyboardComponent._ensureListeners();
  }

  onEntityRemoveFromWorld(): void {
    KeyboardComponent._listenerCount = Math.max(0, KeyboardComponent._listenerCount - 1);
    if (KeyboardComponent._listenerCount === 0) KeyboardComponent._removeListeners();
  }

  override clone(): KeyboardComponent {
    return new KeyboardComponent();
  }

  private static _ensureListeners(): void {
    if (KeyboardComponent._listening || typeof window === 'undefined') return;
    window.addEventListener('keydown', KeyboardComponent._onKeyDown);
    window.addEventListener('keyup', KeyboardComponent._onKeyUp);
    window.addEventListener('blur', KeyboardComponent._onBlur);
    KeyboardComponent._listening = true;
  }

  private static _removeListeners(): void {
    if (!KeyboardComponent._listening || typeof window === 'undefined') return;
    window.removeEventListener('keydown', KeyboardComponent._onKeyDown);
    window.removeEventListener('keyup', KeyboardComponent._onKeyUp);
    window.removeEventListener('blur', KeyboardComponent._onBlur);
    KeyboardComponent._listening = false;
    KeyboardComponent._keys.clear();
  }

  private static _onKeyDown = (event: KeyboardEvent): void => {
    if (KeyboardComponent._shouldPreventDefault(event)) {
      event.preventDefault();
    }
    const state = KeyboardComponent._keys.get(event.code) ?? {
      pressed: false,
      downFrame: -1,
      upFrame: -1,
    };
    if (!state.pressed) state.downFrame = KeyboardComponent._frame + 1;
    state.pressed = true;
    KeyboardComponent._keys.set(event.code, state);
  };

  private static _onKeyUp = (event: KeyboardEvent): void => {
    if (KeyboardComponent._shouldPreventDefault(event)) {
      event.preventDefault();
    }
    const state = KeyboardComponent._keys.get(event.code) ?? {
      pressed: false,
      downFrame: -1,
      upFrame: -1,
    };
    state.pressed = false;
    state.upFrame = KeyboardComponent._frame + 1;
    KeyboardComponent._keys.set(event.code, state);
  };

  private static _onBlur = (): void => {
    for (const state of KeyboardComponent._keys.values()) {
      state.pressed = false;
      state.upFrame = KeyboardComponent._frame + 1;
    }
  };

  private static _isKeyPressed = (code: string): boolean => {
    return KeyboardComponent._keys.get(code)?.pressed ?? false;
  };

  private static _wasKeyPressed = (code: string): boolean => {
    return KeyboardComponent._keys.get(code)?.downFrame === KeyboardComponent._frame;
  };

  private static _wasKeyReleased = (code: string): boolean => {
    return KeyboardComponent._keys.get(code)?.upFrame === KeyboardComponent._frame;
  };

  private static _shouldPreventDefault(event: KeyboardEvent): boolean {
    if (!KeyboardComponent._preventDefaultForMappedKeys || !KeyboardComponent._inputMap.hasKey(event.code)) {
      return false;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement)) return true;
    const tag = target.tagName.toLowerCase();
    return tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !target.isContentEditable;
  }
}
