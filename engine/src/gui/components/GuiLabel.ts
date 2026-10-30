import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {guiLabelMeasuredTextWidth} from '../GuiIntrinsicText';
import {admitGuiControl} from '../GuiControlIdentity';
import { GuiDirtyFlags, type GuiElementOptions, type GuiRect } from '../GuiTypes';
import { GuiElement } from './GuiElement';
import {assignedGuiRect} from '../GuiLayoutState';
import {guiContentMetrics} from '../GuiContent';

export type GuiLabelTextAlign = 'left' | 'center' | 'right';

export interface GuiLabelOptions extends GuiElementOptions {
  text?: string;
  fontSize?: number;
  textAlign?: GuiLabelTextAlign;
  /** Sizes the label width to the measured text plus horizontal padding. */
  autoWidth?: boolean;
}



/** Non-interactive text intended for headings, status text, and HUD values. */
export class GuiLabel extends GuiElement {
  private static readonly __controlIdentityGuiLabel = /* @__PURE__ */ (() => admitGuiControl(GuiLabel.prototype, 'GuiLabel', undefined, paintGuiLabel))();
  static override readonly themeControlType: string = 'GuiLabel';
  text: string;
  fontSize: number | undefined;
  textAlign: GuiLabelTextAlign;
  autoWidth: boolean;

  constructor(options: GuiLabelOptions = {}) {
    super({ width: 96, height: 24, disabled: true, ...options });
    this.text = options.text ?? '';
    this.fontSize = options.fontSize;
    this.textAlign = options.textAlign ?? 'left';
    this.autoWidth = options.autoWidth ?? false;
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.markDirty(GuiDirtyFlags.Text | GuiDirtyFlags.Visual);
  }

  setFontSize(fontSize: number | undefined): void {
    if (this.fontSize === fontSize) return;
    this.fontSize = fontSize;
    this.markDirty(GuiDirtyFlags.Text | GuiDirtyFlags.Visual);
  }

  setTextAlign(textAlign: GuiLabelTextAlign): void {
    if (this.textAlign === textAlign) return;
    this.textAlign = textAlign;
    this.markDirty(GuiDirtyFlags.Visual);
  }

  setAutoWidth(autoWidth: boolean): void {
    if (this.autoWidth === autoWidth) return;
    this.autoWidth = autoWidth;
    this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
  }

  override layout(parentRect: GuiRect): void {
    super.layout(parentRect);
    if (!this.autoWidth || assignedGuiRect(this)) return;
    const measuredWidth = guiLabelMeasuredTextWidth(this);
    if (measuredWidth === undefined) return;
    const skin = this.getResolvedStyle();
    const width = Math.ceil(measuredWidth + guiContentMetrics(this, 0, this.fontSize ?? skin.fontSize ?? 14).horizontal);
    if (this.rect.width === width) return;
    this.rect.width = width;
    for (const child of this.children) child.layout(this.getContentRect());
  }
}

export {setGuiLabelMeasuredTextWidth} from '../GuiIntrinsicText';

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiLabel(context:GuiPaint.GuiControlPaintContext, label: GuiLabel, theme: GuiPaint.GuiTheme): void {
    const font = context.activeFont;
    const opacity = context.styleFor(label).opacity ?? 1;
    const radius = context.styleFor(label).radius ?? theme.radius;
    const border = context.styleFor(label).borderColor;
    const background = context.styleFor(label).backgroundColor;
    const inset = border ? 1 : 0;
    if (border) {
      context.addRect(
        label.rect.x,
        label.rect.y,
        label.rect.width,
        label.rect.height,
        radius,
        GuiPaint.withAlpha(GuiPaint.colorToRgba(border, theme.colors.border), opacity),
      );
    }
    if (background || border) {
      context.addRect(
        label.rect.x + inset,
        label.rect.y + inset,
        Math.max(0, label.rect.width - inset * 2),
        Math.max(0, label.rect.height - inset * 2),
        Math.max(0, radius - inset),
        GuiPaint.withAlpha(GuiPaint.colorToRgba(background, theme.colors.surface), opacity),
      );
    }

    const padding = context.styleFor(label).padding ?? 0;
    const fontSize = label.fontSize ?? theme.fontSize;
    const style = context.styleFor(label), box = GuiPaint.guiContentBox(label, 0, fontSize);
    const customContent = !!(style.contentInsets || style.nineSlice || style.icon);
    const x = customContent ? box.text.x : label.rect.x + padding;
    const width = customContent ? box.text.width : Math.max(0, label.rect.width - padding * 2);
    let textX = x;
    if (font && label.textAlign !== 'left') {
      const textWidth = GuiPaint.measureGuiTextWidth(label.text, font, fontSize);
      textX = label.textAlign === 'center'
        ? x + Math.max(0, (width - textWidth) * 0.5)
        : x + Math.max(0, width - textWidth);
    }
    context.currentTextBatch.addText({
      text: label.text,
      x: textX,
      y: customContent ? box.text.y : label.rect.y + (GuiPaint.isGuiLayoutManaged(label) ? padding : 0),
      width: Math.max(0, x + width - textX),
      height: customContent ? box.text.height : Math.max(0, label.rect.height - (GuiPaint.isGuiLayoutManaged(label) ? padding * 2 : 0)),
      fontSize,
      color: GuiPaint.withAlpha(GuiPaint.colorToRgba(context.styleFor(label).color, theme.colors.text), opacity),
      multiline: GuiPaint.isGuiLayoutManaged(label),
      wrap: GuiPaint.isGuiLayoutManaged(label),
      clip: context.clipRect(label.rect),
    });
  }
