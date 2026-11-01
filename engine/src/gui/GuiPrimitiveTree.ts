import type {GuiElement} from './components/GuiElement';
import {guiControlPrototype} from './GuiControlIdentity';
import {isGuiLayoutHidden} from './GuiLayoutState';
import {isGuiExternallyPainted} from './GuiExternalPresentation';

type Kind='element'|'GuiLabel'|'GuiProgress'|'GuiButton';
const common=['visible','disabled','hovered','pressed','focused'] as const;
const keys:Record<Kind,readonly string[]>={element:[],GuiLabel:['text','fontSize','textAlign','autoWidth'],GuiProgress:['value','min','max','showText'],GuiButton:['text','variant','hoverTransition','hoverTransitionMs']};
const styles=new Set(['cursor','backgroundColor','hoverBackgroundColor','borderColor','color','hoverColor','opacity','radius','padding']);
const noChildren:readonly GuiElement[]=[],noValues:readonly unknown[]=[],noStyle:Record<string,unknown>={};
export interface GuiPrimitiveEntry {
  readonly element:GuiElement;readonly parent:GuiPrimitiveEntry|null;readonly children:readonly GuiElement[];readonly kind:Kind;
  values:readonly unknown[];style:Record<string,unknown>;hidden:boolean;
}
/** A conservative description of stock paint inputs, shared by the existing font and paint owners. */
export class GuiPrimitiveTree {
  readonly entries:GuiPrimitiveEntry[]=[];
  private constructor(private readonly base:GuiElement){}
  static capture(root:GuiElement,paintInputs=true):GuiPrimitiveTree|null {
    const tree=new GuiPrimitiveTree(Object.getPrototypeOf(root) as GuiElement),seen=new Set<GuiElement>();
    const visit=(element:GuiElement,parent:GuiPrimitiveEntry|null):boolean=>{
      if(seen.has(element))return false;seen.add(element);
      const kind=tree.kind(element);if(!kind)return false;
      const entry:GuiPrimitiveEntry={element,parent,children:element.children.length?element.children.slice():noChildren,kind,values:paintInputs?tree.values(element,kind):noValues,style:paintInputs?{...element.style}:noStyle,hidden:!element.visible||isGuiLayoutHidden(element)||!!parent?.hidden};tree.entries.push(entry);
      for(const child of element.children)if(child.parent!==element||!visit(child,entry))return false;
      return true;
    };
    return visit(root,null)?tree:null;
  }
  /** Validate topology even when callers directly edit public child arrays. */
  valid():boolean {
    for(const entry of this.entries){const e=entry.element;if(this.kind(e,false)!==entry.kind||e.children.length!==entry.children.length)return false;for(let i=0;i<entry.children.length;i++)if(e.children[i]!==entry.children[i]||e.children[i]!.parent!==e)return false;}
    return true;
  }
  changed(entry:GuiPrimitiveEntry):boolean {
    const e=entry.element,r=e.rect,record=e as unknown as Record<string,unknown>;let i=0;
    for(const key of common)if(!Object.is(entry.values[i++],record[key]))return true;
    if(!Object.is(entry.values[i++],r.x)||!Object.is(entry.values[i++],r.y)||!Object.is(entry.values[i++],r.width)||!Object.is(entry.values[i++],r.height)||entry.values[i++]!==isGuiLayoutHidden(e))return true;
    for(const key of keys[entry.kind])if(!Object.is(entry.values[i++],record[key]))return true;
    const style=e.style as Record<string,unknown>,before=entry.style;
    for(const key in style)if(!Object.hasOwn(before,key)||!Object.is(before[key],style[key]))return true;
    for(const key in before)if(!Object.hasOwn(style,key))return true;
    return false;
  }
  remember(entry:GuiPrimitiveEntry):void {entry.values=this.values(entry.element,entry.kind);entry.style={...entry.element.style};}
  private values(e:GuiElement,kind:Kind):unknown[] {const r=e.rect,record=e as unknown as Record<string,unknown>;return [...common.map(k=>record[k]),r.x,r.y,r.width,r.height,isGuiLayoutHidden(e),...keys[kind].map(k=>record[k])];}
  private kind(e:GuiElement,inspect=true):Kind|undefined {
    const p=Object.getPrototypeOf(e) as GuiElement,id=guiControlPrototype(p),kind:Kind|undefined=p===this.base?'element':id==='GuiLabel'||id==='GuiProgress'||id==='GuiButton'?id:undefined;
    if(!kind||kind!=='element'&&e.children.length||e.getResolvedStyle!==this.base.getResolvedStyle||e.getContentRect!==this.base.getContentRect||isGuiExternallyPainted(e))return;
    if(e.themeResource||kind==='GuiButton'&&(e as unknown as {hoverTransition:boolean}).hoverTransition)return;
    const style=e.style,prototype=Object.getPrototypeOf(style);if(prototype!==Object.prototype&&prototype!==null)return;
    for(const key in style){const value=(style as Record<string,unknown>)[key];if(!styles.has(key)||value!==undefined&&typeof value!=='string'&&typeof value!=='number')return;if(inspect){const d=Object.getOwnPropertyDescriptor(style,key);if(!d||!('value'in d))return;}}
    if(inspect)for(const key of [...common,...keys[kind],'rect','style']){const d=Object.getOwnPropertyDescriptor(e,key);if(d&&!('value'in d))return;}
    for(const key of ['label','content','displayText','visibleNodes'])if(key in e)return;
    if(kind==='element'&&'text'in e)return;
    return kind;
  }
}
