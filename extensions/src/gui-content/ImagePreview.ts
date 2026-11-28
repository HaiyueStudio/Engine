import type {GuiElement} from '@haiyue/engine/gui';
import {GuiDirtyFlags} from '@haiyue/engine/gui';
import {Composite,surface,button,number,fail} from '../gui-common/composite.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import {GuiImageView} from '../gui-display/image.js';
import {GuiDialog} from '../gui-overlays/dialog.js';
import type {GuiImagePreviewOptions} from './types.js';
export class GuiImagePreview {
  readonly dialog:GuiDialog;readonly image:GuiImageView;readonly viewport:GuiElement;private readonly body:PreviewBody;private rootOff:()=>void=()=>{};private current:number;private zoom=1;private x=0;private y=0;private dead=false;private drag:{id:number;x:number;y:number;startX:number;startY:number}|null=null;
  constructor(private readonly options:GuiImagePreviewOptions){
    if(!options.images.length||options.images.length>1000)fail('Image preview requires 1–1000 borrowed sources.');this.current=number(options.index??0,'image index',0,options.images.length-1);if(!Number.isInteger(this.current))fail('Image index must be an integer.');
    this.body=new PreviewBody(options);this.viewport=this.body.viewport;this.image=this.body.image;
    this.viewport.on('pointerdown',event=>{const e=event.detail;if(e.button===0)this.drag={id:e.pointerId,x:e.x,y:e.y,startX:this.x,startY:this.y};});this.viewport.on('pointermove',event=>{const e=event.detail;if(this.drag?.id===e.pointerId){this.x=this.drag.startX+e.x-this.drag.x;this.y=this.drag.startY+e.y-this.drag.y;this.sync();}});this.viewport.on('pointerup',()=>{this.drag=null;});this.viewport.on('pointercancel',()=>{this.drag=null;});
    this.body.previous.on('click',()=>this.setIndex((this.current-1+options.images.length)%options.images.length));this.body.next.on('click',()=>this.setIndex((this.current+1)%options.images.length));this.body.zoomIn.on('click',()=>this.setZoom(Math.min(8,this.zoom*1.25)));this.body.zoomOut.on('click',()=>this.setZoom(Math.max(1,this.zoom/1.25)));
    try{this.dialog=new GuiDialog({root:options.root,focusManager:options.focusManager,title:'Image preview',content:this.body.element,width:600,height:420});}catch(error){this.body.dispose();throw error;}try{this.image.setSource(options.images[this.current]!);this.sync();this.rootOff=options.root.onDispose(()=>this.dispose());}catch(error){this.dispose();throw error;}
  }
  private alive():void {if(this.dead)fail('Image preview is disposed.');}
  get index():number{return this.current;}get scale():number{return this.zoom;}
  open():boolean {this.alive();return this.dialog.open();}close():void {this.dialog.close();}
  setZoom(value:number):void {this.alive();this.zoom=number(value,'image zoom',1,8);this.sync();}
  setIndex(index:number):void {this.alive();number(index,'image index',0,this.options.images.length-1);if(!Number.isInteger(index))fail('Image index must be an integer.');const changed=index!==this.current;this.current=index;this.zoom=1;this.x=0;this.y=0;this.image.setSource(this.options.images[index]!);this.sync();if(changed)this.options.onChange?.(index);}
  private sync():void {const width=this.viewport.rect.width||520,height=this.viewport.rect.height||240,maxX=width*(this.zoom-1)/2,maxY=height*(this.zoom-1)/2;this.x=Math.max(-maxX,Math.min(maxX,this.x));this.y=Math.max(-maxY,Math.min(maxY,this.y));setContainerStyle(this.image.element,{position:'absolute',width:{percent:100*this.zoom},height:{percent:100*this.zoom},inset:{left:-maxX+this.x,top:-maxY+this.y}});this.body.title.setText(`${this.current+1} / ${this.options.images.length} · ${Math.round(this.zoom*100)}%`);this.body.invalidate();}
  dispose():void {if(this.dead)return;this.dead=true;this.drag=null;this.rootOff();try{this.dialog.dispose();}finally{this.body.dispose();}}
}
class PreviewBody extends Composite {
  readonly image:GuiImageView;readonly viewport:GuiElement;readonly previous:import('@haiyue/engine/gui').GuiButton;readonly next:import('@haiyue/engine/gui').GuiButton;readonly zoomIn:import('@haiyue/engine/gui').GuiButton;readonly zoomOut:import('@haiyue/engine/gui').GuiButton;readonly title:import('@haiyue/engine/gui').GuiButton;
  constructor(options:GuiImagePreviewOptions){super('GuiImagePreviewContent',{direction:'column',rowGap:8,width:{percent:100}},options,undefined,options.focusManager);this.viewport=this.part('viewport',surface('GuiImagePreviewViewport',{direction:'column',height:240,width:{percent:100}},{pointerFilter:'stop'},theme=>({backgroundColor:theme.colors.hover,clipRadius:8,radius:8})));this.image=new GuiImageView({fit:'contain',placeholder:'Image preview'});this.viewport.add(this.image.element);this.releases.push(()=>this.image.dispose());const toolbar=this.part('toolbar',surface('GuiImagePreviewToolbar',{direction:'row',height:32,columnGap:6}));this.previous=this.part('previous',button('‹',()=>{},{width:32}),toolbar);this.zoomOut=this.part('zoomOut',button('−',()=>{},{width:32}),toolbar);this.title=this.part('counter',button('',()=>{},{grow:1},{disabled:true}),toolbar);this.zoomIn=this.part('zoomIn',button('+',()=>{},{width:32}),toolbar);this.next=this.part('next',button('›',()=>{},{width:32}),toolbar);this.finish();}
  invalidate():void {this.element.markDirty(GuiDirtyFlags.Layout|GuiDirtyFlags.Visual);}
}
