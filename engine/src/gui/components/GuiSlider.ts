import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import {GuiDirtyFlags,type GuiElementOptions,type GuiPointerEvent,type GuiValueChangeHandler,type GuiActionEvent,type GuiRect} from '../GuiTypes';
import {GuiElement} from './GuiElement';

export interface GuiSliderOptions extends GuiElementOptions {
  value?:number;min?:number;max?:number;step?:number;
  orientation?:'horizontal'|'vertical';range?:readonly[number,number];thumbSize?:number;
  marks?:readonly {readonly value:number;readonly label?:string}[];
  tooltip?:'none'|'hover'|'always';formatValue?:(value:number)=>string;
  onChange?:GuiValueChangeHandler<number>;onCommit?:GuiValueChangeHandler<number>;
  onRangeChange?:(range:readonly[number,number])=>void;onRangeCommit?:(range:readonly[number,number])=>void;
}
/** One original pointer/action owner for single and double-thumb, horizontal and vertical sliders. */
export class GuiSlider extends GuiElement {
  private static readonly __controlIdentityGuiSlider=/* @__PURE__ */ (()=>admitGuiControl(GuiSlider.prototype,'GuiSlider',undefined,paintGuiSlider,(_slider,theme)=>({focusWidth:2,focusColor:theme.colors.focus??theme.colors.primary,parts:{track:{backgroundColor:theme.colors.border},indicator:{backgroundColor:theme.colors.primary},thumb:{backgroundColor:theme.colors.thumb??theme.colors.text,borderColor:theme.colors.primary},mark:{color:theme.colors.textMuted},tooltip:{backgroundColor:theme.colors.elevated??theme.colors.surface,color:theme.colors.text,radius:5}}})))();
  static override readonly themeControlType:string='GuiSlider';
  value:number;min:number;max:number;step:number;
  orientation:'horizontal'|'vertical';thumbSize:number;tooltip:'none'|'hover'|'always';
  readonly marks:readonly {readonly value:number;readonly label?:string}[];
  readonly formatValue:(value:number)=>string;
  onChange:GuiValueChangeHandler<number>|null;onCommit:GuiValueChangeHandler<number>|null;
  onRangeChange:((range:readonly[number,number])=>void)|null;onRangeCommit:((range:readonly[number,number])=>void)|null;
  private end:number|null=null;
  activeThumb:0|1=0;
  constructor(options:GuiSliderOptions={}){
    super({width:options.orientation==='vertical'?48:160,height:options.orientation==='vertical'?160:32,focus:{mode:'all'},...options});
    this.min=options.min??0;this.max=options.max??100;this.step=options.step??1;this.value=this.min;
    this.orientation=options.orientation??'horizontal';this.thumbSize=options.thumbSize??16;this.tooltip=options.tooltip??'none';this.formatValue=options.formatValue??String;
    if(![this.min,this.max,this.step,this.thumbSize].every(Number.isFinite)||this.min>this.max||this.step<0||this.thumbSize<8||this.thumbSize>48||!['horizontal','vertical'].includes(this.orientation)||!['none','hover','always'].includes(this.tooltip)||typeof this.formatValue!=='function')throw new TypeError('Invalid GUI slider configuration.');
    if(options.marks!==undefined&&(!Array.isArray(options.marks)||options.marks.length>100))throw new TypeError('Invalid GUI slider marks.');
    const values=new Set<number>();this.marks=Object.freeze((options.marks??[]).map(mark=>{if(!mark||!Number.isFinite(mark.value)||mark.value<this.min||mark.value>this.max||values.has(mark.value)||mark.label!==undefined&&typeof mark.label!=='string')throw new TypeError('Invalid or duplicate GUI slider mark.');values.add(mark.value);return Object.freeze({...mark});}));
    this.onChange=options.onChange??null;this.onCommit=options.onCommit??null;this.onRangeChange=options.onRangeChange??null;this.onRangeCommit=options.onRangeCommit??null;
    this.setValue(options.value??this.min);if(options.range)this.setRange(options.range);
  }
  get ratio():number{return this.ratioFor(this.value);}
  get range():readonly[number,number]|null{return this.end===null?null:Object.freeze([this.value,this.end]as const);}
  get displayText():string {return [...this.marks.map(m=>m.label??''),...(this.tooltip==='none'?[]:[this.formatValue(this.value),...(this.end===null?[]:[this.formatValue(this.end)])])].join(' ');}
  get tooltipRects():readonly GuiRect[]{return sliderTips(this).map(t=>t.rect);}
  private ratioFor(value:number):number{return this.max>this.min?Math.min(1,Math.max(0,(value-this.min)/(this.max-this.min))):0;}
  private snap(value:number):number {
    if(!Number.isFinite(value))throw new TypeError('Slider values must be finite.');
    const snapped=this.step>0?this.min+Math.round((value-this.min)/this.step)*this.step:value;
    return Math.min(this.max,Math.max(this.min,Number(snapped.toPrecision(14))));
  }
  setValue(value:number,emit=false):void {
    const next=Math.min(this.end??this.max,this.snap(value));if(next===this.value)return;this.value=next;this.markDirty(GuiDirtyFlags.Visual|GuiDirtyFlags.Input|GuiDirtyFlags.Text);
    if(emit){this.onChange?.(next);if(this.end!==null)this.onRangeChange?.(this.range!);}
  }
  setRange(range:readonly[number,number]|null,emit=false):void {
    if(range===null){if(this.end!==null){this.end=null;this.activeThumb=0;this.markDirty(GuiDirtyFlags.Visual|GuiDirtyFlags.Input|GuiDirtyFlags.Text);}return;}
    if(!Array.isArray(range)||range.length!==2||!range.every(Number.isFinite)||range[0]>range[1])throw new TypeError('Slider range must be an ordered finite pair.');
    const start=this.snap(range[0]),end=this.snap(range[1]);if(this.value===start&&this.end===end)return;this.value=start;this.end=end;this.markDirty(GuiDirtyFlags.Visual|GuiDirtyFlags.Input|GuiDirtyFlags.Text);if(emit)this.onRangeChange?.(this.range!);
  }
  setActiveThumb(index:0|1):void {if(index!==0&&index!==1||index===1&&this.end===null)throw new TypeError('Invalid slider thumb.');if(index!==this.activeThumb){this.activeThumb=index;this.markDirty(GuiDirtyFlags.Visual);}}
  private updateValue(value:number,emit:boolean):void {if(this.activeThumb===0||this.end===null)this.setValue(value,emit);else {const end=Math.max(this.value,this.snap(value));if(this.end!==end){this.end=end;this.markDirty(GuiDirtyFlags.Visual|GuiDirtyFlags.Input|GuiDirtyFlags.Text);if(emit)this.onRangeChange?.(this.range!);}}}
  private commit():void {this.onCommit?.(this.value);if(this.end!==null)this.onRangeCommit?.(this.range!);}
  override handleAction(event:GuiActionEvent):void {
    super.handleAction(event);if(event.consumed||this.disabled)return;
    if(this.end!==null&&(event.action==='next'&&this.activeThumb===0||event.action==='previous'&&this.activeThumb===1)){this.setActiveThumb(this.activeThumb===0?1:0);event.consume();return;}
    const negative=this.orientation==='vertical'?'down':'left',positive=this.orientation==='vertical'?'up':'right';
    if(event.action===negative||event.action===positive){this.updateValue((this.activeThumb===1?this.end??this.value:this.value)+(event.action===negative?-1:1)*(this.step>0?this.step:(this.max-this.min)/100),true);event.consume();}
    else if(event.action==='confirm'){this.commit();event.consume();}
  }
  override handlePointerDown(event:GuiPointerEvent):void {
    if(this.disabled||event.button!==0)return;super.handlePointerDown(event);const value=this.pointerValue(event);if(this.end!==null)this.setActiveThumb(Math.abs(value-this.end)<Math.abs(value-this.value)?1:0);this.updateValue(value,true);
  }
  override handlePointerMove(event:GuiPointerEvent):void {super.handlePointerMove(event);if(this.pressed&&!this.disabled)this.updateValue(this.pointerValue(event),true);}
  override handlePointerUp(event:GuiPointerEvent):void {const pressed=this.pressed;super.handlePointerUp(event);if(pressed&&!this.disabled)this.commit();}
  private pointerValue(event:GuiPointerEvent):number {const track=sliderTrack(this),ratio=this.orientation==='vertical'?(track.height>0?1-(event.y-track.y)/track.height:0):(track.width>0?(event.x-track.x)/track.width:0);return this.min+(this.max-this.min)*ratio;}
}
function sliderTrack(slider:GuiSlider):GuiRect {const r=slider.rect,labels=slider.marks.some(m=>m.label!==undefined),vertical=slider.orientation==='vertical';return vertical?{x:r.x+(labels?Math.min(12,r.width/3):r.width/2),y:r.y+slider.thumbSize/2,width:4,height:Math.max(0,r.height-slider.thumbSize)}:{x:r.x+(slider.range?slider.thumbSize/2:0),y:r.y+(labels?Math.max(slider.thumbSize/2,(r.height-14)/2):r.height/2),width:Math.max(0,r.width-(slider.range?slider.thumbSize:0)),height:4};}
function pointFor(slider:GuiSlider,value:number):{x:number;y:number}{const r=sliderTrack(slider),ratio=slider.max>slider.min?Math.max(0,Math.min(1,(value-slider.min)/(slider.max-slider.min))):0;return slider.orientation==='vertical'?{x:r.x,y:r.y+r.height*(1-ratio)}:{x:r.x+r.width*ratio,y:r.y};}
function sliderTips(slider:GuiSlider):{rect:GuiRect;text:string}[]{
  if(slider.tooltip==='none'||slider.disabled||slider.tooltip!=='always'&&!slider.hovered&&!slider.focused&&!slider.pressed)return [];
  const values=slider.range?[...slider.range]:[slider.value],shown=slider.tooltip==='always'?values:[values[slider.activeThumb]??slider.value];
  return shown.map(value=>{const p=pointFor(slider,value);return {text:slider.formatValue(value),rect:slider.getPopupRect({width:88,height:26},{anchor:{x:p.x-4,y:p.y-4,width:8,height:8},placement:slider.orientation==='vertical'?'right':'top'})};});
}
function paintGuiSlider(context:GuiPaint.GuiControlPaintContext,slider:GuiSlider,theme:GuiPaint.GuiTheme):void {
  const skin=context.styleFor(slider),trackStyle=slider.getPartStyle('track'),fillStyle=slider.getPartStyle('indicator'),thumbStyle=slider.getPartStyle('thumb'),track=sliderTrack(slider),vertical=slider.orientation==='vertical',opacity=(skin.opacity??1)*(slider.disabled?.45:1),color=(value:string|undefined,fallback:string)=>GuiPaint.withAlpha(GuiPaint.colorToRgba(value,fallback),opacity);
  const from=pointFor(slider,slider.range?slider.value:slider.min),to=pointFor(slider,slider.range?.[1]??slider.value);
  context.addRect(track.x-(vertical?2:0),track.y-(vertical?0:2),track.width,track.height,2,color(trackStyle.backgroundColor??skin.backgroundColor,theme.colors.border));
  context.addRect(vertical?track.x-2:from.x,vertical?to.y:track.y-2,vertical?4:Math.max(0,to.x-from.x),vertical?Math.max(0,from.y-to.y):4,2,color(fillStyle.backgroundColor??fillStyle.color,theme.colors.primary));
  for(const mark of slider.marks){const p=pointFor(slider,mark.value);context.addRect(p.x-2,p.y-2,4,4,2,color(fillStyle.backgroundColor,theme.colors.primary));if(mark.label){const label=vertical?{x:p.x+12,y:p.y-7,width:Math.max(0,slider.rect.width-24),height:14}:{x:p.x-24,y:slider.rect.y+slider.rect.height-14,width:48,height:14};context.addCenteredText(mark.label,label.x,label.y,label.width,label.height,10,color(slider.getPartStyle('mark').color,theme.colors.textMuted));}}
  const values=slider.range?[...slider.range]:[slider.value];values.forEach(value=>{const p=pointFor(slider,value),size=slider.thumbSize;GuiPaint.paintGuiBox(context.currentBatch,{x:p.x-size/2,y:p.y-size/2,width:size,height:size},{...thumbStyle,borderWidth:thumbStyle.borderWidth??2,radius:size/2},color(thumbStyle.backgroundColor,theme.colors.thumb??theme.colors.text),color(thumbStyle.borderColor,theme.colors.primary),context.currentClip,size/2);});
  for(const tip of sliderTips(slider)){const style=slider.getPartStyle('tooltip');GuiPaint.paintGuiBox(context.currentPopupBatch,tip.rect,style,GuiPaint.colorToRgba(style.backgroundColor,theme.colors.elevated??theme.colors.surface),GuiPaint.colorToRgba(style.borderColor,theme.colors.border),undefined,5);const x=tip.rect.x+Math.max(4,(tip.rect.width-context.measureTextWidth(tip.text,12))/2);context.currentPopupTextBatch.addText({text:tip.text,...tip.rect,x,width:Math.max(0,tip.rect.x+tip.rect.width-x-4),fontSize:12,color:GuiPaint.colorToRgba(style.color,theme.colors.text),clip:tip.rect,verticalAlign:'center',overflow:'ellipsis'});}
}
