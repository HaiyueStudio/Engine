import type {GuiElement} from './components/GuiElement';
import {GuiDirtyFlags} from './GuiTypes';
import {guiControlPrototype} from './GuiControlIdentity';
import {clearGuiTextDirty,guiLocalChange,guiTextNeedsCoordinates} from './GuiInvalidationState';

const owners=new WeakMap<GuiElement,GuiDirtyState>();
/** One journal on the existing layout owner. Readers never consume another reader's changes. */
export class GuiDirtyState {
  readonly pending=new Set<GuiElement>();
  broadVersion=0;
  full=true;
  private trusted=false;
  private topology=new Map<GuiElement,readonly GuiElement[]>();
  private readonly base:GuiElement;
  constructor(private readonly root:GuiElement){this.base=Object.getPrototypeOf(root) as GuiElement;owners.set(root,this);}
  note(element:GuiElement,flags:GuiDirtyFlags,kind:number,reason?:string):void {
    if(reason||flags!==GuiDirtyFlags.None&&!guiLocalChange(kind))this.broadVersion++;
    if(flags&(GuiDirtyFlags.Children|GuiDirtyFlags.Layout))this.full=true;
    if(!this.full&&flags!==GuiDirtyFlags.None)this.pending.add(element);
  }
  invalidate():void {this.full=true;this.broadVersion++;}
  get dense():boolean {return !this.full&&this.pending.size>this.topology.size/3;}
  isDirty():boolean {
    // Public child arrays and custom live getters remain observable without a notification.
    return this.root.dirty;
  }
  needsCoordinates(fallback:()=>boolean):boolean {
    if(this.full||!this.trusted||this.dense||!this.valid())return fallback();
    for(const node of this.pending){const flags=node.getDirtyFlags();if(flags&(GuiDirtyFlags.Layout|GuiDirtyFlags.Children)||flags&GuiDirtyFlags.Text&&guiTextNeedsCoordinates(node))return true;}
    return false;
  }
  clear(fallback:()=>void):void {
    try{
      if(this.trusted&&this.dense){fallback();this.pending.clear();return;}
      if(this.full||!this.trusted||!this.valid()||[...this.pending].some(node=>!this.standard(node)||!this.belongs(node))){fallback();this.trusted=this.inspect();}
      else for(const node of this.pending)clearGuiOwnDirty(node);
      this.pending.clear();this.full=!this.trusted;
    }catch(error){this.full=true;this.trusted=false;throw error;}
  }
  dispose():void {this.pending.clear();this.topology.clear();if(owners.get(this.root)===this)owners.delete(this.root);}
  private valid():boolean {for(const [node,children]of this.topology){if(!this.standard(node)||node.children.length!==children.length)return false;for(let i=0;i<children.length;i++)if(node.children[i]!==children[i]||children[i]!.parent!==node)return false;}return true;}
  private belongs(node:GuiElement):boolean {for(let current:GuiElement|null=node;current;current=current.parent)if(current===this.root)return true;return false;}
  private standard(node:GuiElement):boolean {
    const prototype=Object.getPrototypeOf(node) as GuiElement;
    return (prototype===this.base||guiControlPrototype(prototype)!==undefined)&&!Object.hasOwn(node,'dirty')&&node.clearDirty===this.base.clearDirty&&node.getDirtyFlags===this.base.getDirtyFlags&&
      (prototype===this.base||!Object.hasOwn(prototype,'dirty'));
  }
  private inspect():boolean {
    this.topology.clear();const pending=[this.root],seen=new Set<GuiElement>();while(pending.length){const node=pending.pop()!;if(seen.has(node)||!this.standard(node))return false;seen.add(node);this.topology.set(node,node.children.slice());for(const child of node.children){if(child.parent!==node)return false;pending.push(child);}}
    return true;
  }
}
export function guiDirtyState(root:GuiElement):GuiDirtyState|undefined {return owners.get(root);}
/** Private friend used by both the public recursive clear and the owner's sparse clear. */
export function clearGuiOwnDirty(element:GuiElement):void {(element as unknown as {dirtyFlags:GuiDirtyFlags}).dirtyFlags=GuiDirtyFlags.None;clearGuiTextDirty(element);}
