import {Composite,button,surface,fail} from '../gui-common/composite.js';
import type {GuiButton} from '@haiyue/engine/gui';
import type {GuiVirtualKeyboardOptions,GuiVirtualKey} from './types.js';
const defaultRows:readonly (readonly GuiVirtualKey[])[]=[
 ...['1234567890','qwertyuiop','asdfghjkl','zxcvbnm'].map(row=>Array.from(row,letter=>({key:letter,label:letter,text:letter}))),
 [{key:'space',label:'Space',action:'space'},{key:'backspace',label:'⌫',action:'backspace'},{key:'left',label:'←',action:'left'},{key:'right',label:'→',action:'right'},{key:'enter',label:'Enter',action:'enter'}]
];
export class GuiVirtualKeyboard extends Composite {
 readonly buttons:readonly GuiButton[];private readonly keys=new Map<string,GuiVirtualKey>();
 constructor(private readonly options:GuiVirtualKeyboardOptions){
  super('GuiVirtualKeyboard',{direction:'column',rowGap:4,width:420},options,undefined,options.focusManager);const rows=options.rows??defaultRows;if(!Array.isArray(rows)||rows.length<1||rows.length>8||rows.some(row=>!Array.isArray(row)||!row.length||row.length>20))fail('Invalid virtual keyboard rows.');
  for(const key of rows.flat()){if(!key.key||this.keys.has(key.key)||typeof key.label!=='string'||(key.text===undefined)===(key.action===undefined)||key.text!==undefined&&typeof key.text!=='string'||key.action!==undefined&&!['backspace','delete','left','right','enter','space'].includes(key.action))fail('Virtual keys need distinct keys and exactly one text/action.');this.keys.set(key.key,{...key});}
  const buttons:GuiButton[]=[];for(const row of rows){const panel=this.part('row',surface('GuiKeyboardRow',{direction:'row',columnGap:4,height:36}));for(const key of row)buttons.push(this.part('key',button(key.label,this.action(()=>{this.press(key.key);}),{grow:key.action==='space'?3:1,basis:0,height:36},{style:{padding:0}}),panel));}this.buttons=Object.freeze(buttons);this.finish();
 }
 press(key:string):boolean {
  this.alive();const binding=this.keys.get(key);if(!binding)fail('Unknown virtual key.');const target=this.options.target();if(!target||target.disabled||target.readOnly||target.isComposing)return false;
  if(binding.text!==undefined)target.insertText(binding.text);else switch(binding.action){case'backspace':target.deleteBackward();break;case'delete':target.deleteForward();break;case'left':target.moveCaret(-1);break;case'right':target.moveCaret(1);break;case'space':target.insertText(' ');break;case'enter':if(target.multiline)target.insertText('\n');else target.submit();break;}
  if(!this.dead)this.options.focusManager?.focus(target);return true;
 }
}
