import {GuiInput,GuiButton} from '@haiyue/engine/gui';
import type {GuiActionEvent} from '@haiyue/engine/gui';
import {Composite,show,textElement,number,fail,within,surface} from '../gui-common/composite.js';
import {LatestRequest} from '../gui-common/latest.js';
import {createGuiVirtualList} from '../gui-collections.js';
import type {GuiVirtualList} from '../gui-collections.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import type {GuiAutoCompleteOptions,GuiSuggestion} from './types.js';
class SuggestionInput extends GuiInput {
  navigate:((event:GuiActionEvent)=>void)|undefined;
  preedit:(()=>void)|undefined;
  override beginComposition():void {this.preedit?.();super.beginComposition();}
  override updateComposition(text:string,selectionUtf16?:readonly [number,number]):void {if(!this.isComposing)this.preedit?.();super.updateComposition(text,selectionUtf16);}
  override submit():void {if(this.isComposing)return;let consumed=false;const event:GuiActionEvent={action:'confirm',source:'keyboard',get consumed(){return consumed;},consume(){consumed=true;}};this.navigate?.(event);if(!event.consumed)super.submit();}
  override handleAction(event:GuiActionEvent):void {if(!this.isComposing)this.navigate?.(event);if(!event.consumed)super.handleAction(event);}
}
/** Inline suggestions keep the original editor in its input domain; no second text host or modal. */
export class GuiAutoComplete extends Composite {
  readonly input:GuiInput;readonly list:GuiVirtualList<GuiSuggestion>;readonly feedback:import('@haiyue/engine/gui').GuiLabel;
  private readonly request=new LatestRequest();private readonly suggestionPanel:import('@haiyue/engine/gui').GuiElement;private items:readonly GuiSuggestion[]=[];private active=-1;private readonly max:number;
  constructor(private readonly options:GuiAutoCompleteOptions={}){
    super('GuiAutoComplete',{direction:'column',rowGap:4,width:320},options,undefined,options.focusManager);this.max=number(options.maxSuggestions??1000,'suggestion limit',1,100000);
    const input=this.part('input',new SuggestionInput({value:options.value??'',placeholder:options.placeholder??'',onChange:value=>{options.onChange?.(value);if(!this.dead)void this.search(value);}}));this.input=input;setContainerStyle(input,{width:{percent:100},height:32});this.releases.push(()=>{input.navigate=undefined;input.preedit=undefined;input.onChange=null;});
    this.feedback=this.part('feedback',textElement('',{height:20}));
    const suggestionHeight=number(options.suggestionHeight??150,'suggestion height',30,4096);this.suggestionPanel=this.part('suggestions',surface('GuiSuggestions',{direction:'column',height:suggestionHeight,width:{percent:100}}));
    this.list=createGuiVirtualList<GuiSuggestion>({items:[],keyOf:item=>item.key,rowHeight:30,height:suggestionHeight,maxItems:this.max,...(options.focusManager?{focus:options.focusManager}:{}),createRow:()=>{
      let item:GuiSuggestion|undefined;const element=new GuiButton({width:'100%',height:30,onClick:()=>{if(item&&!item.disabled)this.select(item.key);}});
      return{element,bind:value=>{item=value;element.setText(value.label);element.setDisabled(value.disabled??false);return()=>{item=undefined;};},dispose:()=>element.removeAllListeners()};
    }});
    this.suggestionPanel.add(this.list.element);this.releases.push(()=>this.list.dispose());this.displayResults(false);show(this.feedback,false);
    input.preedit=()=>this.close();
    input.navigate=event=>{if((event.action==='up'||event.action==='down')&&this.items.length&&this.list.element.visible){const enabled=this.items.map((item,index)=>item.disabled?-1:index).filter(index=>index>=0);if(enabled.length){const pos=enabled.indexOf(this.active),index=enabled[(pos+(event.action==='down'?1:-1)+enabled.length)%enabled.length]!;this.active=index;this.list.setSelection(this.items[index]!.key);this.list.scrollToKey(this.items[index]!.key);}event.consume();}else if(event.action==='confirm'&&this.active>=0&&this.list.element.visible){this.select(this.items[this.active]!.key);event.consume();}else if(event.action==='cancel'){this.close();event.consume();}};
    if(options.root)this.releases.push(options.root.onInvalidation(()=>{if(!this.dead&&!this.element.isEffectivelyVisible())this.close();}));if(options.focusManager)this.releases.push(options.focusManager.subscribe(()=>{if(!this.dead&&!within(options.focusManager!.focused,this.element))this.close();}));this.finish();
  }
  async search(query=this.input.value):Promise<boolean> {
    this.alive();if(this.input.isComposing)return false;const signal=this.request.begin();this.feedback.setText('Loading…');show(this.feedback,true);
    try{const items=await this.options.suggestions?.(query,signal)??[];if(!this.request.current(signal))return false;const keys=new Set<string>();if(!Array.isArray(items)||items.length>this.max)fail('Suggestion limit exceeded.');for(const item of items){if(!item.key||keys.has(item.key)||typeof item.label!=='string'||typeof item.value!=='string')fail('Suggestions require unique keys, labels and values.');keys.add(item.key);}this.items=items.map(item=>({...item}));this.active=-1;this.list.setItems(this.items);this.displayResults(items.length>0);this.feedback.setText(items.length?'':'No suggestions');show(this.feedback,!items.length);return true;}
    catch(error){if(!this.request.current(signal))return false;this.items=[];this.list.setItems([]);this.displayResults(false);this.feedback.setText(error instanceof Error?error.message:'Suggestions failed.');show(this.feedback,true);return false;}
  }
  select(key:string):void {this.alive();const item=this.items.find(item=>item.key===key);if(!item||item.disabled)return;this.close();this.input.setValue(item.value);this.options.onChange?.(item.value);if(this.dead)return;this.options.onSelect?.(item);if(!this.dead)this.options.focusManager?.focus(this.input);}
  private displayResults(value:boolean):void {show(this.suggestionPanel,value);show(this.list.element,value);}
  close():void {this.request.cancel();this.active=-1;this.displayResults(false);show(this.feedback,false);}
  override dispose():void {this.request.cancel();super.dispose();}
}
