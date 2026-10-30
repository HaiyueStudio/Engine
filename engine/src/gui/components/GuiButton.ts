import {guiButtonHoverProgress} from '../input/GuiButtonHover';
import {resolveGuiSkin,guiThemeState} from '../GuiThemeResolve';
import type {GuiSkin} from '../GuiThemeTypes';
import {guiImageSourceReady} from '../rendering/GuiImageSources';
import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import {finishGuiButtonHover,retargetGuiButtonHover} from '../input/GuiButtonHover';
import { GuiElement } from './GuiElement';
import {activateGuiElement} from '../input/GuiActivation';
import type {GuiActionEvent} from '../GuiTypes';
import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent } from '../GuiTypes';

export interface GuiButtonOptions extends GuiElementOptions {
  text?: string;
  /** Animate hover enter/leave colors. Defaults to false. */
  hoverTransition?: boolean;
  /** Hover color transition duration in milliseconds. Defaults to 180; nonpositive or nonfinite values are instant. */
  hoverTransitionMs?: number;
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
  private transitionEnabled: boolean;
  private transitionDuration: number;
  get hoverTransition():boolean {return this.transitionEnabled;}
  set hoverTransition(value:boolean) {this.transitionEnabled=value;finishGuiButtonHover(this);this.markDirty(GuiDirtyFlags.Visual);}
  get hoverTransitionMs():number {return this.transitionDuration;}
  set hoverTransitionMs(value:number) {this.transitionDuration=Number.isFinite(value)?Math.max(0,value):0;finishGuiButtonHover(this);this.markDirty(GuiDirtyFlags.Visual);}
  override handlePointerEnter(event:GuiPointerEvent):void {super.handlePointerEnter(event);retargetGuiButtonHover(this);}
  override handlePointerLeave(event:GuiPointerEvent):void {super.handlePointerLeave(event);retargetGuiButtonHover(this);}
  text: string;
  variant: 'default' | 'primary' | 'danger' | 'outline';

  constructor(options: GuiButtonOptions = {}) {
    super({ width: 96, height: 32, focus: {mode: 'all'}, ...options });
    this.transitionEnabled=options.hoverTransition??false;
    const duration=options.hoverTransitionMs??180;
    this.transitionDuration=Number.isFinite(duration)?Math.max(0,duration):0;
    finishGuiButtonHover(this);
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
    const progress=guiButtonHoverProgress(button),state=guiThemeState(button);
    const normal=progress===1?null:!state.hover?style:resolveGuiSkin(button,{...state,hover:false}),hover=progress===0?null:state.hover?style:resolveGuiSkin(button,{...state,hover:true});
    const colors=(skin:GuiSkin,over:boolean)=>{
      const palette={...(context.themeColors??theme.colors),...skin.palette};
      const base=button.variant==='primary'?palette.primary:button.variant==='danger'?palette.danger:palette.surface;
      return {border:GuiPaint.colorToRgba(skin.borderColor,button.focused?palette.primary:palette.border),background:GuiPaint.colorToRgba(over?skin.hoverBackgroundColor??skin.backgroundColor:skin.backgroundColor,button.pressed?palette.active:over?palette.hover:base),text:GuiPaint.colorToRgba(over?skin.hoverColor??skin.color:skin.color,palette.text)};
    };
    const from=normal?colors(normal,false):colors(hover!,true),to=hover?colors(hover,true):from;
    const mix=(a:[number,number,number,number],b:[number,number,number,number]):[number,number,number,number]=>[a[0]+(b[0]-a[0])*progress,a[1]+(b[1]-a[1])*progress,a[2]+(b[2]-a[2])*progress,a[3]+(b[3]-a[3])*progress];
    const border=style.nineSlice&&guiImageSourceReady(style.nineSlice.source)?GuiPaint.colorToRgba('transparent','transparent'):mix(from.border,to.border);
    const background=style.nineSlice&&guiImageSourceReady(style.nineSlice.source)?GuiPaint.colorToRgba('transparent','transparent'):mix(from.background,to.background),textColor=mix(from.text,to.text);
    if (button.variant === 'outline') {
      context.currentBatch.addShape({ ...button.rect, radius, color: border, strokeWidth: 1.5, clip: context.currentClip });
      context.addCenteredText(button.text, textRect.x, textRect.y, textRect.width, textRect.height, theme.fontSize, textColor);
      return;
    }
    context.addRect(button.rect.x, button.rect.y, button.rect.width, button.rect.height, radius, border);
    context.addRect(button.rect.x + 1, button.rect.y + 1, button.rect.width - 2, button.rect.height - 2, Math.max(0, radius - 1), GuiPaint.withAlpha(background, button.disabled ? 0.45 : 1));
    context.addCenteredText(button.text, textRect.x, textRect.y, textRect.width, textRect.height, theme.fontSize, textColor);
  }
