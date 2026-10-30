import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {GuiRoot,GuiElement,GuiButton,GuiLabel,GuiScrollView,GuiModal,GuiSystem,GuiImage,GuiSwitch,GuiToast,hitTestGui} from '@haiyue/engine/gui';
const root=fileURLToPath(new URL('../..',import.meta.url));
execFileSync(process.execPath,[fileURLToPath(new URL('../../node_modules/typescript/bin/tsc',import.meta.url)),'--target','ESNext','--module','ESNext','--moduleResolution','bundler','--strict','--noUncheckedIndexedAccess','--exactOptionalPropertyTypes','--skipLibCheck','--types','@webgpu/types','--rootDir','extensions/src','--outDir','artifacts/engine-0.2.2/g03/compiled','extensions/src/gui-layout.ts'],{cwd:root,stdio:'pipe'});
const {attachGuiLayout,createGuiContainer}=await import('../../artifacts/engine-0.2.2/g03/compiled/gui-layout.js');
const {readGuiLayoutCounters}=await import('../../artifacts/engine-0.2.2/g03/compiled/gui-layout/diagnostics.js');
const none=()=>({width:0,height:0,minWidth:0,minHeight:0});

test('theme content insets belong to container layout once; colors solve nothing and explicit layout padding wins',()=>{
 let skin={contentInsets:{left:12,top:6,right:8,bottom:4},color:'red'};const listeners=new Set(),resource={version:1,resolve:type=>type==='*'?skin:{},subscribe(callback){listeners.add(callback);return()=>listeners.delete(callback);}};
 const root=new GuiRoot(),panel=root.add(createGuiContainer('column',{style:{width:120,height:60}})),child=panel.add(new GuiButton({width:30,height:20}));panel.setThemeResource(resource);
 const binding=attachGuiLayout(root,{measure:none});root.layout(200,100);root.clearDirty();assert.equal(child.rect.x,12);assert.equal(child.rect.y,6);const initial=readGuiLayoutCounters(binding).solves;
 skin={...skin,color:'blue'};resource.version++;for(const f of listeners)f();root.layout(200,100);assert.equal(readGuiLayoutCounters(binding).solves,initial);root.clearDirty();
 skin={...skin,contentInsets:{left:18,top:9,right:8,bottom:4}};resource.version++;for(const f of listeners)f();root.layout(200,100);assert.equal(child.rect.x,18);assert.equal(child.rect.y,9);assert.equal(readGuiLayoutCounters(binding).solves,initial+1);
 binding.setStyle(panel,{padding:{left:2,top:3,right:2,bottom:3}});root.layout(200,100);assert.equal(child.rect.x,2);assert.equal(child.rect.y,3);binding.dispose();root.destroy();assert.equal(listeners.size,0);
});

test('reverse flow preserves focus identity and tree order; modal and Toast keep input and animation ownership',()=>{
 const root=new GuiRoot(),row=root.add(createGuiContainer('row',{style:{width:200,height:50,direction:'row-reverse'}}));
 const a=row.add(new GuiButton({width:60,height:30})),b=row.add(new GuiButton({width:60,height:30}));
 const toast=root.add(new GuiToast({visible:true,text:'Saved',animationMs:100})),modal=root.add(new GuiModal());
 const binding=attachGuiLayout(root,{measure:none}),system=new GuiSystem({});
 binding.setStyle(toast,{width:180,height:40});binding.setStyle(modal,{width:400,height:300});
 root.layout(400,300);root.clearDirty();system.focus.focus(a);
 assert.ok(a.rect.x>b.rect.x);assert.deepEqual(row.children,[a,b]);assert.equal(system.focus.focused,a);
 const before=readGuiLayoutCounters(binding);toast.advanceAnimation(10000);toast.advanceAnimation(25);root.layout(400,300);
 assert.deepEqual(readGuiLayoutCounters(binding),before);assert.equal(toast.hitTest(1,1),null);assert.equal(system.focus.focused,a);
 modal.show();root.layout(400,300);const r=modal.confirmButton.rect;
 assert.equal(hitTestGui(null,new Set([root]),r.x+r.width/2,r.y+r.height/2),modal.confirmButton);
 assert.throws(()=>binding.setStyle(modal.confirmButton,{width:10}),/Composite control/);
 modal.hide();root.layout(400,300);assert.equal(hitTestGui(null,new Set([root]),a.rect.x+2,a.rect.y+2),a);
 assert.deepEqual(row.children,[a,b]);assert.equal(system.focus.focused,a);
 binding.dispose();system.destroy();root.destroy();
});
test('public GUI adapter uses shared flex sizing; manual siblings and composite children retain their owner',()=>{
 const root=new GuiRoot(),panel=root.add(createGuiContainer('row',{style:{width:300,height:60}})),a=panel.add(new GuiButton({id:'a'})),b=panel.add(new GuiButton({id:'b'}));
 const manual=root.add(new GuiElement({x:350,y:5,width:40,height:20}));
 const binding=attachGuiLayout(root,{measure:none});binding.setStyle(a,{width:'auto',height:20,basis:0,grow:1,maxWidth:100});binding.setStyle(b,{width:'auto',height:20,basis:0,grow:1});
 root.layout(500,200);assert.equal(a.rect.width,100);assert.equal(b.rect.width,200);assert.equal(b.rect.x,100);assert.equal(manual.rect.x,350);assert.equal(root.hitTest(110,10),b);
 binding.dispose();root.layout(500,200);assert.equal(a.rect.width,96);assert.equal(b.rect.x,0);
});
test('presets auto-size a wrapped flow and reject unknown presets',()=>{
 const root=new GuiRoot(),flow=root.add(createGuiContainer('flow',{style:{width:100,rowGap:5,columnGap:5,alignItems:'start',alignContent:'start'}}));
 for(let i=0;i<3;i++)flow.add(new GuiButton({width:60,height:20}));
 const binding=attachGuiLayout(root,{measure:none});root.layout(300,200);assert.equal(flow.rect.height,70);assert.equal(flow.children[2].rect.y,50);
 assert.throws(()=>createGuiContainer('unknown'));binding.dispose();
});
test('static and paint changes solve nothing; fixed-size sibling islands isolate local reflow',()=>{
 const root=new GuiRoot(),panels=['left','right'].map(id=>root.add(createGuiContainer('column',{id,style:{width:100,height:100}})));
 panels.forEach(p=>p.add(new GuiLabel({text:'a',width:60,height:20})));
 const binding=attachGuiLayout(root,{measure:none});root.layout(300,200);root.clearDirty();const first=readGuiLayoutCounters(binding);
 root.layout(300,200);panels[0].setStyle({backgroundColor:'#ff0000'});root.layout(300,200);assert.equal(readGuiLayoutCounters(binding).solves,first.solves);root.clearDirty();
 panels[0].children[0].setText('changed');root.layout(300,200);assert.equal(readGuiLayoutCounters(binding).solves,first.solves+1);
 binding.dispose();assert.equal(readGuiLayoutCounters(binding).sessions,0);
});
test('version invalidation remeasures constrained content and removed islands release their sessions',()=>{
 const root=new GuiRoot(),panel=root.add(createGuiContainer('column',{style:{width:100,height:100}})),text=panel.add(new GuiLabel({text:'a'}));let width=20;
 const binding=attachGuiLayout(root,{measure:()=>({width,height:10,minWidth:0,minHeight:0})});binding.setStyle(text,{width:'auto',height:'auto',alignSelf:'start'});
 root.layout(200,200);assert.equal(text.rect.width,20);root.clearDirty();width=50;binding.invalidate(text);root.layout(200,200);assert.equal(text.rect.width,50);
 root.remove(panel);root.layout(200,200);assert.equal(readGuiLayoutCounters(binding).sessions,0);assert.throws(()=>binding.invalidate(panel));binding.dispose();
});
test('managed scrolling derives content, preserves flow while scrolling, clamps shrink and restores manual height',()=>{
 const root=new GuiRoot(),scroll=root.add(new GuiScrollView({width:100,height:60,contentHeight:500}));
 const buttons=Array.from({length:4},(_,i)=>scroll.add(new GuiButton({id:'item-'+i,width:90,height:30})));
 const binding=attachGuiLayout(root,{measure:none});binding.setStyle(scroll,{direction:'column',width:100,height:60,alignItems:'start'});
 root.layout(200,200);root.clearDirty();assert.equal(scroll.contentHeight,120);assert.equal(scroll.maxScrollY,60);assert.equal(buttons[3].rect.y,90);
 const before=readGuiLayoutCounters(binding);scroll.scrollTo(45);assert.equal(buttons[2].rect.y,15);assert.equal(root.hitTest(10,20),buttons[2]);
 root.layout(200,200);assert.equal(buttons[2].rect.y,15);assert.equal(readGuiLayoutCounters(binding).solves,before.solves);root.clearDirty();
 for(const item of buttons.slice(1))scroll.remove(item);root.layout(200,200);assert.equal(scroll.contentHeight,30);assert.equal(scroll.scrollY,0);assert.equal(buttons[0].rect.y,0);
 binding.dispose();assert.equal(scroll.contentHeight,500);root.layout(200,200);assert.equal(scroll.contentHeight,500);
});
test('display none removes a branch from flow, drawing and hit testing; visible false retains space',()=>{
 const root=new GuiRoot(),panel=root.add(createGuiContainer('row',{style:{width:200,height:50}}));
 const a=panel.add(new GuiButton({width:50,height:30,text:'hidden'})),b=panel.add(new GuiButton({width:50,height:30}));
 const binding=attachGuiLayout(root,{measure:none});binding.setStyle(a,{display:'none'});root.layout(300,200);assert.equal(b.rect.x,0);assert.notEqual(root.hitTest(10,10),a);
 const renderer=new GuiSystem({}).renderer;renderer.collectElement(root.root,root.theme);assert.ok(!renderer.textBatch.commands.some(c=>c.text==='hidden'));
 root.clearDirty();binding.setStyle(a,{display:'flex'});a.setVisible(false);root.layout(300,200);assert.equal(b.rect.x,50);assert.notEqual(root.hitTest(10,10),a);
 binding.dispose();
});
test('nested managed scroll offsets compose without enlarging the outer content by inner overflow',()=>{
 const root=new GuiRoot(),outer=root.add(new GuiScrollView({width:120,height:80}));outer.add(new GuiButton({height:30,width:100}));
 const inner=outer.add(new GuiScrollView({width:100,height:40}));const items=Array.from({length:3},()=>inner.add(new GuiButton({width:90,height:30})));outer.add(new GuiButton({height:30,width:100}));
 const binding=attachGuiLayout(root,{measure:none});binding.setStyle(outer,{direction:'column',width:120,height:80,alignItems:'start'});binding.setStyle(inner,{direction:'column',width:100,height:40,alignItems:'start'});
 root.layout(300,200);root.clearDirty();assert.equal(outer.contentHeight,100);assert.equal(inner.contentHeight,90);
 outer.scrollTo(10);inner.scrollTo(20);root.layout(300,200);assert.equal(inner.rect.y,20);assert.equal(items[1].rect.y,30);assert.equal(root.hitTest(10,35),items[1]);
 binding.dispose();
});
test('composite geometry uses the assigned region while private children keep their original owner',()=>{
 const root=new GuiRoot(),modal=root.add(new GuiModal({visible:true,title:'Title'}));const binding=attachGuiLayout(root,{measure:none});
 binding.setStyle(modal,{width:180,height:120});root.layout(400,300);assert.equal(modal.rect.width,180);assert.equal(modal.rect.height,120);assert.ok(modal.dialogRect.width<=180);
 assert.throws(()=>binding.setStyle(modal.titleLabel,{width:10}),/Composite control/);binding.dispose();
});
test('manual anchors use core absolute sizing, resize and constraints; container-owned children ignore anchors',()=>{
 const root=new GuiRoot(),a=root.add(new GuiButton({id:'anchor',x:1,width:20,height:20}));const binding=attachGuiLayout(root,{measure:none});
 binding.setStyle(a,{anchors:{left:.5,top:0,right:1,bottom:1},offsets:{left:5,top:10,right:-5,bottom:-10},minWidth:20,maxWidth:80});
 root.layout(200,100);assert.deepEqual(a.rect,{x:105,y:10,width:80,height:80});root.clearDirty();root.layout(300,200);assert.deepEqual(a.rect,{x:155,y:10,width:80,height:180});
 const row=root.add(createGuiContainer('row',{style:{width:200,height:50}}));row.add(a);root.layout(300,200);assert.equal(a.rect.x,0);assert.equal(a.rect.width,20);
 assert.throws(()=>binding.setStyle(a,{anchors:{left:1,top:0,right:0,bottom:1}}),/Anchor end/);
 binding.dispose();root.layout(300,200);assert.equal(a.rect.x,1);
});
test('anchored scroll view keeps the viewport frame separate from natural content',()=>{
 const root=new GuiRoot(),scroll=root.add(new GuiScrollView());for(let i=0;i<4;i++)scroll.add(new GuiButton({width:50,height:30}));
 const binding=attachGuiLayout(root,{measure:none});binding.setStyle(scroll,{direction:'column',anchors:{left:.5,top:0,right:1,bottom:1},offsets:{left:0,top:10,right:-10,bottom:-10}});
 root.layout(200,100);assert.deepEqual(scroll.rect,{x:100,y:10,width:90,height:80});assert.equal(scroll.contentHeight,120);scroll.scrollTo(20);assert.equal(scroll.children[1].rect.y,20);binding.dispose();
});
test('content minima are opt-in, aggregate through core flow math and explicit minima retain precedence',()=>{
 const root=new GuiRoot(),row=root.add(createGuiContainer('row',{style:{width:200,height:50,columnGap:5,contentMinimum:true}}));
 const a=row.add(new GuiButton({id:'min-a',width:0,height:10})),b=row.add(new GuiButton({id:'min-b',width:0,height:10}));
 const binding=attachGuiLayout(root,{measure:id=>({width:60,height:20,minWidth:id==='min-a'?40:id==='min-b'?30:0,minHeight:10})});
 binding.setStyle(a,{contentMinimum:true});binding.setStyle(b,{contentMinimum:true,minWidth:5});root.layout(300,200);assert.equal(a.rect.width,40);assert.equal(b.rect.width,5);assert.equal(row.rect.width,200);
 root.clearDirty();binding.setStyle(row,{width:10});root.layout(300,200);assert.equal(row.rect.width,50);
 assert.throws(()=>binding.setStyle(row,{contentMinimum:'auto'}),/boolean/);binding.dispose();
});
class ImageSource extends EventTarget {
 naturalWidth=20;naturalHeight=15;live=0;destroyed=0;
 addEventListener(...args){this.live++;super.addEventListener(...args)}removeEventListener(...args){this.live--;super.removeEventListener(...args)}destroy(){this.destroyed++}
}
test('image readiness/replacement invalidates local metrics, removal/pause/detach releases borrowed-source listeners',()=>{
 const root=new GuiRoot(),row=root.add(createGuiContainer('row',{style:{width:200,height:100}})),source=new ImageSource(),image=row.add(new GuiImage({id:'image',source}));
 const binding=attachGuiLayout(root,{measure:id=>id==='image'?{width:image.source.naturalWidth,height:image.source.naturalHeight,minWidth:0,minHeight:0}:none()});binding.setStyle(image,{width:'auto',height:'auto',alignSelf:'start'});
 root.layout(300,200);root.clearDirty();assert.equal(image.rect.width,20);assert.equal(source.live,2);
 source.naturalWidth=40;source.dispatchEvent(new Event('load'));root.layout(300,200);root.clearDirty();assert.equal(image.rect.width,40);
 const next=new ImageSource();next.naturalWidth=70;image.setSource(next);root.layout(300,200);root.clearDirty();assert.equal(image.rect.width,70);assert.equal(source.live,0);assert.equal(next.live,2);
 const system=new GuiSystem({});system.roots.add(root);system.stopAnimations();assert.equal(next.live,0);assert.equal(readGuiLayoutCounters(binding).sessions,0);
 root.layout(300,200);assert.equal(next.live,2);root.clearDirty();row.remove(image);assert.equal(next.live,0);root.layout(300,200);
 binding.dispose();system.destroy();assert.equal(source.destroyed+next.destroyed,0);
});
test('activity notifications are independent of solver work and observing a switch cannot consume its first frame',()=>{
 const root=new GuiRoot(),scroll=root.add(new GuiScrollView({width:100,height:40,contentHeight:300,inertia:true})),toggle=root.add(new GuiSwitch({thumbTransitionMs:100}));const events=[];
 const binding=attachGuiLayout(root,{measure:none});root.layout(300,200);root.clearDirty();root.onInvalidation(e=>events.push(e));scroll.scrollTo(20);scroll.fling(100);
 assert.ok(events.some(e=>e.reasons.includes('animation')&&e.activeAnimation));scroll.stopInertia();assert.equal(events.at(-1).activeAnimation,false);
 toggle.setChecked(true);assert.equal(events.at(-1).activeAnimation,true);toggle.advanceAnimation(10000);assert.equal(toggle.thumbProgress,0);
 binding.dispose();
});
test('large GUI input remains bounded and static; one fixed-island change solves only its dependency region',()=>{
 const root=new GuiRoot(),groups=Array.from({length:10},(_,i)=>root.add(createGuiContainer('column',{id:'group-'+i,style:{width:100,height:1000}})));
 for(const [i,group]of groups.entries())for(let j=0;j<100;j++)group.add(new GuiElement({id:`item-${i}-${j}`,width:10,height:5}));
 const binding=attachGuiLayout(root,{measure:none});root.layout(1000,1000);root.clearDirty();const before=readGuiLayoutCounters(binding);
 for(let i=0;i<20;i++)root.layout(1000,1000);assert.deepEqual(readGuiLayoutCounters(binding),before);
 binding.setStyle(groups[0].children[0],{width:20});root.layout(1000,1000);const after=readGuiLayoutCounters(binding);assert.equal(after.solves,before.solves+1);assert.equal(after.solvedNodes-before.solvedNodes,101);
 binding.dispose();
 const large=new GuiRoot();for(let i=0;i<9999;i++)large.add(new GuiElement({width:1,height:1}));const largeBinding=attachGuiLayout(large,{measure:none});largeBinding.setStyle(large.root,{direction:'column'});large.layout(100,100);large.clearDirty();const first=readGuiLayoutCounters(largeBinding);large.layout(100,100);assert.equal(readGuiLayoutCounters(largeBinding).solves,first.solves);
 large.add(new GuiElement());assert.throws(()=>large.layout(100,100),/bound/);largeBinding.dispose();
});
test('a managed island inside a manual scroller keeps manual extent and uses one scroll coordinate transform',()=>{
 const root=new GuiRoot(),scroll=root.add(new GuiScrollView({x:10,y:20,width:100,height:60,contentHeight:300,scrollY:50})),panel=scroll.add(createGuiContainer('column',{style:{width:100,height:100}}));
 const buttons=Array.from({length:3},()=>panel.add(new GuiButton({width:90,height:30})));const binding=attachGuiLayout(root,{measure:none});root.layout(300,200);
 assert.equal(scroll.contentHeight,300);assert.equal(panel.rect.y,-30);assert.equal(buttons[2].rect.y,30);assert.equal(root.hitTest(15,35),buttons[2]);root.clearDirty();scroll.scrollTo(60);root.layout(300,200);assert.equal(buttons[2].rect.y,20);binding.dispose();
});
