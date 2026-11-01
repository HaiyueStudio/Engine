import {GuiElement} from './components/GuiElement';
import {GuiDirtyFlags} from './GuiTypes';
import {guiControlAnimationGetter,guiControlPrototype} from './GuiControlIdentity';
import {guiStructureVersion,isGuiLayoutHidden} from './GuiLayoutState';

interface Entry {element:GuiElement;parent:Entry|null;children:GuiElement[]|undefined;childrenActive:number;active:boolean;structureVersion:number;}

/** Incremental activity of the original layout owner. Custom getters retain the legacy scan. */
export class GuiActivityState {
  private entries=new Map<GuiElement,Entry>();
  private initialized=false;
  private fallback=false;
  constructor(private readonly root:GuiElement,private readonly scan:(element:GuiElement)=>boolean){}
  reset():void {this.entries.clear();this.initialized=false;this.fallback=false;}
  private trusted(element:GuiElement):boolean {
    const prototype=Object.getPrototypeOf(element) as object;
    if(prototype!==GuiElement.prototype&&guiControlPrototype(prototype)===undefined)return false;
    if(Object.hasOwn(element,'animating'))return false;
    for(const key of ['visible','disabled','children'] as const){const descriptor=Object.getOwnPropertyDescriptor(element,key);if(!descriptor||!('value' in descriptor))return false;}
    const getter=guiControlAnimationGetter(prototype);
    return getter?Object.getOwnPropertyDescriptor(prototype,'animating')?.get===getter:!('animating' in element);
  }
  private local(entry:Entry):boolean {
    const element=entry.element;
    return element.visible&&!isGuiLayoutHidden(element)&&!element.disabled&&
      (('animating' in element&&element.animating===true)||entry.childrenActive>0);
  }
  private collect(element:GuiElement,parent:Entry|null):boolean {
    const order:Entry[]=[],pending:{element:GuiElement;parent:Entry|null}[]=[{element,parent}];
    while(pending.length){
      const {element,parent}=pending.pop()!;
      if(this.entries.has(element)||!this.trusted(element))return false;
      const entry:Entry={element,parent,children:element.children.length?[...element.children]:undefined,childrenActive:0,active:false,structureVersion:guiStructureVersion(element)};this.entries.set(element,entry);order.push(entry);
      for(let i=element.children.length-1;i>=0;i--)pending.push({element:element.children[i]!,parent:entry});
    }
    for(let i=order.length-1;i>=0;i--){const entry=order[i]!;entry.active=this.local(entry);if(entry.active&&entry.parent)entry.parent.childrenActive++;}
    return true;
  }
  private rebuild():void {
    this.reset();
    if(!this.collect(this.root,null)){this.entries.clear();this.fallback=true;}
    this.initialized=true;
  }
  structure(parent:GuiElement,child:GuiElement,added:boolean,version:number):void {
    if(!this.initialized)return;
    try{
      const entry=this.entries.get(parent),existing=this.entries.get(child);
      if(this.fallback||!entry||!this.trusted(parent)){this.reset();return;}
      if(added){
        if(!this.collect(child,entry)){this.reset();return;}
        (entry.children??=[]).push(child);
      }else{
        if(!existing||existing.parent!==entry){this.reset();return;}
        if(existing.active)entry.childrenActive--;
        const index=entry.children?.indexOf(child)??-1;if(index<0){this.reset();return;}entry.children!.splice(index,1);
        const pending=[child];while(pending.length){const node=pending.pop()!,cached=this.entries.get(node);if(cached?.children)pending.push(...cached.children);this.entries.delete(node);}
      }
      entry.structureVersion=version;this.refresh(entry);
    }catch(error){this.reset();throw error;}
  }
  private refresh(entry:Entry):void {
    for(let current:Entry|null=entry;current;current=current.parent){
      const active=this.local(current);
      if(active!==current.active){current.active=active;if(current.parent)current.parent.childrenActive+=active?1:-1;}
    }
  }
  value(element:GuiElement|undefined,flags:GuiDirtyFlags,structure?:number):boolean {
    try{
      const known=structure!==undefined&&element!==undefined&&this.entries.get(element)?.structureVersion===structure;
      if(!this.initialized||element===this.root&&!known||!!(flags&GuiDirtyFlags.Children)&&!known)this.rebuild();
      if(!this.fallback&&element){
        const entry=this.entries.get(element);
        if(!entry||!this.trusted(element)||entry.parent?.element!==element.parent&&element!==this.root)this.rebuild();
        else this.refresh(entry);
      }
      return this.fallback?this.scan(this.root):this.entries.get(this.root)?.active??false;
    }catch(error){this.reset();throw error;}
  }
}
