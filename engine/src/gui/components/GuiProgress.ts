import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import { GuiDirtyFlags, GuiElementOptions } from '../GuiTypes';
import { GuiElement } from './GuiElement';

export interface GuiProgressOptions extends GuiElementOptions {
  value?: number;
  min?: number;
  max?: number;
  showText?: boolean;
}

export class GuiProgress extends GuiElement {
  private static readonly __controlIdentityGuiProgress = /* @__PURE__ */ (() => admitGuiControl(GuiProgress.prototype, 'GuiProgress', undefined, paintGuiProgress))();
  static override readonly themeControlType: string = 'GuiProgress';
  value: number;
  min: number;
  max: number;
  showText: boolean;

  constructor(options: GuiProgressOptions = {}) {
    super({ width: 160, height: 12, ...options });
    this.value = options.value ?? 0;
    this.min = options.min ?? 0;
    this.max = options.max ?? 100;
    this.showText = options.showText ?? false;
  }

  get ratio(): number {
    const range = this.max - this.min;
    if (range <= 0) return 0;
    return Math.min(1, Math.max(0, (this.value - this.min) / range));
  }

  setValue(value: number): void {
    const next = Math.min(this.max, Math.max(this.min, value));
    if (this.value === next) return;
    this.value = next;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Text);
  }
}

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiProgress(context:GuiPaint.GuiControlPaintContext, progress: GuiProgress, theme: GuiPaint.GuiTheme): void {
    const radius = context.styleFor(progress).radius ?? progress.rect.height * 0.5;
    context.addRect(progress.rect.x, progress.rect.y, progress.rect.width, progress.rect.height, radius, GuiPaint.colorToRgba(context.styleFor(progress).backgroundColor, theme.colors.border));
    context.addRect(progress.rect.x, progress.rect.y, progress.rect.width * progress.ratio, progress.rect.height, radius, GuiPaint.colorToRgba(theme.colors.primary, theme.colors.primary));
    if (progress.showText) {
      const skin = context.styleFor(progress), r = skin.contentInsets || skin.nineSlice || skin.icon ? GuiPaint.guiContentBox(progress, 0, theme.fontSize).text : progress.rect;
      context.addCenteredText(`${Math.round(progress.ratio * 100)}%`, r.x, r.y, r.width, r.height, theme.fontSize, GuiPaint.colorToRgba(theme.colors.text, theme.colors.text));
    }
  }
