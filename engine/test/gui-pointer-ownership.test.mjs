import assert from 'node:assert/strict';
import test from 'node:test';
import {GuiSystem,GuiRoot,GuiButton,GuiSlider,GuiInput} from '../dist/gui.js';
import {World} from '../dist/ecs.js';

function setup(){const system=new GuiSystem({});system.renderer.prepare=()=>{};const root=new GuiRoot(),world=new World('PointerOwnership');system.roots.add(root);return {system,root,world,ready(){root.layout(300,200);},send(type,id,x,y){const native={pointerId:id,pointerType:'touch',button:0,buttons:type==='pointerup'?0:1,preventDefault(){}};system.dispatchPointerEvent(world,{type,native,x,y});},close(){system.destroy();root.destroy();}};}

test('two touch sequences in one GUI keep independent press owners and click once each',()=>{
 const s=setup();let a=0,b=0;const left=s.root.add(new GuiButton({width:80,height:40,onClick:()=>a++})),right=s.root.add(new GuiButton({x:120,width:80,height:40,onClick:()=>b++}));s.ready();
 s.send('pointerdown',1,10,10);s.send('pointerdown',2,130,10);assert.equal(left.pressed,true);assert.equal(right.pressed,true);
 s.send('pointerup',1,10,10);assert.equal(right.pressed,true);s.send('pointerup',2,130,10);assert.deepEqual([a,b],[1,1]);assert.equal(s.system.pointerStates.size,0);s.close();
});

test('pointer cancellation releases a slider without committing or clicking',()=>{
 const s=setup();let commits=0,cancels=0;const slider=s.root.add(new GuiSlider({width:100,height:30,onCommit:()=>commits++,onPointerCancel:()=>cancels++}));s.ready();
 s.send('pointerdown',3,30,15);s.send('pointercancel',3,90,15);assert.equal(slider.pressed,false);assert.equal(commits,0);assert.equal(cancels,1);s.close();
});

test('cancelling text selection clears selection drag without submitting the field',()=>{
 const s=setup();const input=s.root.add(new GuiInput({value:'abc',width:100,height:30}));s.system.updateInputCaretFromPointer=()=>{};s.ready();
 s.send('pointerdown',4,10,10);input.selecting=true;s.send('pointercancel',4,150,10);assert.equal(input.selecting,false);assert.equal(input.pressed,false);s.close();
});

test('lifecycle cancellation clears every held touch and notifies each owner once',()=>{
 const s=setup();let cancels=0,commits=0;const a=s.root.add(new GuiSlider({width:80,height:30,onCommit:()=>commits++,onPointerCancel:e=>{cancels++;assert.equal(e.nativeEvent.type,'pointercancel');}})),b=s.root.add(new GuiButton({x:120,width:80,height:30,onPointerCancel:()=>cancels++}));s.ready();
 s.send('pointerdown',1,10,10);s.send('pointerdown',2,130,10);s.system.cancelInput();assert.equal(a.pressed,false);assert.equal(b.pressed,false);assert.equal(cancels,2);assert.equal(commits,0);assert.equal(s.system.pointerStates.size,0);
 s.system.cancelInput();assert.equal(cancels,2);s.close();
});

test('orphan release over a control cannot create a click or slider commit',()=>{
 const s=setup();let clicks=0,commits=0;s.root.add(new GuiButton({width:80,height:30,onClick:()=>clicks++}));s.root.add(new GuiSlider({x:120,width:80,height:30,onCommit:()=>commits++}));s.ready();
 s.send('pointerup',1,10,10);s.send('pointerup',2,130,10);assert.equal(clicks,0);assert.equal(commits,0);s.close();
});

test('disabling a system cancels all sequences immediately',()=>{
 const s=setup();let cancels=0;const button=s.root.add(new GuiButton({width:80,height:30,onPointerCancel:()=>cancels++}));s.ready();
 s.send('pointerdown',1,10,10);s.system.disabled=true;assert.equal(cancels,1);assert.equal(button.pressed,false);assert.equal(s.system.pointerStates.size,0);s.close();
});

test('password eye preserves focus, selection, value and history, and remasks on blur',()=>{
 const s=setup();let changes=0;const input=s.root.add(new GuiInput({value:'A😀é',inputType:'password',width:200,height:40,onChange:()=>changes++}));s.ready();s.system.focus.focus(input);input.setSelection(1,3);
 s.send('pointerdown',10,182,18);s.send('pointerup',10,182,18);
 assert.equal(input.displayValue,'A😀é');assert.equal(input.inputType,'password');assert.equal(input.focused,true);assert.deepEqual([input.selectionStart,input.selectionEnd],[1,3]);assert.equal(changes,0);assert.equal(input.canUndo,false);assert.equal(input.displaySelectionEnd,3);
 s.send('pointerdown',11,182,18);s.send('pointerup',11,182,18);assert.equal(input.displayValue,'•••');assert.equal(input.displaySelectionEnd,2);
 s.send('pointerdown',12,182,18);s.send('pointerup',12,182,18);s.system.focus.blur();assert.equal(input.displayValue,'•••');s.close();
});

test('password eye ignores cancellation, releases outside, orphan releases and disabled controls',()=>{
 const s=setup(),input=s.root.add(new GuiInput({value:'secret',inputType:'password',width:200,height:40}));s.ready();
 s.send('pointerdown',1,182,18);s.send('pointercancel',1,182,18);assert.equal(input.displayValue,'••••••');
 s.send('pointerdown',2,182,18);s.send('pointerup',2,120,18);assert.equal(input.displayValue,'••••••');
 s.send('pointerup',3,182,18);assert.equal(input.displayValue,'••••••');
 input.disabled=true;s.send('pointerdown',4,182,18);s.send('pointerup',4,182,18);assert.equal(input.displayValue,'••••••');s.close();
});
