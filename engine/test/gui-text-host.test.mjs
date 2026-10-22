import test from 'node:test';
import assert from 'node:assert/strict';
import {GuiInput,GuiRoot,GuiSystem} from '../dist/gui.js';

function fixture({finish=null,reenterClose=false}={}){
 const canvas=new EventTarget();canvas.tabIndex=0;canvas.getBoundingClientRect=()=>({left:10,top:20,width:200,height:100});
 const records=[],insets=[];
 const host={open(request){const record={request,values:[],selections:[],rects:[],closed:0};records.push(record);
  return {setValue:value=>record.values.push(value),setSelection:(a,b)=>record.selections.push([a,b]),setCaretRect:r=>record.rects.push({...r}),
   finish:()=>finish?finish(request):null,close:()=>{record.closed++;if(reenterClose)request.onEdit({generation:request.generation,startUtf16:0,endUtf16:0,text:'stale'});}};
 }};
 const system=new GuiSystem({canvas,displayWidth:100,displayHeight:50},{textInputHost:host,onViewportInset:i=>insets.push(i)}),root=new GuiRoot({theme:{fontSize:16}});
 const a=root.add(new GuiInput({id:'a',x:5,y:5,width:90,value:'ab'})),b=root.add(new GuiInput({id:'b',y:40,value:'B'}));
 system.roots.add(root);root.layout(100,100);system.inputDomain.refresh();
 return {system,root,canvas,a,b,records,insets,focus:target=>system.focus.focus(target),close(){system.destroy();root.destroy();}};
}
const composition=(request,phase,text='',extra={})=>request.onComposition({generation:request.generation,phase,text,selectionUtf16:[text.length,text.length],...extra});

test('host composition preview commits once, is synchronized, and duplicate transaction edits are ignored',()=>{
 const f=fixture();f.focus(f.a);const r=f.records[0],q=r.request;
 composition(q,'start');composition(q,'update','中');assert.equal(f.a.value,'ab');assert.equal(f.a.displayValue,'ab中');
 composition(q,'commit','中',{eventId:1});composition(q,'commit','中',{eventId:1});
 q.onEdit({generation:q.generation,startUtf16:2,endUtf16:2,text:'中',eventId:1});
 assert.equal(f.a.value,'ab中');assert.deepEqual(r.values,['ab中']);assert.deepEqual(r.selections.at(-1),[3,3]);
 q.onCommand('undo');assert.equal(f.a.value,'ab');q.onCommand('redo');assert.equal(f.a.value,'ab中');f.close();assert.equal(r.closed,1);
});
test('focus A to B to A uses distinct generations; stale edits, selection, inset and close callbacks cannot write',()=>{
 const f=fixture({reenterClose:true});f.focus(f.a);const old=f.records[0].request;f.focus(f.b);f.focus(f.a);const current=f.records[2].request;
 assert.notEqual(old.generation,current.generation);
 old.onEdit({generation:old.generation,startUtf16:0,endUtf16:0,text:'bad'});old.onSelection(0,0,old.generation);old.onViewportInset({top:0,right:0,bottom:20,left:0});
 assert.equal(f.a.value,'ab');assert.equal(f.a.caretIndex,2);assert.equal(f.b.value,'B');assert.deepEqual(f.insets,[]);
 current.onEdit({generation:current.generation,startUtf16:2,endUtf16:2,text:'😀'});assert.equal(f.a.value,'ab😀');f.close();assert.equal(f.a.value,'ab😀');
});
test('unconfirmed focus loss cancels and restores selection, while an explicit host finish commits exactly once',()=>{
 for(const confirmed of [false,true]){
  const f=fixture({finish:confirmed?q=>({generation:q.generation,phase:'commit',text:'新',selectionUtf16:[1,1]}):null});
  f.a.setSelection(0,2);f.focus(f.a);const q=f.records[0].request;composition(q,'start');composition(q,'update','新');f.focus(f.b);
  assert.equal(f.a.value,confirmed?'新':'ab');assert.equal(f.a.isComposing,false);
  if(!confirmed)assert.deepEqual([f.a.selectionAnchor,f.a.selectionFocus],[0,2]);
  composition(q,'commit','late');assert.equal(f.a.value,confirmed?'新':'ab');f.close();
 }
});
test('disable, root removal and destroy close without host-confirmed commit and retain no live session',()=>{
 for(const action of ['disable','remove','destroy']){
  const f=fixture({finish:q=>({generation:q.generation,phase:'commit',text:'bad',selectionUtf16:[3,3]})});f.focus(f.a);const q=f.records[0].request;
  composition(q,'start');composition(q,'update','preview');
  if(action==='disable')f.system.disabled=true;else if(action==='remove'){f.root.remove(f.a);f.system.inputDomain.refresh();}else f.system.destroy();
  assert.equal(f.a.value,'ab');assert.equal(f.a.isComposing,false);assert.equal(f.records[0].closed,1);
  q.onEdit({generation:q.generation,startUtf16:0,endUtf16:0,text:'late'});assert.equal(f.a.value,'ab');f.close();
 }
});
test('caret screen rectangle uses the actual CSS/host transform and viewport notifications reject invalid geometry',()=>{
 const f=fixture();f.focus(f.a);const r=f.records[0],rect=r.rects.at(-1);
 assert.ok(Math.abs(rect.x-71.2)<1e-6);assert.equal(rect.y,44);assert.equal(rect.width,3);assert.equal(rect.height,36);
 r.request.onViewportInset({top:10,right:0,bottom:200,left:0});r.request.onViewportInset({top:0,right:0,bottom:NaN,left:0});
 assert.deepEqual(f.insets,[{top:10,right:0,bottom:200,left:0}]);
 f.a.setValue('z');f.system.dispatchAction('left');assert.deepEqual(r.values,['z']);assert.equal(r.selections.at(-1)[0],0);f.close();
});
test('synchronous host callbacks during open may change focus and the abandoned returned session is closed',()=>{
 const canvas=new EventTarget();canvas.tabIndex=0;canvas.getBoundingClientRect=()=>({left:0,top:0,width:200,height:100});let closed=0,system,root,a,b;
 const host={open(q){if(q.value==='A')system.focus.focus(b);return {setSelection(){},setCaretRect(){},setValue(){},close(){closed++;}};}};
 system=new GuiSystem({canvas},{textInputHost:host});root=new GuiRoot();a=root.add(new GuiInput({value:'A'}));b=root.add(new GuiInput({value:'B'}));
 system.roots.add(root);root.layout(200,100);system.inputDomain.refresh();system.focus.focus(a);
 assert.equal(system.focus.focused,b);assert.equal(closed,1);system.destroy();root.destroy();assert.equal(closed,2);
});
test('legacy canvas composition cannot submit to the next focus and keyboard undo uses the same Unicode history',()=>{
 const f=fixture();f.focus(f.a);const start=new Event('compositionstart');f.canvas.dispatchEvent(start);
 const update=new Event('compositionupdate');Object.assign(update,{data:'中'});f.canvas.dispatchEvent(update);assert.equal(f.a.displayValue,'ab中');
 f.focus(f.b);const end=new Event('compositionend');Object.assign(end,{data:'中'});f.canvas.dispatchEvent(end);assert.equal(f.b.value,'B');assert.equal(f.a.value,'ab');
 f.a.insertText('😀');f.focus(f.a);const key=new Event('keydown',{cancelable:true});Object.assign(key,{key:'z',code:'KeyZ',ctrlKey:true});f.canvas.dispatchEvent(key);assert.equal(f.a.value,'ab');f.close();
});
test('native value snapshots preserve shared surrogate/combining/ZWJ prefixes and cannot bypass length limits',()=>{
 const f=fixture();f.a.setValue('A😀B');f.focus(f.a);const q=f.records[0].request;
 q.onValue('A😁B',[3,3],q.generation,1);assert.equal(f.a.value,'A😁B');assert.equal(f.a.caretIndex,3);
 q.onValue('A😁Be\u0301',[6,6],q.generation,2);assert.equal(f.a.value,'A😁Be\u0301');assert.equal(f.a.caretIndex,6);
 f.a.setValue('👩💻');f.system.dispatchAction('right');q.onValue('👩‍💻',[3,3],q.generation,3);assert.equal(f.a.value,'👩‍💻');assert.equal(f.a.caretIndex,0,'explicit native UTF-16 index snaps backward under the frozen contract');
 f.a.maxLength=4;f.a.setValue('A😀B');f.a.setCaret(3);f.system.dispatchAction('right');
 q.onValue('A😀中B',[4,4],q.generation,4);assert.equal(f.a.value,'A😀B');assert.equal(f.records[0].values.at(-1),'A😀B');
 q.onValue('bad',[3,3],q.generation,4);assert.equal(f.a.value,'A😀B','replayed native transaction is ignored');f.close();
});
test('pointer focus cannot be stolen back from the native text responder by the canvas',()=>{
 const f=fixture();f.system.renderer.prepare=()=>{};let stolen=0;
 f.canvas.focus=()=>{stolen++;const r=f.records.at(-1);if(r&&!r.closed)r.request.onFocusLost(r.request.generation);};
 const event=new Event('pointerdown',{cancelable:true});Object.assign(event,{pointerId:1,pointerType:'mouse',button:0,buttons:1,clientX:40,clientY:50});f.canvas.dispatchEvent(event);
 assert.equal(f.system.focus.focused,f.a);assert.equal(f.records.length,1);assert.equal(f.records[0].closed,0);assert.equal(stolen,0);f.close();
});

test('programmatic preedit cancellation or value replacement retires the native lease before late snapshots',()=>{
 for(const replacement of [null,'replacement']){
  const f=fixture();f.focus(f.a);const old=f.records[0].request;composition(old,'start');composition(old,'update','中');
  if(replacement===null)f.a.cancelComposition();else f.a.setValue(replacement);
  old.onValue('ab中',[3,3],old.generation,1);old.onComposition({generation:old.generation,phase:'commit',text:'中',selectionUtf16:[1,1]});
  assert.equal(f.a.value,replacement??'ab');assert.equal(f.records[0].closed,1);assert.equal(f.records.length,2);assert.notEqual(f.records[1].request.generation,old.generation);f.close();
 }
});

test('a long live session cannot replay a retired transaction after many newer native snapshots',()=>{
 const f=fixture();f.focus(f.a);const q=f.records[0].request;
 for(let eventId=1;eventId<=100;eventId++)q.onValue('ab',[2,2],q.generation,eventId);
 q.onValue('stale',[5,5],q.generation,1);q.onEdit({generation:q.generation,startUtf16:0,endUtf16:0,text:'stale',eventId:2});
 assert.equal(f.a.value,'ab');q.onValue('ab😀',[4,4],q.generation,101);assert.equal(f.a.value,'ab😀');f.close();
});

test('legacy canvas copy/cut cannot expose a password and a pending paste cannot interrupt new preedit',async()=>{
 const f=fixture(),password=f.root.add(new GuiInput({value:'A😀secret',inputType:'password'}));f.root.layout(200,100);f.focus(password);password.selectAll();
 f.system.renderer.prepare=()=>{};for(const type of ['pointerdown','pointerup'])f.system.dispatchPointerEvent(null,{type,x:password.rect.x+password.rect.width-10,y:password.rect.y+10,routedHit:password,native:{pointerId:9,pointerType:'touch',button:0,buttons:type==='pointerdown'?1:0,preventDefault(){}}});assert.equal(password.displayValue,password.value);
 const written=[];f.system.writeClipboard=async text=>written.push(text);
 const keyboard=(key)=>{const event=new Event('keydown',{cancelable:true});Object.assign(event,{key,code:'Key'+key.toUpperCase(),ctrlKey:true});f.canvas.dispatchEvent(event);};
 for(const type of ['copy','cut']){const event=new Event(type,{cancelable:true});Object.assign(event,{clipboardData:{setData:(...args)=>written.push(args)}});f.canvas.dispatchEvent(event);assert.equal(event.defaultPrevented,true);}
 keyboard('c');keyboard('x');assert.equal(password.value,'A😀secret');assert.deepEqual(written,[]);
 let resolve;f.system.readClipboard=()=>new Promise(done=>{resolve=done;});f.focus(f.a);keyboard('v');f.a.beginComposition();f.a.updateComposition('中');resolve('old paste');await Promise.resolve();
 assert.equal(f.a.value,'ab');assert.equal(f.a.displayValue,'ab中');assert.equal(f.a.isComposing,true);f.close();
});
