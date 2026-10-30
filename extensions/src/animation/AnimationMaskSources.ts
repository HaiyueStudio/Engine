import {Component} from '@haiyue/engine';
import {UniqueCheckType} from '@haiyue/engine/ecs';

/** Known authored sources survive hidden/deferred drawables without allocating geometry or GPU targets. */
export class AnimationMaskSources extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('AnimationMaskSources');
  readonly keys: readonly string[];
  constructor(keys: readonly string[]) {super('AnimationMaskSources'); this.keys = Object.freeze([...keys]);}
  override clone(): AnimationMaskSources {return new AnimationMaskSources(this.keys);}
}
