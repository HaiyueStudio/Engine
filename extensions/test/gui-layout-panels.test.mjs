import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {GuiRoot, GuiElement, GuiButton, GuiLabel, GuiInput, GuiSwitch, GuiSystem, GuiFocusManager, GuiImage} from '@haiyue/engine/gui';
const rootPath = fileURLToPath(new URL('../..', import.meta.url));
execFileSync(process.execPath, [fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url)), '--target','ESNext','--module','ESNext','--moduleResolution','bundler','--strict','--noUncheckedIndexedAccess','--exactOptionalPropertyTypes','--skipLibCheck','--types','@webgpu/types','--rootDir','extensions/src','--outDir','artifacts/engine-0.2.2/g08/compiled','extensions/src/gui-layout.ts'], {cwd: rootPath, stdio:'pipe'});
const {attachGuiLayout, createGuiContainer, GuiSplitPanel, GuiTabContainer} = await import('../../artifacts/engine-0.2.2/g08/compiled/gui-layout.js');
const {readGuiLayoutCounters} = await import('../../artifacts/engine-0.2.2/g08/compiled/gui-layout/diagnostics.js');
const measure = () => ({width:0,height:0,minWidth:0,minHeight:0});
function setup(control, width=400, height=240) {
  const root = new GuiRoot(); root.add(control.element);
  const binding=attachGuiLayout(root,{measure}); binding.setStyle(control.element,{width,height});
  root.layout(width,height); root.clearDirty();
  return {root,binding,draw(){root.layout(width,height);root.clearDirty();},dispose(){control.dispose();binding.dispose();root.destroy();}};
}
function pointer(type,x,y,id=1) {return {type,x,y,localX:0,localY:0,button:0,buttons:type==='pointerup'?0:1,pointerId:id,nativeEvent:{},stopped:false,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;}};}
function action(value) {return {action:value,source:'keyboard',consumed:false,consume(){this.consumed=true;}};}
const page=(id, options={})=>({id,title:id,content:new GuiElement({id:'content-'+id,width:'100%',height:'100%'}),...options});

test('split Grid preserves preferred fractions, clamps minima, overflows tiny parents and recovers on resize',()=>{
 const split=new GuiSplitPanel({axis:'horizontal',ratio:.25,minimumFirst:80,minimumSecond:120,dividerSize:10,first:new GuiElement(),second:new GuiElement()});
 const env=setup(split,410,200);assert.equal(split.firstPane.rect.width,100);assert.equal(split.secondPane.rect.width,300);
 split.setRatio(.01);env.draw();assert.equal(split.firstPane.rect.width,80);assert.equal(split.secondPane.rect.width,320);
 env.binding.setStyle(split.element,{width:100});env.draw();assert.equal(split.firstPane.rect.width,80);assert.equal(split.secondPane.rect.width,120);assert.equal(split.secondPane.rect.x+120,210);
 env.binding.setStyle(split.element,{width:410});split.setRatio(.25);env.draw();assert.equal(split.firstPane.rect.width,100);assert.equal(split.ratio,.25);
 split.setRatio(0);env.draw();assert.equal(split.firstPane.rect.width,80);split.setRatio(1);env.draw();assert.equal(split.secondPane.rect.width,120);env.dispose();
});
test('nested vertical/horizontal panels use a single binding, independent dimensions and static zero solves',()=>{
 const nested=new GuiSplitPanel({axis:'vertical',ratio:.5,dividerSize:8,first:new GuiElement(),second:new GuiElement()});
 const outer=new GuiSplitPanel({axis:'horizontal',ratio:.5,dividerSize:10,first:nested.element,second:new GuiElement()});
 const env=setup(outer,410,208);assert.equal(nested.element.rect.width,200);assert.equal(nested.firstPane.rect.height,100);assert.equal(nested.secondPane.rect.y,108);
 const counters=readGuiLayoutCounters(env.binding);for(let i=0;i<20;i++)env.draw();assert.deepEqual(readGuiLayoutCounters(env.binding),counters);
 nested.setRatio(.25);env.draw();assert.equal(nested.firstPane.rect.height,50);assert.equal(outer.firstPane.rect.width,200);outer.dispose();nested.dispose();env.binding.dispose();env.root.destroy();
});
test('both split axes match an independent constrained-allocation oracle, including endpoints and minimum freezing',()=>{
 for(const axis of ['horizontal','vertical'])for(const ratio of [0,.001,.1,.25,.5,.8,.999,1])for(const size of [60,210,810]) {
  const split=new GuiSplitPanel({axis,ratio,minimumFirst:80,minimumSecond:120,first:new GuiElement(),second:new GuiElement()});
  const env=setup(split,axis==='horizontal'?size:200,axis==='vertical'?size:200),available=Math.max(0,size-10);
  const expected=available<200?80:Math.max(80,Math.min(available-120,available*ratio));
  assert.ok(Math.abs((axis==='horizontal'?split.firstPane.rect.width:split.firstPane.rect.height)-expected)<1e-6);
  assert.ok(Math.abs((axis==='horizontal'?split.secondPane.rect.width:split.secondPane.rect.height)-(available<200?120:available-expected))<1e-6);env.dispose();
 }
});
test('divider dragging uses solved padded coordinates rather than the outer panel border',()=>{
 const split=new GuiSplitPanel({axis:'horizontal',ratio:.5,first:new GuiElement(),second:new GuiElement(),style:{padding:20}}),env=setup(split,450,200);
 assert.equal(split.firstPane.rect.x,20);split.divider.handlePointerDown(pointer('pointerdown',225,50));split.divider.handlePointerMove(pointer('pointermove',325,50));split.divider.handlePointerUp(pointer('pointerup',325,50));env.draw();assert.equal(split.ratio,.75);assert.equal(split.firstPane.rect.width,300);env.dispose();
});
test('clicking a minimum-clamped divider or dragging fully locked panes preserves the preferred ratio',()=>{
 const split=new GuiSplitPanel({axis:'horizontal',ratio:.01,minimumFirst:80,minimumSecond:120,first:new GuiElement(),second:new GuiElement()}),env=setup(split,410,200);
 let x=split.divider.rect.x+5;split.divider.handlePointerDown(pointer('pointerdown',x,30));split.divider.handlePointerUp(pointer('pointerup',x,30));assert.equal(split.ratio,.01);
 split.setRatio(.5);env.binding.setStyle(split.element,{width:210});env.draw();x=split.divider.rect.x+5;split.divider.handlePointerDown(pointer('pointerdown',x,30));split.divider.handlePointerMove(pointer('pointermove',x+30,30));split.divider.handlePointerUp(pointer('pointerup',x+30,30));assert.equal(split.ratio,.5);env.dispose();
});
test('pointer drag retains grab offset, ignores other fingers, clamps and cancellation restores the starting ratio',()=>{
 const changes=[],split=new GuiSplitPanel({axis:'horizontal',ratio:.5,minimumFirst:50,minimumSecond:50,first:new GuiElement(),second:new GuiElement(),onRatioChange:r=>changes.push(r)}),env=setup(split,410,200);
 split.divider.handlePointerDown(pointer('pointerdown',205,10));split.divider.handlePointerMove(pointer('pointermove',305,10,2));assert.equal(split.ratio,.5);
 split.divider.handlePointerMove(pointer('pointermove',305,10));env.draw();assert.equal(split.firstPane.rect.width,300);
 split.divider.handlePointerCancel(pointer('pointercancel',305,10));env.draw();assert.equal(split.ratio,.5);
 split.divider.handlePointerDown(pointer('pointerdown',205,10));split.divider.handlePointerMove(pointer('pointermove',900,10));env.draw();assert.equal(split.secondPane.rect.width,50);assert.equal(changes.length,3);env.dispose();
});
test('divider keyboard changes the correct axis, consumes only adjustment keys and starts from the constrained size',()=>{
 const split=new GuiSplitPanel({axis:'vertical',ratio:0,minimumFirst:80,minimumSecond:10,keyboardStep:.1,first:new GuiElement(),second:new GuiElement()}),env=setup(split,200,410);
 const ignored=action('left');split.divider.handleAction(ignored);assert.equal(ignored.consumed,false);
 const down=action('down');split.divider.handleAction(down);env.draw();assert.equal(down.consumed,true);assert.ok(Math.abs(split.firstPane.rect.height-120)<1e-6);env.dispose();
});
test('split state round-trips only logical data and malformed restore is atomic',()=>{
 const split=new GuiSplitPanel({axis:'horizontal',ratio:.3,first:new GuiElement(),second:new GuiElement(),onRatioChange:()=>{}}),env=setup(split);
 const state=JSON.parse(JSON.stringify(split.serialize()));assert.deepEqual(Object.keys(state),['version','type','axis','ratio']);split.setRatio(.7);split.restore(state);assert.equal(split.ratio,.3);
 for(const bad of [{...state,ratio:NaN},{...state,axis:'vertical'},{...state,callback:()=>{}}])assert.throws(()=>split.restore(bad));assert.equal(split.ratio,.3);
 env.dispose();assert.throws(()=>split.setRatio(.5),/disposed/);assert.throws(()=>new GuiSplitPanel({axis:'horizontal',ratio:NaN,first:new GuiElement(),second:new GuiElement()}));
});
test('tabs preserve business identity, manual child coordinates, saved binding styles and inactive dirty state',()=>{
 const a=page('a'),b=page('b');const input=a.content.add(new GuiInput({id:'saved-input',x:23,y:17,width:90,height:30,value:'persistent'}));
 const label=b.content.add(new GuiLabel({text:'before',width:80,height:20})),secondLabel=b.content.add(new GuiLabel({text:'second',width:80,height:20}));const tabs=new GuiTabContainer({pages:[a,b],activeId:'a'}),env=setup(tabs);
 assert.equal(input.rect.x,23);assert.equal(input.rect.y,tabs.body.rect.y+17);
 tabs.activate('b');env.binding.setStyle(b.content,{direction:'column',rowGap:7});env.draw();tabs.activate('a');env.draw();const events=[];const off=env.root.onInvalidation(e=>events.push(e));
 label.setText('updated while inactive');assert.equal(events.length,0);assert.equal(env.root.dirty,false);assert.ok(label.dirty);assert.equal(b.content.parent,null);
 tabs.activate('b');env.draw();assert.equal(label.text,'updated while inactive');assert.equal(secondLabel.rect.y-label.rect.y,27);assert.equal(b.content.parent,tabs.body);assert.equal(tabs.pages[0].content,a.content);
 tabs.activate('a');env.draw();assert.equal(input.value,'persistent');assert.equal(input.rect.x,23);off();env.dispose();
});
test('tab focus restores eligible content, repairs a deleted old focus and keyboard navigation stays on the strip',()=>{
 const focus=new GuiFocusManager(),a=page('a'),b=page('b');const a1=a.content.add(new GuiButton({id:'a1'})),a2=a.content.add(new GuiButton({id:'a2'})),b1=b.content.add(new GuiButton({id:'b1'}));
 const tabs=new GuiTabContainer({pages:[a,b],focus}),env=setup(tabs);focus.setRoots([env.root.root]);focus.focus(a2);
 tabs.activate('b');assert.equal(focus.focused,b1);tabs.activate('a');assert.equal(focus.focused,a2);tabs.activate('b');a.content.remove(a2);tabs.activate('a');assert.equal(focus.focused,a1);
 const first=tabs.header.children[0].children[0];focus.focus(first);const event=action('right');first.handleAction(event);assert.equal(event.consumed,true);assert.equal(tabs.activeId,'b');assert.equal(focus.focused,tabs.header.children[1].children[0]);
 const outside=env.root.add(new GuiButton({id:'outside'}));focus.focus(outside);tabs.activate('a');assert.equal(focus.focused,outside);env.dispose();focus.dispose();
});
test('active deletion/hiding chooses the right then left visible page, all-hidden is empty, showing restores an active page',()=>{
 const tabs=new GuiTabContainer({pages:[page('a'),page('b'),page('c')],activeId:'b'}),env=setup(tabs);
 tabs.remove('b');assert.equal(tabs.activeId,'c');tabs.setPageVisible('c',false);assert.equal(tabs.activeId,'a');tabs.setPageVisible('a',false);assert.equal(tabs.activeId,null);assert.equal(tabs.body.children.length,0);
 tabs.setPageVisible('c',true);assert.equal(tabs.activeId,'c');assert.throws(()=>tabs.activate('a'),/hidden/);tabs.remove('c');assert.equal(tabs.activeId,null);env.dispose();
});
test('layout-hidden page focus cannot leave the old detached control focused',()=>{
 const focus=new GuiFocusManager(),a=page('a'),b=page('b',{content:createGuiContainer('column')}),a1=a.content.add(new GuiButton()),b1=b.content.add(new GuiButton());
 const tabs=new GuiTabContainer({pages:[a,b],focus}),env=setup(tabs);focus.setRoots([env.root.root]);tabs.activate('b');env.binding.setStyle(b1,{display:'none'});env.draw();tabs.activate('a');env.draw();focus.focus(a1);tabs.activate('b');assert.equal(focus.focused,tabs.header.children[1].children[0]);env.dispose();focus.dispose();
});
test('close veto, stable reordering and layout state round-trip retain content and exclude callbacks/captures/GPU data',()=>{
 let allowed=false;const contents=[page('a',{closable:true}),page('b'),page('c')],tabs=new GuiTabContainer({pages:contents,onClose:()=>allowed}),env=setup(tabs);
 assert.equal(tabs.close('a'),false);assert.equal(tabs.close('b'),false);tabs.move('c',0);tabs.setPageVisible('b',false);tabs.activate('c');
 const state=JSON.parse(JSON.stringify(tabs.serialize()));assert.deepEqual(state,{version:1,type:'gui-tab-container',order:['c','a','b'],hidden:['b'],activeId:'c'});
 tabs.move('c',2);tabs.setPageVisible('b',true);tabs.activate('a');tabs.restore(state);assert.deepEqual(tabs.serialize(),state);assert.equal(tabs.pages[1].content,contents[0].content);
 assert.throws(()=>tabs.restore({...state,order:['a','a','b']}));assert.throws(()=>tabs.restore({...state,activeId:'b'}));assert.throws(()=>tabs.restore({...state,device:{}}));assert.deepEqual(tabs.serialize(),state);
 allowed=true;assert.equal(tabs.close('a'),true);assert.deepEqual(tabs.pages.map(p=>p.id),['c','b']);env.dispose();
});
test('inactive pages do not paint, hit, animate or solve and reactivation invalidates exactly the active branch',()=>{
 const a=page('a'),b=page('b');a.content.add(new GuiLabel({text:'active-only',width:80,height:20}));const hidden=b.content.add(new GuiSwitch({checked:false,thumbTransitionMs:100}));b.content.add(new GuiLabel({text:'inactive-only',width:80,height:20}));
 const tabs=new GuiTabContainer({pages:[a,b]}),env=setup(tabs);const system=new GuiSystem({});system.roots.add(env.root);
 system.renderer.collectElement(env.root.root,env.root.theme);assert.ok(system.renderer.textBatch.commands.some(c=>c.text==='active-only'));assert.ok(!system.renderer.textBatch.commands.some(c=>c.text==='inactive-only'));
 const counters=readGuiLayoutCounters(env.binding);hidden.setChecked(true);assert.equal(env.root.dirty,false);for(let i=0;i<30;i++)env.draw();assert.deepEqual(readGuiLayoutCounters(env.binding),counters);
 assert.notEqual(env.root.hitTest(10,50),hidden);tabs.activate('b');env.draw();assert.equal(hidden.checked,true);assert.ok(readGuiLayoutCounters(env.binding).solves>counters.solves);system.destroy();env.dispose();
});
test('detached page theme/image subscriptions are released and borrowed sources survive destruction',()=>{
 class Source extends EventTarget {naturalWidth=20;naturalHeight=20;live=0;addEventListener(...a){this.live++;super.addEventListener(...a);}removeEventListener(...a){this.live--;super.removeEventListener(...a);}}
 const source=new Source(),listeners=new Set(),resource={version:1,resolve:()=>({color:'#fff'}),subscribe(f){listeners.add(f);return()=>listeners.delete(f);}};
 const a=page('a',{content:createGuiContainer('column')}),b=page('b');a.content.themeResource=resource;a.content.add(new GuiImage({source,width:20,height:20}));
 const tabs=new GuiTabContainer({pages:[a,b]}),env=setup(tabs);assert.equal(source.live,2);assert.equal(listeners.size,1);
 tabs.activate('b');env.draw();assert.equal(source.live,0);assert.equal(listeners.size,0);tabs.activate('a');env.draw();assert.equal(source.live,2);assert.equal(listeners.size,1);
 env.dispose();assert.equal(source.live,0);assert.equal(listeners.size,0);assert.equal(source.naturalWidth,20);
});
test('invalid identities and ownership are rejected, callbacks see atomic removals, disposal releases page frames',()=>{
 const a=page('a');assert.throws(()=>new GuiTabContainer({pages:[a,a]}));assert.throws(()=>new GuiTabContainer({pages:[a],activeId:'missing'}));
 let tabs;tabs=new GuiTabContainer({pages:[page('a'),page('b')],onActiveChange:()=>{if(tabs.pages.length===1)tabs.remove('b');}});const env=setup(tabs);tabs.remove('a');assert.equal(tabs.pages.length,0);assert.equal(tabs.activeId,null);env.dispose();
 const content=new GuiElement();const first=new GuiTabContainer({pages:[{id:'x',title:'x',content}]});first.dispose();const second=new GuiTabContainer({pages:[{id:'x',title:'x',content}]});second.dispose();assert.throws(()=>second.activate('x'),/disposed/);
});
test('stable page IDs containing reserved separators cannot collide with generated header controls',()=>{
 const tabs=new GuiTabContainer({pages:[page('a',{closable:true}),page('a:close'),page('a:select'),page('a%3Aclose')]});const env=setup(tabs);
 tabs.activate('a:close');env.draw();assert.equal(tabs.activeId,'a:close');const state=tabs.serialize();tabs.activate('a:select');tabs.restore(state);assert.equal(tabs.activeId,'a:close');env.dispose();
});
