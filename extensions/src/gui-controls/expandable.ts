import type {GuiElement,GuiFocusManager,GuiStyle} from '@haiyue/engine/gui';
import {GuiCollapse} from './collapse.js';
export interface GuiExpandableOptions {
  readonly title:string;readonly content:GuiElement;readonly expanded?:boolean;readonly focus?:GuiFocusManager;
  readonly variant?:'bordered'|'ghost';readonly animationMs?:number;readonly style?:GuiStyle;
  readonly onExpandChange?:(expanded:boolean)=>void;
}
/** A single-panel convenience API, entirely delegated to the existing collapse controller. */
export class GuiExpandable {
  readonly element:GuiElement;
  private readonly collapse:GuiCollapse;
  constructor(options:GuiExpandableOptions){this.collapse=new GuiCollapse({items:[{key:'content',title:options.title,content:options.content}],expandedKeys:options.expanded?['content']:[],...(options.focus?{focus:options.focus}:{}),...(options.style?{style:options.style}:{}),...(options.variant?{variant:options.variant}:{}),...(options.animationMs===undefined?{}:{animationMs:options.animationMs}),onExpandChange:keys=>options.onExpandChange?.(keys.length>0)});this.element=this.collapse.element;}
  get expanded():boolean{return this.collapse.getExpandedKeys().length>0;}
  setExpanded(expanded:boolean):void {if(typeof expanded!=='boolean')throw new TypeError('Invalid expandable state.');this.collapse.setExpandedKeys(expanded?['content']:[]);}
  dispose():void{this.collapse.dispose();}
}
