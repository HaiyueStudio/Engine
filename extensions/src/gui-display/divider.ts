import {Composite,surface,textElement,choice,number} from '../gui-common/composite.js';
import type {GuiDividerOptions} from './types.js';
export class GuiDivider extends Composite {
  constructor(options:GuiDividerOptions={}){
    const orientation=choice(options.orientation??'horizontal',['horizontal','vertical'],'divider orientation'),align=choice(options.textAlign??'center',['start','center','end'],'divider text alignment'),thickness=number(options.lineWidth??1,'divider width',0.25,32);
    super('GuiDivider',{direction:'row',alignItems:'center',columnGap:12,width:orientation==='vertical'?thickness:'auto',height:orientation==='vertical'?32:28},options,theme=>({parts:{line:{backgroundColor:theme.colors.border},label:{color:theme.colors.textMuted,fontSize:12}}}));
    const line=(grow:number)=>surface('GuiDividerLine',{width:orientation==='vertical'?thickness:'auto',height:orientation==='vertical'?{percent:100}:thickness,grow,shrink:0});
    this.part('line',line(align==='start'?0.1:1));if(orientation==='horizontal'&&options.text){this.part('label',textElement(options.text));this.part('line',line(align==='end'?0.1:1));}
    this.finish();
  }
}
