import {markGuiPaintDirty} from '../GuiInvalidationState';
import {registerGuiControlSize} from '../GuiControlSize';
import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import { GuiCheckbox, GuiCheckboxOptions } from './GuiCheckbox';
import { GuiDirtyFlags } from '../GuiTypes';

export interface GuiSwitchOptions extends GuiCheckboxOptions {
  /** Thumb movement duration in milliseconds. Defaults to 0 (instant). */
  thumbTransitionMs?: number;
  loading?: boolean;
  checkedLabel?: string;
  uncheckedLabel?: string;
  /** Track color transition duration in milliseconds. Defaults to 0 (instant). */
  colorTransitionMs?: number;
}

export class GuiSwitch extends GuiCheckbox {
  private static readonly __controlIdentityGuiSwitch = /* @__PURE__ */ (() => admitGuiControl(GuiSwitch.prototype, 'GuiSwitch', undefined, paintGuiSwitch, (_control,theme)=>({focusWidth:2,focusColor:theme.colors.focus??theme.colors.primary})))();
  static override readonly themeControlType: string = 'GuiSwitch';
  private busy=false;
  private spin=0;
  private stopLoading:(()=>void)|undefined;
  get loading():boolean{return this.busy;}
  set loading(value:boolean){if(this.busy===value)return;this.busy=value;this.stopLoading?.();this.setVisualState({loading:value});this.stopLoading=value?this.setActivity(dt=>{this.spin=(this.spin+dt/900)%1;markGuiPaintDirty(this);return this.busy;}):undefined;}
  checkedLabel:string;
  uncheckedLabel:string;
  thumbTransitionMs: number;
  colorTransitionMs: number;
  private target: number;
  private thumbFrom: number;
  private colorFrom: number;
  private elapsed = 0;
  constructor(options: GuiSwitchOptions = {}) {
    super({ width: 48, height: 28, ...options });
    registerGuiControlSize(this,options,28);
    this.loading=options.loading??false;this.checkedLabel=options.checkedLabel??'';this.uncheckedLabel=options.uncheckedLabel??'';
    this.thumbTransitionMs = options.thumbTransitionMs ?? 0;
    this.colorTransitionMs = options.colorTransitionMs ?? 0;
    this.target = this.thumbFrom = this.colorFrom = this.checked ? 1 : 0;
  }
  override handleClick(event:import('../GuiTypes').GuiPointerEvent):void {if(!this.loading)super.handleClick(event);}
  override handleAction(event:import('../GuiTypes').GuiActionEvent):void {if(!this.loading)super.handleAction(event);}
  get loadingPhase():number{return this.spin;}
  get thumbProgress(): number {
    this.syncTarget();
    return this.sample(this.thumbFrom, this.thumbTransitionMs);
  }
  get colorProgress(): number {
    this.syncTarget();
    return this.sample(this.colorFrom, this.colorTransitionMs);
  }
  get animating(): boolean {
    const next = this.checked ? 1 : 0;
    return (Number.isFinite(this.thumbTransitionMs) && this.thumbTransitionMs > 0 && this.sample(this.thumbFrom, this.thumbTransitionMs) !== next) ||
      (Number.isFinite(this.colorTransitionMs) && this.colorTransitionMs > 0 && this.sample(this.colorFrom, this.colorTransitionMs) !== next);
  }
  advanceAnimation(deltaMs: number): void {
    const changed = this.syncTarget();
    if (!this.animating) return;
    // A newly observed change starts now, not at the previous (possibly idle) frame.
    if (!changed && Number.isFinite(deltaMs)) this.elapsed += Math.max(0, deltaMs);
    this.markDirty(GuiDirtyFlags.Visual);
  }
  finishAnimation(): void {
    this.target = this.thumbFrom = this.colorFrom = this.checked ? 1 : 0;
    this.elapsed = 0;
    this.markDirty(GuiDirtyFlags.Visual);
  }
  private syncTarget(): boolean {
    const next = this.checked ? 1 : 0;
    if (next === this.target) return false;
    this.thumbFrom = this.sample(this.thumbFrom, this.thumbTransitionMs);
    this.colorFrom = this.sample(this.colorFrom, this.colorTransitionMs);
    this.target = next;
    this.elapsed = 0;
    return true;
  }
  private sample(from: number, duration: number): number {
    if (!Number.isFinite(duration) || duration <= 0 || this.elapsed >= duration) return this.target;
    const t = 1 - Math.pow(1 - this.elapsed / duration, 3);
    return from + (this.target - from) * t;
  }
}

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiSwitch(context:GuiPaint.GuiControlPaintContext, control: GuiSwitch, theme: GuiPaint.GuiTheme): void {
    if(theme.density||control.loading||control.checkedLabel||control.uncheckedLabel){
      const skin=context.styleFor(control),track=GuiPaint.guiPartStyle(context,control,'track'),thumb=GuiPaint.guiPartStyle(context,control,'thumb'),r=control.rect,amount=control.colorProgress;
      const off=GuiPaint.colorToRgba(track.backgroundColor??skin.backgroundColor,theme.colors.disabled),on=GuiPaint.colorToRgba(track.backgroundColor??skin.backgroundColor,theme.colors.primary),color=off.map((v,i)=>v+(on[i]!-v)*amount) as [number,number,number,number];
      GuiPaint.paintGuiBox(context.currentBatch,r,{...skin,borderWidth:skin.borderWidth??0,radius:skin.radius??r.height/2,...track},GuiPaint.withAlpha(color,control.disabled?.45:1),[0,0,0,0],context.currentClip,r.height/2);
      const size=Math.max(4,r.height-6),x=r.x+3+Math.max(0,r.width-size-6)*control.thumbProgress;
      GuiPaint.paintGuiBox(context.currentBatch,{x,y:r.y+3,width:size,height:size},{radius:size/2,borderWidth:0,...thumb},GuiPaint.colorToRgba(thumb.backgroundColor,theme.colors.thumb??'#fff'),[0,0,0,0],context.currentClip,size/2);
      if(control.loading)GuiPaint.paintGuiArc(context.currentBatch,{x:x+4,y:r.y+7,width:Math.max(0,size-8),height:Math.max(0,size-8)},GuiPaint.colorToRgba(thumb.color,theme.colors.primary),control.loadingPhase*Math.PI*2,control.loadingPhase*Math.PI*2+Math.PI*1.5,1.5,context.currentClip);
      const label=control.checked?control.checkedLabel:control.uncheckedLabel;if(label){const w=Math.max(0,r.width-size-8),lx=control.checked?r.x+3:r.x+size+5;context.addCenteredText(label,lx,r.y,w,r.height,Math.min(12,theme.fontSize),GuiPaint.colorToRgba(track.color,theme.colors.onPrimary??'#fff'));}return;
    }
    const off = GuiPaint.colorToRgba(context.styleFor(control).backgroundColor, theme.colors.border);
    const on = GuiPaint.colorToRgba(context.styleFor(control).backgroundColor, theme.colors.primary);
    const amount = control.colorProgress;
    const track = GuiPaint.withAlpha(off.map((value, i) => value + (on[i]! - value) * amount) as [number, number, number, number], control.disabled ? 0.45 : 1);
    const thumb = GuiPaint.colorToRgba(theme.colors.text, theme.colors.text);
    const radius = control.rect.height * 0.5;
    context.currentBatch.addShape({ ...control.rect, radius, color: track, roundedMesh: true, clip: context.currentClip });
    const thumbSize = Math.max(4, control.rect.height - 6);
    const thumbX = control.rect.x + 3 + Math.max(0, control.rect.width - thumbSize - 6) * control.thumbProgress;
    context.currentBatch.addShape({ x: thumbX, y: control.rect.y + 3, width: thumbSize, height: thumbSize, radius: thumbSize * 0.5, color: GuiPaint.withAlpha(thumb, control.disabled ? 0.45 : 1), roundedMesh: true, clip: context.currentClip });
  }
