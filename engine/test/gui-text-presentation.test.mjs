import test from 'node:test';
import assert from 'node:assert/strict';
import {GuiInput,GuiRoot,GuiSystem,GuiScrollView} from '../dist/gui.js';

function fixture(){
 const canvas=new EventTarget();canvas.tabIndex=0;let width=200,height=200;
 canvas.getBoundingClientRect=()=>({left:0,top:0,width,height});
 const requests=[],carets=[];
 const host={open(q){requests.push(q);return {setValue(){},setSelection(){},setCaretRect:r=>carets.push({...r}),close(){}};}};
 const engine={canvas,displayWidth:200,displayHeight:200};
 const system=new GuiSystem(engine,{textInputHost:host}),root=new GuiRoot({theme:{fontSize:16}});
 system.roots.add(root);root.layout(width,height);system.inputDomain.refresh();
 return {system,root,requests,carets,resize(w,h){width=w;height=h;engine.displayWidth=w;engine.displayHeight=h;root.layout(w,h);},sync(){system.dispatchAction('right');},close(){system.destroy();root.destroy();}};
}

test('caret timer invalidates retained paint only on blink phases and stops on blur or destroy',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(),input=f.root.add(new GuiInput({value:'A😀B'}));f.root.layout(200,200);f.system.focus.focus(input);
 const changes=[];f.root.onInvalidation(c=>changes.push(c));
 assert.equal(f.system.animating,false,'a caret must not force every-frame region redraws');
 t.mock.timers.tick(499);assert.equal(changes.length,0);
 t.mock.timers.tick(1);assert.equal(changes.filter(c=>c.reasons.includes('paint')).length,1);
 t.mock.timers.tick(500);assert.equal(changes.filter(c=>c.reasons.includes('paint')).length,2);
 f.system.focus.blur();changes.length=0;t.mock.timers.tick(2000);assert.equal(changes.length,0);
 f.system.focus.focus(input);f.close();changes.length=0;t.mock.timers.tick(2000);assert.equal(changes.length,0);
});

test('long text shares clipped caret geometry with the responder and pointer mapping uses the same scroll offset',()=>{
 const f=fixture(),input=f.root.add(new GuiInput({x:10,y:10,width:100,value:'A'.repeat(40)+'😀'}));f.root.layout(200,200);f.system.focus.focus(input);
 const caret=f.carets.at(-1);assert.ok(caret.x>=18&&caret.x+caret.width<=102,JSON.stringify(caret));
 f.system.renderer.prepare=()=>{};
 const event=new Event('pointerdown',{cancelable:true});Object.assign(event,{pointerId:1,pointerType:'mouse',button:0,buttons:1,clientX:20,clientY:25});f.system.engine.canvas.dispatchEvent(event);
 assert.ok(input.caretIndex>20,'pointer hits the visible suffix, rather than the clipped beginning');
 assert.ok(input.caretIndex!==41,'no caret inside the surrogate pair');f.close();
});

test('keyboard occlusion permits enough scroll even for content that previously fit, and restores constraints after hide',()=>{
 const f=fixture(),scroll=f.root.add(new GuiScrollView({width:'100%',height:'100%',contentHeight:200}));
 const input=scroll.add(new GuiInput({y:160,width:180,value:'中😀'}));f.root.layout(200,200);f.system.focus.focus(input);assert.equal(scroll.maxScrollY,0);
 const changes=[];f.root.onInvalidation(change=>changes.push(change));
 const request=f.requests.at(-1);request.onViewportInset({top:0,right:0,bottom:100,left:0});
 assert.ok(changes.some(c=>c.reasons.includes('input')),'keyboard geometry must wake a stopped demand host immediately');f.sync();
 assert.ok(scroll.scrollY>0);assert.equal(scroll.maxScrollY,100);const caret=f.carets.at(-1);assert.ok(caret.y>=0&&caret.y+caret.height<=100);
 assert.equal(scroll.getLayoutOptions().height,'100%');assert.equal(scroll.contentHeight,200,'occlusion must not overwrite persisted content height');
 request.onViewportInset({top:0,right:0,bottom:0,left:0});f.sync();assert.equal(scroll.maxScrollY,0);assert.equal(scroll.scrollY,0);
 f.resize(300,120);request.onViewportInset({top:0,right:0,bottom:60,left:0});f.sync();
 const rotated=f.carets.at(-1);assert.ok(rotated.y+rotated.height<=60);f.system.focus.blur();assert.equal(scroll.maxScrollY,80);f.close();
});

test('multiline rendering, selection, preedit underline and host caret share line positions and vertical scrolling',()=>{
 const f=fixture(),input=f.root.add(new GuiInput({x:0,y:0,width:180,height:60,multiline:true,value:'a\nb\nc\nd\ne'}));f.root.layout(200,200);f.system.focus.focus(input);
 let caret=f.carets.at(-1);assert.ok(caret.y>=8&&caret.y+caret.height<=52);
 const renderer=f.system.renderer;renderer.currentFont={size:16,lineHeight:19.2,chars:new Map(Array.from('abcde?•中').map(c=>[c.codePointAt(0),{xadvance:8}])),kernings:new Map()};
 input.beginComposition();input.updateComposition('中');renderer.addInput(input,f.root.theme);
 const lines=renderer.textBatch.commands;assert.equal(lines.length,5);assert.equal(lines.at(-1).text,'e中');
 assert.ok(lines.every(line=>line.clip&&line.clip.height===44));assert.ok(lines.at(-1).y<52);
 assert.ok(renderer.batch.commands.some(shape=>shape.height===1),'marked text gets a clipped underline');
 input.cancelComposition();input.setSelection(0,5);renderer.textBatch.clear();renderer.batch.clear();renderer.addInput(input,f.root.theme);
 assert.ok(renderer.batch.commands.filter(shape=>shape.color[3]===0.42).length>=2,'multiline selection has one rectangle per affected line');f.close();
});

test('native viewport state is cleared once on session close and late keyboard callbacks cannot reapply it',()=>{
 const f=fixture(),input=f.root.add(new GuiInput());f.root.layout(200,200);f.system.focus.focus(input);
 const request=f.requests[0];request.onViewportInset({top:0,right:0,bottom:100,left:0});f.system.focus.blur();
 assert.equal(f.system.textViewportInset.bottom,0);request.onViewportInset({top:0,right:0,bottom:200,left:0});assert.equal(f.system.textViewportInset.bottom,0);f.close();
});

test('CRLF, CR and LF render as logical lines while host caret and public indices remain original UTF-16',()=>{
 const f=fixture(),input=f.root.add(new GuiInput({width:180,height:100,multiline:true,value:'a\r\nb\rc\nd'}));f.root.layout(200,200);f.system.focus.focus(input);
 const renderer=f.system.renderer;renderer.addInput(input,f.root.theme);assert.deepEqual(renderer.textBatch.commands.map(c=>c.text),['a','b','c','d']);
 input.setCaret(3);const caret=f.system.textCaretRect(input);assert.ok(Math.abs(caret.y-27.2)<1e-6);assert.equal(input.caretIndex,3);assert.equal(input.value,'a\r\nb\rc\nd');
 const single=new GuiInput({value:'a\r\nb\rc\nd'});single.layout({x:0,y:0,width:200,height:100});renderer.textBatch.clear();renderer.addInput(single,f.root.theme);assert.equal(renderer.textBatch.commands[0].text,'a b c d');f.close();
});

test('surface-relative safe insets also reveal the caret when the canvas has a nonzero window origin',()=>{
 const f=fixture();f.system.engine.canvas.getBoundingClientRect=()=>({left:40,top:60,width:200,height:200});
 const scroll=f.root.add(new GuiScrollView({width:'100%',height:'100%',contentHeight:400})),input=scroll.add(new GuiInput({y:160,width:180,value:'a'}));f.root.layout(200,200);scroll.scrollTo(160);f.system.focus.focus(input);
 f.requests[0].onViewportInset({top:10,right:0,bottom:0,left:0});const caret=f.system.textCaretRect(input);assert.ok(caret.y>=70);assert.equal(scroll.scrollY,157);f.close();
});

test('length counter follows committed UTF-16 limit through edits, IME, rejection and undo',()=>{
 const f=fixture(),input=f.root.add(new GuiInput({width:200,height:40,maxLength:4,value:'A😀B'}));f.root.layout(200,200);
 const renderer=f.system.renderer;
 const counter=()=>{renderer.textBatch.clear();renderer.batch.clear();renderer.addInput(input,f.root.theme);return renderer.textBatch.commands.at(-1)?.text;};
 assert.equal(counter(),'4/4');input.insertText('X');assert.equal(counter(),'4/4');input.deleteBackward();assert.equal(counter(),'3/4');input.beginComposition();input.updateComposition('我');assert.equal(counter(),'3/4');input.commitComposition();assert.equal(counter(),'4/4');input.undo();assert.equal(counter(),'3/4');
 input.value='';assert.equal(counter(),'0/4');input.maxLength=0;assert.equal(counter(),'0/0');input.maxLength=Infinity;assert.equal(counter(),undefined);assert.equal(renderer.textBatch.commands.length,0);f.close();
});

test('counter and eye have visible separate gutters with clipped text and multiline footer',()=>{
 const f=fixture(),input=f.root.add(new GuiInput({width:200,height:40,value:'A😀B',maxLength:4,inputType:'password'}));f.root.layout(200,200);
 const r=f.system.renderer;r.currentFont={size:16,lineHeight:19.2,chars:new Map(Array.from('0123456789/•?').map(c=>[c.codePointAt(0),{xadvance:8}])),kernings:new Map()};
 r.addInput(input,f.root.theme);const [text,count]=r.textBatch.commands;
 assert.equal(count.text,'4/4');assert.ok(text.clip.x+text.clip.width<=count.x);assert.ok(count.x+count.width<=164);assert.ok(count.clip.x+count.clip.width>=200,'counter must not inherit text clip');
 const eye=r.batch.commands.filter(shape=>shape.x>=164);assert.ok(eye.length>=3);assert.ok(eye.every(shape=>shape.clip.x+shape.clip.width>=shape.x+shape.width),'eye must be visible outside text clip');
 const multiline=f.root.add(new GuiInput({width:200,height:100,multiline:true,value:'A😀B',maxLength:4}));f.root.layout(200,200);r.textBatch.clear();r.batch.clear();r.addInput(multiline,f.root.theme);const [multi,footer]=r.textBatch.commands;assert.ok(multi.clip.y+multi.clip.height<=footer.y);assert.ok(footer.y+footer.height<=100);f.close();
});
