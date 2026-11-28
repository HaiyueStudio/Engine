import {Composite,textElement,choice} from '../gui-common/composite.js';
import type {GuiRibbonOptions} from './types.js';
export class GuiRibbon extends Composite {
  constructor(options:GuiRibbonOptions){
    const placement=choice(options.placement??'end',['start','end'],'ribbon placement');super('GuiRibbon',{direction:'column',width:320},options,undefined,options.focusManager);
    try{this.mount([{name:'content',node:options.content,parent:this.element}]);}catch(error){this.dispose();throw error;}
    const ribbon=this.part('ribbon',textElement(options.text,{position:'absolute',inset:{top:12,[placement==='end'?'right':'left']:-4},height:28,minWidth:64},{style:{padding:10}}));ribbon.setDefaultSkin(theme=>({backgroundColor:options.color??theme.colors.primary,color:theme.colors.onPrimary??'#fff',radius:3,fontSize:12,fontWeight:600}));this.finish();
  }
}
