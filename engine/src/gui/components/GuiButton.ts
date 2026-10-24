import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import { GuiElement } from './GuiElement';
import {activateGuiElement} from '../input/GuiActivation';
import type {GuiActionEvent} from '../GuiTypes';
import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent } from '../GuiTypes';

export interface GuiButtonOptions extends GuiElementOptions {
  text?: string;
  variant?: 'default' | 'primary' | 'danger' | 'outline';
  onClick?: (event: GuiPointerEvent) => void;
}

export class GuiButton extends GuiElement {
  private static readonly __controlIdentityGuiButton = /* @__PURE__ */ (() => admitGuiControl(GuiButton.prototype, 'GuiButton', undefined, paintGuiButton))();
  static override readonly themeControlType: string = 'GuiButton';
  override handleAction(event: GuiActionEvent): void {
    super.handleAction(event);
    if (!event.consumed && event.action === 'confirm') activateGuiElement(this, event);
  }
  text: string;
  variant: 'default' | 'primary' | 'danger' | 'outline';

  constructor(options: GuiButtonOptions = {}) {
    super({ width: 96, height: 32, focus: {mode: 'all'}, ...options });
    this.text = options.text ?? 'Button';
    this.variant = options.variant ?? 'default';
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.markDirty(GuiDirtyFlags.Text | GuiDirtyFlags.Visual);
  }
}

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiButton(context:GuiPaint.GuiControlPaintContext, button: GuiButton, theme: GuiPaint.GuiTheme): void {
    const style = context.styleFor(button), padding = style.padding ?? (button.variant === 'outline' ? 4 : 8);
    const box = GuiPaint.guiContentBox(button, button.variant === 'outline' ? 4 : 8, theme.fontSize);
    const textRect = style.contentInsets || style.nineSlice || style.icon ? box.text : {x: button.rect.x + padding, y: button.rect.y, width: button.rect.width - padding * 2, height: button.rect.height};
    const radius = context.styleFor(button).radius ?? theme.radius;
    const border = GuiPaint.colorToRgba(context.styleFor(button).borderColor, button.focused ? theme.colors.primary : theme.colors.border);
    const baseSurface = button.variant === 'primary'
      ? theme.colors.primary
      : button.variant === 'danger'
        ? theme.colors.danger
        : theme.colors.surface;
    const surface = button.pressed
      ? theme.colors.active
      : button.hovered
        ? theme.colors.hover
        : baseSurface;
    const background = button.hovered
      ? context.styleFor(button).hoverBackgroundColor ?? context.styleFor(button).backgroundColor
      : context.styleFor(button).backgroundColor;
    const textColor = button.hovered
      ? context.styleFor(button).hoverColor ?? context.styleFor(button).color
      : context.styleFor(button).color;
    if (button.variant === 'outline') {
      context.currentBatch.addShape({ ...button.rect, radius, color: border, strokeWidth: 1.5, clip: context.currentClip });
      context.addCenteredText(button.text, textRect.x, textRect.y, textRect.width, textRect.height, theme.fontSize, GuiPaint.colorToRgba(textColor,theme.colors.text));
      return;
    }
    context.addRect(button.rect.x, button.rect.y, button.rect.width, button.rect.height, radius, border);
    context.addRect(button.rect.x + 1, button.rect.y + 1, button.rect.width - 2, button.rect.height - 2, Math.max(0, radius - 1), GuiPaint.withAlpha(GuiPaint.colorToRgba(background, surface), button.disabled ? 0.45 : 1));
    context.addCenteredText(button.text, textRect.x, textRect.y, textRect.width, textRect.height, theme.fontSize, GuiPaint.colorToRgba(textColor, theme.colors.text));
  }
