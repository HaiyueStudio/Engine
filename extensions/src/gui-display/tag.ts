import {GuiLabel,GuiButton} from '@haiyue/engine/gui';
import {Composite,textElement,button,choice,statusColor,show} from '../gui-common/composite.js';
import type {GuiTagOptions} from './types.js';
export class GuiTag extends Composite {
  readonly label:GuiLabel;readonly closeButton:GuiButton;
  private closed=false;
  constructor(options:GuiTagOptions){
    const status=choice(options.status??'default',['default','info','success','warning','error'],'tag status');
    super('GuiTag',{direction:'row',alignItems:'center',columnGap:6,padding:{left:8,right:8,top:3,bottom:3},height:28,shrink:0},options,theme=>({radius:5,borderWidth:1,backgroundColor:theme.colors.surface,borderColor:statusColor(theme,status),parts:{label:{color:statusColor(theme,status),fontSize:12,icon:options.icon??null},close:{padding:0,paddingY:0,color:theme.colors.textMuted}}}),options.focusManager);
    this.label=this.part('label',textElement(options.text));this.closeButton=this.part('close',button('×',this.action(()=>{if(options.onClose?.()===false||this.dead)return;this.closed=true;this.blurWithin(this.element);show(this.element,false);}),{width:20,height:20},{themeControlType:'GuiTagClose'}));show(this.closeButton,options.closable??false);
    this.finish();
  }
  setText(value:string):void{this.alive();this.label.setText(value);}
  get isClosed():boolean{return this.closed;}
}
