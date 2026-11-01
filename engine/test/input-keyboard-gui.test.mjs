import assert from 'node:assert/strict';
import test from 'node:test';
import {KeyboardComponent as K} from '../dist/components.js';
import {GuiRoot,GuiButton,GuiSystem} from '../dist/gui.js';
import {InputMap} from '../dist/input.js';

test('legacy scene action APIs filter GUI consumption while raw sampling, hold/release and later fresh strokes remain compatible',()=>{
 const oldWindow=globalThis.window,oldElement=globalThis.HTMLElement,target=new EventTarget();
 globalThis.window=target;globalThis.HTMLElement=class{};
 const canvas=Object.assign(new EventTarget(),{tabIndex:0}),gui=new GuiSystem({canvas},{preventDefault:false}),root=new GuiRoot(),button=root.add(new GuiButton());
 gui.roots.add(root);root.layout(100,100);gui.focus.setRoots([root.root]);gui.focus.focus(button);
 const keyboard=new K();K.preventDefaultForMappedKeys=false;K.setInputMap({jump:['Space']});keyboard.onEntityAddToWorld();let time=0;
 const advance=()=>keyboard.onUpdate(null,++time,0,null);
 const key=(type,route=true)=>{const e=new Event(type,{cancelable:true});Object.assign(e,{code:'Space',key:' ',repeat:false});if(route)canvas.dispatchEvent(e);target.dispatchEvent(e);return e;};
 try {
  const down=key('keydown');advance();assert.equal(InputMap.isEventConsumed(down),true);assert.equal(down.defaultPrevented,false);assert.equal(K.isKeyPressed('Space'),true);assert.equal(K.wasKeyPressed('Space'),true);assert.equal(K.isPressed('jump'),false);assert.equal(K.wasPressed('jump'),false);assert.deepEqual(K.actionSnapshot().pressed,[]);
  gui.destroy();advance();assert.equal(K.isPressed('jump'),false);assert.equal(K.isKeyPressed('Space'),true);
  key('keyup',false);advance();assert.equal(K.wasKeyReleased('Space'),true);assert.equal(K.wasReleased('jump'),false);
  key('keydown',false);advance();assert.equal(K.isPressed('jump'),true);assert.equal(K.wasPressed('jump'),true);
  key('keyup',false);advance();assert.equal(K.wasReleased('jump'),true);
  target.dispatchEvent(new Event('blur'));advance();keyboard.onEntityRemoveFromWorld();assert.equal(K.isKeyPressed('Space'),false);
 }finally{keyboard.onEntityRemoveFromWorld();gui.destroy();root.destroy();K.setInputMap(InputMap.defaultTetris());K.preventDefaultForMappedKeys=true;globalThis.window=oldWindow;globalThis.HTMLElement=oldElement;}
});

test('GUI takeover releases a previously scene-owned held key once while raw state remains held',()=>{
 const oldWindow=globalThis.window,oldElement=globalThis.HTMLElement,target=new EventTarget();globalThis.window=target;globalThis.HTMLElement=class{};
 const canvas=Object.assign(new EventTarget(),{tabIndex:0}),gui=new GuiSystem({canvas},{preventDefault:false}),root=new GuiRoot(),button=root.add(new GuiButton());gui.roots.add(root);root.layout(100,100);gui.focus.setRoots([root.root]);
 const keyboard=new K();K.preventDefaultForMappedKeys=false;K.setInputMap({jump:['Space']});keyboard.onEntityAddToWorld();let time=1000;const advance=()=>keyboard.onUpdate(null,++time,0,null);
 const key=(type,route,repeat=false)=>{const event=new Event(type,{cancelable:true});Object.assign(event,{code:'Space',key:' ',repeat});if(route)canvas.dispatchEvent(event);target.dispatchEvent(event);return event;};
 try{key('keydown',false);advance();assert(K.isPressed('jump'));assert(K.wasPressed('jump'));gui.focus.focus(button);const repeat=key('keydown',true,true);assert(InputMap.isEventConsumed(repeat));advance();assert.equal(K.isPressed('jump'),false);assert(K.wasReleased('jump'));assert(K.isKeyPressed('Space'));advance();assert.equal(K.wasReleased('jump'),false);key('keyup',true);advance();assert.equal(K.wasReleased('jump'),false);gui.destroy();key('keydown',false);advance();assert(K.wasPressed('jump'));key('keyup',false);advance();assert(K.wasReleased('jump'));}
 finally{keyboard.onEntityRemoveFromWorld();gui.destroy();root.destroy();K.setInputMap(InputMap.defaultTetris());K.preventDefaultForMappedKeys=true;globalThis.window=oldWindow;globalThis.HTMLElement=oldElement;}
});
