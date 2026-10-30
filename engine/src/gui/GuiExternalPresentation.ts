import type {GamepadControlSample} from '../input/GamepadInputLayers';
import type {GuiTextBufferEdit} from './input/GuiTextBuffer';
import type {GuiElement} from './components/GuiElement';
import type {GuiInput} from './components/GuiInput';
import type {GuiInputGeometry,GuiInputPresentation} from './input/GuiInputPresentation';
export interface GuiExternalPresentation {
 readonly gamepad?:(sample:GamepadControlSample,target:GuiElement)=>boolean;
 readonly keyboard?:(event:KeyboardEvent,target:GuiElement)=>boolean;
 readonly textEdit?:(edit:GuiTextBufferEdit & Readonly<{selectionUtf16:readonly[number,number]}>,input:GuiInput)=>void;
 readonly inputGeometry?:(input:GuiInput)=>GuiInputGeometry|undefined;
 readonly presentation?:(input:GuiInput)=>GuiInputPresentation|undefined;
 readonly onRelease?:()=>void;
}
const bindings=new WeakMap<GuiElement,GuiExternalPresentation>();
function binding(element:GuiElement):GuiExternalPresentation|undefined{
 let node:GuiElement|null=element;const visited=new Set<GuiElement>();
 while(node){if(visited.has(node)||visited.size>=128)throw new Error('External GUI presentation hierarchy is cyclic or too deep.');visited.add(node);const owner=bindings.get(node);if(owner)return owner;node=node.parent;}
 return undefined;
}
export function isGuiExternallyPainted(element:GuiElement):boolean{return binding(element)!==undefined;}
export function readGuiExternalInputGeometry(input:GuiInput):GuiInputGeometry|undefined{return binding(input)?.inputGeometry?.(input);}
export function readGuiExternalPresentation(input:GuiInput):GuiInputPresentation|undefined{return binding(input)?.presentation?.(input);}
export function bindGuiExternalPresentation(element:GuiElement,options:GuiExternalPresentation):()=>void{
 if(bindings.has(element))throw new Error('GUI element already has an external presentation owner.');
 const value=Object.freeze({...options});bindings.set(element,value);let released=false;
 return()=>{if(released)return;released=true;if(bindings.get(element)===value)bindings.delete(element);};
}

function capability(element:GuiElement,key:'keyboard'|'textEdit'|'gamepad'):GuiExternalPresentation|undefined {let node:GuiElement|null=element;const seen=new Set<GuiElement>();while(node){if(seen.has(node)||seen.size>=128)throw new Error('External GUI input hierarchy is cyclic or too deep.');seen.add(node);const value=bindings.get(node);if(value?.[key])return value;node=node.parent;}return undefined;}
export function routeGuiExternalKeyboard(target:GuiElement,event:KeyboardEvent):boolean{return capability(target,'keyboard')?.keyboard?.(event,target)??false;}
export function notifyGuiExternalTextEdit(input:GuiInput,edit:GuiTextBufferEdit & Readonly<{selectionUtf16:readonly[number,number]}>):void{capability(input,'textEdit')?.textEdit?.(edit,input);}

export function routeGuiExternalGamepad(target:GuiElement,sample:GamepadControlSample):boolean{return capability(target,'gamepad')?.gamepad?.(sample,target)??false;}
