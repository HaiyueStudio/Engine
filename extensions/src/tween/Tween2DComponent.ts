import { Component } from '@haiyue/engine';
import { UniqueCheckType } from '@haiyue/engine/ecs';
import { Easing, type EasingFunction } from '@haiyue/engine/tween';

export type Tween2DEasingName = keyof typeof Easing;

export interface Tween2DProperties {
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
}

export interface Tween2DComponentOptions {
  from?: Tween2DProperties;
  to?: Tween2DProperties;
  duration?: number;
  delay?: number;
  easing?: Tween2DEasingName | EasingFunction | string;
  removeOnComplete?: boolean;
}

export class Tween2DComponent extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Tween2DComponent');
  static editor = {
    fields: {
      from: { type: 'json', label: 'From JSON', rows: 4 },
      to: { type: 'json', label: 'To JSON', rows: 4 },
      duration: { type: 'number', label: 'Duration ms', min: 0, step: 16 },
      delay: { type: 'number', label: 'Delay ms', min: 0, step: 16 },
      easing: { type: 'text', label: 'Easing' },
      removeOnComplete: { type: 'boolean', label: 'Remove On Complete' },
    },
  };

  from: Tween2DProperties | null;
  to: Tween2DProperties;
  duration: number;
  delay: number;
  easing: Tween2DEasingName | EasingFunction | string;
  removeOnComplete: boolean;
  elapsed = 0;
  started = false;
  completed = false;
  private _resolvedFrom: Tween2DProperties = {};

  constructor(options: Tween2DComponentOptions = {}) {
    super('Tween2DComponent');
    this.from = options.from ? { ...options.from } : null;
    this.to = { ...(options.to ?? {}) };
    this.duration = Math.max(0, options.duration ?? 160);
    this.delay = Math.max(0, options.delay ?? 0);
    this.easing = options.easing ?? 'cubicOut';
    this.removeOnComplete = options.removeOnComplete ?? true;
  }

  resolveFrom(current: Tween2DProperties): Tween2DProperties {
    if (this.started) return this._resolvedFrom;
    this._resolvedFrom = {};
    for (const key of Object.keys(this.to) as Array<keyof Tween2DProperties>) {
      this._resolvedFrom[key] = this.from?.[key] ?? current[key] ?? 0;
    }
    return this._resolvedFrom;
  }

  getEasingFunction(): EasingFunction {
    if (typeof this.easing === 'function') return this.easing;
    return Easing[this.easing as Tween2DEasingName] ?? Easing.linear;
  }

  override clone(): Tween2DComponent {
    return new Tween2DComponent({
      ...(this.from ? { from: { ...this.from } } : {}),
      to: { ...this.to },
      duration: this.duration,
      delay: this.delay,
      easing: this.easing,
      removeOnComplete: this.removeOnComplete,
    });
  }
}
