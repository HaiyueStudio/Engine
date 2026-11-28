import test from 'node:test';import assert from 'node:assert/strict';
import {guiApi,guiActivity,guiExtension} from './helpers/private-gui-source.mjs';
const {GuiRoot,GuiElement,GuiInput,GuiButton,GuiLabel,GuiFocusManager,GuiSystem,GuiDirtyFlags}=await guiApi();
const {advanceGuiActivity,guiHasActivity}=await guiActivity();
const {GuiInputNumber}=await guiExtension('gui-forms/InputNumber.ts');
const {GuiPopover}=await guiExtension('gui-overlays/popover.ts');
const {OverlayController}=await guiExtension('gui-overlays/overlay.ts');
const {GuiDropdown}=await guiExtension('gui-overlays/menu.ts');
const {GuiPopconfirm}=await guiExtension('gui-overlays/dialog.ts');
const {GuiCarousel}=await guiExtension('gui-content/Carousel.ts');
const {attachGuiLayout}=await guiExtension('gui-layout.ts');
const {createGuiContainer,setContainerStyle}=await guiExtension('gui-layout/presets.ts');
function fixture(){const root=new GuiRoot(),focus=new GuiFocusManager();focus.setRoots([root.root]);const layout=attachGuiLayout(root,{measure:()=>({width:100,height:32,minWidth:0,minHeight:0})}),system=new GuiSystem({});return{root,focus,system,draw(){root.layout(640,480);focus.reconcile();root.clearDirty();},hover(node,type='mouse'){system.updateHover(node,{type:'pointermove',native:{pointerId:1,pointerType:type,button:-1,buttons:0,preventDefault(){}},x:node?.rect.x??639,y:node?.rect.y??479});},tick(element,count=3){for(let i=0;i<count;i++)advanceGuiActivity(element,100);},close(){system.destroy();layout.dispose();focus.dispose();root.destroy();}};}
function subscriptions(root){const on=root.onDispose;let active=0;root.onDispose=function(listener){active++;const off=on.call(this,listener);let live=true;return()=>{if(live){active--;live=false;}off();};};return()=>active;}
test('focused InputNumber disposal cancels uncommitted text without emitting a change or throwing',()=>{
 const f=fixture(),changes=[],value=new GuiInputNumber({root:f.root,focusManager:f.focus,value:1,onChange:n=>changes.push(n)});try{f.root.add(value.element);f.draw();f.focus.focus(value.input);value.input.setValue('2');assert.doesNotThrow(()=>value.dispose());assert.equal(value.value,1);assert.deepEqual(changes,[]);assert.equal(value.element.parent,null);assert.equal(f.focus.focused,null);assert.doesNotThrow(()=>value.dispose());}finally{value.dispose();f.close();}
});
test('normal InputNumber blur still commits once and supports disposal inside its onChange',()=>{
 const f=fixture(),changes=[];let value;value=new GuiInputNumber({focusManager:f.focus,value:1,onChange:n=>{changes.push(n);value.dispose();}});try{f.root.add(value.element);f.draw();f.focus.focus(value.input);value.input.setValue('2');assert.doesNotThrow(()=>f.focus.blur());assert.equal(value.value,2);assert.deepEqual(changes,[2]);assert.equal(value.element.parent,null);}finally{value.dispose();f.close();}
});
test('root destruction safely cancels a focused numeric composition and releases its controller',()=>{
 const f=fixture(),changes=[],value=new GuiInputNumber({root:f.root,focusManager:f.focus,value:1,onChange:n=>changes.push(n)});try{f.root.add(value.element);f.draw();f.focus.focus(value.input);value.input.beginComposition();value.input.updateComposition('ni');assert.doesNotThrow(()=>f.root.destroy());assert.equal(value.input.isComposing,false);assert.deepEqual(changes,[]);assert.throws(()=>value.commit(),error=>error.code==='disposed');}finally{value.dispose();f.close();}
});
for(const [name,create]of [['Popover',o=>new GuiPopover({...o,content:o.content,trigger:'click'})],['Dropdown',o=>new GuiDropdown({...o,items:[{key:'x',label:'X'}]})],['Popconfirm',o=>new GuiPopconfirm({...o,title:'Confirm'})]])test(`${name} rejects a missing automatic anchor before acquiring content or root subscriptions`,()=>{
 const f=fixture(),count=subscriptions(f.root),content=new GuiElement();try{for(let i=0;i<3;i++)assert.throws(()=>create({root:f.root,focusManager:f.focus,content}),/anchor/i);assert.equal(count(),0);assert.equal(content.parent,null);const reused=new GuiPopover({root:f.root,focusManager:f.focus,content,trigger:'manual'});reused.dispose();assert.equal(count(),0);}finally{f.close();}
});
test('invalid trigger does not change a borrowed content frame or its listeners',()=>{
 const f=fixture(),count=subscriptions(f.root),content=new GuiButton({text:'Kept',width:77,height:35}),listener=()=>{};content.on('click',listener);try{assert.throws(()=>new GuiPopover({root:f.root,focusManager:f.focus,content,trigger:'unsupported'}));assert.equal(count(),0);assert.equal(content.parent,null);assert.equal(content.width,77);const good=new GuiPopover({root:f.root,focusManager:f.focus,content,trigger:'manual'});good.dispose();assert.equal(content.width,77);}finally{f.close();}
});
test('trigger listener installation failure rolls back the anchor listener, root subscription and borrowed frame',()=>{
 const f=fixture(),count=subscriptions(f.root),anchor=f.root.add(new GuiButton()),content=new GuiInput({value:'kept'}),on=anchor.on,off=anchor.off,active=new Set(),failure=new Error('host listener refused');anchor.on=function(type,listener,...rest){on.call(this,type,listener,...rest);active.add(listener);throw failure;};anchor.off=function(type,listener){active.delete(listener);return off.call(this,type,listener);};try{assert.throws(()=>new GuiPopover({root:f.root,focusManager:f.focus,anchor,content}),error=>error===failure||error instanceof AggregateError&&error.errors.includes(failure));assert.equal(count(),0);assert.equal(content.parent,null);assert.equal(active.size,0);anchor.on=on;anchor.off=off;const reused=new GuiPopover({root:f.root,focusManager:f.focus,anchor,content,trigger:'manual'});reused.dispose();assert.equal(count(),0);}finally{anchor.on=on;anchor.off=off;f.close();}
});
test('a root subscription failure after mounting content rolls back the complete acquired frame',()=>{
 const f=fixture(),content=new GuiInput(),color=content.getResolvedStyle().color,on=f.root.onDispose,failure=new Error('subscription refused');f.root.onDispose=()=>{throw failure;};try{assert.throws(()=>new GuiPopover({root:f.root,focusManager:f.focus,content,trigger:'manual',style:{parts:{content:{color:'#fa4321'}}}}),error=>error===failure);assert.equal(content.parent,null);assert.equal(content.getResolvedStyle().color,color,'failed construction must release part bindings as well as the frame');f.root.onDispose=on;const reused=new GuiPopover({root:f.root,focusManager:f.focus,content,trigger:'manual'});reused.dispose();}finally{f.root.onDispose=on;f.close();}
});
test('hover Popover remains open over children, then closes after the child leaves',()=>{
 const f=fixture(),anchor=f.root.add(new GuiButton()),panel=new GuiElement(),child=panel.add(new GuiButton({text:'Child'})),popup=new GuiPopover({root:f.root,focusManager:f.focus,anchor,content:panel,trigger:'hover'});try{f.draw();f.hover(anchor);assert(popup.isOpen);f.draw();f.hover(child);assert(child.hovered&&!popup.panel.hovered);f.tick(popup.panel);assert(popup.isOpen);assert.equal(guiHasActivity(popup.panel),false,'stable hover does not keep a closing activity alive');f.hover(null);f.tick(popup.panel,1);assert(popup.isOpen);f.tick(popup.panel,1);assert.equal(popup.isOpen,false);}finally{popup.dispose();f.close();}
});
test('crossing child controls and returning to the anchor resets the hover close grace',()=>{
 const f=fixture(),anchor=f.root.add(new GuiButton()),content=new GuiElement(),a=content.add(new GuiButton()),b=content.add(new GuiInput()),popup=new GuiPopover({root:f.root,focusManager:f.focus,anchor,content,trigger:'hover'});try{f.draw();f.hover(anchor);f.draw();f.hover(a);f.tick(popup.panel,3);f.hover(b);f.tick(popup.panel,3);assert(popup.isOpen);f.hover(null);f.tick(popup.panel,1);f.hover(anchor);f.tick(popup.panel,3);assert(popup.isOpen);f.hover(null);f.tick(popup.panel,2);assert.equal(popup.isOpen,false);}finally{popup.dispose();f.close();}
});
test('touch does not open a hover-only Popover and manual/click modes do not auto-close',()=>{
 const f=fixture(),anchor=f.root.add(new GuiButton());try{for(const trigger of ['hover','manual','click']){const popup=new GuiPopover({root:f.root,focusManager:f.focus,anchor,content:new GuiInput(),trigger});f.draw();f.hover(anchor,'touch');assert.equal(popup.isOpen,false);f.hover(null,'touch');if(trigger!=='hover'){popup.open();f.draw();f.tick(popup.panel,10);assert(popup.isOpen);}popup.dispose();}}finally{f.close();}
});
test('Carousel pauses on visible descendant hover and resumes on the original frame clock',()=>{
 const f=fixture(),first=new GuiInput({value:'first'}),second=new GuiLabel({text:'second'}),carousel=new GuiCarousel({root:f.root,focusManager:f.focus,slides:[first,second],autoplayMs:250});try{f.root.add(carousel.element);f.draw();f.hover(first);f.tick(carousel.element,10);assert.equal(carousel.index,0);f.hover(null);f.tick(carousel.element,3);assert.equal(carousel.index,1);carousel.dispose();assert.equal(first.parent,null);assert.equal(second.parent,null);assert(first.visible&&second.visible);}finally{carousel.dispose();f.close();}
});
test('a hidden descendant with stale hover cannot indefinitely pause Carousel',()=>{
 const f=fixture(),hidden=new GuiButton({visible:false}),content=new GuiElement();content.add(hidden);const carousel=new GuiCarousel({root:f.root,slides:[content,new GuiLabel({text:'next'})],autoplayMs:250});try{f.root.add(carousel.element);f.draw();hidden.hovered=true;f.tick(carousel.element);assert.equal(carousel.index,1);}finally{carousel.dispose();f.close();}
});
test('root disposal during overlay construction cannot return an already-dead controller',()=>{
 const f=fixture(),content=new GuiInput(),on=f.root.onDispose;f.root.onDispose=function(listener){this.destroy();return on.call(this,listener);};try{assert.throws(()=>new GuiPopover({root:f.root,focusManager:f.focus,content,trigger:'manual'}),/disposed.*construction/);assert.equal(content.parent,null);}finally{f.root.onDispose=on;f.close();}
});
test('trigger rollback aggregates cleanup failure after releasing all independent resources',()=>{
 const f=fixture(),count=subscriptions(f.root),anchor=f.root.add(new GuiButton()),content=new GuiInput(),on=anchor.on,off=anchor.off,first=new Error('install failed'),second=new Error('off failed');anchor.on=function(...args){on.apply(this,args);throw first;};anchor.off=function(...args){off.apply(this,args);throw second;};try{assert.throws(()=>new GuiPopover({root:f.root,focusManager:f.focus,anchor,content}),error=>error instanceof AggregateError&&error.errors.includes(first)&&error.errors.includes(second));assert.equal(count(),0);assert.equal(content.parent,null);}finally{anchor.on=on;anchor.off=off;f.close();}
});
test('hover region includes an explicitly owned submenu in its shared modal host',()=>{
 const f=fixture(),anchor=f.root.add(new GuiButton()),content=new GuiElement(),link=content.add(new GuiButton()),popup=new GuiPopover({root:f.root,focusManager:f.focus,anchor,content,trigger:'hover'}),leaf=new GuiButton(),child=new OverlayController({root:f.root,focusManager:f.focus,anchor:link},leaf,undefined,popup);try{f.draw();f.hover(anchor);f.draw();f.hover(link);child.open();f.draw();f.hover(leaf);f.tick(popup.panel,5);assert(popup.isOpen&&child.isOpen);assert.equal(guiHasActivity(popup.panel),false);f.hover(null);f.tick(popup.panel,2);assert.equal(popup.isOpen,false);assert.equal(child.isOpen,false);}finally{child.dispose();popup.dispose();f.close();}
});
test('disposing a pending hover close cancels its original activity lease',()=>{
 const f=fixture(),anchor=f.root.add(new GuiButton()),popup=new GuiPopover({root:f.root,focusManager:f.focus,anchor,content:new GuiInput(),trigger:'hover'});try{f.draw();f.hover(anchor);f.draw();f.hover(null);assert(guiHasActivity(popup.panel));popup.dispose();assert.equal(guiHasActivity(popup.panel),false);assert.doesNotThrow(()=>f.tick(popup.panel,5));}finally{popup.dispose();f.close();}
});
test('Carousel hidden ancestors suspend autoplay without losing its remaining time',()=>{
 const f=fixture(),parent=f.root.add(new GuiElement({width:640,height:480})),carousel=new GuiCarousel({root:f.root,slides:[new GuiInput(),new GuiLabel()],autoplayMs:250});try{parent.add(carousel.element);f.draw();f.tick(carousel.element,1);parent.setVisible(false);f.draw();f.tick(carousel.element,5);assert.equal(carousel.index,0);parent.setVisible(true);f.draw();f.tick(carousel.element,2);assert.equal(carousel.index,1);}finally{carousel.dispose();f.close();}
});

test('layout-only hidden descendants with stale hover do not pause Carousel',()=>{
 const f=fixture(),slide=createGuiContainer('column'),hidden=slide.add(createGuiContainer('column')),child=hidden.add(new GuiInput()),carousel=new GuiCarousel({root:f.root,slides:[slide,new GuiLabel()],autoplayMs:250});try{f.root.add(carousel.element);f.draw();f.hover(child);f.tick(carousel.element,3);assert.equal(carousel.index,0);setContainerStyle(hidden,{display:'none'});hidden.markDirty(GuiDirtyFlags.Layout);f.draw();assert.equal(child.visible,true);assert.equal(child.hovered,true);assert.equal(child.isEffectivelyVisible(),false);f.tick(carousel.element,3);assert.equal(carousel.index,1);}finally{carousel.dispose();f.close();}
});
