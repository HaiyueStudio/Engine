import { Component, UniqueCheckType } from '../ecs/Component';

export class OutlineTarget extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('OutlineTarget');

  constructor() {
    super('OutlineTarget');
  }
}
