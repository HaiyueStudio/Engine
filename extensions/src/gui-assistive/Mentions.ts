import {Composite,fail} from '../gui-common/composite.js';
import {GuiAutoComplete} from '../gui-forms/AutoComplete.js';
import type {GuiInput} from '@haiyue/engine/gui';
import type {GuiMentionsOptions} from './types.js';
/** Token replacement through the original AutoComplete/editor; no second text buffer or IME host. */
export class GuiMentions extends Composite {
 readonly autocomplete:GuiAutoComplete;readonly input:GuiInput;
 constructor(private readonly options:GuiMentionsOptions){
  super('GuiMentions',{direction:'column',width:320},options,undefined,options.focusManager);const trigger=options.trigger??'@';if(Array.from(trigger).length!==1||/\s/u.test(trigger))fail('Mention trigger must be one non-whitespace character.');const carets=new Map<string,number>();
  this.autocomplete=new GuiAutoComplete({...options,suggestions:async(value,signal)=>{
   const input=this.input;if(!input||input.isComposing||input.hasSelection)return[];const end=input.selectionStart,prefix=value.slice(0,end),start=prefix.lastIndexOf(trigger);if(start<0||start>0&&!/\s/u.test(prefix[start-1]!)||/[\s]/u.test(prefix.slice(start+trigger.length)))return[];
   const query=prefix.slice(start+trigger.length);if(query.length>128)return[];const items=await options.suggestions(query,signal);if(signal.aborted||input.value!==value||input.selectionStart!==end||input.hasSelection)return[];carets.clear();return items.map(item=>{const suffix=value.slice(end),hasSpace=/^\s/u.test(suffix),inserted=trigger+item.value+(hasSpace?'':' ');carets.set(item.key,start+inserted.length+(hasSpace?1:0));return{...item,value:value.slice(0,start)+inserted+suffix};});
  },onSelect:item=>{const caret=carets.get(item.key);if(caret!==undefined&&!this.dead)this.input.setCaret(caret);}});
  this.input=this.autocomplete.input;this.part('autocomplete',this.autocomplete.element);this.releases.push(()=>{carets.clear();this.autocomplete.dispose();});this.finish();
 }
 search():Promise<boolean>{this.alive();return this.autocomplete.search();}
}
