import assert from 'node:assert/strict';
import test from 'node:test';
import {GuiSystem,GuiRoot,GuiButton,GuiModal,GuiInput} from '../dist/gui.js';

class Surface extends EventTarget {
 tabIndex=0; installed=new Map();captured=new Set();
 addEventListener(name,fn,options){if(!this.installed.has(name))this.installed.set(name,new Set());this.installed.get(name).add(fn);super.addEventListener(name,fn,options);}
 removeEventListener(name,fn,options){this.installed.get(name)?.delete(fn);super.removeEventListener(name,fn,options);}
 count(name){return this.installed.get(name)?.size??0;}
 setPointerCapture(id){this.captured.add(id);}hasPointerCapture(id){return this.captured.has(id);}releasePointerCapture(id){this.captured.delete(id);}
}
function key(surface,code){const e=new Event('keydown',{cancelable:true});Object.assign(e,{code,key:code,repeat:false});surface.dispatchEvent(e);return e;}
function setup(){
 const canvas=new Surface(),engine={canvas},a=new GuiSystem(engine),b=new GuiSystem(engine),ra=new GuiRoot(),rb=new GuiRoot();
 a.roots.add(ra);b.roots.add(rb);const refresh=()=>{ra.layout(200,100);rb.layout(200,100);a.inputDomain.refresh();};
 return {canvas,a,b,ra,rb,refresh,close(){a.destroy();b.destroy();ra.destroy();rb.destroy();}};
}

test('two GUI systems share one native keyboard listener and each Tab/confirm is processed once',()=>{
 const s=setup();let ca=0,cb=0;const a=s.ra.add(new GuiButton({id:'a',onClick:()=>ca++})),b=s.rb.add(new GuiButton({id:'b',onClick:()=>cb++}));s.refresh();
 assert.equal(s.a.focus,s.b.focus);assert.equal(s.canvas.count('keydown'),1);
 key(s.canvas,'Tab');assert.equal(s.a.focus.focused,a);key(s.canvas,'Enter');assert.deepEqual([ca,cb],[1,0]);
 key(s.canvas,'Tab');assert.equal(s.a.focus.focused,b);key(s.canvas,'Enter');assert.deepEqual([ca,cb],[1,1]);
 s.close();assert.equal(s.canvas.count('keydown'),0);assert.equal(s.canvas.count('blur'),0);
});

test('modal in a separate overlay layer traps keyboard input and restores sidebar focus',()=>{
 const s=setup();let actions=0;const a=s.ra.add(new GuiButton({id:'underlying',onClick:()=>actions++})),modal=s.rb.add(new GuiModal());s.refresh();s.a.focus.focus(a);modal.show();
 key(s.canvas,'Tab');assert.equal(s.a.focus.modal,modal);assert.ok(modal.findById(s.a.focus.focused.id));
 key(s.canvas,'Escape');assert.equal(modal.visible,false);assert.equal(s.a.focus.focused,a);assert.equal(actions,0);s.close();
});

test('removing one system preserves the remaining listener, focus and actions',()=>{
 const s=setup();let count=0;const b=s.rb.add(new GuiButton({onClick:()=>count++}));s.refresh();s.a.focus.focus(b);s.a.destroy();
 assert.equal(s.canvas.count('keydown'),1);assert.equal(s.b.focus.focused,b);key(s.canvas,'Enter');assert.equal(count,1);
 s.close();assert.equal(s.canvas.count('keydown'),0);
});

test('canvas blur cancels pressed visuals and native capture without destroying the remaining domain',()=>{
 const s=setup();const a=s.ra.add(new GuiButton());s.refresh();s.a.pressed=a;a.pressed=true;s.canvas.setPointerCapture(7);s.a.capturedPointers.add(7);
 s.canvas.dispatchEvent(new Event('blur'));assert.equal(a.pressed,false);assert.equal(s.a.pressed,null);assert.equal(s.canvas.captured.size,0);assert.equal(s.canvas.count('keydown'),1);s.close();
});

test('active IME owns directional and escape keys before global modal navigation',()=>{
 const s=setup(),modal=s.rb.add(new GuiModal()),input=modal.add(new GuiInput());s.refresh();modal.show();s.a.inputDomain.refresh();s.b.focus.focus(input);
 assert.equal(s.canvas.count('compositionstart'),1);assert.equal(s.canvas.count('compositionend'),1);
 s.canvas.dispatchEvent(new Event('compositionstart'));key(s.canvas,'ArrowDown');key(s.canvas,'Escape');
 assert.equal(s.a.focus.focused,input);assert.equal(modal.visible,true);assert.equal(s.b.composing,true);assert.equal(s.a.composing,false);
 const end=new Event('compositionend',{cancelable:true});Object.assign(end,{data:'中'});s.canvas.dispatchEvent(end);assert.equal(input.value,'中','shared text listener commits once');
 s.close();assert.equal(s.canvas.count('compositionend'),0);
});
