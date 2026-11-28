import {GuiImage} from '@haiyue/engine/gui';
import {Composite,textElement,surface} from '../gui-common/composite.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import type {GuiEmptyOptions} from './types.js';
export class GuiEmpty extends Composite {
  constructor(options:GuiEmptyOptions={}){
    super('GuiEmpty',{direction:'column',alignItems:'center',justifyContent:'center',rowGap:12,width:260,minHeight:150,padding:{top:20,bottom:20}},options,theme=>({parts:{image:{color:theme.colors.border,fontSize:42},description:{color:theme.colors.textMuted,fontSize:13}}}),options.focusManager);
    if(options.image){const image=this.part('image',new GuiImage({source:options.image,fit:'contain'}));setContainerStyle(image,{width:72,height:64});}else this.part('image',textElement('◇',{height:52}));
    this.part('description',textElement(options.description??'No data'));const action=this.part('action',surface('GuiEmptyAction',{direction:'row'}));
    try{this.mount([{name:'actionContent',node:options.action,parent:action}]);}catch(error){this.dispose();throw error;}
    this.finish();
  }
}
