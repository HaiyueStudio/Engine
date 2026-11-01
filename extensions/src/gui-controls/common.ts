import{GuiElement}from'@haiyue/engine/gui';
import{LayoutError}from'../layout.js';
export const invalid=(message:string):never=>{throw new LayoutError('invalid-input',message);};
export function stableKey(value:string):string{if(typeof value!=='string'||!value.trim())invalid('GUI items require a nonempty stable key.');return value;}
export function text(value:string):string{if(typeof value!=='string')invalid('GUI labels must be strings.');return value;}
export function flag(value:boolean|undefined):boolean{if(value!==undefined&&typeof value!=='boolean')invalid('GUI disabled state must be boolean.');return value??false;}
export function live(dead:boolean):void{if(dead)throw new LayoutError('disposed','GUI composite is disposed.');}
export function onClick(element:GuiElement,run:()=>void):()=>void{const listener=()=>run();element.on('click',listener);return()=>element.off('click',listener);}
export function array(value:unknown):asserts value is readonly unknown[]{if(!Array.isArray(value)||value.length>10000)invalid('GUI item arrays must respect the shared 10000-node bound.');}
