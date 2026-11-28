import {registerGuiControlSize} from '../GuiControlSize';
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
import {guiStockTextControl,markGuiTextContentDirty,markGuiPaintDirty} from '../GuiInvalidationState';

export interface GuiButtonOptions extends GuiElementOptions {
  text?: string;
  loading?: boolean;
  iconOnly?: boolean;
  /** Animate hover enter/leave colors. Defaults to false. */
  hoverTransition?: boolean;
  /** Hover color transition duration in milliseconds. Defaults to 180; nonpositive or nonfinite values are instant. */
  hoverTransitionMs?: number;
  variant?: 'default' | 'primary' | 'danger' | 'outline' | 'text' | 'link';
  onClick?: (event: GuiPointerEvent) => void;
}

export class GuiButton extends GuiElement {
  private static readonly __controlIdentityGuiButton = /* @__PURE__ */ (() => admitGuiControl(GuiButton.prototype, 'GuiButton', undefined, paintGuiButton, (button,theme,state)=>({padding:theme.density==='compact'?8:theme.density==='touch'?16:12,paddingY:4,radius:theme.radius,borderWidth:1,focusWidth:2,focusColor:theme.colors.focus??theme.colors.primary,
    backgroundColor:state.disabled?theme.colors.disabled:button.variant==='text'||button.variant==='link'?'transparent':state.pressed?theme.colors.active:state.hover?theme.colors.hover:button.variant==='primary'?theme.colors.primary:button.variant==='danger'?theme.colors.danger:button.variant==='outline'?'transparent':theme.colors.elevated??theme.colors.surface,
    borderColor:button.variant==='text'||button.variant==='link'?'transparent':state.focus?theme.colors.focus??theme.colors.primary:button.variant==='primary'?theme.colors.primary:button.variant==='danger'?theme.colors.danger:theme.colors.border,
    ...(state.disabled?{color:theme.colors.disabledText??theme.colors.textMuted}:button.variant==='primary'||button.variant==='danger'?{color:theme.colors.onPrimary??'#fff'}:button.variant==='link'?{color:theme.colors.primary}:{})})))();
  static override readonly themeControlType: string = 'GuiButton';
  override handleAction(event: GuiActionEvent): void {
    super.handleAction(event);
    if (!event.consumed && !this.loading && event.action === 'confirm') activateGuiElement(this, event);
  }
  private transitionEnabled: boolean;
  private transitionDuration: number;
  get hoverTransition():boolean {return this.transitionEnabled;}
  set hoverTransition(value:boolean) {this.transitionEnabled=value;finishGuiButtonHover(this);this.markDirty(GuiDirtyFlags.Visual);}
  get hoverTransitionMs():number {return this.transitionDuration;}
  set hoverTransitionMs(value:number) {this.transitionDuration=Number.isFinite(value)?Math.max(0,value):0;finishGuiButtonHover(this);this.markDirty(GuiDirtyFlags.Visual);}
  override handlePointerEnter(event:GuiPointerEvent):void {super.handlePointerEnter(event);retargetGuiButtonHover(this);}
  override handlePointerLeave(event:GuiPointerEvent):void {super.handlePointerLeave(event);retargetGuiButtonHover(this);}
  iconOnly: boolean;
  private busy=false;
  private phase=0;
  private stopLoading:(()=>void)|undefined;
  get loading():boolean{return this.busy;}
  set loading(value:boolean){if(this.busy===value)return;this.busy=value;this.stopLoading?.();this.phase=0;this.setVisualState({loading:value});this.stopLoading=value?this.setActivity(delta=>{this.phase=(this.phase+delta/900)%1;markGuiPaintDirty(this);return this.busy;}):undefined;}
  get loadingPhase():number{return this.phase;}
  override handleClick(event:GuiPointerEvent):void {if(!this.loading)super.handleClick(event);}
  text: string;
  variant: 'default' | 'primary' | 'danger' | 'outline' | 'text' | 'link';

  constructor(options: GuiButtonOptions = {}) {
    super({ width: 96, height: 32, focus: {mode: 'all'}, ...options });
    registerGuiControlSize(this,options,32);
    this.transitionEnabled=options.hoverTransition??false;
    const duration=options.hoverTransitionMs??180;
    this.transitionDuration=Number.isFinite(duration)?Math.max(0,duration):0;
    finishGuiButtonHover(this);
    this.text = options.text ?? 'Button';
    this.variant = options.variant ?? 'default';
    this.iconOnly=options.iconOnly??false;this.loading=options.loading??false;
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    if(guiStockTextControl(this,GuiButton.prototype,GuiElement.prototype))markGuiTextContentDirty(this,GuiElement.prototype,true);
    else this.markDirty(GuiDirtyFlags.Text | GuiDirtyFlags.Visual);
  }
}

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiButton(context:GuiPaint.GuiControlPaintContext, button: GuiButton, theme: GuiPaint.GuiTheme): void {
    if(theme.density||button.loading||button.iconOnly||button.variant==='text'||button.variant==='link'){
      const skin=context.styleFor(button),label=GuiPaint.guiPartStyle(context,button,'label'),padding=skin.padding??12,vertical=skin.paddingY??padding;
      const r=skin.contentInsets||skin.nineSlice||skin.icon?{...GuiPaint.guiContentBox(button,padding,theme.fontSize).text}:{x:button.rect.x+padding,y:button.rect.y+vertical,width:Math.max(0,button.rect.width-padding*2),height:Math.max(0,button.rect.height-vertical*2)};
      const state=guiThemeState(button),progress=guiButtonHoverProgress(button);
      const normal=progress===1?null:!state.hover?skin:resolveGuiSkin(button,{...state,hover:false}),hover=progress===0?null:state.hover?skin:resolveGuiSkin(button,{...state,hover:true});
      const colors=(s:GuiSkin,over:boolean)=>({fill:GuiPaint.colorToRgba(over?s.hoverBackgroundColor??s.backgroundColor:s.backgroundColor,button.variant==='text'||button.variant==='link'||button.variant==='outline'?'transparent':over?theme.colors.hover:theme.colors.surface),border:GuiPaint.colorToRgba(s.borderColor,theme.colors.border),text:GuiPaint.colorToRgba(over?s.hoverColor??s.color:s.color,theme.colors.text)});
      const from=normal?colors(normal,false):colors(hover!,true),to=normal&&hover?colors(hover,true):from;
      const mix=(a:[number,number,number,number],b:[number,number,number,number]):[number,number,number,number]=>a===b?a:a.map((v,i)=>v+(b[i]!-v)*progress) as [number,number,number,number];
      const fill=mix(from.fill,to.fill),border=mix(from.border,to.border),text=mix(from.text,to.text);
      GuiPaint.paintGuiBox(context.currentBatch,button.rect,skin,fill,border,context.currentClip,theme.radius);
      if(button.loading){const size=Math.min(16,button.rect.height-8),x=button.iconOnly?button.rect.x+(button.rect.width-size)/2:r.x;GuiPaint.paintGuiArc(context.currentBatch,{x,y:button.rect.y+(button.rect.height-size)/2,width:size,height:size},GuiPaint.colorToRgba(label.color??skin.color,theme.colors.text),button.loadingPhase*Math.PI*2,button.loadingPhase*Math.PI*2+Math.PI*1.5,2,context.currentClip);r.x+=size+8;r.width=Math.max(0,r.width-size-8);}
      if(!button.iconOnly)context.addCenteredText(button.text,r.x,r.y,r.width,r.height,label.fontSize??theme.fontSize,label.color?GuiPaint.colorToRgba(label.color,theme.colors.text):text);return;
    }
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
