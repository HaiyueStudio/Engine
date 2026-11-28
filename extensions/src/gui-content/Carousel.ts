import {Composite,surface,button,show,number,fail} from '../gui-common/composite.js';
import type {GuiCarouselOptions} from './types.js';
import {hoveredWithin} from '../gui-common/hover.js';
export class GuiCarousel extends Composite {
  readonly indicators:readonly import('@haiyue/engine/gui').GuiButton[];private current:number;private elapsed=0;private drag:{id:number;x:number}|null=null;
  constructor(private readonly options:GuiCarouselOptions){
    super('GuiCarousel',{direction:'column',rowGap:8,width:320},options,theme=>({backgroundColor:theme.colors.surface,radius:8,clipRadius:8}),options.focusManager);
    if(!options.slides.length||options.slides.length>100)fail('Carousel requires 1–100 borrowed slides.');this.current=number(options.index??0,'slide index',0,options.slides.length-1);if(!Number.isInteger(this.current))fail('Slide index must be an integer.');const interval=number(options.autoplayMs??0,'autoplay interval',0,3600000);if(interval>0&&interval<250)fail('Autoplay interval must be at least 250 ms.');
    const stage=this.part('stage',surface('GuiCarouselStage',{direction:'column',width:{percent:100},height:180},{pointerFilter:'pass',onPointerDown:event=>{if(!this.dead&&!this.drag&&event.button===0)this.drag={id:event.pointerId,x:event.x};},onPointerUp:event=>{if(this.drag?.id!==event.pointerId)return;const delta=event.x-this.drag.x;this.drag=null;if(Math.abs(delta)>=40)this.setIndex((this.current+(delta<0?1:-1)+options.slides.length)%options.slides.length,true);},onPointerCancel:event=>{if(this.drag?.id===event.pointerId)this.drag=null;}}));
    const initial=options.slides.map(slide=>slide.visible);try{this.mount(options.slides.map((node,index)=>({name:'slide'+index,node,parent:stage,layout:{position:'absolute',inset:{left:0,right:0,top:0,bottom:0},width:'auto',height:'auto'}})));}catch(error){this.dispose();throw error;}
    this.releases.push(()=>{this.drag=null;options.slides.forEach((slide,index)=>show(slide,initial[index]!));});
    const navigation=this.part('navigation',surface('GuiCarouselNavigation',{direction:'row',columnGap:6,justifyContent:'center',height:28}));this.indicators=Object.freeze(options.slides.map((_,index)=>{const node=this.part('indicator',button('•',this.action(()=>this.setIndex(index,true)),{width:24,height:24}),navigation);node.setDefaultSkin((theme,state)=>({padding:0,paddingY:0,borderWidth:0,radius:12,backgroundColor:'transparent',color:state.selected?theme.colors.primary:theme.colors.textMuted,fontSize:16}));return node;}));this.sync();
    if(interval)this.releases.push(this.element.setActivity(delta=>{if(this.drag||hoveredWithin(this.element))return;this.elapsed+=delta;if(this.elapsed>=interval){this.elapsed%=interval;this.setIndex((this.current+1)%options.slides.length,true);}}));this.finish();
  }
  get index():number{return this.current;}
  setIndex(index:number,emit=false):void {this.alive();number(index,'slide index',0,this.options.slides.length-1);if(!Number.isInteger(index))fail('Slide index must be an integer.');const previous=this.current;if(previous!==index)this.blurWithin(this.options.slides[previous]!);this.current=index;this.elapsed=0;this.sync();if(previous!==index&&emit)this.options.onChange?.(index);}
  private sync():void {this.options.slides.forEach((slide,index)=>show(slide,index===this.current));this.indicators.forEach((node,index)=>{node.setVisualState({selected:index===this.current});node.setText(index===this.current?'●':'○');});this.focus?.reconcile();}
}
