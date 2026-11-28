import {GuiButton} from '@haiyue/engine/gui';
import {Composite,button,textElement,surface,fail} from '../gui-common/composite.js';
import {LatestRequest} from '../gui-common/latest.js';
import {GuiPopover} from '../gui-overlays/popover.js';
import {createGuiVirtualList} from '../gui-collections.js';
import type {GuiVirtualList} from '../gui-collections.js';
import type {GuiCascaderOptions,GuiCascaderNode} from './types.js';
export class GuiCascader extends Composite {
  readonly trigger:GuiButton;readonly list:GuiVirtualList<GuiCascaderNode>;readonly popup:GuiPopover;readonly feedback:import('@haiyue/engine/gui').GuiLabel;
  private readonly request=new LatestRequest();private levels:readonly GuiCascaderNode[][]=[];private trail:GuiCascaderNode[]=[];private chosen:readonly GuiCascaderNode[]=[];private current:readonly GuiCascaderNode[];
  constructor(private readonly options:GuiCascaderOptions){
    super('GuiCascader',{direction:'column',width:240},options,undefined,options.focusManager);this.current=this.checked(options.nodes);
    this.trigger=this.part('trigger',button(options.placeholder??'Choose path…',this.action(()=>this.popup.open()),{width:{percent:100}}));
    const content=surface('GuiCascaderContent',{direction:'column',rowGap:4,width:{percent:100},height:{percent:100}});const back=button('‹ Back',this.action(()=>this.back()),{height:28});content.add(back);this.feedback=textElement('',{height:22});content.add(this.feedback);
    this.list=createGuiVirtualList({items:this.current,keyOf:item=>item.key,rowHeight:32,height:192,focus:options.focusManager,createRow:()=>{let item:GuiCascaderNode|undefined;const element=new GuiButton({width:'100%',height:32,onClick:()=>{if(item)void this.navigate(item.key);}});return{element,bind:value=>{item=value;element.setText(value.label+(value.leaf?'':' ›'));element.setDisabled(value.disabled??false);return()=>{item=undefined;};},dispose:()=>element.removeAllListeners()};}});content.add(this.list.element);
    try{this.popup=new GuiPopover({root:options.root,focusManager:options.focusManager,anchor:this.trigger,content,width:320,height:280,trigger:'manual',onOpenChange:open=>{if(!open)this.request.cancel();}});}catch(error){this.list.dispose();this.dispose();throw error;}
    this.releases.push(()=>this.list.dispose(),()=>this.popup.dispose(),()=>{back.removeAllListeners();content.removeAllListeners();});this.finish();
  }
  private checked(nodes:readonly GuiCascaderNode[]):readonly GuiCascaderNode[] {if(!Array.isArray(nodes)||nodes.length>100000)fail('Invalid cascader level.');const keys=new Set<string>();for(const node of nodes){if(!node.key||keys.has(node.key)||typeof node.label!=='string')fail('Cascader keys must be unique within each level.');keys.add(node.key);}return [...nodes];}
  get path():readonly GuiCascaderNode[]{return Object.freeze([...this.chosen]);}
  async navigate(key:string):Promise<boolean> {
    this.alive();const node=this.current.find(item=>item.key===key);if(!node||node.disabled)return false;const next=[...this.trail,node];if(next.length>64)fail('Cascader depth limit exceeded.');
    const signal=this.request.begin();if(node.leaf||!node.children&&!this.options.loadChildren){this.chosen=next;this.trigger.setText(next.map(item=>item.label).join(' / '));this.popup.close('select');this.options.onChange?.(this.path);return true;}
    this.feedback.setText('Loading…');try{const children=this.checked(node.children??await this.options.loadChildren!(Object.freeze(next),signal));if(!this.request.current(signal))return false;this.levels=[...this.levels,[...this.current]];this.trail=next;this.current=children;this.list.setItems(children);this.list.setScrollOffset(0);this.feedback.setText(children.length?next.map(item=>item.label).join(' / '):'No options');return true;}catch(error){if(!this.request.current(signal))return false;this.feedback.setText(error instanceof Error?error.message:'Could not load options.');return false;}
  }
  back():void {this.alive();this.request.cancel();if(!this.levels.length)return;this.current=this.levels[this.levels.length-1]!;this.levels=this.levels.slice(0,-1);this.trail=this.trail.slice(0,-1);this.list.setItems(this.current);this.feedback.setText(this.trail.map(item=>item.label).join(' / '));}
  override dispose():void {this.request.cancel();super.dispose();}
}
