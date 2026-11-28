import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import { GuiDirtyFlags, GuiElementOptions } from '../GuiTypes';
import { GuiElement } from './GuiElement';
import {guiStockTextControl,markGuiPaintDirty,markGuiTextContentDirty} from '../GuiInvalidationState';

export interface GuiProgressOptions extends GuiElementOptions {
  value?: number;
  min?: number;
  max?: number;
  showText?: boolean;
  variant?:'line'|'circle';
  status?:'normal'|'success'|'exception'|'active';
  strokeWidth?:number;
  indeterminate?:boolean;
}

export class GuiProgress extends GuiElement {
  private static readonly __controlIdentityGuiProgress = /* @__PURE__ */ (() => admitGuiControl(GuiProgress.prototype, 'GuiProgress', undefined, paintGuiProgress))();
  static override readonly themeControlType: string = 'GuiProgress';
  value: number;
  min: number;
  max: number;
  showText: boolean;
  variant:'line'|'circle';
  status:'normal'|'success'|'exception'|'active';
  strokeWidth:number;
  indeterminate=false;
  phase=0;
  private stopActivity:()=>void=()=>{};

  constructor(options: GuiProgressOptions = {}) {
    super({ width: 160, height: 12, ...options });
    this.value = options.value ?? 0;
    this.min = options.min ?? 0;
    this.max = options.max ?? 100;
    this.showText = options.showText ?? false;
    this.variant=options.variant??'line';this.status=options.status??'normal';this.strokeWidth=options.strokeWidth??4;
    if(!['line','circle'].includes(this.variant)||!['normal','success','exception','active'].includes(this.status)||!Number.isFinite(this.strokeWidth)||this.strokeWidth<=0||this.strokeWidth>128)throw new TypeError('Invalid GUI progress appearance.');
    this.setIndeterminate(options.indeterminate??false);
  }
  setIndeterminate(value:boolean):void {
    if(typeof value!=='boolean')throw new TypeError('Invalid GUI progress activity.');
    if(value===this.indeterminate)return;this.indeterminate=value;this.stopActivity();this.stopActivity=()=>{};
    if(value)this.stopActivity=this.setActivity(delta=>{this.phase=(this.phase+delta/1100)%1;markGuiPaintDirty(this);});
    markGuiPaintDirty(this);
  }

  get ratio(): number {
    const range = this.max - this.min;
    if (range <= 0) return 0;
    return Math.min(1, Math.max(0, (this.value - this.min) / range));
  }

  setValue(value: number): void {
    const next = Math.min(this.max, Math.max(this.min, value));
    if (this.value === next) return;
    const text=this.showText?Math.round(this.ratio*100):null;
    this.value = next;
    if(!guiStockTextControl(this,GuiProgress.prototype,GuiElement.prototype)){this.markDirty(GuiDirtyFlags.Visual|GuiDirtyFlags.Text);return;}
    if(this.showText&&!Object.is(text,Math.round(this.ratio*100)))markGuiTextContentDirty(this,GuiElement.prototype,true);
    else markGuiPaintDirty(this);
  }
  get displayText():string{return this.showText?`${Math.round(this.ratio*100)}%`:'';}
}

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiProgress(context:GuiPaint.GuiControlPaintContext, progress: GuiProgress, theme: GuiPaint.GuiTheme): void {
    const skin=context.styleFor(progress),track=progress.getPartStyle('track'),indicator=progress.getPartStyle('indicator'),opacity=progress.disabled?.45:skin.opacity??1;
    const fill=GuiPaint.withAlpha(GuiPaint.colorToRgba(indicator.backgroundColor??indicator.color,progress.status==='success'?theme.colors.success??'#20845c':progress.status==='exception'?theme.colors.danger:theme.colors.primary),opacity),background=GuiPaint.withAlpha(GuiPaint.colorToRgba(track.backgroundColor??skin.backgroundColor,theme.colors.border),opacity);
    if(progress.variant==='circle'){
      const size=Math.min(progress.rect.width,progress.rect.height),rect={x:progress.rect.x+(progress.rect.width-size)/2,y:progress.rect.y+(progress.rect.height-size)/2,width:size,height:size},start=-Math.PI/2+(progress.indeterminate?progress.phase*Math.PI*2:0),sweep=(progress.indeterminate?.72:progress.ratio)*Math.PI*2,thickness=Math.min(progress.strokeWidth,size/2);
      GuiPaint.paintGuiArc(context.currentBatch,rect,background,0,Math.PI*2,thickness,context.currentClip);
      if(sweep>0)GuiPaint.paintGuiArc(context.currentBatch,rect,fill,start,start+sweep,thickness,context.currentClip);
      if(progress.showText&&!progress.indeterminate)context.addCenteredText(`${Math.round(progress.ratio*100)}%`,rect.x,rect.y,rect.width,rect.height,Math.min(theme.fontSize,size/4),GuiPaint.colorToRgba(progress.getPartStyle('label').color??skin.color,theme.colors.text));return;
    }
    const radius = context.styleFor(progress).radius ?? progress.rect.height * 0.5;
    context.addRect(progress.rect.x, progress.rect.y, progress.rect.width, progress.rect.height, radius, background);
    const span=progress.indeterminate?.3:progress.ratio,x=progress.rect.x+(progress.indeterminate?(progress.rect.width*(1-span))*progress.phase:0);
    context.addRect(x, progress.rect.y, progress.rect.width * span, progress.rect.height, radius, fill);
    if (progress.showText) {
      const skin = context.styleFor(progress), r = skin.contentInsets || skin.nineSlice || skin.icon ? GuiPaint.guiContentBox(progress, 0, theme.fontSize).text : progress.rect;
      context.addCenteredText(`${Math.round(progress.ratio * 100)}%`, r.x, r.y, r.width, r.height, theme.fontSize, GuiPaint.colorToRgba(theme.colors.text, theme.colors.text));
    }
  }
