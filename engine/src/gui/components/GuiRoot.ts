import { Component, UniqueCheckType } from '../../ecs/Component';
import { DEFAULT_GUI_THEME, GuiDirtyFlags, GuiElementOptions, GuiRect, GuiTheme } from '../GuiTypes';
import { GuiElement } from './GuiElement';
import type {GuiInvalidation, GuiLayoutDelegate, GuiMeasureConstraint} from '../GuiLayoutTypes';
import {GuiLayoutOwner} from '../GuiLayoutOwner';
import {measureGuiElement, releaseGuiMeasureOwner} from '../GuiMeasure';

export interface GuiRootOptions extends GuiElementOptions {
  theme?: Partial<GuiTheme> | undefined;
}

export class GuiRoot extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('GuiRoot');

  readonly root: GuiElement;
  theme: GuiTheme;
  viewport: GuiRect = { x: 0, y: 0, width: 1, height: 1 };
  private readonly layoutOwner: GuiLayoutOwner;

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
    this.layoutOwner = new GuiLayoutOwner(this.root, () => JSON.stringify(this.theme));
  }

  installLayoutDelegate(delegate: GuiLayoutDelegate): () => void {return this.layoutOwner.install(delegate);}
  onInvalidation(listener: (change: GuiInvalidation) => void): () => void {return this.layoutOwner.subscribe(listener);}
  measureElement(element: GuiElement, width: GuiMeasureConstraint, height: GuiMeasureConstraint): {readonly width: number; readonly height: number; readonly minWidth: number; readonly minHeight: number} {
    let ancestor: GuiElement | null = element;
    while (ancestor && ancestor !== this.root) ancestor = ancestor.parent;
    if (!ancestor) throw new Error('Cannot measure an element belonging to another GUI root.');
    return measureGuiElement(this, element, width, height);
  }

  override destroy(): void {try {this.layoutOwner.destroy();} finally {releaseGuiMeasureOwner(this); super.destroy();}}

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
    const previous = this.viewport;
    const next = { x: 0, y: 0, width, height };
    const changed =
      this.viewport.width !== width ||
      this.viewport.height !== height;
    this.viewport = next;
    if (changed) this.root.markDirty(GuiDirtyFlags.Layout);
    try {if (!this.layoutOwner.layout(this.viewport) && this.root.dirty) this.root.layout(this.viewport);}
    catch (error) {this.viewport = previous; throw error;}
  }

  hitTest(x: number, y: number): GuiElement | null {
    return this.root.hitTest(x, y);
  }

  clearDirty(): void {
    this.root.clearDirty();
  }
}
