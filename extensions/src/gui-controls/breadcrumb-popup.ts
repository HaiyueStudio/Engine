import{GuiModal,GuiScrollView,GuiButton,GuiElement}from'@haiyue/engine/gui';
import type{GuiRect}from'@haiyue/engine/gui';
import{headerStyle}from'../gui-layout/panel-content.js';
import{onClick}from'./common.js';
import type{GuiBreadcrumbMenuItem}from'./types.js';
/** Original modal identity, focus trap, scrollbar and button painters; no new input owner. */
export class BreadcrumbPopup extends GuiModal{
 private anchor:GuiElement|null;
 private readonly list:GuiScrollView;
 private readonly releases:(()=>void)[]=[];
 private dead=false;
 constructor(anchor:GuiElement,items:readonly GuiBreadcrumbMenuItem[],choose:(key:string)=>void,closed:()=>void){
  super({visible:true,width:240,height:Math.max(32,items.length*32),showCloseButton:false,showConfirmButton:false,showCancelButton:false,closeOnBackdrop:true,backdropColor:'transparent',onClose:closed,themeControlType:'GuiBreadcrumbMenu'});
  this.anchor=anchor;this.titleLabel.setVisible(false);this.messageLabel.setVisible(false);
  this.list=this.add(new GuiScrollView({width:'100%',height:'100%',contentHeight:items.length*32,showScrollbar:true}));
  for(let i=0;i<items.length;i++){const item=items[i]!,button=this.list.add(new GuiButton({x:0,y:i*32,width:'100%',height:32,text:item.label,disabled:!!item.disabled,style:headerStyle(item),themeControlType:'GuiBreadcrumbMenuItem'}));this.releases.push(onClick(button,()=>{if(!this.dead&&!item.disabled)choose(item.key);}));}
 }
 override layout(viewport:GuiRect):void{
  super.layout(viewport);if(this.dead||!this.anchor)return;
  const width=Math.min(240,Math.max(0,viewport.width)),height=Math.min(this.list.contentHeight,Math.max(0,viewport.height));
  const x=Math.max(viewport.x,Math.min(this.anchor.rect.x,viewport.x+viewport.width-width));
  const below=this.anchor.rect.y+this.anchor.rect.height,y=below+height<=viewport.y+viewport.height?below:Math.max(viewport.y,this.anchor.rect.y-height);
  Object.assign(this.dialogRect,{x,y,width,height});this.list.layout(this.dialogRect);
 }
 release():void{if(this.dead)return;this.dead=true;this.setHandlers({onClose:null});this.hide();this.parent?.remove(this);for(const off of this.releases)off();this.releases.length=0;this.anchor=null;this.list.removeAllListeners();for(const child of [...this.list.children]){child.setDisabled(true);this.list.remove(child);}}
}
