import {GuiModal,GuiElement} from '@haiyue/engine/gui';
import type {GuiRect,GuiButton} from '@haiyue/engine/gui';
import {GuiMenu} from '../gui-overlays/menu.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import {GuiCleanup} from '../gui-layout/panel-cleanup.js';
import type {GuiBreadcrumbMenuItem} from './types.js';
/** Compatibility adapter: rows/actions are the same menu implementation; the old modal identity stays. */
export class BreadcrumbPopup extends GuiModal {
  private anchor:GuiElement|null;
  private readonly menu:GuiMenu;
  private readonly popupHeight:number;
  private dead=false;
  constructor(anchor:GuiElement,items:readonly GuiBreadcrumbMenuItem[],choose:(key:string)=>void,closed:()=>void){
    super({visible:true,width:240,height:Math.max(48,items.length*34+16),showCloseButton:false,showConfirmButton:false,showCancelButton:false,closeOnBackdrop:true,backdropColor:'transparent',onClose:closed,themeControlType:'GuiBreadcrumbMenu'});
    this.anchor=anchor;this.popupHeight=Math.max(48,items.length*34+16);this.titleLabel.setVisible(false);this.messageLabel.setVisible(false);
    this.menu=new GuiMenu({items,onSelect:key=>{if(!this.dead)choose(key);}});
    setContainerStyle(this.menu.element,{width:'auto',height:'auto',padding:{left:8,right:8,top:8,bottom:8}});
    this.add(this.menu.element);
  }
  get firstButton():GuiButton|null {return this.menu.buttons.find(button=>!button.disabled)??null;}
  override getDialogRect(viewport:GuiRect,rectFor:(element:GuiElement)=>GuiRect=element=>element.rect):GuiRect {
    if(!this.anchor)return{x:viewport.x,y:viewport.y,width:0,height:0};
    return this.anchor.getPopupRect({width:240,height:this.popupHeight},{viewport,anchor:rectFor(this.anchor),placement:'bottom',align:'start',gap:4});
  }
  override layout(viewport:GuiRect):void {super.layout(viewport);if(!this.dead)this.menu.element.layout(this.dialogRect);}
  release():void {
    if(this.dead)return;this.dead=true;this.setHandlers({onClose:null});this.anchor=null;const cleanup=new GuiCleanup();
    cleanup.run(()=>this.hide());cleanup.run(()=>this.parent?.remove(this));cleanup.run(()=>this.menu.dispose());cleanup.complete('Breadcrumb popup cleanup failed.');
  }
}
