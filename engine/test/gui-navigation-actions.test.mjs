import assert from 'node:assert/strict';
import test from 'node:test';
import {GuiRoot,GuiButton,GuiCheckbox,GuiRadio,GuiSlider,GuiInput,GuiSelect,GuiScrollView,GuiModal,GuiSystem,serializeGuiRoot,deserializeGuiRoot} from '../dist/gui.js';
import {InputMap} from '../dist/input.js';

function setup(options={}) {
 const root=new GuiRoot(),system=new GuiSystem({},options);
 const ready=()=>{root.layout(400,300);system.roots.add(root);system.focus.setRoots([root.root]);};
 return {root,system,ready,close(){system.destroy();root.destroy();}};
}
function key(code,extra={}) {return {code,key:code==='Space'?' ':code,shiftKey:false,ctrlKey:false,altKey:false,metaKey:false,repeat:false,isComposing:false,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...extra};}

test('keyboard Tab/confirm navigates and invokes the existing button callback once; repeats do not confirm again',()=>{
 const s=setup();let count=0;const a=s.root.add(new GuiButton({onClick:e=>{count++;assert.equal(e.pointerId,-1);}})),b=s.root.add(new GuiButton());s.ready();
 const tab=key('Tab');s.system.onKeyDown(tab);assert.equal(s.system.focus.focused,a);assert.equal(tab.defaultPrevented,true);
 s.system.onKeyDown(key('Enter'));s.system.onKeyDown(key('Enter',{repeat:true}));assert.equal(count,1);
 s.system.onKeyDown(key('Tab'));assert.equal(s.system.focus.focused,b);s.system.onKeyDown(key('Tab',{shiftKey:true}));assert.equal(s.system.focus.focused,a);s.close();
});

test('engine action consumption remains true with DOM default prevention disabled',()=>{
 const s=setup({preventDefault:false});let count=0;const a=s.root.add(new GuiButton({onClick:()=>count++}));s.ready();s.system.focus.focus(a);
 const enter=key('Enter');assert.equal(s.system.handleKeyboardEvent(enter),true);assert.equal(enter.defaultPrevented,false);
 s.system.onKeyDown(enter);assert.equal(enter.defaultPrevented,false);assert.equal(count,2);s.close();
});

test('slider dedicated arrows are consumed at bounds before directional navigation',()=>{
 const s=setup();let changes=0,commits=0;const slider=s.root.add(new GuiSlider({value:0,min:0,max:2,step:1,onChange:()=>changes++,onCommit:()=>commits++}));s.root.add(new GuiButton({x:200}));s.ready();s.system.focus.focus(slider);
 for(let i=0;i<3;i++)assert.equal(s.system.dispatchAction('right'),true);
 assert.equal(slider.value,2);assert.equal(changes,2);assert.equal(s.system.focus.focused,slider);
 s.system.dispatchAction('confirm');assert.equal(commits,1);s.close();
});

test('checkbox and radio activate through their existing change/group behavior for host-sampled gamepad actions',()=>{
 const s=setup();let changes=0;const c=s.root.add(new GuiCheckbox({onChange:()=>changes++})),a=s.root.add(new GuiRadio({group:'g',value:'a',checked:true})),b=s.root.add(new GuiRadio({group:'g',value:'b'}));s.ready();
 s.system.focus.focus(c);assert.equal(s.system.dispatchAction('confirm','gamepad'),true);assert.equal(c.checked,true);assert.equal(changes,1);
 s.system.focus.focus(b);s.system.dispatchAction('confirm','gamepad');assert.equal(b.checked,true);assert.equal(a.checked,false);s.close();
});

test('select owns up/down, skips disabled options, confirms and cancels its popup before modal navigation',()=>{
 const s=setup();let changes=0;const select=s.root.add(new GuiSelect({options:[{label:'a',value:'a'},{label:'b',value:'b',disabled:true},{label:'c',value:'c'}],value:'a',onChange:()=>changes++}));s.ready();s.system.focus.focus(select);
 s.system.dispatchAction('confirm');assert.equal(select.open,true);s.system.dispatchAction('down');assert.equal(select.value,'c');assert.equal(changes,1);
 s.system.dispatchAction('cancel');assert.equal(select.open,false);assert.equal(s.system.focus.focused,select);s.close();
});

test('text editing keys remain local; Tab leaves the field and Enter submits once',()=>{
 const s=setup({preventDefault:false});let submits=0;const input=s.root.add(new GuiInput({value:'ab',onSubmit:()=>submits++})),button=s.root.add(new GuiButton({x:220}));s.ready();s.system.focus.focus(input);input.setCaret(2);
 s.system.onKeyDown(key('ArrowLeft'));assert.equal(input.caretIndex,1);assert.equal(s.system.focus.focused,input);
 const enter=key('Enter');s.system.onKeyDown(enter);assert.equal(submits,1);assert.equal(enter.defaultPrevented,false);
 s.system.onKeyDown(key('Tab'));assert.equal(s.system.focus.focused,button);s.close();
});

test('modal actions are trapped and cancel restores the opening control without invoking it',()=>{
 const s=setup();let underlying=0,cancelled=0;const a=s.root.add(new GuiButton({onClick:()=>underlying++})),modal=s.root.add(new GuiModal({onCancel:()=>cancelled++}));s.ready();s.system.focus.focus(a);modal.show();s.system.focus.reconcile();
 assert.equal(s.system.dispatchAction('cancel','gamepad'),true);assert.equal(modal.visible,false);assert.equal(cancelled,1);assert.equal(underlying,0);assert.equal(s.system.focus.focused,a);s.close();
});

test('scroll consumes movement then allows navigation when it has no remaining movement',()=>{
 const s=setup();const scroll=s.root.add(new GuiScrollView({width:100,height:50,contentHeight:90})),button=s.root.add(new GuiButton({y:120}));s.ready();s.system.focus.focus(scroll);
 s.system.dispatchAction('down');assert.equal(scroll.scrollY,40);assert.equal(s.system.focus.focused,scroll);
 s.system.dispatchAction('down');assert.equal(s.system.focus.focused,button);s.close();
});

test('sequential navigation reveals a focused descendant in its scroll viewport',()=>{
 const s=setup(),scroll=s.root.add(new GuiScrollView({width:150,height:80,contentHeight:300,focus:{mode:'none'}}));
 const a=scroll.add(new GuiButton({y:0,height:30})),b=scroll.add(new GuiButton({y:220,height:30}));s.ready();s.system.focus.focus(a);
 s.system.dispatchAction('next');assert.equal(s.system.focus.focused,b);assert.equal(scroll.scrollY,170);assert.ok(b.rect.y>=scroll.rect.y&&b.rect.y+b.rect.height<=scroll.rect.y+scroll.rect.height);
 s.system.dispatchAction('previous');assert.equal(s.system.focus.focused,a);assert.equal(scroll.scrollY,0);s.close();
});

test('custom InputMap bindings and control interception precede automatic navigation',()=>{
 const map=InputMap.guiNavigation().setAction('confirm',['KeyZ']),s=setup({navigationMap:map});let actions=0;
 const a=s.root.add(new GuiButton({onAction:e=>{if(e.action==='right'){actions++;e.consume();}}})),b=s.root.add(new GuiButton({x:150}));s.ready();s.system.focus.focus(a);
 assert.equal(s.system.handleKeyboardEvent(key('ArrowRight')),true);assert.equal(actions,1);assert.equal(s.system.focus.focused,a);
 assert.equal(s.system.handleKeyboardEvent(key('KeyQ')),false);assert.equal(s.system.handleKeyboardEvent(key('KeyZ',{key:'z'})),true);
 assert.ok(b);s.close();
});

test('asynchronous paste cannot write to a previous focus generation, even after returning',async()=>{
 const s=setup();const a=s.root.add(new GuiInput()),b=s.root.add(new GuiInput());s.ready();s.system.focus.focus(a);
 let resolve;s.system.readClipboard=()=>new Promise(r=>resolve=r);s.system.onKeyDown(key('KeyV',{key:'v',ctrlKey:true}));
 s.system.focus.focus(b);s.system.focus.focus(a);resolve('stale');await Promise.resolve();assert.equal(a.value,'');s.close();
});

test('focus/filter metadata round-trips; focus, callbacks and capture remain transient',()=>{
 const s=setup();const a=s.root.add(new GuiButton({id:'a',focus:{mode:'all',tabIndex:3,neighbours:{right:'b'}},pointerFilter:'pass',onAction:e=>e.consume()}));s.ready();s.system.focus.focus(a);
 const data=serializeGuiRoot(s.root),copy=deserializeGuiRoot(data),restored=copy.findById('a');assert.deepEqual(restored.focusOptions,a.focusOptions);assert.equal(restored.pointerFilter,'pass');assert.equal(restored.focused,false);
 assert.equal(JSON.stringify(data).includes('onAction'),false);const bad=structuredClone(data);bad.root.children[0].focus.neighbours.right=17;assert.throws(()=>deserializeGuiRoot(bad),/neighbour/i);
 copy.destroy();s.close();
});
