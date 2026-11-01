import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
const {GuiRoot}=await importEngineSource('gui/components/GuiRoot.ts');
const {GuiElement}=await importEngineSource('gui/components/GuiElement.ts');
const {GuiLabel}=await importEngineSource('gui/components/GuiLabel.ts');
const {GuiProgress}=await importEngineSource('gui/components/GuiProgress.ts');
const {GuiSwitch}=await importEngineSource('gui/components/GuiSwitch.ts');
const {GuiButton}=await importEngineSource('gui/components/GuiButton.ts');
const {GuiPixelResources}=await importEngineSource('gui/GuiPixelResources.ts');
const {GuiThemeResource}=await importEngineSource('gui/GuiThemeResource.ts');
const {GuiDirtyFlags}=await importEngineSource('gui/GuiTypes.ts');

test('incremental cold appends and detach release entries without rebuilding earlier siblings',()=>{
 const root=new GuiRoot(),owner=root.layoutOwner,rebuild=owner.activity.rebuild;let rebuilds=0;
 owner.activity.rebuild=function(){rebuilds++;return rebuild.call(this);};
 try{
  const cards=[];
  for(let i=0;i<64;i++){const card=root.add(new GuiElement());cards.push(card);card.add(new GuiLabel({text:'a'}));card.add(new GuiProgress());}
  assert.ok(rebuilds<=1,'cold whole-tree rebuilds: '+rebuilds);assert.equal(owner.activity.entries.size,193);
  for(const card of cards)root.remove(card);
  assert.equal(owner.activity.entries.size,1);assert.equal(owner.activity.entries.get(root.root).childrenActive,0);
  root.destroy();assert.equal(owner.activity.entries.size,0);
 }finally{root.destroy();}
});

test('incremental activity matches the original scan across stock subtree changes',()=>{
 const root=new GuiRoot(),left=root.add(new GuiElement()),right=root.add(new GuiElement()),a=left.add(new GuiSwitch({thumbTransitionMs:100})),b=left.add(new GuiSwitch({thumbTransitionMs:100})),bar=right.add(new GuiProgress());
 const events=[];root.onInvalidation(event=>events.push(event));
 const same=()=>assert.equal(events.at(-1).activeAnimation,root.layoutOwner.active(root.root));
 try{
  a.setChecked(true);same();b.setChecked(true);same();left.setDisabled(true);same();left.setVisible(false);same();left.setDisabled(false);same();left.setVisible(true);same();
  right.add(a);same();b.finishAnimation();same();right.setVisible(false);same();right.setVisible(true);same();a.finishAnimation();same();
  a.setChecked(false);same();root.remove(right);same();bar.setValue(7);root.add(right);same();right.remove(a);same();left.add(a);same();a.finishAnimation();same();
 }finally{root.destroy();}
});

test('percentage text invalidates only when the displayed percentage changes',()=>{
 const root=new GuiRoot(),bar=root.add(new GuiProgress({value:20,showText:true})),events=[];
 try{root.layout(200,80);root.clearDirty();root.onInvalidation(e=>events.push(e));bar.setValue(20.1);assert.equal(bar.getDirtyFlags()&GuiDirtyFlags.Text,0);assert.deepEqual(events.at(-1).reasons,['paint']);root.clearDirty();const rect=bar.rect;bar.setValue(21);assert.ok(bar.getDirtyFlags()&GuiDirtyFlags.Text);assert.deepEqual(events.at(-1).reasons,['paint']);root.layout(200,80);assert.equal(bar.rect,rect);}finally{root.destroy();}
});

test('known content and paint changes skip theme/pixel rescans; source and metric changes remain observable',()=>{
 class ImageEvents extends EventTarget {width=16;height=16;naturalWidth=0;naturalHeight=0;complete=false;listeners=0;addEventListener(...args){this.listeners++;super.addEventListener(...args);}removeEventListener(...args){this.listeners--;super.removeEventListener(...args);}}
 const old=new ImageEvents(),next=new ImageEvents(),theme=new GuiThemeResource({controls:{GuiButton:{normal:{icon:old}}}}),root=new GuiRoot({themeResource:theme});
 const button=root.add(new GuiButton({text:'before',width:90,height:25})),label=root.add(new GuiLabel({text:'before',width:90,height:25})),bar=root.add(new GuiProgress()),changes=[];
 const pixels=new GuiPixelResources((element,source)=>changes.push([element,source]));pixels.sync([root]);root.layout(300,100);root.clearDirty();
 let themes=0,scans=0;const syncTheme=root.themeOwner.sync,syncPixels=pixels.sync;
 root.themeOwner.sync=function(...args){themes++;return syncTheme.apply(this,args);};pixels.sync=function(...args){scans++;return syncPixels.apply(this,args);};
 try{
  button.setText('after');label.setText('after');bar.setValue(30);assert.equal(themes,0);assert.equal(scans,0);assert.equal(old.listeners,2);
  label.setFontSize(25);assert.ok(themes>0);assert.ok(scans>0);
  theme.update({controls:{GuiButton:{normal:{icon:next}}}});assert.equal(old.listeners,0);assert.equal(next.listeners,2);
  next.naturalWidth=32;next.naturalHeight=32;next.dispatchEvent(new Event('load'));assert.ok(changes.some(([element,source])=>element===button&&source===next));
 }finally{root.destroy();pixels.release();assert.equal(old.listeners,0);assert.equal(next.listeners,0);}
});

test('bulk stock text/paint changes do not walk every sibling to report activity',()=>{
 const root=new GuiRoot(),n=64,labels=[],bars=[];
 try{
  for(let i=0;i<n;i++){const card=root.add(new GuiElement({width:40,height:24}));labels.push(card.add(new GuiLabel({text:'before',width:30,height:12})));bars.push(card.add(new GuiProgress({value:0,showText:false})));}
  root.layout(400,300);root.clearDirty();const owner=root.layoutOwner,scan=owner.active;let visits=0,refreshes=0,rebuilds=0;
  owner.active=function(element){visits++;return scan.call(this,element);};
  if(owner.activity){const refresh=owner.activity.refresh,rebuild=owner.activity.rebuild;owner.activity.refresh=function(entry){refreshes++;return refresh.call(this,entry);};owner.activity.rebuild=function(){rebuilds++;return rebuild.call(this);};}
  for(let i=0;i<n;i++){labels[i].setText('after');bars[i].setValue(1);}
  assert.ok(visits<=4*n,'whole-tree activity visits: '+visits);assert.ok(refreshes<=2*n);assert.equal(rebuilds,0);
 }finally{root.destroy();}
});
test('a progress bar without text emits paint without text/layout invalidation',()=>{
 const root=new GuiRoot(),bar=root.add(new GuiProgress({value:0,showText:false})),events=[];
 try{root.layout(300,100);root.clearDirty();root.onInvalidation(event=>events.push(event));bar.setValue(20);assert.equal(bar.getDirtyFlags()&GuiDirtyFlags.Text,0);assert.equal(bar.getDirtyFlags()&GuiDirtyFlags.Layout,0);assert.deepEqual(events.at(-1).reasons,['paint']);}finally{root.destroy();}
});
test('fixed stock text changes keep manual rectangles; metric changes still layout',()=>{
 const root=new GuiRoot(),label=root.add(new GuiLabel({text:'before',width:80,height:20}));
 try{
  root.layout(300,100);root.clearDirty();let rect=label.rect;label.setText('after');root.layout(300,100);assert.equal(label.rect,rect);assert.ok(label.getDirtyFlags()&GuiDirtyFlags.Text);
  root.clearDirty();rect=label.rect;label.setText('more');label.setFontSize(25);root.layout(300,100);assert.notEqual(label.rect,rect);
  root.clearDirty();rect=label.rect;label.setFontSize(26);label.setText('last');root.layout(300,100);assert.notEqual(label.rect,rect);
  root.clearDirty();rect=label.rect;label.setAutoWidth(true);root.layout(300,100);root.clearDirty();rect=label.rect;label.setText('auto');root.layout(300,100);assert.notEqual(label.rect,rect);
 }finally{root.destroy();}
});
test('custom coordinate owners keep text-dependent geometry',()=>{
 class Parent extends GuiElement {layout(rect){if(this.children[0])this.children[0].width=this.children[0].text.length*10;super.layout(rect);}}
 const root=new GuiRoot(),parent=root.add(new Parent({width:200,height:60})),label=parent.add(new GuiLabel({text:'a',height:20}));
 try{root.layout(300,100);root.clearDirty();label.setText('abc');root.layout(300,100);assert.equal(label.rect.width,30);}finally{root.destroy();}
});
test('activity snapshots follow visibility, removal/reparenting and completion synchronously',()=>{
 const root=new GuiRoot(),parent=root.add(new GuiElement()),toggle=parent.add(new GuiSwitch({thumbTransitionMs:100})),events=[];
 try{
  root.onInvalidation(event=>events.push(event));toggle.setChecked(true);const started=events.at(-1);assert.equal(started.activeAnimation,true);assert.ok(Object.isFrozen(started));
  parent.setVisible(false);assert.equal(events.at(-1).activeAnimation,false);parent.setVisible(true);assert.equal(events.at(-1).activeAnimation,true);
  parent.remove(toggle);assert.equal(events.at(-1).activeAnimation,false);root.add(toggle);assert.equal(events.at(-1).activeAnimation,true);
  toggle.finishAnimation();assert.equal(events.at(-1).activeAnimation,false);assert.equal(started.activeAnimation,true);
 }finally{root.destroy();}
});
test('custom activity getters keep legacy short-circuit and live-state behavior',()=>{
 class Custom extends GuiElement {on=false;get animating(){if(this.explode)throw Error('custom getter');return this.on;}}
 const root=new GuiRoot(),parent=root.add(new GuiElement()),custom=parent.add(new Custom()),bar=root.add(new GuiProgress()),events=[];
 try{
  root.onInvalidation(event=>events.push(event));custom.on=true;bar.setValue(1);assert.equal(events.at(-1).activeAnimation,true);
  parent.setVisible(false);custom.explode=true;assert.doesNotThrow(()=>bar.setValue(2));custom.explode=false;parent.setVisible(true);custom.on=false;bar.setValue(3);assert.equal(events.at(-1).activeAnimation,false);
 }finally{root.destroy();}
});
test('paint-only mutation during layout still invalidates and rolls back the transaction',()=>{
 const root=new GuiRoot(),bar=root.add(new GuiProgress({showText:false}));let mutate=false;
 const off=root.installLayoutDelegate({measure:()=>({width:1,height:1}),arrange(element,viewport,commit){commit(element,viewport);commit(bar,{x:0,y:0,width:100,height:20});if(mutate)bar.setValue(20);},dispose(){}});
 try{root.layout(300,100);root.clearDirty();const before={...bar.rect};mutate=true;root.root.markDirty(GuiDirtyFlags.Layout);assert.throws(()=>root.layout(400,200),/changed during layout/);assert.deepEqual(bar.rect,before);mutate=false;root.layout(400,200);assert.equal(root.viewport.width,400);}finally{off();root.destroy();}
});
test('a nested public invalidation cannot inherit the outer stock-text hint',()=>{
 const root=new GuiRoot(),label=root.add(new GuiLabel({text:'before',width:80,height:20})),events=[];let nested=false;
 try{
  root.layout(200,100);root.clearDirty();const before=label.rect;
  root.onInvalidation(event=>{events.push(event);if(!nested){nested=true;label.fontSize=30;label.markDirty(GuiDirtyFlags.Text);}});
  label.setText('after');assert.ok(events.some(event=>event.reasons.includes('layout')));root.layout(200,100);assert.notEqual(label.rect,before);
 }finally{root.destroy();}
});
