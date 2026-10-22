import test from 'node:test';
import assert from 'node:assert/strict';
import {GuiInput,GuiRoot,GuiSystem} from '../dist/gui.js';

function fixture(options={}){
 const selections=[],canvas=new EventTarget();canvas.tabIndex=0;canvas.focus=()=>{};canvas.getBoundingClientRect=()=>({left:0,top:0,width:500,height:300});
 const system=new GuiSystem({canvas,displayWidth:500,displayHeight:300},{textInputHost:{open(){return {setValue(){},setSelection:(...range)=>selections.push(range),setCaretRect(){},close(){}};}}});
 system.renderer.prepare=()=>{};system.renderer.measureTextWidth=text=>text.length*10;system.renderer.measureTextLineHeight=()=>20;
 const root=new GuiRoot();system.roots.add(root);let changes=0;
 const input=root.add(new GuiInput({value:'A😀é👩🏽‍💻',x:10,y:10,width:300,height:60,...options,onChange:()=>changes++}));
 const other=root.add(new GuiInput({value:'other',x:10,y:100,width:300,height:40}));root.layout(500,300);system.inputDomain.refresh();
 const send=(type,time,x=35,y=30,id=1,kind='mouse',button=0)=>system.dispatchPointerEvent(null,{type,x,y,native:{type,timeStamp:time,pointerId:id,pointerType:kind,button,buttons:type==='pointerup'||type==='pointercancel'?0:1,isPrimary:true,preventDefault(){}}});
 const click=(time,x=35,y=30,id=1,kind='mouse',button=0)=>{send('pointerdown',time,x,y,id,kind,button);send('pointerup',time+10,x,y,id,kind,button);};
 return {system,root,input,other,selections,send,click,get changes(){return changes;},close(){system.destroy();root.destroy();}};
}

test('third completed primary click selects the whole Unicode value and immediately synchronizes the native selection',()=>{
 const f=fixture();try{
  f.click(100);assert.equal(f.input.hasSelection,false);f.click(200);assert.equal(f.input.hasSelection,false);
  f.click(300);assert.equal(f.input.selectedText,f.input.value);assert.deepEqual(f.selections.at(-1),[0,f.input.value.length]);
  assert.equal(f.input.selecting,false);assert.equal(f.changes,0);assert.equal(f.input.canUndo,false);
  f.click(400);assert.equal(f.input.hasSelection,false,'a subsequent ordinary click places the caret again');
 }finally{f.close();}
});

test('slow, distant, held and dragged presses cannot complete a triple click',()=>{
 for(const mode of ['slow','distant','held','dragged']){
  const f=fixture();try{
   f.click(100);f.click(200);
   if(mode==='slow')f.click(1000);
   if(mode==='distant')f.click(300,90);
   if(mode==='held'){f.send('pointerdown',300);f.send('pointerup',900);}
   if(mode==='dragged'){f.send('pointerdown',300);f.send('pointermove',310,90);f.send('pointermove',320,35);f.send('pointerup',330);}
   assert.notEqual(f.input.selectedText,f.input.value,mode);assert.equal(f.changes,0);
  }finally{f.close();}
 }
});

test('pointer cancellation, focus changes and input suspension reset the click sequence',()=>{
 for(const mode of ['cancel','blur','suspend']){
  const f=fixture();try{
   f.click(100);f.click(200);
   if(mode==='cancel'){f.send('pointerdown',250);f.send('pointercancel',260);}
   if(mode==='blur')f.system.focus.focus(f.other);
   if(mode==='suspend')f.system.cancelInput();
   f.click(300);assert.equal(f.input.hasSelection,false,mode);
  }finally{f.close();}
 }
});

test('touch taps may use fresh pointer IDs and readonly multiline fields still select all',()=>{
 const f=fixture({value:'中文\nA😀\né👩🏽‍💻',multiline:true,readOnly:true});try{
  f.click(100,35,30,10,'touch');f.click(200,35,30,11,'touch');f.click(300,35,30,12,'touch');
  assert.equal(f.input.selectedText,'中文\nA😀\né👩🏽‍💻');assert.equal(f.changes,0);assert.equal(f.input.canUndo,false);
 }finally{f.close();}
});

test('changing the committed value interrupts the preceding click sequence without changing history',()=>{
 const f=fixture();try{
  f.click(100);f.click(200);f.input.setValue('replacement😀');f.click(300);assert.equal(f.input.hasSelection,false);
  f.click(400);f.click(500);assert.equal(f.input.selectedText,'replacement😀');assert.equal(f.changes,0);assert.equal(f.input.canUndo,false);
 }finally{f.close();}
});

test('mixed pointer kinds, secondary buttons and overlapping contacts cannot form a triple click',()=>{
 for(const mode of ['kind','secondary','overlap']){
  const f=fixture();try{
   f.click(100);f.click(200);
   if(mode==='kind')f.click(300,35,30,10,'touch');
   if(mode==='secondary')f.click(300,35,30,1,'mouse',2);
   if(mode==='overlap'){f.send('pointerdown',300,35,30,10,'touch');f.send('pointerdown',301,35,30,11,'touch');f.send('pointerup',310,35,30,11,'touch');f.send('pointerup',311,35,30,10,'touch');}
   assert.notEqual(f.input.selectedText,f.input.value,mode);
  }finally{f.close();}
 }
});

test('three password-eye presses do not select text or enter a body-click sequence',()=>{
 const f=fixture({value:'A😀secret',inputType:'password',width:200,height:40});try{
  f.system.focus.focus(f.input);f.input.setSelection(1,3);
  f.click(100,192,30);f.click(200,192,30);f.click(300,192,30);
  assert.deepEqual([f.input.selectionAnchor,f.input.selectionFocus],[1,3]);assert.equal(f.changes,0);assert.equal(f.input.canUndo,false);
  f.click(400);assert.equal(f.input.hasSelection,false);f.click(500);assert.equal(f.input.hasSelection,false);f.click(600);assert.equal(f.input.selectedText,f.input.value);
  assert.equal(f.input.inputType,'password');
 }finally{f.close();}
});
