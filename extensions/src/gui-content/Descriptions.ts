import {Composite,surface,textElement,number,choice,fail} from '../gui-common/composite.js';
import type {GuiDescriptionsOptions} from './types.js';
export class GuiDescriptions extends Composite {
  constructor(options:GuiDescriptionsOptions){
    const columns=number(options.columns??2,'description columns',1,12),rowHeight=number(options.rowHeight??(options.direction==='vertical'?76:44),'description row height',24,2048);if(!Number.isInteger(columns))fail('Description columns must be an integer.');
    super('GuiDescriptions',{display:'grid',columns:Array.from({length:columns},()=>({fr:1})),rows:Array.from({length:Math.max(1,Math.ceil(options.items.length/columns))},()=>rowHeight),rowGap:1,columnGap:1,width:480},options,theme=>({backgroundColor:theme.colors.border,borderColor:theme.colors.border,borderWidth:1,radius:8,clipRadius:8}),options.focusManager);
    const direction=choice(options.direction??'horizontal',['horizontal','vertical'],'description direction'),keys=new Set<string>();if(options.items.length>1000)fail('Description item limit exceeded.');
    try{for(const item of options.items){if(!item.key||keys.has(item.key))fail('Descriptions require unique keys.');keys.add(item.key);const cell=this.part('item',surface('GuiDescriptionItem',{direction:direction==='horizontal'?'row':'column',columnGap:12,rowGap:6,padding:{left:12,right:12,top:10,bottom:10},minWidth:0}));cell.setDefaultSkin(theme=>({backgroundColor:theme.colors.surface}));const label=this.part('label',textElement(item.label,{width:direction==='horizontal'?110:'auto',height:24}),cell);label.setDefaultSkin(theme=>({color:theme.colors.textMuted,fontSize:12}));if(item.content)this.mount([{name:'value',node:item.content,parent:cell,layout:{grow:1,minWidth:0}}]);else this.part('value',textElement(item.value||options.emptyText||'—',{grow:1,minWidth:0,height:24}),cell);}}catch(error){this.dispose();throw error;}this.finish();
  }
}
