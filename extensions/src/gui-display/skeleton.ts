import {GuiElement} from '@haiyue/engine/gui';
import {Composite,surface,number,show,flag} from '../gui-common/composite.js';
import type {GuiSkeletonOptions} from './types.js';
export class GuiSkeleton extends Composite {
  private readonly placeholders:GuiElement;
  private readonly content:GuiElement;
  private readonly blocks:GuiElement[]=[];
  private loading=false;
  private stop:()=>void=()=>{};
  constructor(private readonly options:GuiSkeletonOptions={}){
    const rows=number(options.rows??3,'skeleton rows',1,20);if(!Number.isInteger(rows))throw new TypeError('Skeleton rows must be integral.');
    const loading=flag(options.loading,'skeleton loading',true);flag(options.animated,'skeleton animation',true);
    super('GuiSkeleton',{direction:'column',width:280,padding:{left:16,right:16,top:16,bottom:16}},options,theme=>({parts:{block:{backgroundColor:theme.colors.hover,radius:4},avatar:{backgroundColor:theme.colors.hover,radius:20}}}),options.focusManager);
    this.placeholders=this.part('placeholders',surface('GuiSkeletonPlaceholders',{direction:'column',rowGap:12,width:{percent:100}}));
    if(options.avatar)this.blocks.push(this.part('avatar',surface('GuiSkeletonAvatar',{width:40,height:40}),this.placeholders));
    if(options.title!==false)this.blocks.push(this.part('block',surface('GuiSkeletonTitle',{width:{percent:45},height:18}),this.placeholders));
    for(let i=0;i<rows;i++)this.blocks.push(this.part('block',surface('GuiSkeletonLine',{width:{percent:i===rows-1?65:100},height:12}),this.placeholders));
    this.content=this.part('content',surface('GuiSkeletonContent',{direction:'column',width:{percent:100}}));
    try{this.mount([{name:'contentBody',node:options.content,parent:this.content}]);}catch(error){this.dispose();throw error;}
    this.releases.push(()=>this.stop());this.setLoading(loading);this.finish();
  }
  setLoading(value:boolean):void {
    this.alive();if(typeof value!=='boolean')throw new TypeError('Invalid skeleton loading state.');if(value)this.blurWithin(this.content);this.loading=value;show(this.element,value||!!this.options.content);show(this.placeholders,value);show(this.content,!value&&!!this.options.content);this.stop();this.stop=()=>{};
    if(value&&this.options.animated!==false){let phase=0;this.stop=this.element.setActivity(delta=>{phase=(phase+delta/1200)%1;const opacity=.55+.45*(.5-.5*Math.cos(phase*Math.PI*2));for(const node of this.blocks)node.setStyle({opacity});});}
  }
  get isLoading():boolean{return this.loading;}
}
