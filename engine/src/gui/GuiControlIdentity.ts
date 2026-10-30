import type {GuiTheme} from './GuiTypes';
import type {GuiControlPaintContext} from './rendering/GuiRenderer';
import type {GuiElement} from './components/GuiElement';
export type GuiControlKind = 'GuiButton' | 'GuiCheckbox' | 'GuiHelpDialog' | 'GuiImage' | 'GuiInput' | 'GuiLabel' | 'GuiModal' | 'GuiNineSlice' | 'GuiProgress' | 'GuiRadio' | 'GuiScrollView' | 'GuiSelect' | 'GuiSlider' | 'GuiSwitch' | 'GuiToast' | 'GuiTooltip' | 'GuiTree';
type Painter=(context:GuiControlPaintContext,element:GuiElement,theme:GuiTheme)=>void;
const prototypes = new WeakMap<object, GuiControlKind>(),painters=new WeakMap<object,Painter>();
let radios: Readonly<{rebuild(root:GuiElement):void;ensure(root:GuiElement):unknown}> | undefined;
/** A weak identity table, not a theme tag or constructor-name test.
 * The static field retains its initialization for every used constructor.
 * An unused class has no reachable instances/prototype, so removing its
 * annotated initialization cannot change any lookup or public behavior. */
export function admitGuiControl<T extends GuiElement>(prototype:T, kind:GuiControlKind, radio?:typeof radios,paint?:(context:GuiControlPaintContext,element:T,theme:GuiTheme)=>void):T {prototypes.set(prototype,kind);if(radio)radios=radio;if(paint)painters.set(prototype,paint as Painter);return prototype;}
export function guiControlPrototype(prototype:object):GuiControlKind|undefined {return prototypes.get(prototype);}
export function isGuiControl<T extends object>(value:unknown, kind:GuiControlKind):value is T {
 if(value===null || typeof value!=='object' && typeof value!=='function')return false;
 for(let prototype=Object.getPrototypeOf(value) as object|null;prototype;prototype=Object.getPrototypeOf(prototype) as object|null)if(prototypes.get(prototype)===kind)return true;
 return false;
}
export function maintainGuiRadioGroups(root:GuiElement,dirty:boolean):void {if(dirty)radios?.rebuild(root);else radios?.ensure(root);}

export function guiControlPainter(prototype:object):Painter|undefined{return painters.get(prototype);}
export function guiControlPainterFor(element:GuiElement,kind:GuiControlKind):Painter|undefined{for(let p=Object.getPrototypeOf(element) as object|null;p;p=Object.getPrototypeOf(p) as object|null)if(prototypes.get(p)===kind)return painters.get(p);return undefined;}
