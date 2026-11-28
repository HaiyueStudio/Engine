import {GuiElement,GuiLabel,GuiButton,GuiDirtyFlags} from '@haiyue/engine/gui';
import type {GuiElementOptions,GuiSkin,GuiTheme,GuiThemeState,GuiFocusManager,GuiStyle,GuiRoot} from '@haiyue/engine/gui';
import {setContainerStyle,ownContentFrame,presetStyle} from '../gui-layout/presets.js';
import type {GuiLayoutStyle} from '../gui-layout/types.js';
import {GuiCleanup} from '../gui-layout/panel-cleanup.js';
import {LayoutError} from '../layout.js';

export type Skin=(theme:Readonly<GuiTheme>,state:GuiThemeState)=>GuiSkin;
export function fail(message:string):never {throw new LayoutError('invalid-input',message);}
export function number(value:number,name:string,min=0,max=1e6):number {if(!Number.isFinite(value)||value<min||value>max)fail(`Invalid ${name}.`);return value;}
export function choice<T extends string>(value:T,values:readonly T[],name:string):T {if(!values.includes(value))fail(`Invalid ${name}.`);return value;}
export function label(value:string,name='text'):string {if(typeof value!=='string')fail(`Invalid ${name}.`);return value;}
export function flag(value:unknown,name:string,fallback=false):boolean {if(value===undefined)return fallback;if(typeof value!=='boolean')fail(`Invalid ${name}.`);return value;}
export function within(node:GuiElement|null,parent:GuiElement):boolean {for(let n=node;n;n=n.parent)if(n===parent)return true;return false;}
const visibleDisplay=new WeakMap<GuiElement,'flex'|'grid'>();
export function show(node:GuiElement,value:boolean):void {
  const style=presetStyle(node);
  if(style){if(style.display!=='none')visibleDisplay.set(node,style.display??'flex');const display=value?visibleDisplay.get(node)??'flex':'none';if(style.display!==display){setContainerStyle(node,{...style,display});node.markDirty(GuiDirtyFlags.Layout);}}
  node.setVisible(value);
}
export function surface(type:string,style:GuiLayoutStyle,options:GuiElementOptions={},skin?:Skin):GuiElement {
  const element=new GuiElement({...options,themeControlType:options.themeControlType??type,pointerFilter:options.pointerFilter??'ignore',width:options.width??'100%'});
  const length=(v:number|`${number}%`|undefined)=>typeof v==='string'?{percent:Number.parseFloat(v)}:v;
  setContainerStyle(element,{width:'auto',height:'auto',minWidth:0,...style,...(options.width===undefined?{}:{width:length(options.width)!}),...(options.height===undefined?{}:{height:length(options.height)!})});
  if(skin)element.setDefaultSkin(skin);return element;
}
export function textElement(text:string,style:GuiLayoutStyle={},options:GuiElementOptions={}):GuiLabel {
  const node=new GuiLabel({...options,text:label(text),pointerFilter:options.pointerFilter??'ignore',style:{padding:0,...options.style}});
  setContainerStyle(node,{width:'auto',height:'auto',minWidth:0,shrink:0,...style});return node;
}
export function button(text:string,run:()=>void,style:GuiLayoutStyle={},options:GuiElementOptions={}):GuiButton {
  const node=new GuiButton({...options,text:label(text),onClick:run});setContainerStyle(node,{width:'auto',height:32,minWidth:0,...style});return node;
}
/** One lifecycle for display and overlay controllers; business subtrees are always borrowed. */
export class Composite {
  readonly element:GuiElement;
  protected dead=false;
  protected readonly releases:(()=>void)[]=[];
  protected readonly owned=new Set<GuiElement>();
  private readonly parts=new Map<GuiElement,()=>void>();
  private readonly slots=new Map<GuiElement,{parent:GuiElement;release:()=>void}>();
  private readonly lifetimeRoot:GuiRoot|undefined;
  constructor(type:string,layout:GuiLayoutStyle,options:GuiElementOptions&{readonly root?:GuiRoot}={},skin?:Skin,protected readonly focus?:GuiFocusManager){if(options.root?.destroyed)fail('GUI root is disposed.');this.element=surface(type,layout,options,skin);this.owned.add(this.element);this.lifetimeRoot=options.root;}
  protected finish():void {if(this.lifetimeRoot){if(this.lifetimeRoot.destroyed){this.dispose();fail('GUI root was disposed during construction.');}const off=this.lifetimeRoot.onDispose(()=>this.dispose());if(this.dead){off();fail('GUI root was disposed during construction.');}this.releases.push(off);}}
  protected alive():void {if(this.dead)throw new LayoutError('disposed','GUI component is disposed.');}
  protected part<T extends GuiElement>(name:string,node:T,parent=this.element):T {
    parent.add(node);this.owned.add(node);this.parts.set(node,this.element.bindPart(name,node));return node;
  }
  protected forget(node:GuiElement):void {
    node.parent?.remove(node);const pending=[node],cleanup=new GuiCleanup();
    while(pending.length){const current=pending.pop()!;pending.push(...current.children);if(!this.owned.delete(current))continue;const release=this.parts.get(current);if(release)cleanup.run(release);this.parts.delete(current);cleanup.run(()=>current.setActivity(null));cleanup.run(()=>current.setDefaultSkin(null));cleanup.run(()=>current.setDisabled(true));cleanup.run(()=>current.removeAllListeners());}
    cleanup.complete('GUI subtree cleanup failed.');
  }
  protected mount(entries:readonly {name:string;node:GuiElement|undefined;parent:GuiElement;layout?:GuiLayoutStyle}[]):void {
    const nodes=new Set<GuiElement>(),acquired:{node:GuiElement;parent:GuiElement;release:()=>void;part:()=>void}[]=[];
    for(const e of entries)if(e.node){if(!(e.node instanceof GuiElement)||e.node.parent||nodes.has(e.node)||within(e.parent,e.node))fail('Slots require distinct unattached borrowed elements.');nodes.add(e.node);}
    try {for(const e of entries)if(e.node){const release=ownContentFrame(e.node,e.layout??{});let part=()=>{};try{e.parent.add(e.node);part=this.element.bindPart(e.name,e.node);}catch(error){e.node.parent?.remove(e.node);release();throw error;}acquired.push({node:e.node,parent:e.parent,release,part});}}
    catch(error){for(const a of acquired.reverse()){a.parent.remove(a.node);a.part();a.release();}throw error;}
    for(const a of acquired)this.slots.set(a.node,{parent:a.parent,release:()=>{a.part();a.release();}});
  }
  protected action(run:()=>void):()=>void {return()=>{if(!this.dead)run();};}
  protected blurWithin(parent:GuiElement):void {if(within(this.focus?.focused??null,parent))this.focus?.blur();}
  setStyle(style:GuiStyle):void {this.alive();this.element.setStyle(style);}
  dispose():void {
    if(this.dead)return;this.dead=true;const cleanup=new GuiCleanup();
    cleanup.run(()=>this.blurWithin(this.element));
    for(const off of this.releases.splice(0).reverse())cleanup.run(off);
    for(const off of this.parts.values())cleanup.run(off);this.parts.clear();
    for(const [node,slot]of this.slots){cleanup.run(()=>{if(node.parent===slot.parent)slot.parent.remove(node);});cleanup.run(slot.release);}this.slots.clear();
    for(const node of this.owned){cleanup.run(()=>node.setActivity(null));cleanup.run(()=>node.setDisabled(true));cleanup.run(()=>node.removeAllListeners());}
    cleanup.run(()=>this.element.parent?.remove(this.element));this.owned.clear();cleanup.run(()=>this.focus?.reconcile());cleanup.complete('GUI component cleanup failed.');
  }
}
export function statusColor(theme:Readonly<GuiTheme>,status:'default'|'info'|'success'|'warning'|'error'):string {
  return status==='success'?theme.colors.success??'#20845c':status==='warning'?theme.colors.warning??'#a66c14':status==='error'?theme.colors.danger:status==='info'?theme.colors.primary:theme.colors.textMuted;
}
