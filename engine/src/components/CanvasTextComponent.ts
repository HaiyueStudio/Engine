import { Component, UniqueCheckType } from '../ecs/Component';
import { CssMaterial, type CssMaterialStyle } from '../material/CssMaterial';

export interface CanvasTextComponentOptions {
  text?: string;
  style?: CssMaterialStyle;
  material?: CssMaterial;
}

export class CanvasTextComponent extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('CanvasTextComponent');

  material: CssMaterial;

  constructor(options: CanvasTextComponentOptions = {}) {
    super('CanvasTextComponent');
    this.material = options.material ?? new CssMaterial({
      ...(options.text === undefined ? {} : { text: options.text }),
      ...(options.style === undefined ? {} : { style: options.style }),
    });
  }

  get text(): string {
    return this.material.text;
  }

  set text(value: string) {
    this.material.setText(value);
  }

  get style(): CssMaterialStyle {
    return this.material.style;
  }

  set style(value: CssMaterialStyle) {
    this.material.setStyle(value);
  }

  override clone(): CanvasTextComponent {
    return new CanvasTextComponent({
      text: this.text,
      style: { ...this.style },
    });
  }
}
