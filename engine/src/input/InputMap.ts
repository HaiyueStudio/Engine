import {isInputEventConsumed} from './InputEventConsumption';
import {InputBindings} from './InputBindings';

export type InputActionBindings = Record<string, string[]>;

export interface InputActionSnapshot {
  readonly pressed: readonly string[];
  readonly down: readonly string[];
  readonly up: readonly string[];
}

type KeyPredicate = (code: string) => boolean;

export class InputMap {
  static isEventConsumed(event: Event): boolean { return isInputEventConsumed(event); }
  private readonly _bindings = new InputBindings();

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

  /** GUI bindings reuse InputMap; the host retains device sampling ownership. */
  static guiNavigation(): InputMap {
    return new InputMap({next: ['Tab'], previous: ['Shift+Tab'], left: ['ArrowLeft'], right: ['ArrowRight'],
      up: ['ArrowUp'], down: ['ArrowDown'], confirm: ['Enter', 'Space'], cancel: ['Escape']});
  }

  setBindings(bindings: InputActionBindings): this {
    const next = new Map<string, Readonly<{keys:readonly string[]}>>();
    for (const [action, codes] of Object.entries(bindings)) {
      const name=action.trim(),keys=normalizeCodes(codes);if(!name)continue;
      if(keys.length)next.set(name,Object.freeze({keys}));else next.delete(name);
    }
    this._bindings.replace(next);
    return this;
  }

  setAction(action: string, codes: Iterable<string>): this {
    const normalizedAction = action.trim();
    if (!normalizedAction) return this;
    const keys=normalizeCodes(codes);
    if (keys.length) {
      this._bindings.set(normalizedAction, Object.freeze({keys}));
    } else {
      this._bindings.remove(normalizedAction);
    }
    return this;
  }

  addBinding(action: string, code: string): this {
    const normalizedAction = action.trim();
    const normalizedCode = code.trim();
    if (!normalizedAction || !normalizedCode) return this;
    return this.setAction(normalizedAction, [...this.getKeys(normalizedAction),normalizedCode]);
  }

  removeAction(action: string): this {
    this._bindings.remove(action);
    return this;
  }

  getKeys(action: string): ReadonlySet<string> {
    return new Set(this._bindings.get(action)?.keys ?? []);
  }

  hasAction(action: string): boolean {
    return this._bindings.has(action);
  }

  hasKey(code: string): boolean {
    return this._bindings.forKey(code).length > 0;
  }

  matches(actionOrCode: string, predicate: KeyPredicate): boolean {
    const keys = this._bindings.get(actionOrCode)?.keys;
    if (!keys) return predicate(actionOrCode);
    for (const code of keys) {
      if (predicate(code)) return true;
    }
    return false;
  }

  snapshot(predicates: { pressed: KeyPredicate; down: KeyPredicate; up: KeyPredicate }): InputActionSnapshot {
    const pressed: string[] = [], down: string[] = [], up: string[] = [];
    for (const [action, binding] of this._bindings.entries()) {
      const keys = binding.keys ?? [];
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
    return Object.freeze({pressed:Object.freeze(pressed),down:Object.freeze(down),up:Object.freeze(up)});
  }

  toJSON(): InputActionBindings {
    return Object.fromEntries([...this._bindings.entries()].map(([action,binding]) => [action,[...binding.keys ?? []]]));
  }
}

function normalizeCodes(codes:Iterable<string>):readonly string[]{
  const keys=new Set<string>();for(const code of codes){const normalized=String(code).trim();if(normalized)keys.add(normalized);}return Object.freeze([...keys]);
}
