import { UniqueCheckType } from '../ecs/Component';
import { LightComponent } from './LightComponent';
import type { ColorLike } from '../color/ColorLike';

export interface AmbientLightOptions {
  color?:     ColorLike;
  intensity?: number;
}

export class AmbientLight extends LightComponent {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol    = Symbol.for('LightComponent');

  readonly lightType = 'ambient' as const;

  constructor(options: AmbientLightOptions = {}) {
    super(options.color, options.intensity ?? 0.1);
    this.name = 'AmbientLight';
  }
}
