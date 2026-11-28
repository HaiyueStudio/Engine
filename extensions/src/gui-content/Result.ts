import {GuiImage} from '@haiyue/engine/gui';
import {Composite,textElement,statusColor} from '../gui-common/composite.js';
import type {GuiResultOptions} from './types.js';
export class GuiResult extends Composite {
  constructor(options:GuiResultOptions){
    super('GuiResult',{direction:'column',alignItems:'center',rowGap:12,padding:{left:24,right:24,top:24,bottom:24},width:400},options,theme=>({backgroundColor:theme.colors.surface,radius:12}),options.focusManager);
    const icon=options.icon?new GuiImage({source:options.icon,fit:'contain',width:56,height:56}):textElement(options.status==='success'?'✓':options.status==='error'?'×':options.status==='warning'?'!':'i',{width:56,height:56},{style:{fontSize:36}});icon.setDefaultSkin(theme=>({color:statusColor(theme,options.status??'info')}));this.part('icon',icon);const title=this.part('title',textElement(options.title,{height:30}));title.setDefaultSkin(theme=>({color:theme.colors.text,fontSize:22,fontWeight:600}));const description=this.part('description',textElement(options.description??'',{height:28}));description.setDefaultSkin(theme=>({color:theme.colors.textMuted}));try{this.mount([{name:'actions',node:options.actions,parent:this.element}]);}catch(error){this.dispose();throw error;}this.finish();
  }
}
