import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {GuiInput,GuiSystem,GuiRoot,serializeGuiRoot,deserializeGuiRoot} from '../dist/gui.js';

const corpus=readFileSync(new URL('./gui-grapheme-15.1.txt',import.meta.url));
test('editing uses every official Unicode 15.1 extended grapheme conformance case',()=>{
 assert.equal(createHash('sha256').update(corpus).digest('hex'),'ed9c5e92fd0911ccbeeb63c97cb19c519ea272ff1112ce843abd991582dd848f');
 let cases=0;
 for(const line of corpus.toString('utf8').split(/\r?\n/u)){
  const source=line.split('#')[0].trim();if(!source)continue;
  let text='';const expected=[];
  for(const token of source.split(/\s+/u)){
   if(token==='÷')expected.push(text.length);
   else if(token!=='×')text+=String.fromCodePoint(parseInt(token,16));
  }
  const input=new GuiInput({value:text}),forward=[0];input.setCaret(0);
  for(let step=1;step<expected.length;step++){input.moveCaret(1);forward.push(input.caretIndex);}
  assert.deepEqual(forward,expected,source);
  for(let step=expected.length-2;step>=0;step--){input.moveCaret(-1);assert.equal(input.caretIndex,expected[step],source);}
  for(let offset=0;offset<=text.length;offset++){
   input.setCaret(offset);assert.equal(input.caretIndex,expected.filter(n=>n<=offset).at(-1),source);
  }
  for(let i=1;i<expected.length;i++){
   input.setValue(text);input.setCaret(expected[i]);input.deleteBackward();
   assert.equal(input.value,text.slice(0,expected[i-1])+text.slice(expected[i]),source);
   input.undo();assert.equal(input.value,text,source);
  }
  cases++;
 }
 assert.equal(cases,1187);
});

test('frozen emoji regression and representative combining, ZWJ, flag, Indic and RTL clusters stay whole',()=>{
 for(const cluster of ['😀','e\u0301','👩🏽‍💻','👨‍👩‍👧‍👦','🇨🇳','क्\u200dष','ن\u0651']){
  const input=new GuiInput({value:`A${cluster}B`});input.setCaret(1+cluster.length);input.deleteBackward();assert.equal(input.value,'AB',cluster);
  input.undo();input.setCaret(1);input.deleteForward();assert.equal(input.value,'AB',cluster);
  input.undo();input.setCaret(2);assert.equal(input.caretIndex,1,cluster);
 }
});

test('nonempty UTF-16 selections expand to cluster edges, including reversed ranges and direct fields',()=>{
 const input=new GuiInput({value:'A👩🏽‍💻e\u0301B'});
 input.setSelection(2,3);assert.equal(input.selectedText,'👩🏽‍💻');
 input.insertText('中');assert.equal(input.value,'A中e\u0301B');
 input.undo();input.setSelection(3,2);assert.deepEqual([input.selectionAnchor,input.selectionFocus],[8,1]);
 input.deleteForward();assert.equal(input.value,'Ae\u0301B');
 input.setValue('A😀B');input.caretIndex=2;assert.equal(input.caretIndex,1);input.deleteForward();assert.equal(input.value,'AB');
 input.setSelection(-20,100);assert.equal(input.selectedText,'AB');
 assert.throws(()=>input.setCaret(NaN),RangeError);
});

test('pointer caret hit testing never measures or returns a partial grapheme',()=>{
 const input=new GuiInput({value:'A😀e\u0301B'}),measured=[];
 const width=text=>{measured.push(text);return [...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text)].length*10;};
 for(let x=0;x<=45;x++)assert.ok([0,1,3,5,6].includes(input.getCaretIndexAt(x,width,0)));
 assert.ok(measured.every(prefix=>!['A\ud83d','A😀e'].includes(prefix)));
});

test('UTF-16 length caps truncate at grapheme boundaries and preserve replacements and merged caret boundaries',()=>{
 const input=new GuiInput({maxLength:4,value:'A😀B'});input.setCaret(3);input.insertText('中');assert.equal(input.value,'A😀B');
 input.setSelection(1,3);input.insertText('👩🏽‍💻');assert.equal(input.value,'A😀B','an unrepresentable cluster does not erase the selection');
 input.undo();assert.equal(input.value,'A😀B');
 input.maxLength=2;assert.equal(input.value,'A');assert.equal(input.canUndo,false,'history cannot bypass a new cap');
 input.insertText('😀');assert.equal(input.value,'A');
 const merged=new GuiInput({value:'👩💻'});merged.setCaret(2);merged.insertText('\u200d');assert.equal(merged.value,'👩‍💻');assert.equal(merged.caretIndex,5);
 assert.throws(()=>new GuiInput({maxLength:-1}),RangeError);
});

test('malformed incoming surrogate units are replaced and valid edits cannot manufacture lone surrogates',()=>{
 const input=new GuiInput({value:'A\ud83dB\udc00'});assert.equal(input.value,'A\ufffdB\ufffd');
 input.selectAll();input.insertText('\ud83d');assert.equal(input.value,'\ufffd');
 input.undo();assert.equal(input.value,'A\ufffdB\ufffd');
});

test('composition preview remains separate, cancels to the original selection, and commits and undoes once',()=>{
 let changes=0;const input=new GuiInput({value:'A😀B',onChange:()=>changes++});input.setSelection(1,3);
 input.beginComposition();input.updateComposition('中文',[1,2]);
 assert.equal(input.value,'A😀B');assert.equal(input.displayValue,'A中文B');assert.equal(input.displayCaretIndex,3);assert.equal(changes,0);
 input.cancelComposition();assert.equal(input.displayValue,'A😀B');assert.deepEqual([input.selectionAnchor,input.selectionFocus],[1,3]);
 input.beginComposition();input.updateComposition('中');input.commitComposition();input.commitComposition('中');
 assert.equal(input.value,'A中B');assert.equal(changes,1);assert.equal(input.isComposing,false);
 input.undo();assert.equal(input.value,'A😀B');assert.deepEqual([input.selectionAnchor,input.selectionFocus],[1,3]);
 input.redo();assert.equal(input.value,'A中B');assert.equal(changes,3);
});

test('blur, programmatic replacement and read-only edits do not commit stale preedit',()=>{
 const input=new GuiInput({value:'old'});input.setSelection(0,3);input.beginComposition();input.updateComposition('新');input.handleBlur();
 assert.equal(input.value,'old');assert.equal(input.isComposing,false);input.commitComposition('新');assert.equal(input.value,'old');
 input.beginComposition();input.updateComposition('新');input.setValue('replacement');input.commitComposition('新');assert.equal(input.value,'replacement');
 input.readOnly=true;input.insertText('x');input.beginComposition();assert.equal(input.isComposing,false);assert.equal(input.value,'replacement');
});

test('undo/redo is bounded and fresh edits discard redo; selection collapse is directional',()=>{
 const input=new GuiInput({value:'A😀B'});input.setSelection(1,3);input.moveCaret(-1);assert.equal(input.caretIndex,1);
 input.setSelection(1,3);input.moveCaret(1);assert.equal(input.caretIndex,3);
 input.setValue('');for(let i=0;i<140;i++)input.insertText('a');for(let i=0;i<140;i++)input.undo();assert.equal(input.value.length,12);
 input.redo();input.insertText('x');assert.equal(input.canRedo,false);
});
test('password presentation uses one mask per grapheme while all public stored indices remain UTF-16',()=>{
 const input=new GuiInput({value:'A😀e\u0301',inputType:'password'});input.setSelection(1,5);
 assert.equal(input.value,'A😀e\u0301');assert.equal(input.caretIndex,5);assert.equal(input.displayValue,'•••');
 assert.deepEqual([input.displaySelectionStart,input.displaySelectionEnd,input.displayCaretIndex],[1,3,3]);
 const renderer=new GuiSystem({}).renderer;input.layout({x:0,y:0,width:300,height:100});renderer.addInput(input,new GuiRoot().theme);
 assert.equal(renderer.textBatch.commands.at(-1).text,'•••');
   const measured=[];assert.equal(input.getCaretIndexAt(16,text=>{measured.push(text);return text.length*10;},0),3);
   assert.ok(measured.every(text=>/^[•]*$/u.test(text)),'password hit testing measures only rendered masks');
});
test('serialization preserves text options, but never preedit, history or active selection state',()=>{
 const root=new GuiRoot();const input=root.add(new GuiInput({id:'text',value:'A😀B',maxLength:5,inputType:'email',multiline:true}));
 input.insertText('x');input.beginComposition();input.updateComposition('中');
 const document=serializeGuiRoot(root),restored=deserializeGuiRoot(document),copy=restored.findById('text');
 assert.equal(copy.value,'A😀Bx');assert.equal(copy.maxLength,5);assert.equal(copy.inputType,'email');assert.equal(copy.multiline,true);
 assert.equal(copy.isComposing,false);assert.equal(copy.canUndo,false);assert.equal(copy.hasSelection,false);
 assert.ok(!JSON.stringify(document).includes('中'));root.destroy();restored.destroy();
});

test('Chinese IME and supplementary characters at a UTF-16 ceiling stay whole',()=>{
 for(const text of ['我','啊','方','的']){
  const input=new GuiInput({value:'A😀B',maxLength:4});input.setSelection(3,4);input.beginComposition();input.updateComposition(text);input.commitComposition();assert.equal(input.value,'A😀'+text);assert.ok(input.value.isWellFormed());
  input.insertText('多');assert.equal(input.value,'A😀'+text);input.undo();assert.equal(input.value,'A😀B');
 }
 const input=new GuiInput({value:'A😀B',maxLength:4});input.setSelection(3,4);input.insertText('𠀀');assert.equal(input.value,'A😀B','a supplementary CJK character cannot be half inserted');
});

test('password reveal is transient and is not restored by serialization',()=>{
 const root=new GuiRoot(),input=root.add(new GuiInput({id:'password',width:200,height:40,inputType:'password',value:'A😀我'}));root.layout(200,100);
 const event={type:'pointerdown',x:182,y:18,buttons:1,nativeEvent:{},routed:true,target:input,currentTarget:input};input.handlePointerDown(event);input.handlePointerUp({...event,type:'pointerup'});assert.equal(input.displayValue,input.value);
 const restored=deserializeGuiRoot(serializeGuiRoot(root));assert.equal(restored.findById('password').displayValue,'•••');assert.equal(restored.findById('password').inputType,'password');root.destroy();restored.destroy();
});
