import {GuiScrollView} from '@haiyue/engine/gui';
import {Composite,surface,textElement,button,show,choice} from '../gui-common/composite.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import {OverlayController,validateOverlayTrigger} from './overlay.js';
import type {GuiDialogOptions,GuiDrawerOptions,GuiPopconfirmOptions,GuiOverlayCloseReason} from './types.js';
class DialogBody extends Composite {
  constructor(options:GuiDialogOptions,request:(reason:GuiOverlayCloseReason)=>void){
    super('GuiDialogContent',{direction:'column',width:{percent:100},height:{percent:100},minHeight:0,rowGap:12},{},theme=>({parts:{title:{fontSize:18,fontWeight:600,color:theme.colors.text},close:{padding:2,paddingY:2},body:{color:theme.colors.text},footer:{}}}),options.focusManager);
    const header=this.part('header',surface('GuiDialogHeader',{direction:'row',columnGap:8,alignItems:'center',height:'auto',shrink:0}));
    const title=this.part('title',textElement(options.title??'',{grow:1,shrink:1}),header);show(title,!options.header);
    this.part('close',button('×',this.action(()=>request('close')),{width:28,height:28}),header);
    const body=this.part('body',new GuiScrollView({contentHeight:0,showScrollbar:true}));setContainerStyle(body,{direction:'column',width:'auto',height:'auto',grow:1,basis:0,minHeight:0});
    const footer=this.part('footer',surface('GuiDialogFooter',{direction:'row',justifyContent:'end',columnGap:8,height:36,shrink:0}));
    const cancel=this.part('cancel',button(options.cancelText??'Cancel',this.action(()=>request('cancel')),{width:96,height:34}),footer),confirm=this.part('confirm',button(options.confirmText??'Confirm',this.action(()=>request('confirm')),{width:96,height:34}),footer);confirm.variant='primary';show(cancel,!options.footer);show(confirm,!options.footer);
    try{this.mount([{name:'headerContent',node:options.header,parent:header,layout:{grow:1,minWidth:0}},{name:'bodyContent',node:options.content,parent:body},{name:'footerContent',node:options.footer,parent:footer}]);}catch(error){this.dispose();throw error;}
  }
}
function requestHandler(overlay:OverlayController,options:Pick<GuiDialogOptions,'onConfirm'|'onCancel'>,reason:GuiOverlayCloseReason):void {
  if(reason==='confirm'&&options.onConfirm?.()===false||reason==='cancel'&&options.onCancel?.()===false)return;overlay.close(reason);
}
export class GuiDialog extends OverlayController {
  constructor(options:GuiDialogOptions){let request:(reason:GuiOverlayCloseReason)=>void=()=>{};const body=new DialogBody(options,reason=>request(reason));try{super({...options,width:options.width??440,height:options.height??300,closeOnOutside:options.closeOnOutside??false},body.element,{kind:'dialog'});}catch(error){body.dispose();throw error;}request=reason=>requestHandler(this,options,reason);this.releaseWith(()=>body.dispose());}
}
export class GuiDrawer extends OverlayController {
  constructor(options:GuiDrawerOptions){const side=choice(options.side??'right',['left','right','top','bottom'],'drawer side');let request:(reason:GuiOverlayCloseReason)=>void=()=>{};const body=new DialogBody(options,reason=>request(reason));try{super({...options,width:options.width??360,height:options.height??280},body.element,{kind:'drawer',side});}catch(error){body.dispose();throw error;}request=reason=>requestHandler(this,options,reason);this.releaseWith(()=>body.dispose());}
}
export class GuiPopconfirm extends OverlayController {
  constructor(options:GuiPopconfirmOptions){
    validateOverlayTrigger(options,'click');
    let request:(reason:GuiOverlayCloseReason)=>void=()=>{};const description=textElement(options.description??'',{height:'auto',width:'auto'}),body=new DialogBody({...options,content:description},reason=>request(reason));
    try{super({...options,width:options.width??300,height:options.height??190},body.element);}catch(error){body.dispose();throw error;}
    request=reason=>requestHandler(this,options,reason);this.releaseWith(()=>body.dispose());this.bindTrigger('click');
  }
}
