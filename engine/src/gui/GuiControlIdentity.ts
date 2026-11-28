import type {GuiTheme} from './GuiTypes';
import type {GuiControlPaintContext} from './rendering/GuiRenderer';
import type {GuiElement} from './components/GuiElement';
import type {GuiSkin, GuiThemeState} from './GuiThemeTypes';
export type GuiControlKind = 'GuiButton' | 'GuiCheckbox' | 'GuiHelpDialog' | 'GuiImage' | 'GuiInput' | 'GuiLabel' | 'GuiModal' | 'GuiNineSlice' | 'GuiProgress' | 'GuiRadio' | 'GuiScrollView' | 'GuiSelect' | 'GuiSlider' | 'GuiSwitch' | 'GuiToast' | 'GuiTooltip' | 'GuiTree';
type Painter=(context:GuiControlPaintContext,element:GuiElement,theme:GuiTheme)=>void;
const prototypes = new WeakMap<object, GuiControlKind>(),painters=new WeakMap<object,Painter>();
const skins = new WeakMap<object,(element:GuiElement,theme:GuiTheme,state:GuiThemeState)=>GuiSkin>();
export type GuiDefaultSkinCache=Map<object,Map<string,GuiSkin>>;
const animationGetters = new WeakMap<object, (() => unknown) | undefined>();
const progressTextGetters = new WeakMap<object, {display:(()=>unknown)|undefined;ratio:(()=>unknown)|undefined}>();
let radios: Readonly<{rebuild(root:GuiElement):void;ensure(root:GuiElement):unknown}> | undefined;
/** A weak identity table, not a theme tag or constructor-name test.
 * The static field retains its initialization for every used constructor.
 * An unused class has no reachable instances/prototype, so removing its
 * annotated initialization cannot change any lookup or public behavior. */
export function admitGuiControl<T extends GuiElement>(prototype:T, kind:GuiControlKind, radio?:typeof radios,paint?:(context:GuiControlPaintContext,element:T,theme:GuiTheme)=>void,skin?:(element:T,theme:GuiTheme,state:GuiThemeState)=>GuiSkin):T {prototypes.set(prototype,kind);animationGetters.set(prototype,Object.getOwnPropertyDescriptor(prototype,'animating')?.get);if(kind==='GuiProgress')progressTextGetters.set(prototype,{display:Object.getOwnPropertyDescriptor(prototype,'displayText')?.get,ratio:Object.getOwnPropertyDescriptor(prototype,'ratio')?.get});if(radio)radios=radio;if(paint)painters.set(prototype,paint as Painter);if(skin)skins.set(prototype,skin as (element:GuiElement,theme:GuiTheme,state:GuiThemeState)=>GuiSkin);return prototype;}
export function guiStockProgressText(element:GuiElement):boolean {const p=Object.getPrototypeOf(element) as object,proof=progressTextGetters.get(p);return !!proof?.display&&!Object.hasOwn(element,'displayText')&&!Object.hasOwn(element,'ratio')&&Object.getOwnPropertyDescriptor(p,'displayText')?.get===proof.display&&Object.getOwnPropertyDescriptor(p,'ratio')?.get===proof.ratio;}
export function guiControlDefaultSkin(element:GuiElement,theme:GuiTheme,state:GuiThemeState,cache?:GuiDefaultSkinCache):GuiSkin {
  if(!theme.density)return {};
  const own=Object.getPrototypeOf(element) as object;
  for(let p:object|null=own;p;p=Object.getPrototypeOf(p) as object|null){const skin=skins.get(p);if(skin){
    if(cache&&p===own){let entries=cache.get(p);if(!entries){entries=new Map();cache.set(p,entries);}let bits=0,index=0;for(const flag of ['hover','focus','pressed','disabled','checked','selected','invalid','loading','readOnly','open'] as const){if(state[flag])bits|=1<<index;index++;}
      // Built-in defaults depend on state, root tokens and Button.variant. The renderer scopes this cache to one root collection.
      const variant=prototypes.get(p)==='GuiButton'?Object.getOwnPropertyDescriptor(element,'variant'):undefined;
      if(variant&&!('value'in variant))return skin(element,theme,state);
      const key=bits+':'+String(variant?.value??'');let result=entries.get(key);if(!result){result=skin(element,theme,state);entries.set(key,result);}return result;
    }return skin(element,theme,state);}}
  return {};
}
export function guiControlPrototype(prototype:object):GuiControlKind|undefined {return prototypes.get(prototype);}
export function guiControlAnimationGetter(prototype:object):(() => unknown)|undefined {return animationGetters.get(prototype);}
export function isGuiControl<T extends object>(value:unknown, kind:GuiControlKind):value is T {
 if(value===null || typeof value!=='object' && typeof value!=='function')return false;
 for(let prototype=Object.getPrototypeOf(value) as object|null;prototype;prototype=Object.getPrototypeOf(prototype) as object|null)if(prototypes.get(prototype)===kind)return true;
 return false;
}
export function maintainGuiRadioGroups(root:GuiElement,dirty:boolean):void {if(dirty)radios?.rebuild(root);else radios?.ensure(root);}

export function guiControlPainter(prototype:object):Painter|undefined{return painters.get(prototype);}
export function guiControlPainterFor(element:GuiElement,kind:GuiControlKind):Painter|undefined{for(let p=Object.getPrototypeOf(element) as object|null;p;p=Object.getPrototypeOf(p) as object|null)if(prototypes.get(p)===kind)return painters.get(p);return undefined;}
