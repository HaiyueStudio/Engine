import {GuiButton} from '@haiyue/engine/gui';
import {Composite,button,fail} from '../gui-common/composite.js';
import {createGuiVirtualList} from '../gui-collections.js';
import type {GuiVirtualList} from '../gui-collections.js';
import type {GuiHistoryControlsOptions} from './types.js';
export class GuiHistoryControls extends Composite {
 readonly undo:GuiButton;readonly redo:GuiButton;readonly list:GuiVirtualList<{key:string;label:string}>|undefined;
 constructor(private readonly options:GuiHistoryControlsOptions){
  super('GuiHistoryControls',{direction:'column',rowGap:4,width:260},options,undefined,options.focusManager);if(!options.history||typeof options.history.read!=='function'||typeof options.history.subscribe!=='function'||typeof options.history.undo!=='function'||typeof options.history.redo!=='function')fail('History controls require a caller-owned history port.');
  this.undo=this.part('undo',button('Undo',this.action(()=>options.history.undo())));this.redo=this.part('redo',button('Redo',this.action(()=>options.history.redo())));
  if(options.showEntries??!!options.history.goTo){this.list=createGuiVirtualList<{key:string;label:string}>({items:[],keyOf:item=>item.key,rowHeight:30,height:120,maxItems:1000,...(options.focusManager?{focus:options.focusManager}:{}),createRow:()=>{let key:string|undefined;const element=new GuiButton({height:30,width:'100%',onClick:()=>{if(key)options.history.goTo?.(key);}});return{element,bind:item=>{key=item.key;element.setText(item.label);element.setDisabled(!options.history.goTo);return()=>{key=undefined;};},dispose:()=>element.removeAllListeners()};}});this.element.add(this.list.element);this.releases.push(()=>this.list?.dispose());}
  try{this.refresh();const off=options.history.subscribe(()=>{if(!this.dead)this.refresh();});if(typeof off!=='function')fail('History subscription must return a release function.');if(this.dead){off();fail('History controls disposed during subscription.');}this.releases.push(off);this.finish();}catch(error){this.dispose();throw error;}
 }
 refresh():void {this.alive();const snapshot=this.options.history.read();if(!snapshot||typeof snapshot.canUndo!=='boolean'||typeof snapshot.canRedo!=='boolean'||!Array.isArray(snapshot.entries)||snapshot.entries.length>1000||new Set(snapshot.entries.map(item=>item.key)).size!==snapshot.entries.length||snapshot.entries.some(item=>!item.key||typeof item.label!=='string'))fail('Invalid history snapshot.');this.undo.setDisabled(!snapshot.canUndo);this.redo.setDisabled(!snapshot.canRedo);this.list?.setItems(snapshot.entries.map(item=>({...item})));this.list?.setSelection(snapshot.currentKey&&snapshot.entries.some(item=>item.key===snapshot.currentKey)?snapshot.currentKey:null);}
}
