import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import { GuiElementOptions, GuiRect } from '../GuiTypes';
import { GuiElement } from './GuiElement';

export type GuiTooltipPlacement = 'top' | 'right' | 'bottom' | 'left';

export interface GuiTooltipOptions extends GuiElementOptions {
  target: GuiElement;
  content?: string;
  placement?: GuiTooltipPlacement;
  delay?: number;
}

export class GuiTooltip extends GuiElement {
  private static readonly __controlIdentityGuiTooltip = /* @__PURE__ */ (() => admitGuiControl(GuiTooltip.prototype, 'GuiTooltip', undefined, paintGuiTooltip, (_control,theme)=>({backgroundColor:theme.colors.elevated??theme.colors.surface,borderColor:theme.colors.border,radius:6,shadow:{color:theme.colors.shadow??theme.colors.overlay??'#0005',blur:10,y:3}})))();
  static override readonly themeControlType: string = 'GuiTooltip';
  target: GuiElement;
  content: string;
  placement: GuiTooltipPlacement;
  delay: number;
  private activeSince = 0;

  constructor(options: GuiTooltipOptions) {
    super({
      ...options,
      width: options.width ?? 180,
      height: options.height ?? 30,
      visible: options.visible ?? true,
      disabled: true,
      style: options.style,
      id: options.id,
    });
    this.target = options.target;
    this.content = options.content ?? '';
    this.placement = options.placement ?? 'top';
    this.delay = options.delay ?? 0;
  }

  get active(): boolean {
    const targetActive = this.visible && this.target.isEffectivelyVisible() && (this.target.hovered || this.target.focused);
    if (!targetActive) {
      this.activeSince = 0;
      return false;
    }
    if (this.delay <= 0) return true;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this.activeSince === 0) {
      this.activeSince = now;
      return false;
    }
    return now - this.activeSince >= this.delay;
  }

  get popupRect(): GuiRect {
    return this.target.getPopupRect({width:this.rect.width,height:this.rect.height},{placement:this.placement});
  }

  override hitTest(): GuiElement | null {
    return null;
  }
}

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiTooltip(context:GuiPaint.GuiControlPaintContext, tooltip: GuiTooltip, theme: GuiPaint.GuiTheme): void {
    if (!tooltip.active || !tooltip.content) return;
    const rect = tooltip.popupRect;
    const radius = context.styleFor(tooltip).radius ?? theme.radius;
    const style = context.styleFor(tooltip), box = GuiPaint.guiContentBox(tooltip, 8, theme.fontSize, rect);
    const textRect = style.contentInsets || style.nineSlice || style.icon ? box.text : {x:rect.x + 8,y:rect.y,width:rect.width - 16,height:rect.height};
    if(theme.density)GuiPaint.paintGuiBox(context.currentPopupBatch,rect,style,GuiPaint.colorToRgba(style.backgroundColor,theme.colors.elevated??theme.colors.surface),GuiPaint.colorToRgba(style.borderColor,theme.colors.border),undefined,theme.radius);
    else context.addPopupRect(rect.x, rect.y, rect.width, rect.height, radius, GuiPaint.withAlpha(GuiPaint.colorToRgba(context.styleFor(tooltip).backgroundColor, theme.colors.background), 0.96));
    context.currentPopupTextBatch.addText({
      text: tooltip.content,
      ...textRect,
      fontSize: theme.fontSize,
      color: GuiPaint.colorToRgba(theme.colors.text, theme.colors.text),
      multiline: true, wrap: true, verticalAlign: 'center',
      clip: rect,
    });
  }
