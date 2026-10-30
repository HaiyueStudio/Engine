import type {GuiElement} from '../components/GuiElement';
import {isGuiControl} from '../GuiControlIdentity';

/** One inline cursor owner per input domain; no DOM requirement for Native. */
export class GuiPointerCursor {
  private previous: {value: string; priority: string} | null = null;
  private applied: string | null = null;
  constructor(private readonly surface?: HTMLCanvasElement | null) {}

  update(target: GuiElement | null): void {
    let cursor: string | undefined;
    for (let node = target; node; node = node.parent) {
      if (node.disabled || !node.visible) {this.restore(); return;}
      if (cursor === undefined) {
        cursor = node.style.cursor;
        if (cursor === undefined && isGuiControl(node, 'GuiInput')) cursor = 'text';
        if (cursor === undefined && (isGuiControl(node, 'GuiButton') || isGuiControl(node, 'GuiCheckbox') ||
            isGuiControl(node, 'GuiRadio') || isGuiControl(node, 'GuiSwitch') ||
            isGuiControl(node, 'GuiSelect') || isGuiControl(node, 'GuiSlider'))) cursor = 'pointer';
      }
    }
    const style = this.surface?.style;
    if (!style) return;
    if (!cursor) {this.restore(); return;}
    // Application changes made while hovered become the new restoration value.
    if (!this.previous || style.getPropertyValue('cursor') !== this.applied || style.getPropertyPriority('cursor')) {
      this.previous = {value: style.getPropertyValue('cursor'), priority: style.getPropertyPriority('cursor')};
    }
    if (this.applied === cursor && style.getPropertyValue('cursor') === cursor && !style.getPropertyPriority('cursor')) return;
    style.setProperty('cursor', cursor);
    this.applied = style.getPropertyValue('cursor');
  }

  restore(): void {
    const style = this.surface?.style;
    if (style && this.previous && style.getPropertyValue('cursor') === this.applied && !style.getPropertyPriority('cursor')) {
      if (this.previous.value) style.setProperty('cursor', this.previous.value, this.previous.priority);
      else style.removeProperty('cursor');
    }
    this.previous = null;
    this.applied = null;
  }
}
