import {GuiElement} from '@haiyue/engine/gui';
import {Composite,surface,textElement,show,flag} from '../gui-common/composite.js';
import {GuiSkeleton} from './skeleton.js';
import type {GuiCardOptions} from './types.js';
export class GuiCard extends Composite {
  readonly header:GuiElement;readonly body:GuiElement;readonly footer:GuiElement;
  private readonly skeleton:GuiSkeleton;
  private loading=false;
  constructor(options:GuiCardOptions={}){
    const loading=flag(options.loading,'card loading');flag(options.bordered,'card border',true);flag(options.hoverable,'card hover');
    super('GuiCard',{direction:'column',width:320,height:'auto',shrink:0},options,(theme,state)=>({backgroundColor:theme.colors.elevated??theme.colors.surface,borderColor:state.hover&&options.hoverable?theme.colors.primary:theme.colors.border,borderWidth:options.bordered===false?0:1,radius:10,...(state.hover&&options.hoverable?{shadow:{color:theme.colors.shadow??'#0003',blur:14,y:5}}:{}),parts:{title:{fontWeight:600,fontSize:16},body:{color:theme.colors.text},footer:{color:theme.colors.textMuted}}}),options.focusManager);
    this.header=this.part('header',surface('GuiCardHeader',{direction:'row',alignItems:'center',padding:{left:16,right:16,top:12,bottom:12},columnGap:8}));
    this.part('title',textElement(options.title??'',{grow:1,shrink:1}),this.header);show(this.header,!!options.title||!!options.extra);
    const cover=this.part('cover',surface('GuiCardCover',{width:{percent:100},height:'auto'}));show(cover,!!options.cover);
    this.body=this.part('body',surface('GuiCardBody',{direction:'column',padding:{left:16,right:16,top:16,bottom:16},minHeight:56}));
    this.skeleton=new GuiSkeleton({rows:3});this.releases.push(()=>this.skeleton.dispose());this.element.add(this.skeleton.element);
    this.footer=this.part('footer',surface('GuiCardFooter',{direction:'row',columnGap:8,padding:{left:16,right:16,top:12,bottom:12}}));show(this.footer,!!options.footer);
    try{this.mount([{name:'extra',node:options.extra,parent:this.header},{name:'coverContent',node:options.cover,parent:cover},{name:'content',node:options.content,parent:this.body},{name:'footerContent',node:options.footer,parent:this.footer}]);}catch(error){this.dispose();throw error;}
    this.setLoading(loading);this.finish();
  }
  setLoading(value:boolean):void {this.alive();if(typeof value!=='boolean')throw new TypeError('Invalid card loading state.');if(value)this.blurWithin(this.body);this.loading=value;show(this.body,!value);this.skeleton.setLoading(value);}
  get isLoading():boolean{return this.loading;}
}
