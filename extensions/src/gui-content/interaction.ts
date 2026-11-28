import type {GuiElement,GuiPointerEvent} from '@haiyue/engine/gui';
import {GuiDirtyFlags} from '@haiyue/engine/gui';
import {Composite,button,number} from '../gui-common/composite.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import type {GuiDraggableOptions,GuiResizableOptions} from './types.js';
/** Drag data, preview, capture, cancel and gamepad handoff stay in the original Engine drag controller. */
export class GuiDraggable extends Composite {
  readonly handle:import('@haiyue/engine/gui').GuiButton;
  constructor(options:GuiDraggableOptions){super('GuiDraggable',{direction:'column',rowGap:4,width:240},options,undefined,options.focusManager);this.handle=this.part('handle',button(options.handleLabel??'⠿ Drag',()=>{},{height:28}));this.handle.setDefaultSkin(theme=>({cursor:'grab',backgroundColor:theme.colors.hover,borderWidth:0,radius:4}));this.handle.setDragSource({getData:options.data,touchGesture:'drag',...(options.createPreview?{createPreview:options.createPreview}:{}),...(options.disposePreview?{disposePreview:options.disposePreview}:{}),...(options.onEnd?{onEnd:options.onEnd}:{})});this.releases.push(()=>this.handle.setDragSource(null));try{this.mount([{name:'content',node:options.content,parent:this.element}]);}catch(error){this.dispose();throw error;}this.finish();}
}
export class GuiResizable extends Composite {
  readonly handle:import('@haiyue/engine/gui').GuiButton;private w:number;private h:number;private readonly minW:number;private readonly minH:number;private readonly maxW:number;private readonly maxH:number;private drag:{id:number;x:number;y:number;width:number;height:number}|null=null;
  constructor(private readonly options:GuiResizableOptions){
    super('GuiResizable',{direction:'column',width:options.initialWidth,height:options.initialHeight,minWidth:0,minHeight:0},options,theme=>({borderColor:theme.colors.border,borderWidth:1,radius:8}),options.focusManager);
    this.minW=number(options.minWidth??80,'minimum width',1,8192);this.minH=number(options.minHeight??60,'minimum height',1,8192);this.maxW=number(options.maxWidth??4096,'maximum width',this.minW,8192);this.maxH=number(options.maxHeight??4096,'maximum height',this.minH,8192);this.w=number(options.initialWidth,'initial width',this.minW,this.maxW);this.h=number(options.initialHeight,'initial height',this.minH,this.maxH);
    try{this.mount([{name:'content',node:options.content,parent:this.element,layout:{grow:1,minWidth:0,minHeight:0}}]);}catch(error){this.dispose();throw error;}
    this.handle=this.part('handle',button('◢',()=>{},{position:'absolute',inset:{right:0,bottom:0},width:20,height:20},{onPointerDown:event=>{if(!this.dead&&!this.drag&&event.button===0){this.drag={id:event.pointerId,x:event.x,y:event.y,width:this.w,height:this.h};event.preventDefault();}},onPointerMove:event=>this.move(event),onPointerUp:event=>{if(this.drag?.id===event.pointerId){this.move(event);this.drag=null;}},onPointerCancel:event=>{if(this.drag?.id===event.pointerId){const original=this.drag;this.drag=null;this.setSize(original.width,original.height,true);}},onAction:event=>{if(!this.dead&&['left','right','up','down'].includes(event.action)){this.setSize(this.w+(event.action==='right'?8:event.action==='left'?-8:0),this.h+(event.action==='down'?8:event.action==='up'?-8:0),true);event.consume();}}}));this.handle.setDefaultSkin(theme=>({cursor:'nwse-resize',backgroundColor:'transparent',color:theme.colors.textMuted,borderWidth:0,padding:0}));this.finish();
  }
  get size():Readonly<{width:number;height:number}>{return Object.freeze({width:this.w,height:this.h});}
  setSize(width:number,height:number,emit=false):void {this.alive();number(width,'resize width',-1e6,1e6);number(height,'resize height',-1e6,1e6);const w=Math.max(this.minW,Math.min(this.maxW,width)),h=Math.max(this.minH,Math.min(this.maxH,height));if(w===this.w&&h===this.h)return;this.w=w;this.h=h;setContainerStyle(this.element,{direction:'column',width:w,height:h,minWidth:0,minHeight:0});this.element.markDirty(GuiDirtyFlags.Layout|GuiDirtyFlags.Visual);if(emit)this.options.onResize?.(this.size);}
  private move(event:GuiPointerEvent):void {if(!this.dead&&this.drag?.id===event.pointerId){this.setSize(this.drag.width+event.x-this.drag.x,this.drag.height+event.y-this.drag.y,true);event.preventDefault();}}
  override dispose():void {this.drag=null;super.dispose();}
}
