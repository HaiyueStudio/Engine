export type InputActionBindings = Record<string, string[]>;

export interface InputActionSnapshot {
  readonly pressed: readonly string[];
  readonly down: readonly string[];
  readonly up: readonly string[];
}

type KeyPredicate = (code: string) => boolean;

export class InputMap {
  private readonly _bindings = new Map<string, Set<string>>();
  private readonly _snapshotPressed: string[] = [];
  private readonly _snapshotDown: string[] = [];
  private readonly _snapshotUp: string[] = [];
  private readonly _snapshot: InputActionSnapshot = {
    pressed: this._snapshotPressed,
    down: this._snapshotDown,
    up: this._snapshotUp,
  };

  constructor(bindings: InputActionBindings = {}) {
    this.setBindings(bindings);
  }

  static defaultTetris(): InputMap {
    return new InputMap({
      MoveLeft: ['ArrowLeft', 'KeyA'],
      MoveRight: ['ArrowRight', 'KeyD'],
      SoftDrop: ['ArrowDown', 'KeyS'],
      HardDrop: ['Space'],
      Rotate: ['ArrowUp', 'KeyW', 'KeyX'],
      RotateCW: ['ArrowUp', 'KeyW', 'KeyX'],
      RotateCCW: ['KeyZ'],
      Pause: ['KeyP', 'Escape'],
      Restart: ['KeyR'],
    });
  }

  setBindings(bindings: InputActionBindings): this {
    this._bindings.clear();
    for (const [action, codes] of Object.entries(bindings)) {
      this.setAction(action, codes);
    }
    return this;
  }

  setAction(action: string, codes: Iterable<string>): this {
    const normalizedAction = action.trim();
    if (!normalizedAction) return this;
    const set = new Set<string>();
    for (const code of codes) {
      const normalizedCode = String(code).trim();
      if (normalizedCode) set.add(normalizedCode);
    }
    if (set.size) {
      this._bindings.set(normalizedAction, set);
    } else {
      this._bindings.delete(normalizedAction);
    }
    return this;
  }

  addBinding(action: string, code: string): this {
    const normalizedAction = action.trim();
    const normalizedCode = code.trim();
    if (!normalizedAction || !normalizedCode) return this;
    let set = this._bindings.get(normalizedAction);
    if (!set) {
      set = new Set();
      this._bindings.set(normalizedAction, set);
    }
    set.add(normalizedCode);
    return this;
  }

  removeAction(action: string): this {
    this._bindings.delete(action);
    return this;
  }

  getKeys(action: string): ReadonlySet<string> {
    return this._bindings.get(action) ?? EMPTY_KEY_SET;
  }

  hasAction(action: string): boolean {
    return this._bindings.has(action);
  }

  hasKey(code: string): boolean {
    for (const keys of this._bindings.values()) {
      if (keys.has(code)) return true;
    }
    return false;
  }

  matches(actionOrCode: string, predicate: KeyPredicate): boolean {
    const keys = this._bindings.get(actionOrCode);
    if (!keys) return predicate(actionOrCode);
    for (const code of keys) {
      if (predicate(code)) return true;
    }
    return false;
  }

  snapshot(predicates: { pressed: KeyPredicate; down: KeyPredicate; up: KeyPredicate }): InputActionSnapshot {
    const pressed = this._snapshotPressed;
    const down = this._snapshotDown;
    const up = this._snapshotUp;
    pressed.length = 0;
    down.length = 0;
    up.length = 0;
    for (const [action, keys] of this._bindings) {
      for (const code of keys) {
        if (predicates.pressed(code)) {
          pressed.push(action);
          break;
        }
      }
      for (const code of keys) {
        if (predicates.down(code)) {
          down.push(action);
          break;
        }
      }
      for (const code of keys) {
        if (predicates.up(code)) {
          up.push(action);
          break;
        }
      }
    }
    return this._snapshot;
  }

  toJSON(): InputActionBindings {
    const result: InputActionBindings = {};
    for (const [action, keys] of this._bindings) {
      result[action] = [...keys];
    }
    return result;
  }
}

const EMPTY_KEY_SET: ReadonlySet<string> = Object.freeze(new Set<string>());
