import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
const {GuiRoot}=await importEngineSource('gui/components/GuiRoot.ts');
const {GuiElement}=await importEngineSource('gui/components/GuiElement.ts');
const {GuiButton}=await importEngineSource('gui/components/GuiButton.ts');
const {GuiThemeResource}=await importEngineSource('gui/GuiThemeResource.ts');
const normal={hover:false,focus:false,pressed:false,disabled:false};

test('state overlays compose normal, hover, focus, pressed and disabled in contract order',()=>{
 const r=new GuiThemeResource({normal:{color:'normal',padding:4},hover:{color:'hover'},focus:{borderColor:'focus',color:'focus'},pressed:{color:'pressed'},disabled:{color:'disabled'}});
 assert.deepEqual(r.resolve('*',normal),{color:'normal',padding:4});
 assert.deepEqual(r.resolve('*',{hover:true,focus:true,pressed:true,disabled:true}),{color:'disabled',padding:4,borderColor:'focus'});
 assert.equal(r.resolve('*',{...normal,focus:true,pressed:true}).color,'pressed');
});

test('inherited defaults and named control layers stay distinct and definitions are immutable snapshots',()=>{
 const source={normal:{color:'parent'},controls:{GuiButton:{normal:{color:'button',padding:8}}}};
 const parent=new GuiThemeResource(source),child=new GuiThemeResource({parent,normal:{backgroundColor:'child'},controls:{GuiButton:{hover:{color:'hover'}}}});
 source.normal.color='mutated';source.controls.GuiButton.normal.padding=999;
 assert.deepEqual(child.resolve('*',normal),{color:'parent',backgroundColor:'child'});
 assert.deepEqual(child.resolve('GuiButton',{...normal,hover:true}),{color:'hover',padding:8});
 assert.deepEqual(child.resolve('GuiLabel',normal),{});
 assert.equal(Object.isFrozen(child.resolve('*',normal)),true);
});

test('resource inheritance preserves inherited state-specific entries above a derived normal value',()=>{
 const parent=new GuiThemeResource({disabled:{color:'disabled'},focus:{borderColor:'focus'}});
 const child=new GuiThemeResource({parent,normal:{color:'normal'}});
 assert.deepEqual(child.resolve('*',{...normal,focus:true,disabled:true}),{color:'disabled',borderColor:'focus'});
});

test('partial palette tokens inherit without mutating the definition and remain paint-only',()=>{
 const palette={primary:'red',text:'white'},parent=new GuiThemeResource({normal:{palette}}),child=new GuiThemeResource({parent,normal:{palette:{primary:'blue'}}});
 palette.text='mutated';assert.deepEqual(child.resolve('*',normal).palette,{primary:'blue',text:'white'});
 const root=new GuiRoot({themeResource:child}),button=root.add(new GuiButton());root.clearDirty();
 root.layout(100,100);root.clearDirty();root.layout(100,100);assert.equal(root.dirty,false,'unchanged palette does not invalidate every layout frame');
 child.update({parent,normal:{palette:{primary:'green'}}});assert.equal(button.getDirtyFlags()&5,0);root.destroy();
});

test('independent themes subscribe once per registration, detach parent propagation and tolerate replacement',()=>{
 const parent=new GuiThemeResource(),child=new GuiThemeResource({parent}),other=new GuiThemeResource();let changes=0;
 const listener=()=>changes++,off1=child.subscribe(listener),off2=child.subscribe(listener);
 const version=child.version;parent.update({normal:{fontSize:20}});assert.equal(changes,2);assert.ok(child.version>version);
 off1();off1();parent.update({normal:{fontSize:21}});assert.equal(changes,3);
 child.update({parent:other});assert.equal(changes,4);parent.update({});assert.equal(changes,4);
 off2();other.update({});assert.equal(changes,4);
 assert.equal(child.resolve('*',normal).fontSize,undefined);
});

test('invalid updates and inheritance cycles preserve the last valid resource and version',()=>{
 const a=new GuiThemeResource({normal:{fontSize:14}}),b=new GuiThemeResource({parent:a});const version=a.version;
 for(const definition of [{parent:b},{normal:{opacity:2}},{normal:{fontSize:NaN}},{normal:{contentInsets:{top:1,right:1,bottom:-1,left:1}}}])assert.throws(()=>a.update(definition));
 assert.equal(a.version,version);assert.equal(a.resolve('*',normal).fontSize,14);
});

test('borrowed texture objects remain mutable and disposal releases notifications without destroying caller resources',()=>{
 let destroyed=0;const texture={width:16,height:16,destroy(){destroyed++}},r=new GuiThemeResource({normal:{icon:texture}});let changes=0;
 r.subscribe(()=>changes++);texture.width=32;assert.equal(r.resolve('*',normal).icon.width,32);
 r.dispose();r.dispose();assert.equal(destroyed,0);assert.equal(changes,1);assert.deepEqual(r.resolve('*',normal),{});
 assert.throws(()=>r.update({}),/disposed/);r.subscribe(()=>changes++);assert.equal(changes,1);
});

function observed(resource){
 let listeners=0;
 return {get version(){return resource.version;},resolve:(...args)=>resource.resolve(...args),
  subscribe(callback){listeners++;const off=resource.subscribe(callback);let live=true;return()=>{if(live){live=false;listeners--;off();}};},get listeners(){return listeners;}};
}

test('tree cascade follows inherited defaults, control type, local resource then local style without mutating local styles',()=>{
 const inherited=new GuiThemeResource({normal:{color:'inherited',padding:3},controls:{GuiButton:{normal:{color:'type',padding:8}}}});
 const local=new GuiThemeResource({normal:{color:'local'}}),root=new GuiRoot({themeResource:inherited});
 const button=root.add(new GuiButton({themeResource:local,style:{color:'style'}}));
 assert.equal(button.themeControlType,'GuiButton');assert.equal(button.getResolvedStyle().color,'style');assert.equal(button.getResolvedStyle().padding,8);
 assert.deepEqual(button.style,{color:'style'});button.setStyle({color:undefined});assert.equal(button.getResolvedStyle().color,'local');
 button.setThemeResource(null);assert.equal(button.getResolvedStyle().color,'type');root.destroy();
});

test('shared resources update independent roots; pure appearance stays paint-only and metrics invalidate layout',()=>{
 const resource=new GuiThemeResource({normal:{color:'red',fontSize:14}}),tracked=observed(resource);
 const a=new GuiRoot({themeResource:tracked}),b=new GuiRoot({themeResource:tracked});const child=a.add(new GuiButton());
 assert.equal(tracked.listeners,2);a.clearDirty();b.clearDirty();
 resource.update({normal:{color:'blue',fontSize:14}});
 assert.equal(child.getResolvedStyle().color,'blue');assert.equal(child.getDirtyFlags()&5,0,'colors do not invalidate layout or text metrics');
 a.clearDirty();b.clearDirty();resource.update({normal:{color:'blue',fontSize:20}});assert.equal(child.getDirtyFlags()&5,5);
 a.destroy();assert.equal(tracked.listeners,1);b.destroy();assert.equal(tracked.listeners,0);
 assert.equal(resource.resolve('*',normal).fontSize,20,'roots borrow the resource');
});

test('detached subtrees unsubscribe immediately and active state metrics preserve overlay priority',()=>{
 const resource=new GuiThemeResource({normal:{color:'normal',fontSize:14},focus:{borderColor:'focus'},pressed:{fontSize:18},disabled:{color:'disabled'}}),tracked=observed(resource);
 const root=new GuiRoot(),panel=root.add(new GuiElement({themeResource:tracked})),button=panel.add(new GuiButton());
 assert.equal(tracked.listeners,1);root.clearDirty();button.focused=true;button.pressed=true;button.disabled=true;button.markDirty(2);
 assert.equal(button.getResolvedStyle().fontSize,18);assert.equal(button.getResolvedStyle().color,'disabled');assert.equal(button.getResolvedStyle().borderColor,'focus');
 assert.equal(button.getDirtyFlags()&5,5);
 root.remove(panel);assert.equal(tracked.listeners,0);root.destroy();
});

test('nine-slice density changes invalidate layout even when cuts and source remain equal',()=>{
 const source={width:30,height:30},resource=new GuiThemeResource({normal:{nineSlice:{source,sourceWidth:30,sourceHeight:30,cuts:[10,10,10,10],pixelRatio:1}}}),root=new GuiRoot(),panel=root.add(new GuiElement({width:100,height:60,themeResource:resource})),child=panel.add(new GuiElement({width:10,height:10}));
 root.layout(200,100);root.clearDirty();assert.equal(child.rect.x,10);
 resource.update({normal:{nineSlice:{source,sourceWidth:30,sourceHeight:30,cuts:[10,10,10,10],pixelRatio:2}}});assert.ok(panel.getDirtyFlags()&1);root.layout(200,100);assert.equal(child.rect.x,5);root.destroy();
});

test('layout transactions keep borrowed local icon and skin handles opaque even with circular owner metadata',()=>{
 const source={width:30,height:30};source.owner=source;let inspected=0;Object.defineProperty(source,'privateOwner',{enumerable:true,get(){inspected++;throw Error('Borrowed metadata must not be inspected');}});
 const root=new GuiRoot(),element=root.add(new GuiElement({width:60,height:40,style:{icon:source,nineSlice:{source,sourceWidth:30,sourceHeight:30,cuts:[4,4,4,4]}}}));
 const off=root.installLayoutDelegate({measure:()=>({width:0,height:0,minWidth:0,minHeight:0}),arrange(_root,viewport,commit){commit(element,{x:10,y:10,width:60,height:40});},dispose(){}});
 root.layout(100,100);assert.equal(element.rect.x,10);assert.equal(inspected,0);assert.equal(source.owner,source);off();root.destroy();
});

test('a borrowed local icon version changed during a layout calculation rejects the transaction',()=>{
 const source={width:10,height:10,version:1},root=new GuiRoot(),element=root.add(new GuiElement({width:40,height:30,style:{icon:source}}));root.layout(100,100);const before={...element.rect};
 const off=root.installLayoutDelegate({measure:()=>({width:0,height:0,minWidth:0,minHeight:0}),arrange(_root,_viewport,commit){source.version++;commit(element,{x:20,y:20,width:40,height:30});},dispose(){}});
 assert.throws(()=>root.layout(100,100),/changed during layout/);assert.deepEqual(element.rect,before);off();root.destroy();
});
