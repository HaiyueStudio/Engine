import { Component, UniqueCheckType } from '../../ecs/Component';
import { DEFAULT_GUI_THEME, GuiDirtyFlags, GuiElementOptions, GuiRect, GuiTheme } from '../GuiTypes';
import { GuiElement } from './GuiElement';

export interface GuiRootOptions extends GuiElementOptions {
  theme?: Partial<GuiTheme> | undefined;
}

export class GuiRoot extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('GuiRoot');

  readonly root: GuiElement;
  theme: GuiTheme;
  viewport: GuiRect = { x: 0, y: 0, width: 1, height: 1 };

  constructor(options: GuiRootOptions = {}) {
    super('GuiRoot');
    this.root = new GuiElement({
      id: options.id ?? 'gui-root',
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? '100%',
      height: options.height ?? '100%',
      visible: options.visible,
      disabled: options.disabled,
      style: options.style,
    });
    this.theme = {
      ...DEFAULT_GUI_THEME,
      ...options.theme,
      colors: {
        ...DEFAULT_GUI_THEME.colors,
        ...(options.theme?.colors ?? {}),
      },
    };
  }

  get dirty(): boolean {
    return this.root.dirty;
  }

  add<T extends GuiElement>(child: T): T {
    return this.root.add(child);
  }

  remove(child: GuiElement): boolean {
    return this.root.remove(child);
  }

  findById(id: string): GuiElement | null {
    return this.root.findById(id);
  }

  layout(width: number, height: number): void {
    const next = { x: 0, y: 0, width, height };
    const changed =
      this.viewport.width !== width ||
      this.viewport.height !== height;
    this.viewport = next;
    if (changed) this.root.markDirty(GuiDirtyFlags.Layout);
    if (this.root.dirty) this.root.layout(this.viewport);
  }

  hitTest(x: number, y: number): GuiElement | null {
    return this.root.hitTest(x, y);
  }

  clearDirty(): void {
    this.root.clearDirty();
  }
}
